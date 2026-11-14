#!/usr/bin/env node
'use strict';

/**
 * index.js
 *
 * Standalone Node.js pre-brief engine. It mirrors workflow.json step for step:
 *
 *   calendar events (Google / Outlook / webhook / file)
 *     -> select meetings ~LEAD_MINUTES out with external attendees (deduped)
 *     -> HubSpot enrichment state machine (account gate first, read-only)
 *     -> dossier -> LLM brief (or deterministic fallback)
 *     -> Slack Block Kit / email payloads -> dispatch gate -> send
 *
 * Usage:
 *   node src/index.js --events test/fixtures/meeting-event-mock.json --now 2026-11-16T14:30:00Z
 *   node src/index.js --poll                 (fetch from Google or Outlook once)
 *   node src/index.js --serve                (calendar webhook on 127.0.0.1:8788)
 *   node --env-file=.env src/index.js --poll
 *
 * Zero runtime dependencies: global fetch (Node 18+), node:net, node:tls,
 * node:http, node:crypto, node:fs.
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const crypto = require('node:crypto');

const { loadConfig, describeConfig } = require('./config');
const { selectMeetingsToBrief, pruneBriefedKeys } = require('./calendar');
const { HUBSPOT_STAGES, createFetchState, planStage, absorbStage, buildDossier } = require('./hubspot-fetcher');
const { shouldCallLlm, buildLlmRequest, parseLlmResponse, composeBrief, buildDispatchPlan } = require('./brief-formatter');

const WEBHOOK_PATH = '/webhook/meeting-pre-brief';
const MAX_BODY_BYTES = 512 * 1024;

function maskEmail(email) {
  if (typeof email !== 'string' || email.indexOf('@') === -1) return email;
  const parts = email.split('@');
  return (parts[0].slice(0, 1) || '*') + '***@' + parts[1];
}

function createLogger(options) {
  const opts = options || {};
  const write = function (level, message, fields) {
    if (opts.silent) return;
    const line = Object.assign({ level: level, time: new Date().toISOString(), message: message }, fields || {});
    ['email', 'recipient'].forEach(function (k) { if (line[k]) line[k] = maskEmail(line[k]); });
    process.stderr.write(JSON.stringify(line) + '\n');
  };
  return {
    info: function (m, f) { write('info', m, f); },
    warn: function (m, f) { write('warn', m, f); },
    error: function (m, f) { write('error', m, f); }
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (error) { return { raw: text.slice(0, 2000) }; }
}

/** Minimal JSON-over-HTTPS client with 429 / 5xx retries. */
class JsonClient {
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.headers = options.headers || {};
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.maxRetries = options.maxRetries === undefined ? 3 : options.maxRetries;
    this.baseDelayMs = options.baseDelayMs === undefined ? 500 : options.baseDelayMs;
    this.timeoutMs = options.timeoutMs || 30000;
    this.sleep = options.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    if (typeof this.fetch !== 'function') throw new Error('No fetch implementation available (Node 18+ required).');
  }

  async request(method, urlOrPath, body, extraHeaders) {
    const url = /^https?:\/\//.test(urlOrPath) ? urlOrPath : this.baseUrl + urlOrPath;
    for (let attempt = 0; ; attempt++) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(function () { controller.abort(); }, this.timeoutMs) : null;
      let response;
      try {
        response = await this.fetch(url, {
          method: method,
          headers: Object.assign({ Accept: 'application/json' }, body === null || body === undefined ? {} : { 'Content-Type': 'application/json' }, this.headers, extraHeaders || {}),
          body: body === null || body === undefined ? undefined : JSON.stringify(body),
          signal: controller ? controller.signal : undefined
        });
      } catch (error) {
        if (timer) clearTimeout(timer);
        if (attempt < this.maxRetries) { await this.sleep(this.baseDelayMs * Math.pow(2, attempt)); continue; }
        return { statusCode: 0, body: { message: error.message } };
      }
      if (timer) clearTimeout(timer);
      const parsed = await readJsonResponse(response);
      if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.baseDelayMs * Math.pow(2, attempt));
        continue;
      }
      return { statusCode: response.status, body: parsed };
    }
  }
}

function createHubSpotClient(cfg, fetchImpl, extra) {
  if (!cfg.hubspotToken) return null;
  return new JsonClient(Object.assign({ baseUrl: cfg.hubspotBaseUrl, headers: { Authorization: 'Bearer ' + cfg.hubspotToken }, fetchImpl: fetchImpl }, extra || {}));
}

