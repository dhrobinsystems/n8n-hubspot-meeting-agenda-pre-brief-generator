'use strict';

/**
 * workflow.test.js
 *
 * Run with: npm test   (node --test, zero dependencies)
 *
 *   1. Config fail-safe defaults and gates
 *   2. Calendar normalization and meeting selection
 *   3. HubSpot enrichment state machine against recorded (mock) responses
 *   4. LLM prompt assembly, response parsing, and fallback briefs
 *   5. Slack Block Kit, HTML email, and Markdown formatting
 *   6. Engine end-to-end (dry run, sandbox redirect, dedupe, Slack bot, SMTP)
 *   7. workflow.json structure, gate topology, and Code-node parity
 *   8. Repository security scan
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const config = require('../src/config');
const calendar = require('../src/calendar');
const fetcher = require('../src/hubspot-fetcher');
const formatter = require('../src/brief-formatter');
const engine = require('../src/index');
const builder = require('../scripts/build-workflow');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'meeting-event-mock.json'), 'utf8'));
const NOW = new Date(FIXTURE._meta.reference_now);
const BASE_ENV = { INTERNAL_DOMAINS: 'example.com' };

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function events() { return plain(FIXTURE.calendar_events); }
function cfgFrom(env) { return config.parseConfig(Object.assign({}, BASE_ENV, env || {})); }

function selectOptions(cfg, extra) {
  return Object.assign({
    now: NOW,
    leadMinutes: cfg.leadMinutes,
    pollIntervalMinutes: cfg.pollIntervalMinutes,
    internalDomains: cfg.internalDomains,
    ignoreTitleKeywords: cfg.ignoreTitleKeywords,
    skipPrivateEvents: cfg.skipPrivateEvents
  }, extra || {});
}

function selectedMeeting(cfg) {
  const selection = calendar.selectMeetingsToBrief(events(), selectOptions(cfg || cfgFrom()));
  assert.equal(selection.selected.length, 1);
  return selection.selected[0];
}

function recordingFixtureClient(overrides) {
  const responses = Object.assign({}, plain(FIXTURE.hubspot_mock_responses), overrides || {});
  const calls = [];
  return {
    calls: calls,
    request: async function (method, apiPath, body) {
      calls.push({ method: method, path: apiPath, body: body });
      const hit = responses[method + ' ' + apiPath];
      return hit ? plain(hit) : { statusCode: 404, body: { message: 'no fixture' } };
    }
  };
}

async function fixtureDossier(cfg, overrides) {
  const c = cfg || cfgFrom();
  return engine.runHubSpotEnrichment(selectedMeeting(c), c, recordingFixtureClient(overrides));
}

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------

test('config: DRY_RUN and SANDBOX_MODE default to true', function () {
  const cfg = config.loadConfig({});
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.sandboxMode, true);
  assert.equal(cfg.dispatchMode, 'dry_run');
  assert.equal(cfg.dataMode, 'sandbox');
  assert.equal(cfg.leadMinutes, 30);
  assert.deepEqual(cfg.dispatchChannels, ['slack']);
  assert.ok(Object.isFrozen(cfg));
});

test('config: only the literal string "false" disables a safety flag', function () {
  ['0', 'no', 'off', '', 'flase', 'FALSE-ish'].forEach(function (v) {
    assert.equal(config.parseConfig({ DRY_RUN: v }).dryRun, true, 'DRY_RUN=' + v);
    assert.equal(config.parseConfig({ SANDBOX_MODE: v }).sandboxMode, true, 'SANDBOX_MODE=' + v);
  });
  assert.equal(config.parseConfig({ DRY_RUN: ' False ', LLM_ENABLED: 'false' }).dryRun, false);
});

test('config: production data or recipients need ALLOW_PRODUCTION_MODE=true', function () {
  assert.throws(function () { config.parseConfig({ SANDBOX_MODE: 'false' }); }, /ALLOW_PRODUCTION_MODE/);
  assert.throws(function () { config.parseConfig({ DRY_RUN: 'true', SANDBOX_MODE: 'false' }); }, /ALLOW_PRODUCTION_MODE/, 'even read-only production access needs the opt-in');
  const cfg = config.parseConfig({ SANDBOX_MODE: 'false', ALLOW_PRODUCTION_MODE: 'true' });
  assert.equal(cfg.dataMode, 'production');
  assert.equal(cfg.dispatchMode, 'dry_run');
});

test('config: the LLM model must be configured whenever the LLM will actually be called', function () {
  assert.doesNotThrow(function () { config.parseConfig({}); }, 'dry run without LLM needs no model');
  assert.throws(function () { config.parseConfig({ LLM_IN_DRY_RUN: 'true' }); }, /OPENAI_MODEL/);
  assert.throws(function () { config.parseConfig({ DRY_RUN: 'false', OPENAI_MODEL: 'REPLACE_WITH_OPENAI_MODEL' }); }, /OPENAI_MODEL/);
  assert.doesNotThrow(function () { config.parseConfig({ DRY_RUN: 'false', LLM_ENABLED: 'false' }); });
});

test('config: sandbox dispatch requires sandbox targets for each channel', function () {
  assert.throws(function () {
    config.parseConfig({ DRY_RUN: 'false', LLM_ENABLED: 'false', DISPATCH_CHANNELS: 'email', EMAIL_FROM: 'briefs@example.com' });
  }, /SANDBOX_EMAIL_RECIPIENT/);
  assert.throws(function () {
    config.parseConfig({ DRY_RUN: 'false', LLM_ENABLED: 'false', SLACK_MODE: 'bot' });
  }, /SANDBOX_SLACK_CHANNEL_ID/);
  assert.throws(function () {
    config.parseConfig({ DRY_RUN: 'false', LLM_ENABLED: 'false', DISPATCH_CHANNELS: 'email', SANDBOX_EMAIL_RECIPIENT: 'qa@example.com' });
  }, /EMAIL_FROM/);
});

test('config: loadConfig refuses placeholder secrets for the channels that will run', function () {
  assert.throws(function () {
    config.loadConfig({ DRY_RUN: 'false', LLM_ENABLED: 'false', SANDBOX_SLACK_WEBHOOK_URL: 'REPLACE_WITH_SANDBOX_SLACK_WEBHOOK_URL' });
  }, /SANDBOX_SLACK_WEBHOOK_URL/);
  assert.throws(function () {
    config.loadConfig({ DRY_RUN: 'false', OPENAI_MODEL: 'test-model', OPENAI_API_KEY: 'REPLACE_WITH_OPENAI_API_KEY', SANDBOX_SLACK_WEBHOOK_URL: 'https://hooks.example.com/sandbox' });
  }, /OPENAI_API_KEY/);
  const cfg = config.loadConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'prod-token', HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN: 'sbx-token' });
  assert.equal(cfg.hubspotToken, 'sbx-token', 'sandbox mode never reads the production token');
  assert.equal(config.describeConfig(cfg).hubspotToken, '[redacted]');
});

test('config: values are validated', function () {
  assert.throws(function () { config.parseConfig({ LEAD_MINUTES: '2' }); }, /LEAD_MINUTES/);
  assert.throws(function () { config.parseConfig({ BRIEF_TIMEZONE: 'Mars/Olympus' }); }, /BRIEF_TIMEZONE/);
  assert.throws(function () { config.parseConfig({ CURRENCY_CODE: 'DOLLARS' }); }, /CURRENCY_CODE/);
  assert.throws(function () { config.parseConfig({ DISPATCH_CHANNELS: 'slack,sms' }); }, /DISPATCH_CHANNELS/);
  assert.throws(function () { config.parseConfig({ TECH_STACK_PROPERTIES: 'tech stack' }); }, /TECH_STACK_PROPERTIES/);
  assert.throws(function () { config.parseConfig({ OPENAI_BASE_URL: 'http://llm.example.com' }); }, /https/);
});

test('config: HubSpot read gate allows only sandbox or developer test portals in sandbox mode', function () {
  const cfg = config.parseConfig({});
  assert.equal(config.evaluateHubSpotTarget(cfg, { accountType: 'STANDARD', portalId: 1001 }).allowed, false);
  assert.equal(config.evaluateHubSpotTarget(cfg, { accountType: 'SANDBOX', portalId: 1001 }).allowed, true);
  assert.equal(config.evaluateHubSpotTarget(cfg, { accountType: 'DEVELOPER_TEST', portalId: 1001 }).allowed, true);
  const pinned = config.parseConfig({ HUBSPOT_SANDBOX_PORTAL_ID: '2002' });
  assert.equal(config.evaluateHubSpotTarget(pinned, { accountType: 'SANDBOX', portalId: 1001 }).reason, 'sandbox_portal_id_mismatch');
});

test('config: dispatch targets are previews in dry run, redirected in sandbox, real in production', function () {
  const rep = { email: 'jamie.cole@example.com' };
  const dry = config.resolveDispatchTarget(config.parseConfig({ DISPATCH_CHANNELS: 'email', SANDBOX_EMAIL_RECIPIENT: 'qa@example.com' }), 'email', rep);
  assert.deepEqual([dry.allowed, dry.target.email, dry.reason], [false, 'qa@example.com', 'dry_run_enabled']);
  const sbx = config.parseConfig({ DRY_RUN: 'false', LLM_ENABLED: 'false', DISPATCH_CHANNELS: 'email', SANDBOX_EMAIL_RECIPIENT: 'qa@example.com', EMAIL_FROM: 'briefs@example.com' });
  assert.deepEqual([config.resolveDispatchTarget(sbx, 'email', rep).allowed, config.resolveDispatchTarget(sbx, 'email', rep).target.email], [true, 'qa@example.com']);
  const prod = config.parseConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'false', ALLOW_PRODUCTION_MODE: 'true', LLM_ENABLED: 'false', SLACK_MODE: 'bot' });
  const bot = config.resolveDispatchTarget(prod, 'slack_bot', rep);
  assert.deepEqual([bot.allowed, bot.target.needsLookup, bot.target.lookupEmail], [true, true, 'jamie.cole@example.com']);
  assert.equal(config.resolveDispatchTarget(prod, 'slack_bot', null).reason, 'no_recipient_resolved');
});

// ---------------------------------------------------------------------------
// 2. Calendar
// ---------------------------------------------------------------------------

test('calendar: fixture selection matches the documented expectations', function () {
  const selection = calendar.selectMeetingsToBrief(events(), selectOptions(cfgFrom()));
  assert.deepEqual(selection.selected.map(function (m) { return m.key; }), FIXTURE._meta.expected.selected);
  const reasons = {};
  selection.skipped.forEach(function (s) { reasons[s.eventId] = s.reason; });
  assert.deepEqual(reasons, FIXTURE._meta.expected.skipped_reasons);
});

test('calendar: external attendees exclude internal, declined, and resource calendars', function () {
  const meeting = selectedMeeting();
  assert.deepEqual(meeting.externalAttendees.map(function (a) { return a.email; }), ['priya.shah@example.org', 'lee.wong@example.org']);
  assert.deepEqual(meeting.internalAttendees.map(function (a) { return a.email; }), ['jamie.cole@example.com']);
  assert.equal(meeting.minutesUntilStart, 30);
  assert.equal(meeting.conferenceUrl, 'https://meet.example.com/abc-defg-hij');
});

test('calendar: Outlook local times convert through IANA zones, including DST', function () {
  assert.equal(calendar.zonedDateTimeToIso('2026-11-16T09:59:00.0000000', 'America/New_York'), '2026-11-16T14:59:00.000Z');
  assert.equal(calendar.zonedDateTimeToIso('2026-07-01T09:00:00', 'America/New_York'), '2026-07-01T13:00:00.000Z');
  assert.equal(calendar.zonedDateTimeToIso('2026-11-16T15:00:00', 'UTC'), '2026-11-16T15:00:00.000Z');
  assert.equal(calendar.zonedDateTimeToIso('2026-11-16T15:00:00', 'Pacific Standard Time'), null, 'Windows zone names are rejected, not guessed');
});

test('calendar: internal domains fall back to the organizer domain when unset', function () {
  const selection = calendar.selectMeetingsToBrief(events(), selectOptions(cfgFrom({ INTERNAL_DOMAINS: '' })));
  assert.equal(selection.selected.length, 1);
  assert.deepEqual(selection.selected[0].internalDomains, ['example.com']);
});

test('calendar: already-briefed meetings are skipped and stale keys are pruned', function () {
  const key = FIXTURE._meta.expected.selected[0];
  const selection = calendar.selectMeetingsToBrief(events(), selectOptions(cfgFrom(), { briefedKeys: { [key]: NOW.toISOString() } }));
  assert.equal(selection.selected.length, 0);
  assert.ok(selection.skipped.some(function (s) { return s.reason === 'already_briefed'; }));
  const pruned = calendar.pruneBriefedKeys({ old: '2026-11-10T00:00:00Z', fresh: '2026-11-16T10:00:00Z' }, NOW);
  assert.deepEqual(Object.keys(pruned), ['fresh']);
});

test('calendar: a rescheduled meeting gets a new key and a new brief', function () {
  const moved = events();
  moved[0].start.dateTime = '2026-11-16T15:01:00Z';
  const key = FIXTURE._meta.expected.selected[0];
  const selection = calendar.selectMeetingsToBrief(moved, selectOptions(cfgFrom(), { briefedKeys: { [key]: NOW.toISOString() } }));
  assert.equal(selection.selected.length, 1);
});

test('calendar: private events and invalid events are skipped with reasons', function () {
  const list = events();
  list[0].visibility = 'private';
  list.push({ kind: 'calendar#event', summary: 'No id', start: { dateTime: '2026-11-16T15:00:00Z' } });
  const selection = calendar.selectMeetingsToBrief(list, selectOptions(cfgFrom()));
  const reasons = selection.skipped.map(function (s) { return s.reason; });
  assert.ok(reasons.includes('private_event'));
  assert.ok(reasons.includes('event_id_missing'));
  const allowPrivate = calendar.selectMeetingsToBrief(list, selectOptions(cfgFrom(), { skipPrivateEvents: false }));
  assert.equal(allowPrivate.selected.length, 1);
});

// ---------------------------------------------------------------------------
// 3. HubSpot enrichment
// ---------------------------------------------------------------------------

test('fetcher: stage order puts the account gate first', function () {
  assert.equal(fetcher.HUBSPOT_STAGES[0], 'account');
  assert.equal(new Set(fetcher.HUBSPOT_STAGES).size, fetcher.HUBSPOT_STAGES.length);
});

test('fetcher: contact search uses the documented endpoint and an IN filter on attendee emails', function () {
  const cfg = cfgFrom();
  const state = fetcher.createFetchState(selectedMeeting(cfg), cfg);
  const request = fetcher.planStage('contacts', state, cfg);
  assert.equal(request.path, '/crm/v3/objects/contacts/search');
  assert.deepEqual(request.body.filterGroups[0].filters[0], { propertyName: 'email', operator: 'IN', values: ['priya.shah@example.org', 'lee.wong@example.org'] });
  assert.equal(fetcher.planStage('companies', state, cfg), null, 'nothing to batch-read before companies are known');
});

test('fetcher: mock HubSpot responses become a complete dossier', async function () {
  const dossier = await fixtureDossier();
  assert.deepEqual(dossier.portal, { portalId: 1001, accountType: 'DEVELOPER_TEST' });
  const priya = dossier.attendees.find(function (a) { return a.email === 'priya.shah@example.org'; });
  assert.deepEqual([priya.name, priya.jobTitle, priya.company, priya.inCrm, priya.timesContacted], ['Priya Shah', 'VP Revenue Operations', 'Example Org', true, 7]);
  assert.equal(dossier.attendees.find(function (a) { return a.email === 'lee.wong@example.org'; }).inCrm, false);

  const company = dossier.companies[0];
  assert.deepEqual([company.name, company.industry, company.employees, company.location], ['Example Org', 'Computer software', 850, 'Austin, United States']);
  assert.equal(company.techStack[0].value, 'HubSpot, Snowflake, Segment, Zendesk', 'multi-select checkboxes are split');
  assert.match(company.techStack[1].value, /reverse-ETL tool in Q1; legacy/, 'free-text notes keep their semicolons');

  assert.deepEqual(dossier.deals.map(function (d) { return d.id; }), ['3003', '3004'], 'open deal first, recent closed-lost kept, old won deal dropped');
  assert.equal(dossier.deals[0].stage, 'Decision Maker Bought-In');
  assert.equal(dossier.deals[0].pipeline, 'Sales Pipeline');
  assert.equal(dossier.deals[0].notes.length, 2);
  assert.equal(dossier.deals[0].notes[0].text.indexOf('<'), -1, 'note HTML is stripped');
  assert.match(dossier.deals[0].notes[1].text, /manual lead routing & duplicate records/);

  assert.deepEqual(dossier.pipeline, { openDealCount: 1, openPipelineValue: 48000, currency: 'USD', mixedCurrencies: false, dealsWithoutAmount: 0 });
  assert.deepEqual(dossier.tickets.map(function (t) { return [t.id, t.stage, t.priority]; }), [['5001', 'Waiting on us', 'HIGH']]);
  assert.deepEqual(dossier.assignedRep, { email: 'jamie.cole@example.com', name: 'Jamie Cole', source: 'deal_owner' });
  assert.deepEqual(dossier.dataGaps, []);
});

test('fetcher: the account gate blocks a STANDARD portal before any CRM data is read', async function () {
  const cfg = cfgFrom();
  const client = recordingFixtureClient({ 'GET /account-info/v3/details': { statusCode: 200, body: { portalId: 1001, accountType: 'STANDARD' } } });
  await assert.rejects(engine.runHubSpotEnrichment(selectedMeeting(cfg), cfg, client), /HubSpot read blocked by gate/);
  assert.deepEqual(client.calls.map(function (c) { return c.path; }), ['/account-info/v3/details']);
  const failing = recordingFixtureClient({ 'GET /account-info/v3/details': { statusCode: 401, body: {} } });
  await assert.rejects(engine.runHubSpotEnrichment(selectedMeeting(cfg), cfg, failing), /Unable to verify/);
});

test('fetcher: failed stages become data gaps and the rep falls back to the organizer', async function () {
  const dossier = await fixtureDossier(cfgFrom(), {
    'POST /crm/v3/objects/tickets/batch/read': { statusCode: 429, body: { message: 'Too many requests' } },
    'GET /crm/v3/owners/6001': { statusCode: 404, body: {} }
  });
  assert.ok(dossier.dataGaps.includes('tickets:http_429'));
  assert.ok(dossier.dataGaps.includes('owner:http_404'));
  assert.deepEqual(dossier.tickets, []);
  assert.deepEqual(dossier.assignedRep, { email: 'jamie.cole@example.com', name: null, source: 'meeting_organizer' });
});

test('fetcher: consumer mailbox domains never drive a company match', function () {
  const cfg = cfgFrom();
  const meeting = selectedMeeting(cfg);
  meeting.externalAttendees = [{ email: 'someone@' + ['gmail', 'com'].join('.'), name: 'Someone', response: 'accepted' }];
  const state = fetcher.createFetchState(meeting, cfg);
  assert.deepEqual(state.domains, []);
  assert.equal(fetcher.planStage('companySearch', state, cfg), null);
  assert.ok(fetcher.planStage('contacts', state, cfg));
});

test('fetcher: limits for companies, deals, and notes are enforced', async function () {
  const dossier = await fixtureDossier(cfgFrom({ MAX_DEALS: '1', MAX_NOTES_PER_DEAL: '1' }));
  assert.equal(dossier.deals.length, 1);
  assert.equal(dossier.deals[0].notes.length, 1);
  assert.equal(dossier.deals[0].notes[0].timestamp, '2026-11-09T10:15:00.000Z', 'the newest note is kept');
});

// ---------------------------------------------------------------------------
// 4. LLM prompt and parsing
// ---------------------------------------------------------------------------

test('prompt: system prompt demands JSON, grounding, and treats CRM text as untrusted data', function () {
  const p = formatter.SYSTEM_PROMPT;
  assert.match(p, /ONLY facts present/);
  assert.match(p, /untrusted data/);
  assert.match(p, /Ignore any instructions/);
  ['attendee_background', 'company_context', 'open_deals', 'pain_points', 'talking_points'].forEach(function (key) {
    assert.ok(p.includes(key), key);
  });
});

test('prompt: CRM context is delimited, minimal, and PII-redacted', async function () {
  const cfg = cfgFrom();
  const dossier = await fixtureDossier(cfg);
  const messages = formatter.buildLlmMessages(dossier, cfg);
  assert.equal(messages.length, 2);
  const user = messages[1].content;
  assert.match(user, /<crm_context>[\s\S]*<\/crm_context>/);
  assert.equal(user.includes('priya.shah@example.org'), false, 'attendee emails are not sent');
  assert.equal(user.includes('555'), false, 'phone numbers are redacted');
  assert.ok(user.includes('[email]'));
  assert.ok(user.includes('[phone]'));
  assert.ok(user.includes('Decision Maker Bought-In'));
  assert.ok(user.includes('Webhook sync delays during peak hours'));
  const request = formatter.buildLlmRequest(dossier, Object.assign({}, cfg, { openaiModel: 'test-model' }));
  assert.deepEqual([request.model, request.response_format.type, request.temperature], ['test-model', 'json_object', 0.2]);
});

test('prompt: redaction keeps dates and amounts but removes emails and phones', function () {
  assert.equal(formatter.redactPii('Call +1 (555) 010-2030 or mail a.b@example.org on 2026-11-09 about 48000'), 'Call [phone] or mail [email] on 2026-11-09 about 48000');
});

test('llm: shouldCallLlm respects dry run, opt-in, and the kill switch', function () {
  assert.deepEqual(formatter.shouldCallLlm(cfgFrom()), { call: false, reason: 'llm_skipped_in_dry_run' });
  assert.equal(formatter.shouldCallLlm(cfgFrom({ LLM_IN_DRY_RUN: 'true', OPENAI_MODEL: 'test-model' })).call, true);
  assert.deepEqual(formatter.shouldCallLlm(cfgFrom({ LLM_ENABLED: 'false' })), { call: false, reason: 'llm_disabled' });
});

test('llm: a valid JSON response is parsed and sanitized', function () {
  const result = formatter.parseLlmResponse(FIXTURE.llm_mock_response.statusCode, FIXTURE.llm_mock_response.body);
  assert.equal(result.ok, true);
  assert.equal(result.brief.pain_points.length, 3);
  assert.equal(result.brief.talking_points.length, 3);
  result.brief.talking_points.forEach(function (t) { assert.ok(t.length <= 240); });
});

test('llm: bad responses fall back cleanly', function () {
  const wrap = function (content) { return { choices: [{ message: { content: content } }] }; };
  assert.equal(formatter.parseLlmResponse(500, {}).reason, 'llm_http_500');
  assert.equal(formatter.parseLlmResponse(200, wrap('not json')).reason, 'llm_response_not_json');
  assert.equal(formatter.parseLlmResponse(200, wrap('[]')).reason, 'llm_response_not_an_object');
  assert.equal(formatter.parseLlmResponse(200, wrap('{"talking_points":["x"]}')).reason, 'llm_response_missing_sections');
  assert.equal(formatter.parseLlmResponse(200, { choices: [] }).reason, 'llm_empty_response');
  const fenced = formatter.parseLlmResponse(200, wrap('```json\n{"attendee_background":["a"],"company_context":["b"],"open_deals":["c"]}\n```'));
  assert.equal(fenced.ok, true);
  assert.deepEqual(fenced.brief.talking_points, ['Not recorded in CRM']);
});

test('fallback: deterministic brief uses CRM facts only', async function () {
  const cfg = cfgFrom();
  const brief = formatter.buildFallbackBrief(await fixtureDossier(cfg), cfg);
  assert.match(brief.attendee_background[0], /Priya Shah, VP Revenue Operations, Example Org \(last contacted Nov 2, 2026\)/);
  assert.match(brief.attendee_background[1], /Lee Wong \(not in CRM yet\)/);
  assert.match(brief.open_deals[0], /Platform Expansion — Decision Maker Bought-In — \$48,000 — closes Dec 15, 2026/);
  assert.match(brief.pain_points[0], /Webhook sync delays during peak hours \(high priority\)/);
  assert.match(brief.talking_points[0], /Security review sign-off/);
  assert.equal(brief.company_context[0].includes('..'), false);
});

// ---------------------------------------------------------------------------
// 5. Formatting
// ---------------------------------------------------------------------------

async function composedBrief(useLlm, env) {
  const cfg = cfgFrom(env);
  const dossier = await fixtureDossier(cfg);
  const llm = useLlm ? formatter.parseLlmResponse(200, FIXTURE.llm_mock_response.body) : { ok: false, reason: 'llm_skipped_in_dry_run' };
  return { cfg: cfg, dossier: dossier, composed: formatter.composeBrief(dossier, cfg, llm) };
}

test('slack: Block Kit payload is well-formed and within Slack limits', async function () {
  const { composed } = await composedBrief(true);
  const payload = formatter.formatSlackPayload(composed.brief, composed.facts, { sandbox: true, source: composed.source, intendedRecipient: 'jamie.cole@example.com' });
  assert.ok(payload.text.startsWith('[SANDBOX] Pre-brief:'));
  assert.ok(payload.blocks.length <= 50);
  assert.equal(payload.blocks[0].type, 'header');
  assert.ok(payload.blocks[0].text.text.length <= 150);
  assert.equal(payload.unfurl_links, false);
  const sections = payload.blocks.filter(function (b) { return b.type === 'section' && b.text; });
  assert.deepEqual(sections.map(function (b) { return b.text.text.split('\n')[0]; }), ['*Attendee background*', '*Company context*', '*Open deals & pipeline*', '*Potential pain points*', '*Suggested talking points*']);
  sections.forEach(function (b) { assert.ok(b.text.text.length <= 3000); });
  const all = JSON.stringify(payload);
  assert.equal(all.includes('<!channel>'), false, 'LLM output cannot ping the channel');
  assert.ok(all.includes('&lt;!channel&gt;'));
  assert.match(payload.blocks[2].fields[1].text, /\*Pipeline\*\n1 open deal · \$48,000/);
  assert.match(all, /Would have gone to: jamie.cole@example.com/);
});

test('email: HTML is escaped, subject is single-line, and plain text is included', async function () {
  const { composed } = await composedBrief(false);
  composed.facts.title = 'Review <script>alert(1)</script>\r\nBcc: someone@example.net';
  const email = formatter.formatEmail(composed.brief, composed.facts, { sandbox: false, source: composed.source });
  assert.equal(/[\r\n]/.test(email.subject), false);
  assert.equal(email.html.includes('<script>'), false);
  assert.ok(email.html.includes('&lt;script&gt;'));
  assert.ok(email.html.includes('<h3 style="margin:12px 0 4px">Suggested talking points</h3>'));
  assert.match(email.text, /^# Pre-brief:/);
});

test('markdown: renders every section and the data-source footer', async function () {
  const { composed } = await composedBrief(false);
  const md = formatter.formatMarkdown(composed.brief, composed.facts, { sandbox: false, source: composed.source });
  ['## Attendees', '## Attendee background', '## Company context', '## Open deals & pipeline', '## Potential pain points', '## Suggested talking points'].forEach(function (h) {
    assert.ok(md.includes(h), h);
  });
  assert.match(md, /Built directly from HubSpot data \(llm_skipped_in_dry_run\)/);
});

test('dispatch plan: one entry per channel, gated by mode', async function () {
  const { cfg, dossier, composed } = await composedBrief(false, { DISPATCH_CHANNELS: 'slack,email', SANDBOX_EMAIL_RECIPIENT: 'qa@example.com' });
  const plan = formatter.buildDispatchPlan(dossier, cfg, composed);
  assert.deepEqual(plan.map(function (d) { return [d.channel, d.allowed]; }), [['slack_webhook', false], ['email', false]]);
  assert.equal(plan[1].target.email, 'qa@example.com');
  assert.ok(plan[1].payload.subject.startsWith('[SANDBOX] [Pre-brief]'));
});

// ---------------------------------------------------------------------------
// 6. Engine end-to-end
// ---------------------------------------------------------------------------

function recordingFetch(handler) {
  const calls = [];
  const fn = async function (url, init) {
    calls.push({ url: url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const out = handler(url, init) || { status: 404, body: {} };
    return { status: out.status, headers: { get: function () { return null; } }, text: async function () { return JSON.stringify(out.body); } };
  };
  fn.calls = calls;
  return fn;
}

test('engine: default dry run calls no LLM and dispatches nothing', async function () {
  const fetchImpl = recordingFetch(function () { return { status: 500, body: {} }; });
  const cfg = config.loadConfig(BASE_ENV);
  const out = await engine.processEvents(events(), { config: cfg, hubspotClient: recordingFixtureClient(), fetchImpl: fetchImpl, now: function () { return NOW; } });
  assert.equal(fetchImpl.calls.length, 0, 'no network calls outside HubSpot');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].status, 'dry_run');
  assert.equal(out.results[0].briefSource, 'fallback:llm_skipped_in_dry_run');
  assert.equal(out.results[0].dispatches[0].status, 'preview');
});

test('engine: sandbox run calls the LLM and redirects Slack to the sandbox webhook', async function () {
  const fetchImpl = recordingFetch(function (url) {
    if (url === 'https://llm.example.com/v1/chat/completions') return plain({ status: 200, body: FIXTURE.llm_mock_response.body });
    if (url === 'https://hooks.example.com/sandbox') return { status: 200, body: 'ok' };
    return null;
  });
  const cfg = config.loadConfig(Object.assign({}, BASE_ENV, {
    DRY_RUN: 'false', OPENAI_MODEL: 'test-model', OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://llm.example.com/v1',
    SANDBOX_SLACK_WEBHOOK_URL: 'https://hooks.example.com/sandbox', SLACK_WEBHOOK_URL: 'https://hooks.example.com/production'
  }));
  const store = engine.createStateStore(null);
  const deps = { config: cfg, hubspotClient: recordingFixtureClient(), fetchImpl: fetchImpl, stateStore: store, now: function () { return NOW; } };
  const out = await engine.processEvents(events(), deps);
  assert.equal(out.results[0].status, 'sent');
  assert.equal(out.results[0].briefSource, 'llm');
  const urls = fetchImpl.calls.map(function (c) { return c.url; });
  assert.deepEqual(urls, ['https://llm.example.com/v1/chat/completions', 'https://hooks.example.com/sandbox']);
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer test-key');
  assert.ok(fetchImpl.calls[1].body.text.startsWith('[SANDBOX]'));

  const again = await engine.processEvents(events(), deps);
  assert.equal(again.results.length, 0, 'the same meeting is never briefed twice');
});

test('engine: an LLM failure still sends the deterministic brief', async function () {
  const fetchImpl = recordingFetch(function (url) {
    if (/chat\/completions$/.test(url)) return { status: 400, body: { error: { message: 'bad request' } } };
    return { status: 200, body: 'ok' };
  });
  const cfg = config.loadConfig(Object.assign({}, BASE_ENV, {
    DRY_RUN: 'false', OPENAI_MODEL: 'test-model', OPENAI_API_KEY: 'test-key', SANDBOX_SLACK_WEBHOOK_URL: 'https://hooks.example.com/sandbox'
  }));
  const out = await engine.processEvents(events(), { config: cfg, hubspotClient: recordingFixtureClient(), fetchImpl: fetchImpl, now: function () { return NOW; } });
  assert.equal(out.results[0].status, 'sent');
  assert.equal(out.results[0].briefSource, 'fallback:llm_http_400');
});

test('engine: production Slack bot mode looks up the rep and DMs them', async function () {
  const fetchImpl = recordingFetch(function (url) {
    if (url.indexOf('https://slack.com/api/users.lookupByEmail?email=jamie.cole%40example.com') === 0) return { status: 200, body: { ok: true, user: { id: 'U1001' } } };
    if (url === 'https://slack.com/api/chat.postMessage') return { status: 200, body: { ok: true, ts: '1.2' } };
    return null;
  });
  const cfg = config.loadConfig(Object.assign({}, BASE_ENV, {
    DRY_RUN: 'false', SANDBOX_MODE: 'false', ALLOW_PRODUCTION_MODE: 'true', LLM_ENABLED: 'false', SLACK_MODE: 'bot', SLACK_BOT_TOKEN: 'test-bot'
  }));
  const client = recordingFixtureClient({ 'GET /account-info/v3/details': { statusCode: 200, body: { portalId: 1001, accountType: 'STANDARD' } } });
  const out = await engine.processEvents(events(), { config: cfg, hubspotClient: client, fetchImpl: fetchImpl, now: function () { return NOW; } });
  assert.equal(out.results[0].status, 'sent');
  const post = fetchImpl.calls.find(function (c) { return /chat.postMessage$/.test(c.url); });
  assert.equal(post.body.channel, 'U1001');
  assert.equal(post.body.text.startsWith('[SANDBOX]'), false);
});

test('engine: missing HubSpot token is a per-meeting error, never a silent skip', async function () {
  const out = await engine.processEvents(events(), { config: config.loadConfig(BASE_ENV), now: function () { return NOW; } });
  assert.equal(out.results[0].status, 'error');
  assert.match(out.results[0].error, /HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN/);
});

test('email: MIME builder rejects header injection and encodes non-ASCII subjects', function () {
  assert.throws(function () {
    engine.buildMimeMessage({ from: 'briefs@example.com', to: 'rep@example.com\r\nBcc: x@example.net', subject: 's', text: 't', html: 'h' });
  }, /line break/);
  const mime = engine.buildMimeMessage({ from: 'briefs@example.com', to: 'rep@example.com', subject: 'Pre-brief · Café', text: 'hello', html: '<p>hello</p>' });
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.match(mime, /multipart\/alternative/);
});

test('email: SMTP client delivers to a local relay', async function () {
  const received = [];
  const server = net.createServer(function (socket) {
    let data = false;
    let body = '';
    socket.write('220 relay.example.test ESMTP\r\n');
    socket.on('data', function (chunk) {
      const text = chunk.toString('utf8');
      if (data) {
        body += text;
        if (body.endsWith('\r\n.\r\n')) { data = false; received.push(body); socket.write('250 queued\r\n'); }
        return;
      }
      text.split('\r\n').filter(Boolean).forEach(function (line) {
        received.push(line);
        if (/^EHLO/.test(line)) socket.write('250-relay.example.test\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) socket.write('235 ok\r\n');
        else if (/^MAIL FROM/.test(line) || /^RCPT TO/.test(line)) socket.write('250 ok\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      });
    });
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  try {
    const result = await engine.sendSmtpMail({
      host: '127.0.0.1', port: server.address().port, secure: false, user: 'relay-user', password: 'relay-pass',
      from: 'briefs@example.com', to: 'qa@example.com', subject: 'Pre-brief', text: 'hello', html: '<p>hello</p>'
    });
    assert.deepEqual(result.accepted, ['qa@example.com']);
    assert.ok(received.includes('RCPT TO:<qa@example.com>'));
    assert.ok(result.transcript.includes('AUTH PLAIN [redacted]'), 'credentials never appear in the transcript');
  } finally {
    server.close();
  }
});

test('engine: calendar webhook signatures are verified in constant time', function () {
  const body = Buffer.from('{"event_id":"evt-1"}');
  const sig = crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
  assert.equal(engine.verifyWebhookSignature(body, sig, 'test-secret'), true);
  assert.equal(engine.verifyWebhookSignature(body, 'sha256=' + sig, 'test-secret'), true);
  assert.equal(engine.verifyWebhookSignature(body, sig.replace(/.$/, sig.endsWith('0') ? '1' : '0'), 'test-secret'), false);
  assert.throws(function () { engine.createWebhookServer({ config: config.loadConfig({}) }); }, /CALENDAR_WEBHOOK_SECRET/);
});

// ---------------------------------------------------------------------------
// 7. workflow.json
// ---------------------------------------------------------------------------

const WORKFLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));

function nodeByName(name) {
  const node = WORKFLOW.nodes.find(function (n) { return n.name === name; });
  assert.ok(node, 'missing node ' + name);
  return node;
}

function runCodeNode(name, context) {
  const sandbox = Object.assign({ console: console, URL: URL, Intl: Intl }, context);
  vm.createContext(sandbox);
  return plain(vm.runInContext('(function () {\n' + nodeByName(name).parameters.jsCode + '\n})()', sandbox));
}

function itemsOf(list) {
  return {
    first: function () { return { json: list[0] }; },
    all: function () { return list.map(function (j) { return { json: j }; }); },
    item: { json: list[0] }
  };
}

function refs(outputs) {
  return function (name) {
    if (!(name in outputs)) throw new Error('Unexpected node reference ' + name);
    return itemsOf([outputs[name]]);
  };
}

function runSelectNode(env, staticData) {
  const store = staticData || {};
  return runCodeNode(builder.SELECT_NODE, {
    $env: env,
    $input: itemsOf([{ body: { events: events() } }]),
    $getWorkflowStaticData: function () { return store; },
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [NOW.getTime()])); } static now() { return NOW.getTime(); } }
  });
}

function simulateN8nEnrichment(selectItem, responses) {
  let prevOut = selectItem;
  let inbound = selectItem;
  let prevName = builder.SELECT_NODE;
  fetcher.HUBSPOT_STAGES.forEach(function (stage, index) {
    const names = builder.stageNames(index, stage);
    const out = runCodeNode(names.plan, { $input: itemsOf([inbound]), $: refs({ [prevName]: prevOut }) }).json;
    inbound = out.call ? plain(responses[out.request.method + ' ' + out.request.path] || { statusCode: 404, body: {} }) : out;
    prevOut = out;
    prevName = names.plan;
  });
  return runCodeNode(builder.DOSSIER_NODE, { $input: itemsOf([inbound]), $: refs({ [prevName]: prevOut }) }).json;
}

test('workflow: is valid, inactive, and in sync with src/', function () {
  assert.equal(WORKFLOW.active, false);
  assert.equal(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'), builder.render(), 'run npm run build:workflow');
  const names = WORKFLOW.nodes.map(function (n) { return n.name; });
  assert.equal(new Set(names).size, names.length);
  Object.keys(WORKFLOW.connections).forEach(function (source) {
    assert.ok(names.includes(source), source);
    WORKFLOW.connections[source].main.forEach(function (branch) { branch.forEach(function (e) { assert.ok(names.includes(e.node), e.node); }); });
  });
  ['Every 5 Minutes', 'Calendar Webhook', 'Google Calendar: Upcoming Events', 'OpenAI: Chat Completion', 'Slack: Incoming Webhook', 'Slack: chat.postMessage', 'Email: Send Brief (SMTP)'].forEach(nodeByName);
});

test('workflow: credentials are placeholders only and the webhook requires header auth', function () {
  WORKFLOW.nodes.forEach(function (node) {
    Object.values(node.credentials || {}).forEach(function (c) { assert.match(c.id, /^REPLACE_WITH_/, node.name); });
  });
  assert.equal(nodeByName('Calendar Webhook').parameters.authentication, 'headerAuth');
  assert.match(nodeByName('Slack: Incoming Webhook').parameters.url, /\$json\.sandbox \? \$env\.SANDBOX_SLACK_WEBHOOK_URL : \$env\.SLACK_WEBHOOK_URL/);
});

test('workflow: select node defaults to DRY_RUN and SANDBOX_MODE, even with env access blocked', function () {
  const open = runSelectNode({});
  assert.equal(open.length, 1);
  assert.equal(open[0].json.config.dispatchMode, 'dry_run');
  assert.equal(open[0].json.config.dataMode, 'sandbox');
  const blocked = new Proxy({}, { get: function () { throw new Error('access to env vars denied'); } });
  assert.equal(runSelectNode(blocked)[0].json.config.dispatchMode, 'dry_run');
  assert.throws(function () { runSelectNode({ SANDBOX_MODE: 'false' }); }, /ALLOW_PRODUCTION_MODE/);
});

test('workflow: select node matches src/calendar.js and only records briefs outside dry run', function () {
  const store = {};
  const out = runSelectNode({ INTERNAL_DOMAINS: 'example.com' }, store);
  const expected = calendar.selectMeetingsToBrief(events(), selectOptions(cfgFrom()));
  assert.deepEqual(out[0].json.meeting, plain(expected.selected[0]));
  assert.deepEqual(plain(store.briefed), {}, 'dry run never consumes a meeting');
  const live = {};
  runSelectNode({ INTERNAL_DOMAINS: 'example.com', DRY_RUN: 'false', LLM_ENABLED: 'false' }, live);
  assert.deepEqual(Object.keys(live.briefed), FIXTURE._meta.expected.selected);
  assert.equal(runSelectNode({ INTERNAL_DOMAINS: 'example.com', DRY_RUN: 'false', LLM_ENABLED: 'false' }, live).length, 0);
});

test('workflow: the n8n HubSpot stage chain produces the same dossier as src/', async function () {
  const selectItem = runSelectNode({ INTERNAL_DOMAINS: 'example.com' })[0].json;
  const n8n = simulateN8nEnrichment(selectItem, FIXTURE.hubspot_mock_responses);
  const expected = await fixtureDossier(cfgFrom());
  assert.deepEqual(n8n.dossier, plain(expected));
  assert.deepEqual(n8n.llm, { call: false, skipReason: 'llm_skipped_in_dry_run', request: null });
  const blocked = plain(FIXTURE.hubspot_mock_responses);
  blocked['GET /account-info/v3/details'].body.accountType = 'STANDARD';
  assert.throws(function () { simulateN8nEnrichment(selectItem, blocked); }, /HubSpot read blocked by gate/);
});

test('workflow: compose node matches src/ for both the LLM and fallback paths', async function () {
  const cfg = cfgFrom({ OPENAI_MODEL: 'test-model', LLM_IN_DRY_RUN: 'true' });
  const dossier = await fixtureDossier(cfg);
  const base = { config: cfg, dossier: plain(dossier), llm: { call: true, skipReason: null, request: {} } };
  const viaLlm = runCodeNode(builder.COMPOSE_NODE, { $input: itemsOf([plain(FIXTURE.llm_mock_response)]), $: refs({ [builder.DOSSIER_NODE]: base }) }).json;
  const expected = formatter.buildDispatchPlan(dossier, cfg, formatter.composeBrief(dossier, cfg, formatter.parseLlmResponse(200, FIXTURE.llm_mock_response.body)));
  assert.equal(viaLlm.briefSource, 'llm');
  assert.deepEqual(viaLlm.dispatches, plain(expected));
  const skippedBase = Object.assign({}, base, { llm: { call: false, skipReason: 'llm_skipped_in_dry_run', request: null } });
  const viaFallback = runCodeNode(builder.COMPOSE_NODE, { $input: itemsOf([skippedBase]), $: refs({ [builder.DOSSIER_NODE]: skippedBase }) }).json;
  assert.equal(viaFallback.briefSource, 'fallback:llm_skipped_in_dry_run');
  assert.equal(viaFallback.dispatches[0].allowed, false);
});

test('workflow: dispatch, LLM, and CRM nodes are only reachable through their gates', function () {
  const edges = [];
  Object.keys(WORKFLOW.connections).forEach(function (from) {
    WORKFLOW.connections[from].main.forEach(function (branch, out) { branch.forEach(function (e) { edges.push({ from: from, out: out, to: e.node }); }); });
  });
  function reachable(skip) {
    const starts = ['Every 5 Minutes', 'Calendar Webhook'];
    const seen = new Set(starts);
    const queue = starts.slice();
    while (queue.length) {
      const cur = queue.shift();
      edges.filter(function (e) { return e.from === cur && !skip(e); }).forEach(function (e) { if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); } });
    }
    return seen;
  }
  const dispatchNodes = ['Slack: Incoming Webhook', 'Slack: users.lookupByEmail', 'Slack: chat.postMessage', 'Email: Send Brief (SMTP)'];
  const all = reachable(function () { return false; });
  dispatchNodes.concat(['OpenAI: Chat Completion']).forEach(function (n) { assert.ok(all.has(n), n + ' is wired'); });
  const noDispatchGate = reachable(function (e) { return e.from === 'Dispatch Enabled?' && e.out === 0; });
  dispatchNodes.forEach(function (n) { assert.equal(noDispatchGate.has(n), false, n + ' bypasses Dispatch Enabled?'); });
  assert.equal(reachable(function (e) { return e.from === 'Call LLM?' && e.out === 0; }).has('OpenAI: Chat Completion'), false);

  const firstStage = builder.stageNames(0, 'account');
  const secondPlan = builder.stageNames(1, 'contacts').plan;
  const crmNodes = WORKFLOW.nodes.filter(function (n) { return n.credentials && n.credentials.hubspotAppToken && n.name !== firstStage.http; }).map(function (n) { return n.name; });
  assert.equal(crmNodes.length, fetcher.HUBSPOT_STAGES.length - 1);
  const noAccountGate = reachable(function (e) { return e.to === secondPlan; });
  crmNodes.forEach(function (n) { assert.equal(noAccountGate.has(n), false, n + ' bypasses the account gate'); });
});

// ---------------------------------------------------------------------------
// 8. Security scan
// ---------------------------------------------------------------------------

// Every non-RFC-2606 domain allowed in this repository, and why.
const DOMAIN_ALLOWLIST = {
  'dhrobinsystems.com': 'author website and contact (README author block)',
  'behance.net': 'author portfolio (README author block)',
  'linkedin.com': 'author profile (README author block)',
  'github.com': 'repository links in README and package.json',
  'hubapi.com': 'HubSpot API base URL',
  'openai.com': 'OpenAI API base URL default',
  'slack.com': 'Slack Web API endpoints',
  'googleapis.com': 'Google Calendar API endpoint',
  'google.com': 'Google Calendar resource-calendar address pattern',
  'microsoft.com': 'Microsoft Graph API endpoint',
  'gmail.com': 'consumer mailbox list (never used for company matching)',
  'googlemail.com': 'consumer mailbox list',
  'outlook.com': 'consumer mailbox list',
  'hotmail.com': 'consumer mailbox list',
  'live.com': 'consumer mailbox list',
  'msn.com': 'consumer mailbox list',
  'yahoo.com': 'consumer mailbox list',
  'icloud.com': 'consumer mailbox list',
  'me.com': 'consumer mailbox list',
  'aol.com': 'consumer mailbox list',
  'protonmail.com': 'consumer mailbox list',
  'gmx.com': 'consumer mailbox list',
  'zoho.com': 'consumer mailbox list'
};
const ALLOWED_EMAIL_DOMAINS = ['dhrobinsystems.com', 'resource.calendar.google.com'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage']);

function listRepoFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(function (entry) {
    if (SKIP_DIRS.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listRepoFiles(full) : [full];
  });
}

function isRfc2606(host) {
  return /(^|\.)example\.(com|org|net)$/.test(host) || /(^|\.)(test|example|invalid|localhost)$/.test(host);
}

function isAllowedHost(host) {
  const h = host.toLowerCase().replace(/^www\./, '');
  if (isRfc2606(h)) return true;
  return Object.keys(DOMAIN_ALLOWLIST).some(function (d) { return h === d || h.endsWith('.' + d); });
}

const SECRET_PATTERNS = [
  { name: 'private key block', re: new RegExp(['-----BEGIN', '[A-Z ]*PRIVATE KEY-----'].join(' ')) },
  { name: 'HubSpot private app token', re: /\bpat-(?:na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: 'HubSpot legacy API key', re: /hapikey=[0-9a-f]{8}-[0-9a-f]{4}-/i },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'Slack webhook URL', re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
  { name: 'Google OAuth token', re: /\bya29\.[0-9A-Za-z_-]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Stripe live key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}/ },
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'hard-coded secret assignment', re: /\b[A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD|WEBHOOK_URL)\s*[=:]\s*["']?(?!REPLACE_WITH_|https:\/\/[a-z0-9.-]*example\.(?:com|org|net)\/)[A-Za-z0-9\-_./+:]{16,}/ }
];

test('security: no real secrets, private keys, tokens, or webhook URLs in any repository file', function () {
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    SECRET_PATTERNS.forEach(function (p) { if (p.re.test(text)) findings.push(path.relative(ROOT, file) + ': ' + p.name); });
  });
  assert.deepEqual(findings, []);
});

test('security: no committed .env and .env.example holds placeholders or safe defaults only', function () {
  assert.equal(fs.existsSync(path.join(ROOT, '.env')), false);
  const lines = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n').filter(function (l) { return l.trim() && !l.trim().startsWith('#'); });
  const safe = /^(REPLACE_WITH_[A-Z0-9_]+|true|false|\d+(\.\d+)?|slack|webhook|google|UTC|USD|primary|tech_stack,tech_stack_notes|\[no brief\],\[internal\]|https:\/\/api\.hubapi\.com|https:\/\/api\.openai\.com\/v1|127\.0\.0\.1|)$/;
  lines.forEach(function (line) { assert.match(line.slice(line.indexOf('=') + 1).trim(), safe, line); });
  assert.ok(lines.includes('DRY_RUN=true'));
  assert.ok(lines.includes('SANDBOX_MODE=true'));
  assert.ok(lines.includes('ALLOW_PRODUCTION_MODE=false'));
});

test('security: only RFC 2606 domains (plus the documented allowlist) appear in any file', function () {
  const domainRe = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|co|ai|app|dev|me))\b/gi;
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = domainRe.exec(text)) !== null) {
      // A URL-encoded "@" (%40) glues "40" onto the host; strip it before checking.
      const host = text.charAt(match.index - 1) === '%' ? match[1].slice(2) : match[1];
      if (/^proton\.me$/i.test(host)) continue; // consumer mailbox list
      if (!isAllowedHost(host)) findings.push(path.relative(ROOT, file) + ': ' + host);
    }
  });
  assert.deepEqual(Array.from(new Set(findings)), []);
});

test('security: every email address uses an RFC 2606 domain or the documented author contact', function () {
  const emailRe = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = emailRe.exec(text)) !== null) {
      const domain = match[1].toLowerCase();
      if (!isRfc2606(domain) && !ALLOWED_EMAIL_DOMAINS.includes(domain)) findings.push(path.relative(ROOT, file) + ': ' + match[0]);
    }
  });
  assert.deepEqual(findings, []);
});

test('security: the scanner catches planted secrets and foreign domains', function () {
  const token = ['pat', 'na1', '12345678-1234-1234-1234-123456789abc'].join('-');
  const key = ['sk', 'proj', 'abcdefghijklmnopqrstuvwx'].join('-');
  const hook = ['hooks', 'slack', 'com/services/T0001/B0001/abcdefghij'].join('.');
  [token, key, hook].forEach(function (s) { assert.ok(SECRET_PATTERNS.some(function (p) { return p.re.test(s); }), s.slice(0, 12)); });
  assert.equal(isAllowedHost(['acme-corp', 'com'].join('.')), false);
  assert.equal(isAllowedHost('calendar.example.com'), true);
});
