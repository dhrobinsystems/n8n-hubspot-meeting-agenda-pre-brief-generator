'use strict';

/**
 * calendar.js
 *
 * Calendar event normalization and meeting selection.
 *
 *   - Normalizes Google Calendar events, Microsoft Graph (Outlook) events, and a
 *     generic webhook shape into one meeting schema.
 *   - Selects meetings that start inside the lead window (default: 30 minutes
 *     out, +/- half the polling interval) and have at least one external,
 *     non-declined, non-resource attendee.
 *   - Skips cancelled, all-day, private, opted-out ("[no brief]"), and
 *     already-briefed meetings, and reports the reason for each skip.
 *
 * The n8n-core:calendar region is embedded into the n8n workflow and relies on
 * the helpers in the config core (isBlank, clampText, normalizeEmail,
 * emailDomain, domainMatches), which are always embedded first.
 */

const { isBlank, clampText, normalizeEmail, emailDomain, domainMatches } = require('./config');

// <n8n-core:calendar>
const RESOURCE_EMAIL_PATTERN = /@resource\.calendar\.google\.com$/;
const BRIEFED_KEY_TTL_HOURS = 48;

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function zonedDateTimeToIso(dateTime, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(String(dateTime || '').trim());
  if (!match) return null;
  const parts = match.slice(1).map(function (p) { return Number(p || 0); });
  const guess = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  const zone = String(timeZone || 'UTC').trim();
  if (/^(utc|etc\/utc|gmt|z)$/i.test(zone)) return new Date(guess).toISOString();
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch (error) {
    return null; // Not an IANA zone (for example a Windows zone name).
  }
  const offsetAt = function (instant) {
    const values = {};
    formatter.formatToParts(new Date(instant)).forEach(function (part) { values[part.type] = part.value; });
    const asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    return asUtc - instant;
  };
  let instant = guess - offsetAt(guess);
  instant = guess - offsetAt(instant); // second pass settles DST transitions
  return new Date(instant).toISOString();
}

