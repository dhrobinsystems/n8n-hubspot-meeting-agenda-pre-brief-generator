'use strict';

/**
 * config.js
 *
 * Environment loader and safety gates for the pre-brief engine.
 *
 * Two independent safety flags, both ON by default:
 *
 *   DRY_RUN=true       No LLM request (unless LLM_IN_DRY_RUN=true) and no
 *                      Slack / email dispatch. The engine returns previews.
 *   SANDBOX_MODE=true  HubSpot is only read after the portal is verified as a
 *                      SANDBOX or DEVELOPER_TEST account, and every dispatch is
 *                      redirected to sandbox targets (a test Slack webhook or
 *                      channel, a test inbox) instead of the real rep.
 *
 * Turning SANDBOX_MODE off (production CRM data, real reps) additionally
 * requires ALLOW_PRODUCTION_MODE=true. Only the literal string "false" turns a
 * safety flag off; typos, "0", "no", and empty values keep it on.
 *
 * The n8n-core:config region is embedded verbatim into the n8n Code nodes by
 * scripts/build-workflow.js. It also holds the small shared helpers that the
 * calendar, fetcher, and formatter cores rely on, so it is always embedded first.
 */

// <n8n-core:config>
const CONFIG_KEYS = [
  'DRY_RUN',
  'SANDBOX_MODE',
  'ALLOW_PRODUCTION_MODE',
  'HUBSPOT_BASE_URL',
  'HUBSPOT_SANDBOX_PORTAL_ID',
  'CALENDAR_PROVIDER',
  'LEAD_MINUTES',
  'POLL_INTERVAL_MINUTES',
  'INTERNAL_DOMAINS',
  'IGNORE_TITLE_KEYWORDS',
  'SKIP_PRIVATE_EVENTS',
  'DISPATCH_CHANNELS',
  'SLACK_MODE',
  'SANDBOX_SLACK_CHANNEL_ID',
  'SANDBOX_EMAIL_RECIPIENT',
  'FALLBACK_RECIPIENT_EMAIL',
  'EMAIL_FROM',
  'LLM_ENABLED',
  'LLM_IN_DRY_RUN',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'LLM_TEMPERATURE',
  'LLM_MAX_TOKENS',
  'REDACT_PII_FOR_LLM',
  'RECENT_DEAL_DAYS',
  'MAX_COMPANIES',
  'MAX_DEALS',
  'MAX_NOTES_PER_DEAL',
  'MAX_TICKETS',
  'TECH_STACK_PROPERTIES',
  'CURRENCY_CODE',
  'BRIEF_TIMEZONE'
];

const SANDBOX_ACCOUNT_TYPES = ['SANDBOX', 'DEVELOPER_TEST'];
const PLACEHOLDER_PREFIX = 'REPLACE_WITH_';
const EMAIL_ADDRESS_PATTERN = /^[^\s@<>()"',;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function isPlaceholder(value) {
  if (isBlank(value)) return true;
  return String(value).trim().indexOf(PLACEHOLDER_PREFIX) === 0;
}

function clampText(value, maxLength) {
  if (isBlank(value) || typeof value === 'object') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…' : text;
}

function normalizeEmail(value) {
  if (isBlank(value) || typeof value === 'object') return null;
  const email = String(value).trim().toLowerCase().replace(/^mailto:/, '');
  return EMAIL_ADDRESS_PATTERN.test(email) && email.length <= 254 ? email : null;
}

function emailDomain(email) {
  const normalized = normalizeEmail(email);
  return normalized ? normalized.slice(normalized.indexOf('@') + 1) : null;
}

function domainMatches(host, domain) {
  return host === domain || host.slice(-(domain.length + 1)) === '.' + domain;
}

function safetyFlag(value) {
  if (value === undefined || value === null) return true;
  return String(value).trim().toLowerCase() !== 'false';
}

function optInFlag(value) {
  if (value === undefined || value === null) return false;
  return String(value).trim().toLowerCase() === 'true';
}

function boundedInt(value, fallback, min, max, name) {
  if (isBlank(value)) return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max + ' (received "' + value + '").');
  }
  return parsed;
}

function boundedNumber(value, fallback, min, max, name) {
  if (isBlank(value)) return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(name + ' must be a number between ' + min + ' and ' + max + ' (received "' + value + '").');
  }
  return parsed;
}

function csvList(value) {
  if (isBlank(value)) return [];
  return String(value).split(',').map(function (entry) { return entry.trim().toLowerCase(); }).filter(Boolean);
}

function oneOf(value, fallback, allowed, name) {
  const choice = isBlank(value) ? fallback : String(value).trim().toLowerCase();
  if (allowed.indexOf(choice) === -1) throw new Error(name + ' must be one of: ' + allowed.join(', ') + '.');
  return choice;
}

