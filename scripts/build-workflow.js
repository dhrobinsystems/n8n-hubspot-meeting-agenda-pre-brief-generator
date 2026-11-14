#!/usr/bin/env node
'use strict';

/**
 * build-workflow.js
 *
 * Generates workflow.json from src/ so the n8n Code nodes run the exact same
 * selection, enrichment, prompt, formatting, and gate code as the Node engine.
 *
 *   node scripts/build-workflow.js          regenerate workflow.json
 *   node scripts/build-workflow.js --check  exit 1 if workflow.json is stale
 *
 * I edit logic in src/ only, then rebuild. The parity tests fail if a Code
 * node is hand-edited.
 */

const fs = require('node:fs');
const path = require('node:path');
const { HUBSPOT_STAGES } = require('../src/hubspot-fetcher');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'workflow.json');
const SELECT_NODE = 'Select Meetings to Brief';
const DOSSIER_NODE = 'Build Dossier & LLM Request';
const COMPOSE_NODE = 'Compose Brief & Dispatch Plan';

function extractCore(relativeFile, name) {
  const source = fs.readFileSync(path.join(ROOT, relativeFile), 'utf8');
  const start = '// <n8n-core:' + name + '>';
  const end = '// </n8n-core:' + name + '>';
  const i = source.indexOf(start);
  const j = source.indexOf(end);
  if (i === -1 || j === -1 || j < i) throw new Error('Missing n8n-core:' + name + ' markers in ' + relativeFile);
  return source.slice(i, j + end.length);
}

function bodyOf(fn) {
  const text = fn.toString();
  const lines = text.slice(text.indexOf('{') + 1, text.lastIndexOf('}')).split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indent = Math.min.apply(null, lines.filter(function (l) { return l.trim(); }).map(function (l) { return l.match(/^ */)[0].length; }));
  return lines.map(function (l) { return l.slice(indent); }).join('\n');
}

/* eslint-disable no-undef */
// These functions never run in Node; their bodies become Code-node source.

function selectGlue() {
  const readEnv = (key) => {
    try {
      const value = $env[key];
      return value === undefined || value === null ? undefined : String(value);
    } catch (error) {
      return undefined; // N8N_BLOCK_ENV_ACCESS_IN_NODE=true: keep fail-safe defaults
    }
  };
  const env = {};
  for (const key of CONFIG_KEYS) env[key] = readEnv(key);
  const config = parseConfig(env);
  const now = new Date();

  const rawEvents = [];
  for (const item of $input.all()) {
    const j = item.json || {};
    if (Array.isArray(j.items)) {
      j.items.forEach((e) => rawEvents.push(Object.assign({ kind: 'calendar#event' }, e)));
    } else if (j.body !== undefined) {
      const b = j.body;
      const list = Array.isArray(b) ? b
        : (b && Array.isArray(b.events)) ? b.events
          : (b && Array.isArray(b.value)) ? b.value
            : (b && Array.isArray(b.items)) ? b.items : [b];
      list.forEach((e) => rawEvents.push(e));
    }
  }

  let store = {};
  try { store = $getWorkflowStaticData('global'); } catch (error) { store = {}; }
  const briefed = pruneBriefedKeys(store.briefed || {}, now);
  const selection = selectMeetingsToBrief(rawEvents, {
    now,
    leadMinutes: config.leadMinutes,
    pollIntervalMinutes: config.pollIntervalMinutes,
    internalDomains: config.internalDomains,
    ignoreTitleKeywords: config.ignoreTitleKeywords,
    skipPrivateEvents: config.skipPrivateEvents,
    briefedKeys: briefed
  });
  if (config.dispatchMode !== 'dry_run') {
    // At-most-once: mark before dispatch so a failing channel never repeats briefs.
    selection.selected.forEach((m) => { briefed[m.key] = now.toISOString(); });
  }
  store.briefed = briefed;
  return selection.selected.map((meeting) => ({ json: { config, meeting, fetch: createFetchState(meeting, config) } }));
}