function parseInstant(value) {
  if (isBlank(value)) return null;
  const ms = Date.parse(String(value).trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeResponse(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'accepted' || v === 'organizer') return 'accepted';
  if (v === 'declined') return 'declined';
  if (v === 'tentative' || v === 'tentativelyaccepted') return 'tentative';
  return 'needs_action';
}

function detectCalendarProvider(raw) {
  const hinted = String(raw.provider || '').trim().toLowerCase();
  if (hinted === 'google' || hinted === 'outlook' || hinted === 'webhook') return hinted;
  if (raw.kind === 'calendar#event') return 'google';
  if (raw['@odata.etag'] !== undefined || raw.isCancelled !== undefined || (raw.subject !== undefined && raw.start && raw.start.timeZone !== undefined)) return 'outlook';
  if (raw.summary !== undefined && raw.start && (raw.start.dateTime || raw.start.date)) return 'google';
  return 'webhook';
}

function normalizeCalendarEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'event_must_be_an_object', event: null };
  const provider = detectCalendarProvider(raw);
  let event;

  if (provider === 'google') {
    const start = asPlainObject(raw.start);
    const end = asPlainObject(raw.end);
    const conference = asPlainObject(raw.conferenceData);
    const entryPoint = Array.isArray(conference.entryPoints) ? conference.entryPoints.find(function (p) { return p && p.entryPointType === 'video'; }) : null;
    event = {
      provider: 'google',
      eventId: raw.id,
      title: raw.summary,
      start: start.dateTime ? parseInstant(start.dateTime) : null,
      end: end.dateTime ? parseInstant(end.dateTime) : null,
      isAllDay: Boolean(start.date && !start.dateTime),
      status: raw.status === 'cancelled' ? 'cancelled' : 'confirmed',
      isPrivate: raw.visibility === 'private' || raw.visibility === 'confidential',
      organizerEmail: asPlainObject(raw.organizer).email,
      attendees: (Array.isArray(raw.attendees) ? raw.attendees : []).map(function (a) {
        const attendee = asPlainObject(a);
        return {
          email: attendee.email,
          name: attendee.displayName,
          response: normalizeResponse(attendee.responseStatus),
          isResource: Boolean(attendee.resource),
          isOrganizer: Boolean(attendee.organizer)
        };
      }),
      conferenceUrl: raw.hangoutLink || (entryPoint && entryPoint.uri) || null,
      calendarUrl: raw.htmlLink || null,
      description: raw.description
    };
  } else if (provider === 'outlook') {
    const start = asPlainObject(raw.start);
    const end = asPlainObject(raw.end);
    event = {
      provider: 'outlook',
      eventId: raw.id,
      title: raw.subject,
      start: start.dateTime ? zonedDateTimeToIso(start.dateTime, start.timeZone) : null,
      end: end.dateTime ? zonedDateTimeToIso(end.dateTime, end.timeZone) : null,
      isAllDay: Boolean(raw.isAllDay),
      status: raw.isCancelled ? 'cancelled' : 'confirmed',
      isPrivate: raw.sensitivity === 'private' || raw.sensitivity === 'confidential',
      organizerEmail: asPlainObject(asPlainObject(raw.organizer).emailAddress).address,
      attendees: (Array.isArray(raw.attendees) ? raw.attendees : []).map(function (a) {
        const attendee = asPlainObject(a);
        const address = asPlainObject(attendee.emailAddress);
        return {
          email: address.address,
          name: address.name,
          response: normalizeResponse(asPlainObject(attendee.status).response),
          isResource: attendee.type === 'resource',
          isOrganizer: false
        };
      }),
      conferenceUrl: asPlainObject(raw.onlineMeeting).joinUrl || null,
      calendarUrl: raw.webLink || null,
      description: raw.bodyPreview
    };
  } else {
    event = {
      provider: 'webhook',
      eventId: raw.event_id || raw.id,
      title: raw.title,
      start: parseInstant(raw.start),
      end: parseInstant(raw.end),
      isAllDay: Boolean(raw.is_all_day),
      status: String(raw.status || 'confirmed').toLowerCase() === 'cancelled' ? 'cancelled' : 'confirmed',
      isPrivate: Boolean(raw.is_private),
      organizerEmail: raw.organizer_email,
      attendees: (Array.isArray(raw.attendees) ? raw.attendees : []).map(function (a) {
        const attendee = asPlainObject(a);
        return {
          email: attendee.email,
          name: attendee.name,
          response: normalizeResponse(attendee.response_status),
          isResource: Boolean(attendee.is_resource),
          isOrganizer: Boolean(attendee.is_organizer)
        };
      }),
      conferenceUrl: raw.conference_url || null,
      calendarUrl: raw.calendar_url || null,
      description: raw.description
    };
  }

  event.eventId = clampText(event.eventId, 512);
  event.title = clampText(event.title, 200) || '(untitled meeting)';
  event.organizerEmail = normalizeEmail(event.organizerEmail);
  event.description = clampText(event.description, 500);
  const seen = {};
  event.attendees = event.attendees
    .map(function (a) {
      const email = normalizeEmail(a.email);
      return email ? {
        email: email,
        name: clampText(a.name, 120),
        response: a.response,
        isResource: a.isResource || RESOURCE_EMAIL_PATTERN.test(email),
        isOrganizer: a.isOrganizer || email === event.organizerEmail
      } : null;
    })
    .filter(function (a) {
      if (!a || seen[a.email]) return false;
      seen[a.email] = true;
      return true;
    });

  if (!event.eventId) return { ok: false, reason: 'event_id_missing', event: null };
  if (!event.isAllDay && !event.start) return { ok: false, reason: 'start_time_missing_or_unparseable', event: null };
  return { ok: true, reason: null, event: event };
}