function httpsUrl(value, fallback, name) {
  const url = (isBlank(value) ? fallback : String(value).trim()).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(url)) throw new Error(name + ' must use https:// (received "' + url + '").');
  return url;
}

function optionalEmail(value, name) {
  if (isPlaceholder(value)) return null;
  const email = normalizeEmail(value);
  if (!email) throw new Error(name + ' must be a valid email address.');
  return email;
}

function parseConfig(env) {
  const e = env || {};
  const dryRun = safetyFlag(e.DRY_RUN);
  const sandboxMode = safetyFlag(e.SANDBOX_MODE);
  const allowProductionMode = optInFlag(e.ALLOW_PRODUCTION_MODE);

  if (!sandboxMode && !allowProductionMode) {
    throw new Error(
      'Refusing to start: SANDBOX_MODE=false reads production CRM data and messages real reps. ' +
      'Set ALLOW_PRODUCTION_MODE=true only after testing against a HubSpot sandbox.'
    );
  }

  const dispatchChannels = csvList(e.DISPATCH_CHANNELS);
  const channels = dispatchChannels.length ? dispatchChannels : ['slack'];
  channels.forEach(function (channel) {
    if (channel !== 'slack' && channel !== 'email') throw new Error('DISPATCH_CHANNELS may only contain slack and email.');
  });
  const slackMode = oneOf(e.SLACK_MODE, 'webhook', ['webhook', 'bot'], 'SLACK_MODE');

  const sandboxPortalRaw = isPlaceholder(e.HUBSPOT_SANDBOX_PORTAL_ID) ? null : String(e.HUBSPOT_SANDBOX_PORTAL_ID).trim();
  if (sandboxPortalRaw && !/^\d+$/.test(sandboxPortalRaw)) throw new Error('HUBSPOT_SANDBOX_PORTAL_ID must be numeric.');

  const currencyCode = isBlank(e.CURRENCY_CODE) ? 'USD' : String(e.CURRENCY_CODE).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error('CURRENCY_CODE must be a 3-letter ISO 4217 code.');

  const briefTimezone = isBlank(e.BRIEF_TIMEZONE) ? 'UTC' : String(e.BRIEF_TIMEZONE).trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: briefTimezone });
  } catch (error) {
    throw new Error('BRIEF_TIMEZONE must be a valid IANA time zone (received "' + briefTimezone + '").');
  }

  const llmEnabled = safetyFlag(e.LLM_ENABLED);
  const llmInDryRun = optInFlag(e.LLM_IN_DRY_RUN);
  const openaiModel = isPlaceholder(e.OPENAI_MODEL) ? null : String(e.OPENAI_MODEL).trim();
  if (llmEnabled && (!dryRun || llmInDryRun) && !openaiModel) {
    throw new Error('OPENAI_MODEL must be set when the LLM will be called (LLM_ENABLED=true and DRY_RUN=false or LLM_IN_DRY_RUN=true).');
  }

  const cfg = {
    dryRun: dryRun,
    sandboxMode: sandboxMode,
    allowProductionMode: allowProductionMode,
    dispatchMode: dryRun ? 'dry_run' : (sandboxMode ? 'sandbox' : 'production'),
    dataMode: sandboxMode ? 'sandbox' : 'production',
    hubspotBaseUrl: httpsUrl(e.HUBSPOT_BASE_URL, 'https://api.hubapi.com', 'HUBSPOT_BASE_URL'),
    sandboxPortalId: sandboxPortalRaw,
    calendarProvider: oneOf(e.CALENDAR_PROVIDER, 'google', ['google', 'outlook', 'webhook'], 'CALENDAR_PROVIDER'),
    leadMinutes: boundedInt(e.LEAD_MINUTES, 30, 5, 240, 'LEAD_MINUTES'),
    pollIntervalMinutes: boundedInt(e.POLL_INTERVAL_MINUTES, 5, 1, 60, 'POLL_INTERVAL_MINUTES'),
    internalDomains: csvList(e.INTERNAL_DOMAINS),
    ignoreTitleKeywords: csvList(isBlank(e.IGNORE_TITLE_KEYWORDS) ? '[no brief],[internal]' : e.IGNORE_TITLE_KEYWORDS),
    skipPrivateEvents: safetyFlag(e.SKIP_PRIVATE_EVENTS),
    dispatchChannels: channels,
    slackMode: slackMode,
    sandboxSlackChannelId: isPlaceholder(e.SANDBOX_SLACK_CHANNEL_ID) ? null : String(e.SANDBOX_SLACK_CHANNEL_ID).trim(),
    sandboxEmailRecipient: optionalEmail(e.SANDBOX_EMAIL_RECIPIENT, 'SANDBOX_EMAIL_RECIPIENT'),
    fallbackRecipientEmail: optionalEmail(e.FALLBACK_RECIPIENT_EMAIL, 'FALLBACK_RECIPIENT_EMAIL'),
    emailFrom: optionalEmail(e.EMAIL_FROM, 'EMAIL_FROM'),
    llmEnabled: llmEnabled,
    llmInDryRun: llmInDryRun,
    openaiBaseUrl: httpsUrl(e.OPENAI_BASE_URL, 'https://api.openai.com/v1', 'OPENAI_BASE_URL'),
    openaiModel: openaiModel,
    llmTemperature: boundedNumber(e.LLM_TEMPERATURE, 0.2, 0, 1, 'LLM_TEMPERATURE'),
    llmMaxTokens: boundedInt(e.LLM_MAX_TOKENS, 700, 100, 4000, 'LLM_MAX_TOKENS'),
    redactPiiForLlm: safetyFlag(e.REDACT_PII_FOR_LLM),
    recentDealDays: boundedInt(e.RECENT_DEAL_DAYS, 90, 0, 730, 'RECENT_DEAL_DAYS'),
    maxCompanies: boundedInt(e.MAX_COMPANIES, 3, 1, 10, 'MAX_COMPANIES'),
    maxDeals: boundedInt(e.MAX_DEALS, 5, 1, 20, 'MAX_DEALS'),
    maxNotesPerDeal: boundedInt(e.MAX_NOTES_PER_DEAL, 3, 0, 10, 'MAX_NOTES_PER_DEAL'),
    maxTickets: boundedInt(e.MAX_TICKETS, 5, 0, 20, 'MAX_TICKETS'),
    techStackProperties: csvList(isBlank(e.TECH_STACK_PROPERTIES) ? 'tech_stack,tech_stack_notes' : e.TECH_STACK_PROPERTIES),
    currencyCode: currencyCode,
    briefTimezone: briefTimezone
  };

  cfg.techStackProperties.forEach(function (name) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('TECH_STACK_PROPERTIES must be HubSpot internal property names (a-z, 0-9, _).');
  });

  if (cfg.dispatchMode === 'sandbox') {
    if (channels.indexOf('email') !== -1 && !cfg.sandboxEmailRecipient) {
      throw new Error('SANDBOX_MODE dispatch to email requires SANDBOX_EMAIL_RECIPIENT (a test inbox).');
    }
    if (channels.indexOf('slack') !== -1 && slackMode === 'bot' && !cfg.sandboxSlackChannelId) {
      throw new Error('SANDBOX_MODE dispatch with SLACK_MODE=bot requires SANDBOX_SLACK_CHANNEL_ID (a test channel).');
    }
  }
  if (cfg.dispatchMode !== 'dry_run' && channels.indexOf('email') !== -1 && !cfg.emailFrom) {
    throw new Error('Email dispatch requires EMAIL_FROM.');
  }
  return cfg;
}