function stageGlue() {
  const prevStage = '__PREV_STAGE__';
  // The first stage reads its direct input; later stages read the previous Plan node.
  const prev = prevStage ? $('__PREV_NODE__').item.json : $input.item.json;
  let fetch = prev.fetch;
  if (prevStage) {
    const inbound = $input.item.json;
    const skipped = inbound.fetch !== undefined && inbound.call === false;
    const response = skipped ? null
      : (inbound.error ? { statusCode: 0, body: null } : { statusCode: inbound.statusCode, body: inbound.body });
    fetch = absorbStage(prevStage, fetch, response, prev.config);
  }
  const request = planStage('__STAGE__', fetch, prev.config);
  return { json: { config: prev.config, meeting: prev.meeting, fetch, stage: '__STAGE__', request, call: Boolean(request) } };
}

function dossierGlue() {
  const prev = $('__PREV_NODE__').item.json;
  const inbound = $input.item.json;
  const skipped = inbound.fetch !== undefined && inbound.call === false;
  const response = skipped ? null
    : (inbound.error ? { statusCode: 0, body: null } : { statusCode: inbound.statusCode, body: inbound.body });
  const fetch = absorbStage('__PREV_STAGE__', prev.fetch, response, prev.config);
  const dossier = buildDossier(fetch, prev.config, prev.meeting);
  const decision = shouldCallLlm(prev.config);
  return {
    json: {
      config: prev.config,
      dossier,
      llm: { call: decision.call, skipReason: decision.reason, request: decision.call ? buildLlmRequest(dossier, prev.config) : null }
    }
  };
}

function composeGlue() {
  const base = $('Build Dossier & LLM Request').item.json;
  const inbound = $input.item.json;
  let llmResult;
  if (!base.llm.call) llmResult = { ok: false, reason: base.llm.skipReason, brief: null };
  else if (inbound.error) llmResult = { ok: false, reason: 'llm_request_failed', brief: null };
  else llmResult = parseLlmResponse(inbound.statusCode, inbound.body);
  const composed = composeBrief(base.dossier, base.config, llmResult);
  const dispatches = buildDispatchPlan(base.dossier, base.config, composed);
  return {
    json: {
      meetingKey: base.dossier.meeting.key,
      dispatchMode: base.config.dispatchMode,
      briefSource: composed.source,
      assignedRep: base.dossier.assignedRep,
      dataGaps: base.dossier.dataGaps,
      dispatches
    }
  };
}

function fanOutGlue() {
  return $input.all().flatMap((item, index) => item.json.dispatches.map((d) => ({ json: d, pairedItem: { item: index } })));
}

function resolveSlackGlue() {
  const dispatch = $('Needs Slack User Lookup?').item.json;
  const lookup = $input.item.json;
  if (!lookup || !lookup.ok || !lookup.user) throw new Error('Slack users.lookupByEmail failed: ' + ((lookup && lookup.error) || 'unknown_error'));
  return { json: Object.assign({}, dispatch, { target: Object.assign({}, dispatch.target, { channel: lookup.user.id, needsLookup: false }) }) };
}
/* eslint-enable no-undef */

function codeNode(name, id, position, cores, body, mode) {
  const parameters = { jsCode: '// GENERATED by scripts/build-workflow.js from src/. Edit src/, then rebuild.\n' + cores.concat([body]).join('\n\n') + '\n' };
  if (mode === 'each') parameters.mode = 'runOnceForEachItem';
  return { parameters: parameters, id: id, name: name, type: 'n8n-nodes-base.code', typeVersion: 2, position: position };
}

function ifNode(name, id, position, condition) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [Object.assign({ id: id + '-condition' }, condition)],
        combinator: 'and'
      },
      options: {}
    },
    id: id,
    name: name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: position
  };
}

function booleanTrue(expression) {
  return { leftValue: expression, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } };
}