function buildMeetingKey(event) {
  return event.provider + ':' + event.eventId + ':' + (event.start || 'all-day');
}

function resolveInternalDomains(event, configured) {
  if (configured && configured.length) return configured;
  const organizerDomain = emailDomain(event.organizerEmail);
  return organizerDomain ? [organizerDomain] : [];
}

function isInternalEmail(email, internalDomains) {
  const domain = emailDomain(email);
  return Boolean(domain) && internalDomains.some(function (d) { return domainMatches(domain, d); });
}

function pruneBriefedKeys(briefed, now, ttlHours) {
  const cutoff = now.getTime() - (ttlHours || BRIEFED_KEY_TTL_HOURS) * 3600000;
  const kept = {};
  Object.keys(briefed || {}).forEach(function (key) {
    const at = Date.parse(briefed[key]);
    if (Number.isFinite(at) && at >= cutoff) kept[key] = briefed[key];
  });
  return kept;
}

function selectMeetingsToBrief(rawEvents, options) {
  const opts = options || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const leadMs = (opts.leadMinutes || 30) * 60000;
  const halfPollMs = ((opts.pollIntervalMinutes || 5) * 60000) / 2;
  const windowStart = now.getTime() + leadMs - halfPollMs;
  const windowEnd = now.getTime() + leadMs + halfPollMs;
  const briefed = opts.briefedKeys || {};
  const keywords = opts.ignoreTitleKeywords || [];
  const selected = [];
  const skipped = [];
  const batchKeys = {};

  (Array.isArray(rawEvents) ? rawEvents : []).forEach(function (raw) {
    const normalized = normalizeCalendarEvent(raw);
    if (!normalized.ok) {
      skipped.push({ eventId: raw && raw.id ? String(raw.id) : null, reason: normalized.reason });
      return;
    }
    const event = normalized.event;
    const skip = function (reason) { skipped.push({ eventId: event.eventId, title: event.title, reason: reason }); };
    if (event.status === 'cancelled') return skip('cancelled');
    if (event.isAllDay) return skip('all_day_event');
    if (opts.skipPrivateEvents !== false && event.isPrivate) return skip('private_event');
    const lowerTitle = event.title.toLowerCase();
    if (keywords.some(function (k) { return k && lowerTitle.indexOf(k) !== -1; })) return skip('opted_out_by_title_keyword');
    const startMs = Date.parse(event.start);
    if (startMs < windowStart || startMs >= windowEnd) return skip('outside_lead_window');

    const internalDomains = resolveInternalDomains(event, opts.internalDomains);
    const active = event.attendees.filter(function (a) { return !a.isResource && a.response !== 'declined'; });
    const external = active.filter(function (a) { return !isInternalEmail(a.email, internalDomains); });
    const internal = active.filter(function (a) { return isInternalEmail(a.email, internalDomains); });
    if (internalDomains.length === 0) return skip('internal_domains_unknown');
    if (external.length === 0) return skip('no_external_attendees');

    const key = buildMeetingKey(event);
    if (briefed[key]) return skip('already_briefed');
    if (batchKeys[key]) return skip('duplicate_in_batch');
    batchKeys[key] = true;

    selected.push(Object.assign({}, event, {
      key: key,
      minutesUntilStart: Math.round((startMs - now.getTime()) / 60000),
      internalDomains: internalDomains,
      externalAttendees: external,
      internalAttendees: internal
    }));
  });

  selected.sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); });
  return { selected: selected, skipped: skipped, window: { start: new Date(windowStart).toISOString(), end: new Date(windowEnd).toISOString() } };
}
// </n8n-core:calendar>

module.exports = {
  RESOURCE_EMAIL_PATTERN,
  zonedDateTimeToIso,
  detectCalendarProvider,
  normalizeCalendarEvent,
  buildMeetingKey,
  isInternalEmail,
  pruneBriefedKeys,
  selectMeetingsToBrief
};