function evaluateHubSpotTarget(cfg, account) {
  if (!cfg) return { allowed: false, reason: 'missing_config' };
  if (!cfg.sandboxMode) {
    return cfg.allowProductionMode
      ? { allowed: true, reason: 'production_mode_explicitly_allowed' }
      : { allowed: false, reason: 'production_mode_not_allowed' };
  }
  const accountType = String((account && account.accountType) || '').toUpperCase();
  if (SANDBOX_ACCOUNT_TYPES.indexOf(accountType) === -1) {
    return { allowed: false, reason: 'sandbox_mode_requires_sandbox_or_developer_test_portal (received "' + (accountType || 'unknown') + '")' };
  }
  if (cfg.sandboxPortalId && String(account.portalId) !== cfg.sandboxPortalId) {
    return { allowed: false, reason: 'sandbox_portal_id_mismatch' };
  }
  return { allowed: true, reason: 'sandbox_portal_verified' };
}

function resolveDispatchTarget(cfg, channel, rep) {
  const repEmail = rep && rep.email ? normalizeEmail(rep.email) : null;
  const sandbox = cfg.dispatchMode !== 'production';
  let target = null;
  let reason = null;

  if (channel === 'slack_webhook') {
    target = { webhookEnvVar: sandbox ? 'SANDBOX_SLACK_WEBHOOK_URL' : 'SLACK_WEBHOOK_URL', mentionEmail: repEmail };
  } else if (channel === 'slack_bot') {
    if (sandbox) {
      target = cfg.sandboxSlackChannelId ? { channel: cfg.sandboxSlackChannelId, needsLookup: false, lookupEmail: null } : null;
      if (!target) reason = 'sandbox_slack_channel_not_configured';
    } else if (repEmail) {
      target = { channel: null, needsLookup: true, lookupEmail: repEmail };
    } else {
      reason = 'no_recipient_resolved';
    }
  } else if (channel === 'email') {
    const to = sandbox ? cfg.sandboxEmailRecipient : repEmail;
    if (to) target = { email: to, from: cfg.emailFrom };
    else reason = sandbox ? 'sandbox_email_recipient_not_configured' : 'no_recipient_resolved';
  } else {
    reason = 'unknown_channel';
  }

  if (cfg.dispatchMode === 'dry_run') {
    return { allowed: false, sandbox: sandbox, target: target, reason: reason || 'dry_run_enabled' };
  }
  return { allowed: Boolean(target) && !reason, sandbox: sandbox, target: target, reason: reason || (sandbox ? 'sandbox_redirect' : 'production_recipient') };
}
// </n8n-core:config>