function credential(type, id, label) {
  const out = {};
  out[type] = { id: id, name: label };
  return out;
}

const FULL_RESPONSE = { response: { response: { fullResponse: true, neverError: true } } };
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };

function httpNode(name, id, position, params, creds, extra) {
  const node = {
    parameters: params,
    id: id,
    name: name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: position
  };
  if (creds) node.credentials = creds;
  return Object.assign(node, extra || {});
}

const HUBSPOT_CRED = credential('hubspotAppToken', 'REPLACE_WITH_N8N_HUBSPOT_CREDENTIAL_ID', 'HubSpot Sandbox Private App (REPLACE_WITH_YOUR_CREDENTIAL)');
const OPENAI_CRED = credential('openAiApi', 'REPLACE_WITH_N8N_OPENAI_CREDENTIAL_ID', 'OpenAI API (REPLACE_WITH_YOUR_CREDENTIAL)');
const SLACK_CRED = credential('slackApi', 'REPLACE_WITH_N8N_SLACK_CREDENTIAL_ID', 'Slack Bot Token (REPLACE_WITH_YOUR_CREDENTIAL)');
const SMTP_CRED = credential('smtp', 'REPLACE_WITH_N8N_SMTP_CREDENTIAL_ID', 'SMTP (REPLACE_WITH_YOUR_CREDENTIAL)');
const GCAL_CRED = credential('googleCalendarOAuth2Api', 'REPLACE_WITH_N8N_GOOGLE_CALENDAR_CREDENTIAL_ID', 'Google Calendar OAuth2 (REPLACE_WITH_YOUR_CREDENTIAL)');
const WEBHOOK_CRED = credential('httpHeaderAuth', 'REPLACE_WITH_N8N_HEADER_AUTH_CREDENTIAL_ID', 'Calendar Webhook Header Auth (REPLACE_WITH_YOUR_CREDENTIAL)');

function stageNames(index, stage) {
  return {
    plan: 'HubSpot ' + (index + 1) + ': Plan ' + stage,
    gate: 'Fetch ' + stage + '?',
    http: 'HubSpot ' + (index + 1) + ': Request ' + stage
  };
}