/**
 * Offline client that answers from recorded responses keyed "METHOD /path".
 * Used by `npm run dry-run` so the full pipeline runs with no network at all.
 */
function createFixtureHubSpotClient(responses) {
  return {
    request: async function (method, apiPath) {
      const hit = responses[method + ' ' + apiPath];
      return hit ? JSON.parse(JSON.stringify(hit)) : { statusCode: 404, body: { message: 'No fixture for ' + method + ' ' + apiPath } };
    }
  };
}

async function runHubSpotEnrichment(meeting, cfg, client) {
  let state = createFetchState(meeting, cfg);
  for (let i = 0; i < HUBSPOT_STAGES.length; i++) {
    const stage = HUBSPOT_STAGES[i];
    const request = planStage(stage, state, cfg);
    const response = request ? await client.request(request.method, request.path, request.body) : null;
    state = absorbStage(stage, state, response, cfg);
  }
  return buildDossier(state, cfg, meeting);
}

async function generateBrief(dossier, cfg, deps) {
  const decision = shouldCallLlm(cfg);
  let llmResult = { ok: false, reason: decision.reason, brief: null };
  if (decision.call) {
    const client = deps.llmClient || new JsonClient({
      baseUrl: cfg.openaiBaseUrl,
      headers: { Authorization: 'Bearer ' + cfg.openaiApiKey },
      fetchImpl: deps.fetchImpl,
      maxRetries: 2,
      timeoutMs: 45000
    });
    const response = await client.request('POST', '/chat/completions', buildLlmRequest(dossier, cfg));
    llmResult = parseLlmResponse(response.statusCode, response.body);
  }
  return composeBrief(dossier, cfg, llmResult);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function assertNoHeaderInjection(value, name) {
  if (/[\r\n]/.test(String(value))) throw new Error(name + ' contains a line break; refusing to build the email.');
  return String(value);
}

function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
}

function wrapBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

function buildMimeMessage(options) {
  const from = assertNoHeaderInjection(options.from, 'From');
  const to = assertNoHeaderInjection(options.to, 'To');
  const subject = assertNoHeaderInjection(options.subject, 'Subject');
  const boundary = 'prebrief-' + crypto.randomBytes(12).toString('hex');
  const domain = from.split('@')[1] || 'example.invalid';
  return [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + encodeHeader(subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + crypto.randomBytes(16).toString('hex') + '@' + domain + '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(options.text),
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(options.html),
    '--' + boundary + '--',
    ''
  ].join('\r\n');
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * Minimal SMTP client: implicit TLS (port 465, SMTP_SECURE=true) or STARTTLS.
 * Plaintext is refused unless the server is on loopback (local test relays).
 */
function sendSmtpMail(options) {
  return new Promise(function (resolve, reject) {
    let socket = options.secure
      ? tls.connect({ host: options.host, port: options.port, servername: options.host, rejectUnauthorized: options.rejectUnauthorized !== false })
      : net.connect({ host: options.host, port: options.port });
    let buffer = '';
    let waiter = null;
    const transcript = [];
    const timeout = setTimeout(function () { fail(new Error('SMTP timeout')); }, options.timeoutMs || 30000);
    function fail(error) { clearTimeout(timeout); try { socket.destroy(); } catch (e) { /* ignore */ } reject(error); }
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const m = /^(\d{3})([ -])(.*)$/.exec(lines[i]);
        if (m && m[2] === ' ' && waiter) {
          const reply = lines.slice(0, i + 1);
          buffer = lines.slice(i + 1).join('\r\n');
          const w = waiter; waiter = null;
          w({ code: Number(m[1]), lines: reply });
          return;
        }
      }
    }
    function attach(s) { s.on('data', onData); s.on('error', fail); }
    function read() { return new Promise(function (r) { waiter = r; onData(Buffer.alloc(0)); }); }
    async function command(line, expected, redacted) {
      transcript.push(redacted || line);
      socket.write(line + '\r\n');
      const reply = await read();
      if (expected.indexOf(reply.code) === -1) throw new Error('SMTP ' + (redacted || line.split(' ')[0]) + ' failed: ' + reply.lines.join(' | '));
      return reply;
    }
    attach(socket);
    (async function () {
      const greeting = await read();
      if (greeting.code !== 220) throw new Error('SMTP greeting failed: ' + greeting.lines.join(' | '));
      let ehlo = await command('EHLO pre-brief.example.invalid', [250]);
      if (!options.secure) {
        if (ehlo.lines.some(function (l) { return /STARTTLS/i.test(l); })) {
          await command('STARTTLS', [220]);
          socket.removeListener('data', onData);
          socket = tls.connect({ socket: socket, servername: options.host, rejectUnauthorized: options.rejectUnauthorized !== false });
          attach(socket);
          await new Promise(function (r) { socket.once('secureConnect', r); });
          ehlo = await command('EHLO pre-brief.example.invalid', [250]);
        } else if (!isLoopback(options.host)) {
          throw new Error('SMTP server offers no STARTTLS; refusing to send credentials or briefs in plaintext.');
        }
      }
      if (options.user) {
        const token = Buffer.from('\u0000' + options.user + '\u0000' + options.password, 'utf8').toString('base64');
        await command('AUTH PLAIN ' + token, [235], 'AUTH PLAIN [redacted]');
      }
      await command('MAIL FROM:<' + assertNoHeaderInjection(options.from, 'From') + '>', [250]);
      await command('RCPT TO:<' + assertNoHeaderInjection(options.to, 'To') + '>', [250, 251]);
      await command('DATA', [354]);
      const message = buildMimeMessage(options).replace(/\r\n\./g, '\r\n..');
      await command(message + '\r\n.', [250], '[message body]');
      await command('QUIT', [221]).catch(function () { return null; });
      clearTimeout(timeout);
      socket.end();
      resolve({ accepted: [options.to], transcript: transcript });
    })().catch(fail);
  });
}