/**
 * Full runtime config for the standalone Node.js engine, including secrets.
 * The n8n Code nodes never see these; n8n keeps them in credentials or $env.
 */
function loadConfig(env) {
  const source = env || process.env;
  const settings = parseConfig(source);
  const secret = function (name) { return isPlaceholder(source[name]) ? null : String(source[name]).trim(); };
  const tokenVar = settings.sandboxMode ? 'HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN' : 'HUBSPOT_PRIVATE_APP_TOKEN';
  const llmWillRun = settings.llmEnabled && (!settings.dryRun || settings.llmInDryRun);

  const cfg = Object.assign({}, settings, {
    hubspotToken: secret(tokenVar),
    hubspotTokenVar: tokenVar,
    openaiApiKey: secret('OPENAI_API_KEY'),
    slackWebhookUrl: secret('SLACK_WEBHOOK_URL'),
    sandboxSlackWebhookUrl: secret('SANDBOX_SLACK_WEBHOOK_URL'),
    slackBotToken: secret('SLACK_BOT_TOKEN'),
    smtpHost: secret('SMTP_HOST'),
    smtpPort: boundedInt(source.SMTP_PORT, 465, 1, 65535, 'SMTP_PORT'),
    smtpSecure: safetyFlag(source.SMTP_SECURE),
    smtpUser: secret('SMTP_USER'),
    smtpPassword: secret('SMTP_PASSWORD'),
    googleCalendarAccessToken: secret('GOOGLE_CALENDAR_ACCESS_TOKEN'),
    googleCalendarId: secret('GOOGLE_CALENDAR_ID') || 'primary',
    msGraphAccessToken: secret('MS_GRAPH_ACCESS_TOKEN'),
    calendarWebhookSecret: secret('CALENDAR_WEBHOOK_SECRET'),
    requireWebhookSignature: safetyFlag(source.REQUIRE_WEBHOOK_SIGNATURE),
    stateFile: secret('STATE_FILE'),
    host: secret('HOST') || '127.0.0.1',
    port: boundedInt(source.PORT, 8788, 1, 65535, 'PORT')
  });

  if (llmWillRun && !cfg.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is empty or a placeholder, but the LLM will be called in this mode.');
  }
  if (cfg.dispatchMode !== 'dry_run') {
    const needsSlack = cfg.dispatchChannels.indexOf('slack') !== -1;
    const needsEmail = cfg.dispatchChannels.indexOf('email') !== -1;
    if (needsSlack && cfg.slackMode === 'webhook') {
      const url = cfg.dispatchMode === 'sandbox' ? cfg.sandboxSlackWebhookUrl : cfg.slackWebhookUrl;
      const name = cfg.dispatchMode === 'sandbox' ? 'SANDBOX_SLACK_WEBHOOK_URL' : 'SLACK_WEBHOOK_URL';
      if (!url || !/^https:\/\//i.test(url)) throw new Error(name + ' must be an https:// Slack incoming webhook URL.');
    }
    if (needsSlack && cfg.slackMode === 'bot' && !cfg.slackBotToken) throw new Error('SLACK_MODE=bot requires SLACK_BOT_TOKEN.');
    if (needsEmail && !cfg.smtpHost) throw new Error('Email dispatch requires SMTP_HOST.');
  }
  return Object.freeze(cfg);
}

function describeConfig(cfg) {
  const view = Object.assign({}, cfg);
  ['hubspotToken', 'openaiApiKey', 'slackWebhookUrl', 'sandboxSlackWebhookUrl', 'slackBotToken', 'smtpPassword',
    'googleCalendarAccessToken', 'msGraphAccessToken', 'calendarWebhookSecret'].forEach(function (key) {
    if (key in view) view[key] = view[key] ? '[redacted]' : null;
  });
  return view;
}

module.exports = {
  CONFIG_KEYS,
  SANDBOX_ACCOUNT_TYPES,
  PLACEHOLDER_PREFIX,
  isBlank,
  isPlaceholder,
  clampText,
  normalizeEmail,
  emailDomain,
  domainMatches,
  safetyFlag,
  optInFlag,
  boundedInt,
  csvList,
  parseConfig,
  evaluateHubSpotTarget,
  resolveDispatchTarget,
  loadConfig,
  describeConfig
};