function buildWorkflow() {
  const configCore = extractCore('src/config.js', 'config');
  const calendarCore = extractCore('src/calendar.js', 'calendar');
  const fetcherCore = extractCore('src/hubspot-fetcher.js', 'fetcher');
  const formatterCore = extractCore('src/brief-formatter.js', 'formatter');
  let counter = 0;
  const id = function () { counter++; return '2002b000-0000-4000-8000-' + String(counter).padStart(12, '0'); };
  const nodes = [];
  const connections = {};
  const link = function (from, to, output) {
    const index = output || 0;
    connections[from] = connections[from] || { main: [] };
    while (connections[from].main.length <= index) connections[from].main.push([]);
    connections[from].main[index].push({ node: to, type: 'main', index: 0 });
  };

  nodes.push({
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } },
    id: id(), name: 'Every 5 Minutes', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 200]
  });
  nodes.push(httpNode('Google Calendar: Upcoming Events', id(), [220, 200], {
    method: 'GET',
    url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'googleCalendarOAuth2Api',
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: 'timeMin', value: '={{ new Date().toISOString() }}' },
        { name: 'timeMax', value: '={{ new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() }}' },
        { name: 'singleEvents', value: 'true' },
        { name: 'orderBy', value: 'startTime' },
        { name: 'maxResults', value: '250' }
      ]
    },
    options: {}
  }, GCAL_CRED, RETRY));
  nodes.push({
    parameters: { httpMethod: 'POST', path: 'meeting-pre-brief', authentication: 'headerAuth', responseMode: 'onReceived', options: {} },
    id: id(), name: 'Calendar Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 420],
    webhookId: '3003c000-0000-4000-8000-000000000001', credentials: WEBHOOK_CRED
  });
  nodes.push(codeNode(SELECT_NODE, id(), [440, 300], [configCore, calendarCore, fetcherCore], bodyOf(selectGlue)));
  link('Every 5 Minutes', 'Google Calendar: Upcoming Events');
  link('Google Calendar: Upcoming Events', SELECT_NODE);
  link('Calendar Webhook', SELECT_NODE);

  let previousNode = SELECT_NODE;
  let previousStage = '';
  let x = 660;
  const stageGlueBody = bodyOf(stageGlue);
  HUBSPOT_STAGES.forEach(function (stage, index) {
    const names = stageNames(index, stage);
    const body = stageGlueBody.split('__PREV_NODE__').join(previousNode).split('__PREV_STAGE__').join(previousStage).split('__STAGE__').join(stage);
    nodes.push(codeNode(names.plan, id(), [x, 300], [configCore, fetcherCore], body, 'each'));
    nodes.push(ifNode(names.gate, id(), [x + 220, 300], booleanTrue('={{ $json.call }}')));
    nodes.push(httpNode(names.http, id(), [x + 440, 160], {
      method: '={{ $json.request.method }}',
      url: '={{ $json.config.hubspotBaseUrl + $json.request.path }}',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'hubspotAppToken',
      sendBody: '={{ $json.request.method !== "GET" }}',
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.request.body || {}) }}',
      options: FULL_RESPONSE
    }, HUBSPOT_CRED, { onError: 'continueRegularOutput' }));
    if (index > 0) {
      const prior = stageNames(index - 1, HUBSPOT_STAGES[index - 1]);
      link(prior.http, names.plan);
      link(prior.gate, names.plan, 1);
    } else {
      link(SELECT_NODE, names.plan);
    }
    link(names.plan, names.gate);
    link(names.gate, names.http, 0);
    previousNode = names.plan;
    previousStage = stage;
    x += 660;
  });

  const last = stageNames(HUBSPOT_STAGES.length - 1, HUBSPOT_STAGES[HUBSPOT_STAGES.length - 1]);
  const dossierBody = bodyOf(dossierGlue).split('__PREV_NODE__').join(previousNode).split('__PREV_STAGE__').join(previousStage);
  nodes.push(codeNode(DOSSIER_NODE, id(), [x, 300], [configCore, fetcherCore, formatterCore], dossierBody, 'each'));
  link(last.http, DOSSIER_NODE);
  link(last.gate, DOSSIER_NODE, 1);

  nodes.push(ifNode('Call LLM?', id(), [x + 220, 300], booleanTrue('={{ $json.llm.call }}')));
  nodes.push(httpNode('OpenAI: Chat Completion', id(), [x + 440, 160], {
    method: 'POST',
    url: '={{ $json.config.openaiBaseUrl }}/chat/completions',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'openAiApi',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.llm.request) }}',
    options: Object.assign({ timeout: 45000 }, FULL_RESPONSE)
  }, OPENAI_CRED, { onError: 'continueRegularOutput' }));
  nodes.push(codeNode(COMPOSE_NODE, id(), [x + 660, 300], [configCore, formatterCore], bodyOf(composeGlue), 'each'));
  nodes.push(codeNode('Fan Out Dispatches', id(), [x + 880, 300], [], bodyOf(fanOutGlue)));
  nodes.push(ifNode('Dispatch Enabled?', id(), [x + 1100, 300], booleanTrue('={{ $json.allowed }}')));
  nodes.push({ parameters: {}, id: id(), name: 'Dry Run Preview (No Dispatch)', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [x + 1320, 520] });
  link(DOSSIER_NODE, 'Call LLM?');
  link('Call LLM?', 'OpenAI: Chat Completion', 0);
  link('Call LLM?', COMPOSE_NODE, 1);
  link('OpenAI: Chat Completion', COMPOSE_NODE);
  link(COMPOSE_NODE, 'Fan Out Dispatches');
  link('Fan Out Dispatches', 'Dispatch Enabled?');
  link('Dispatch Enabled?', 'Dry Run Preview (No Dispatch)', 1);

  const channelRule = function (value) {
    return {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: '={{ $json.channel }}', rightValue: value, operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and'
      },
      renameOutput: true,
      outputKey: value
    };
  };
  nodes.push({
    parameters: { rules: { values: [channelRule('slack_webhook'), channelRule('slack_bot'), channelRule('email')] }, options: {} },
    id: id(), name: 'Route by Channel', type: 'n8n-nodes-base.switch', typeVersion: 3, position: [x + 1320, 160]
  });
  link('Dispatch Enabled?', 'Route by Channel', 0);

  nodes.push(httpNode('Slack: Incoming Webhook', id(), [x + 1540, 0], {
    method: 'POST',
    url: '={{ $json.sandbox ? $env.SANDBOX_SLACK_WEBHOOK_URL : $env.SLACK_WEBHOOK_URL }}',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.payload) }}',
    options: {}
  }, null, RETRY));
  nodes.push(ifNode('Needs Slack User Lookup?', id(), [x + 1540, 160], booleanTrue('={{ $json.needsLookup }}')));
  nodes.push(httpNode('Slack: users.lookupByEmail', id(), [x + 1760, 80], {
    method: 'GET',
    url: 'https://slack.com/api/users.lookupByEmail',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'slackApi',
    sendQuery: true,
    queryParameters: { parameters: [{ name: 'email', value: '={{ $json.target.lookupEmail }}' }] },
    options: {}
  }, SLACK_CRED, RETRY));
  nodes.push(codeNode('Resolve Slack DM Channel', id(), [x + 1980, 80], [], bodyOf(resolveSlackGlue), 'each'));
  nodes.push(httpNode('Slack: chat.postMessage', id(), [x + 2200, 200], {
    method: 'POST',
    url: 'https://slack.com/api/chat.postMessage',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'slackApi',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify(Object.assign({ channel: $json.target.channel }, $json.payload)) }}',
    options: {}
  }, SLACK_CRED, RETRY));
  nodes.push({
    parameters: {
      fromEmail: '={{ $json.target.from }}',
      toEmail: '={{ $json.target.email }}',
      subject: '={{ $json.payload.subject }}',
      emailFormat: 'both',
      text: '={{ $json.payload.text }}',
      html: '={{ $json.payload.html }}',
      options: { appendAttribution: false }
    },
    id: id(), name: 'Email: Send Brief (SMTP)', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [x + 1540, 360],
    credentials: SMTP_CRED, retryOnFail: true, maxTries: 2, waitBetweenTries: 5000
  });
  link('Route by Channel', 'Slack: Incoming Webhook', 0);
  link('Route by Channel', 'Needs Slack User Lookup?', 1);
  link('Route by Channel', 'Email: Send Brief (SMTP)', 2);
  link('Needs Slack User Lookup?', 'Slack: users.lookupByEmail', 0);
  link('Needs Slack User Lookup?', 'Slack: chat.postMessage', 1);
  link('Slack: users.lookupByEmail', 'Resolve Slack DM Channel');
  link('Resolve Slack DM Channel', 'Slack: chat.postMessage');

  return {
    name: 'HubSpot Meeting Pre-Brief Generator (DRY RUN + SANDBOX by default)',
    nodes: nodes,
    connections: connections,
    active: false,
    settings: { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: []
  };
}

function render() {
  return JSON.stringify(buildWorkflow(), null, 2) + '\n';
}

if (require.main === module) {
  const output = render();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== output) {
      process.stderr.write('workflow.json is out of date. Run: npm run build:workflow\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('workflow.json is in sync with src/.\n');
    }
  } else {
    fs.writeFileSync(OUTPUT, output);
    process.stdout.write('Wrote ' + path.relative(process.cwd(), OUTPUT) + '\n');
  }
}

module.exports = { buildWorkflow, render, extractCore, bodyOf, stageNames, SELECT_NODE, DOSSIER_NODE, COMPOSE_NODE };