async function dispatchOne(dispatch, cfg, deps) {
  const fetchImpl = deps.fetchImpl;
  if (dispatch.channel === 'slack_webhook') {
    const url = dispatch.sandbox ? cfg.sandboxSlackWebhookUrl : cfg.slackWebhookUrl;
    const client = new JsonClient({ fetchImpl: fetchImpl, maxRetries: 2 });
    const res = await client.request('POST', url, dispatch.payload);
    if (res.statusCode !== 200) throw new Error('Slack webhook returned ' + res.statusCode);
    return { channel: dispatch.channel, status: 'sent' };
  }
  if (dispatch.channel === 'slack_bot') {
    const client = new JsonClient({ baseUrl: 'https://slack.com/api', headers: { Authorization: 'Bearer ' + cfg.slackBotToken }, fetchImpl: fetchImpl, maxRetries: 2 });
    let channel = dispatch.target.channel;
    if (dispatch.target.needsLookup) {
      const lookup = await client.request('GET', '/users.lookupByEmail?email=' + encodeURIComponent(dispatch.target.lookupEmail));
      if (!lookup.body || !lookup.body.ok) throw new Error('Slack users.lookupByEmail failed: ' + ((lookup.body && lookup.body.error) || lookup.statusCode));
      channel = lookup.body.user.id;
    }
    const post = await client.request('POST', '/chat.postMessage', Object.assign({ channel: channel }, dispatch.payload));
    if (!post.body || !post.body.ok) throw new Error('Slack chat.postMessage failed: ' + ((post.body && post.body.error) || post.statusCode));
    return { channel: dispatch.channel, status: 'sent' };
  }
  if (dispatch.channel === 'email') {
    const send = deps.sendMail || sendSmtpMail;
    await send({
      host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpSecure, user: cfg.smtpUser, password: cfg.smtpPassword,
      from: dispatch.target.from, to: dispatch.target.email,
      subject: dispatch.payload.subject, html: dispatch.payload.html, text: dispatch.payload.text
    });
    return { channel: dispatch.channel, status: 'sent' };
  }
  throw new Error('Unknown dispatch channel ' + dispatch.channel);
}

// ---------------------------------------------------------------------------
// State (dedupe) and calendar sources
// ---------------------------------------------------------------------------

function createStateStore(filePath) {
  let memory = {};
  return {
    load: function () {
      if (filePath && fs.existsSync(filePath)) {
        try { memory = JSON.parse(fs.readFileSync(filePath, 'utf8')).briefed || {}; } catch (error) { memory = {}; }
      }
      return Object.assign({}, memory);
    },
    save: function (briefed) {
      memory = Object.assign({}, briefed);
      if (filePath) fs.writeFileSync(filePath, JSON.stringify({ briefed: memory }, null, 2));
    }
  };
}

async function fetchCalendarEvents(cfg, now, fetchImpl) {
  const from = new Date(now.getTime() + (cfg.leadMinutes - cfg.pollIntervalMinutes) * 60000).toISOString();
  const to = new Date(now.getTime() + (cfg.leadMinutes + cfg.pollIntervalMinutes) * 60000).toISOString();
  if (cfg.calendarProvider === 'google') {
    if (!cfg.googleCalendarAccessToken) throw new Error('GOOGLE_CALENDAR_ACCESS_TOKEN is not set.');
    const client = new JsonClient({ headers: { Authorization: 'Bearer ' + cfg.googleCalendarAccessToken }, fetchImpl: fetchImpl });
    const query = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
    const res = await client.request('GET', 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(cfg.googleCalendarId) + '/events?' + query.toString());
    if (res.statusCode !== 200) throw new Error('Google Calendar returned ' + res.statusCode);
    return (res.body.items || []).map(function (e) { return Object.assign({ kind: 'calendar#event' }, e); });
  }
  if (cfg.calendarProvider === 'outlook') {
    if (!cfg.msGraphAccessToken) throw new Error('MS_GRAPH_ACCESS_TOKEN is not set.');
    const client = new JsonClient({ headers: { Authorization: 'Bearer ' + cfg.msGraphAccessToken }, fetchImpl: fetchImpl });
    const query = new URLSearchParams({ startDateTime: from, endDateTime: to, '$top': '50' });
    const res = await client.request('GET', 'https://graph.microsoft.com/v1.0/me/calendarView?' + query.toString(), null, { Prefer: 'outlook.timezone="UTC"' });
    if (res.statusCode !== 200) throw new Error('Microsoft Graph returned ' + res.statusCode);
    return (res.body.value || []).map(function (e) { return Object.assign({ provider: 'outlook' }, e); });
  }
  throw new Error('CALENDAR_PROVIDER=webhook has nothing to poll; use --serve or --events.');
}

function extractEvents(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.events)) return payload.events;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.value)) return payload.value;
  return [payload];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function processEvents(rawEvents, deps) {
  const cfg = deps.config;
  const logger = deps.logger || createLogger({ silent: true });
  const now = deps.now ? deps.now() : new Date();
  const store = deps.stateStore || createStateStore(null);
  let briefed = pruneBriefedKeys(store.load(), now);

  const selection = selectMeetingsToBrief(rawEvents, {
    now: now,
    leadMinutes: cfg.leadMinutes,
    pollIntervalMinutes: cfg.pollIntervalMinutes,
    internalDomains: cfg.internalDomains,
    ignoreTitleKeywords: cfg.ignoreTitleKeywords,
    skipPrivateEvents: cfg.skipPrivateEvents,
    briefedKeys: briefed
  });
  const results = [];

  for (let i = 0; i < selection.selected.length; i++) {
    const meeting = selection.selected[i];
    const result = { meetingKey: meeting.key, title: meeting.title, dispatchMode: cfg.dispatchMode };
    try {
      const hubspot = deps.hubspotClient || createHubSpotClient(cfg, deps.fetchImpl);
      if (!hubspot) throw new Error(cfg.hubspotTokenVar + ' is not set; HubSpot enrichment needs a (sandbox) private app token, even in dry run.');
      const dossier = await runHubSpotEnrichment(meeting, cfg, hubspot);
      const composed = await generateBrief(dossier, cfg, deps);
      const dispatches = buildDispatchPlan(dossier, cfg, composed);
      result.briefSource = composed.source;
      result.assignedRep = dossier.assignedRep;
      result.dataGaps = dossier.dataGaps;
      result.dispatches = [];

      for (let j = 0; j < dispatches.length; j++) {
        const d = dispatches[j];
        if (!d.allowed) {
          result.dispatches.push({ channel: d.channel, status: cfg.dispatchMode === 'dry_run' ? 'preview' : 'blocked', reason: d.reason, target: d.target, payload: d.payload });
          continue;
        }
        try {
          result.dispatches.push(Object.assign(await dispatchOne(d, cfg, deps), { sandbox: d.sandbox, reason: d.reason }));
        } catch (error) {
          result.dispatches.push({ channel: d.channel, status: 'failed', error: error.message });
        }
      }
      if (cfg.dispatchMode !== 'dry_run') {
        // At-most-once: a meeting is marked briefed once dispatch was attempted, so a
        // flaky channel never turns into a stream of duplicate briefs.
        briefed[meeting.key] = now.toISOString();
      }
      result.status = cfg.dispatchMode === 'dry_run' ? 'dry_run' : (result.dispatches.some(function (d) { return d.status === 'sent'; }) ? 'sent' : 'not_sent');
      logger.info('meeting_processed', { meetingKey: meeting.key, status: result.status, recipient: dossier.assignedRep && dossier.assignedRep.email });
    } catch (error) {
      result.status = 'error';
      result.error = error.message;
      logger.error('meeting_failed', { meetingKey: meeting.key, error: error.message });
    }
    results.push(result);
  }

  if (cfg.dispatchMode !== 'dry_run') store.save(briefed);
  return { window: selection.window, selected: selection.selected.length, skipped: selection.skipped, results: results };
}

function verifyWebhookSignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  const provided = String(header).replace(/^sha256=/i, '').trim();
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(provided.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
}

function createWebhookServer(deps) {
  const cfg = deps.config;
  if (cfg.requireWebhookSignature && !cfg.calendarWebhookSecret) {
    throw new Error('REQUIRE_WEBHOOK_SIGNATURE is on but CALENDAR_WEBHOOK_SECRET is empty or a placeholder.');
  }
  const send = function (res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
  return http.createServer(function (req, res) {
    if (req.method !== 'POST' || req.url.split('?')[0] !== WEBHOOK_PATH) return send(res, 404, { status: 'not_found' });
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { aborted = true; send(res, 413, { status: 'payload_too_large' }); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', async function () {
      if (aborted) return;
      const raw = Buffer.concat(chunks);
      if (cfg.requireWebhookSignature && !verifyWebhookSignature(raw, req.headers['x-signature'], cfg.calendarWebhookSecret)) return send(res, 401, { status: 'invalid_signature' });
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch (error) { return send(res, 400, { status: 'invalid_json' }); }
      try {
        const out = await processEvents(extractEvents(payload), deps);
        send(res, 200, { status: 'ok', selected: out.selected, results: out.results.map(function (r) { return { meetingKey: r.meetingKey, status: r.status }; }) });
      } catch (error) {
        send(res, 500, { status: 'error', error: error.message });
      }
    });
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--events') args.events = argv[++i];
    else if (argv[i] === '--now') args.now = argv[++i];
    else if (argv[i] === '--poll') args.poll = true;
    else if (argv[i] === '--serve') args.serve = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args.events && !args.poll && !args.serve)) {
    process.stdout.write('Usage: node src/index.js --events <file.json> [--now <ISO>] | --poll | --serve\n');
    return 0;
  }
  const cfg = loadConfig(process.env);
  const logger = createLogger();
  const nowValue = args.now ? new Date(args.now) : null;
  if (nowValue && !Number.isFinite(nowValue.getTime())) throw new Error('--now must be an ISO timestamp.');
  const deps = { config: cfg, logger: logger, stateStore: createStateStore(cfg.stateFile), now: nowValue ? function () { return nowValue; } : undefined };
  logger.info('config_loaded', { config: describeConfig(cfg) });

  if (args.serve) {
    const server = createWebhookServer(deps);
    await new Promise(function (r) { server.listen(cfg.port, cfg.host, r); });
    logger.info('webhook_listening', { url: 'http://' + cfg.host + ':' + cfg.port + WEBHOOK_PATH, dispatchMode: cfg.dispatchMode });
    return null;
  }
  let events;
  if (args.events) {
    const data = JSON.parse(fs.readFileSync(path.resolve(args.events), 'utf8'));
    events = extractEvents(data.calendar_events || data);
    if (!cfg.hubspotToken && data.hubspot_mock_responses) {
      if (cfg.dispatchMode !== 'dry_run') throw new Error('Recorded HubSpot fixtures may only be used in dry run.');
      deps.hubspotClient = createFixtureHubSpotClient(data.hubspot_mock_responses);
      logger.warn('using_recorded_hubspot_fixtures', { reason: cfg.hubspotTokenVar + ' is not set' });
    }
  } else {
    events = await fetchCalendarEvents(cfg, nowValue || new Date(), undefined);
  }
  const out = await processEvents(events, deps);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return out.results.some(function (r) { return r.status === 'error'; }) ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) {
    if (typeof code === 'number') process.exitCode = code;
  }).catch(function (error) {
    process.stderr.write(JSON.stringify({ level: 'error', message: error.message }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  WEBHOOK_PATH,
  JsonClient,
  maskEmail,
  createLogger,
  createHubSpotClient,
  createFixtureHubSpotClient,
  runHubSpotEnrichment,
  generateBrief,
  buildMimeMessage,
  sendSmtpMail,
  dispatchOne,
  createStateStore,
  fetchCalendarEvents,
  extractEvents,
  processEvents,
  verifyWebhookSignature,
  createWebhookServer,
  main
};
