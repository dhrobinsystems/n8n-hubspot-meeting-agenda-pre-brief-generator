'use strict';

/**
 * hubspot-fetcher.js
 *
 * HubSpot enrichment for one meeting, built as a pure, serializable state
 * machine so the n8n workflow and the Node engine run identical logic:
 *
 *   state = createFetchState(meeting, cfg)
 *   for each stage in HUBSPOT_STAGES:
 *     request = planStage(stage, state, cfg)       // null = nothing to fetch
 *     response = request ? await http(request) : null
 *     state = absorbStage(stage, state, response, cfg)
 *   dossier = buildDossier(state, cfg)
 *
 * Stages (all read-only):
 *   account          GET  /account-info/v3/details           (sandbox gate)
 *   contacts         POST /crm/v3/objects/contacts/search     (email IN attendees)
 *   companySearch    POST /crm/v3/objects/companies/search    (domain IN attendee domains)
 *   contactCompanies POST /crm/v4/associations/contacts/companies/batch/read
 *   companies        POST /crm/v3/objects/companies/batch/read (firmographics + tech stack)
 *   contactDeals     POST /crm/v4/associations/contacts/deals/batch/read
 *   companyDeals     POST /crm/v4/associations/companies/deals/batch/read
 *   deals            POST /crm/v3/objects/deals/batch/read
 *   dealNotes        POST /crm/v4/associations/deals/notes/batch/read
 *   notes            POST /crm/v3/objects/notes/batch/read
 *   companyTickets   POST /crm/v4/associations/companies/tickets/batch/read
 *   tickets          POST /crm/v3/objects/tickets/batch/read
 *   dealPipelines    GET  /crm/v3/pipelines/deals              (stage labels)
 *   ticketPipelines  GET  /crm/v3/pipelines/tickets            (stage labels)
 *   owner            GET  /crm/v3/owners/{ownerId}             (assigned rep)
 *
 * A failed stage (other than the account gate) is recorded as a data gap and
 * the brief still goes out with what is known.
 *
 * The n8n-core:fetcher region depends on the config core (isBlank, clampText,
 * normalizeEmail, emailDomain, evaluateHubSpotTarget), always embedded first.
 */

const { isBlank, clampText, normalizeEmail, emailDomain, evaluateHubSpotTarget } = require('./config');

// <n8n-core:fetcher>
const HUBSPOT_STAGES = [
  'account', 'contacts', 'companySearch', 'contactCompanies', 'companies', 'contactDeals', 'companyDeals',
  'deals', 'dealNotes', 'notes', 'companyTickets', 'tickets', 'dealPipelines', 'ticketPipelines', 'owner'
];

const CONTACT_PROPERTIES = [
  'email', 'firstname', 'lastname', 'jobtitle', 'company', 'lifecyclestage', 'hs_lead_status', 'hubspot_owner_id',
  'notes_last_contacted', 'notes_last_updated', 'num_contacted_notes', 'hs_last_sales_activity_timestamp', 'createdate'
];
const COMPANY_BASE_PROPERTIES = [
  'name', 'domain', 'industry', 'numberofemployees', 'annualrevenue', 'lifecyclestage', 'hubspot_owner_id',
  'city', 'country', 'description'
];
const DEAL_PROPERTIES = [
  'dealname', 'dealstage', 'pipeline', 'amount', 'deal_currency_code', 'closedate', 'hs_lastmodifieddate',
  'hubspot_owner_id', 'hs_is_closed', 'hs_is_closed_won', 'hs_next_step', 'createdate'
];
const NOTE_PROPERTIES = ['hs_note_body', 'hs_timestamp'];
const TICKET_PROPERTIES = ['subject', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority', 'createdate', 'closed_date', 'hs_lastmodifieddate'];

// Consumer mailbox domains: attendees on these are looked up as contacts,
// but their domain is never used to match a company.
const FREE_EMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'zoho.com'
];

const MAX_ASSOCIATED_IDS = 100;
const MAX_NOTE_IDS = 50;
const NOTE_TEXT_LENGTH = 500;
const DAY_IN_MS = 86400000;

function uniqueStrings(values) {
  const out = [];
  const seen = {};
  values.forEach(function (v) {
    if (isBlank(v)) return;
    const s = String(v);
    if (!seen[s]) { seen[s] = true; out.push(s); }
  });
  return out;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function isOk(response) {
  return Boolean(response) && (Number(response.statusCode) === 200 || Number(response.statusCode) === 207);
}

function stripHtml(html) {
  if (isBlank(html)) return null;
  const text = String(html)
    .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return clampText(text, NOTE_TEXT_LENGTH);
}

function humanizeEnum(value) {
  const text = clampText(value, 80);
  if (!text || !/^[A-Z0-9_]+$/.test(text)) return text;
  const words = text.toLowerCase().split('_').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function readMultiValue(value) {
  // HubSpot multi-select checkboxes are stored as "A;B;C" (no spaces).
  if (typeof value !== 'string') return value;
  return /^[^;\s][^;]*(;[^;\s][^;]*)+$/.test(value) && value.indexOf('; ') === -1 ? value.split(';').join(', ') : value;
}

function toNumberOrNull(value) {
  if (isBlank(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toMs(value) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function createFetchState(meeting, cfg) {
  const emails = uniqueStrings(meeting.externalAttendees.map(function (a) { return normalizeEmail(a.email); }));
  const domains = uniqueStrings(emails.map(emailDomain)).filter(function (d) { return FREE_EMAIL_DOMAINS.indexOf(d) === -1; });
  return {
    meetingKey: meeting.key,
    meetingStart: meeting.start,
    organizerEmail: meeting.organizerEmail,
    internalAttendeeEmails: meeting.internalAttendees.map(function (a) { return a.email; }),
    externalEmails: emails,
    domains: domains,
    account: null,
    contacts: {},
    domainCompanyIds: [],
    contactCompanyIds: {},
    companyIds: [],
    companies: {},
    dealLinks: {},
    dealIds: [],
    deals: {},
    relevantDealIds: [],
    dealNoteIds: {},
    notes: {},
    companyTicketIds: {},
    tickets: {},
    openTicketIds: [],
    dealStageLabels: {},
    ticketStageLabels: {},
    ownerId: null,
    ownerSource: null,
    owner: null,
    gaps: [],
    completedStages: []
  };
}

function associationInputs(ids) {
  return { inputs: ids.slice(0, MAX_ASSOCIATED_IDS).map(function (id) { return { id: String(id) }; }) };
}

function readAssociations(body) {
  const links = {};
  const results = body && Array.isArray(body.results) ? body.results : [];
  results.forEach(function (row) {
    const from = row && row.from ? String(row.from.id) : null;
    if (!from) return;
    const to = Array.isArray(row.to) ? row.to.map(function (t) { return String(t.toObjectId); }) : [];
    links[from] = uniqueStrings((links[from] || []).concat(to));
  });
  return links;
}

function pickOwner(state) {
  const topDeal = state.relevantDealIds.map(function (id) { return state.deals[id]; })
    .find(function (d) { return d && d.properties.hs_is_closed !== 'true' && !isBlank(d.properties.hubspot_owner_id); });
  if (topDeal) return { id: String(topDeal.properties.hubspot_owner_id), source: 'deal_owner' };
  const company = state.companyIds.map(function (id) { return state.companies[id]; })
    .find(function (c) { return c && !isBlank(c.properties.hubspot_owner_id); });
  if (company) return { id: String(company.properties.hubspot_owner_id), source: 'company_owner' };
  const contact = Object.keys(state.contacts).map(function (id) { return state.contacts[id]; })
    .find(function (c) { return !isBlank(c.properties.hubspot_owner_id); });
  if (contact) return { id: String(contact.properties.hubspot_owner_id), source: 'contact_owner' };
  return null;
}

function planStage(stage, state, cfg) {
  switch (stage) {
    case 'account':
      return { method: 'GET', path: '/account-info/v3/details', body: null };
    case 'contacts':
      if (!state.externalEmails.length) return null;
      return {
        method: 'POST',
        path: '/crm/v3/objects/contacts/search',
        body: {
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'IN', values: state.externalEmails.slice(0, 100) }] }],
          properties: CONTACT_PROPERTIES,
          limit: 100
        }
      };
    case 'companySearch':
      if (!state.domains.length) return null;
      return {
        method: 'POST',
        path: '/crm/v3/objects/companies/search',
        body: {
          filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'IN', values: state.domains.slice(0, 100) }] }],
          properties: ['domain', 'name'],
          limit: 100
        }
      };
    case 'contactCompanies':
      return Object.keys(state.contacts).length
        ? { method: 'POST', path: '/crm/v4/associations/contacts/companies/batch/read', body: associationInputs(Object.keys(state.contacts)) }
        : null;
    case 'companies':
      return state.companyIds.length
        ? {
          method: 'POST',
          path: '/crm/v3/objects/companies/batch/read',
          body: {
            properties: COMPANY_BASE_PROPERTIES.concat(cfg.techStackProperties || []),
            inputs: state.companyIds.map(function (id) { return { id: id }; })
          }
        }
        : null;
    case 'contactDeals':
      return Object.keys(state.contacts).length
        ? { method: 'POST', path: '/crm/v4/associations/contacts/deals/batch/read', body: associationInputs(Object.keys(state.contacts)) }
        : null;
    case 'companyDeals':
      return state.companyIds.length
        ? { method: 'POST', path: '/crm/v4/associations/companies/deals/batch/read', body: associationInputs(state.companyIds) }
        : null;
    case 'deals':
      return state.dealIds.length
        ? {
          method: 'POST',
          path: '/crm/v3/objects/deals/batch/read',
          body: { properties: DEAL_PROPERTIES, inputs: state.dealIds.slice(0, MAX_ASSOCIATED_IDS).map(function (id) { return { id: id }; }) }
        }
        : null;
    case 'dealNotes':
      return state.relevantDealIds.length && cfg.maxNotesPerDeal > 0
        ? { method: 'POST', path: '/crm/v4/associations/deals/notes/batch/read', body: associationInputs(state.relevantDealIds) }
        : null;
    case 'notes': {
      const noteIds = uniqueStrings(Object.keys(state.dealNoteIds).reduce(function (all, dealId) {
        return all.concat(state.dealNoteIds[dealId]);
      }, [])).sort(function (a, b) { return Number(b) - Number(a); }).slice(0, MAX_NOTE_IDS);
      return noteIds.length
        ? { method: 'POST', path: '/crm/v3/objects/notes/batch/read', body: { properties: NOTE_PROPERTIES, inputs: noteIds.map(function (id) { return { id: id }; }) } }
        : null;
    }
    case 'companyTickets':
      return state.companyIds.length && cfg.maxTickets > 0
        ? { method: 'POST', path: '/crm/v4/associations/companies/tickets/batch/read', body: associationInputs(state.companyIds) }
        : null;
    case 'tickets': {
      const ticketIds = uniqueStrings(Object.keys(state.companyTicketIds).reduce(function (all, id) {
        return all.concat(state.companyTicketIds[id]);
      }, [])).slice(0, MAX_ASSOCIATED_IDS);
      return ticketIds.length
        ? { method: 'POST', path: '/crm/v3/objects/tickets/batch/read', body: { properties: TICKET_PROPERTIES, inputs: ticketIds.map(function (id) { return { id: id }; }) } }
        : null;
    }
    case 'dealPipelines':
      return state.relevantDealIds.length ? { method: 'GET', path: '/crm/v3/pipelines/deals', body: null } : null;
    case 'ticketPipelines':
      return state.openTicketIds.length ? { method: 'GET', path: '/crm/v3/pipelines/tickets', body: null } : null;
    case 'owner': {
      const owner = pickOwner(state);
      return owner && /^\d+$/.test(owner.id)
        ? { method: 'GET', path: '/crm/v3/owners/' + owner.id, body: null }
        : null;
    }
    default:
      throw new Error('Unknown HubSpot stage: ' + stage);
  }
}

function readStageLabels(body) {
  const labels = {};
  const pipelines = body && Array.isArray(body.results) ? body.results : [];
  pipelines.forEach(function (pipeline) {
    (Array.isArray(pipeline.stages) ? pipeline.stages : []).forEach(function (stage) {
      labels[String(stage.id)] = { label: stage.label, pipeline: pipeline.label };
    });
  });
  return labels;
}

function absorbStage(stage, previous, response, cfg) {
  const state = cloneState(previous);
  state.completedStages.push(stage);

  if (stage === 'account') {
    if (!isOk(response)) {
      throw new Error('Unable to verify the HubSpot portal (account details status ' + (response ? response.statusCode : 'n/a') + '). No CRM data was read.');
    }
    const verdict = evaluateHubSpotTarget(cfg, response.body);
    if (!verdict.allowed) throw new Error('HubSpot read blocked by gate: ' + verdict.reason);
    state.account = { portalId: response.body.portalId, accountType: response.body.accountType };
    return state;
  }

  if (response === null) return state; // stage skipped: nothing to fetch
  if (!isOk(response)) {
    state.gaps.push(stage + ':http_' + (response.statusCode || 'error'));
    if (stage === 'owner') state.ownerId = null;
    return state;
  }
  const body = response.body || {};
  const results = Array.isArray(body.results) ? body.results : [];

  switch (stage) {
    case 'contacts':
      results.forEach(function (c) { state.contacts[String(c.id)] = { id: String(c.id), properties: c.properties || {} }; });
      break;
    case 'companySearch':
      state.domainCompanyIds = uniqueStrings(results.map(function (c) { return c.id; }));
      state.companyIds = state.domainCompanyIds.slice(0, cfg.maxCompanies);
      break;
    case 'contactCompanies': {
      state.contactCompanyIds = readAssociations(body);
      const fromContacts = Object.keys(state.contactCompanyIds).reduce(function (all, id) { return all.concat(state.contactCompanyIds[id]); }, []);
      state.companyIds = uniqueStrings(state.domainCompanyIds.concat(fromContacts)).slice(0, cfg.maxCompanies);
      break;
    }
    case 'companies':
      results.forEach(function (c) { state.companies[String(c.id)] = { id: String(c.id), properties: c.properties || {} }; });
      break;
    case 'contactDeals':
    case 'companyDeals': {
      const links = readAssociations(body);
      const side = stage === 'contactDeals' ? 'contacts' : 'companies';
      Object.keys(links).forEach(function (fromId) {
        links[fromId].forEach(function (dealId) {
          const link = state.dealLinks[dealId] || { contacts: [], companies: [] };
          link[side] = uniqueStrings(link[side].concat([fromId]));
          state.dealLinks[dealId] = link;
        });
      });
      state.dealIds = Object.keys(state.dealLinks);
      break;
    }
    case 'deals': {
      results.forEach(function (d) { state.deals[String(d.id)] = { id: String(d.id), properties: d.properties || {} }; });
      const meetingMs = toMs(state.meetingStart) || Date.now();
      const recentCutoff = meetingMs - cfg.recentDealDays * DAY_IN_MS;
      const ranked = Object.keys(state.deals).map(function (id) { return state.deals[id]; }).filter(function (d) {
        const p = d.properties;
        if (p.hs_is_closed !== 'true') return true;
        const closed = toMs(p.closedate);
        return closed !== null && closed >= recentCutoff;
      }).sort(function (a, b) {
        const aOpen = a.properties.hs_is_closed !== 'true' ? 1 : 0;
        const bOpen = b.properties.hs_is_closed !== 'true' ? 1 : 0;
        if (aOpen !== bOpen) return bOpen - aOpen;
        const amount = (toNumberOrNull(b.properties.amount) || 0) - (toNumberOrNull(a.properties.amount) || 0);
        if (amount !== 0) return amount;
        return (toMs(b.properties.hs_lastmodifieddate) || 0) - (toMs(a.properties.hs_lastmodifieddate) || 0);
      });
      state.relevantDealIds = ranked.slice(0, cfg.maxDeals).map(function (d) { return d.id; });
      break;
    }
    case 'dealNotes':
      state.dealNoteIds = readAssociations(body);
      break;
    case 'notes':
      results.forEach(function (n) { state.notes[String(n.id)] = { id: String(n.id), properties: n.properties || {} }; });
      break;
    case 'companyTickets':
      state.companyTicketIds = readAssociations(body);
      break;
    case 'tickets':
      results.forEach(function (t) { state.tickets[String(t.id)] = { id: String(t.id), properties: t.properties || {} }; });
      state.openTicketIds = Object.keys(state.tickets).map(function (id) { return state.tickets[id]; })
        .filter(function (t) { return isBlank(t.properties.closed_date); })
        .sort(function (a, b) { return (toMs(b.properties.createdate) || 0) - (toMs(a.properties.createdate) || 0); })
        .slice(0, cfg.maxTickets)
        .map(function (t) { return t.id; });
      break;
    case 'dealPipelines':
      state.dealStageLabels = readStageLabels(body);
      break;
    case 'ticketPipelines':
      state.ticketStageLabels = readStageLabels(body);
      break;
    case 'owner': {
      const picked = pickOwner(state);
      state.ownerId = picked ? picked.id : null;
      state.ownerSource = picked ? picked.source : null;
      state.owner = {
        email: normalizeEmail(body.email),
        firstName: clampText(body.firstName, 80),
        lastName: clampText(body.lastName, 80)
      };
      break;
    }
    default:
      throw new Error('Unknown HubSpot stage: ' + stage);
  }
  return state;
}

function fullName(first, last) {
  return clampText([first, last].filter(function (v) { return !isBlank(v); }).join(' '), 120);
}

function buildDossier(state, cfg, meeting) {
  const contactsByEmail = {};
  Object.keys(state.contacts).forEach(function (id) {
    const c = state.contacts[id];
    const email = normalizeEmail(c.properties.email);
    if (email) contactsByEmail[email] = c;
  });

  const companies = state.companyIds.filter(function (id) { return state.companies[id]; }).map(function (id) {
    const p = state.companies[id].properties;
    const techStack = (cfg.techStackProperties || []).map(function (name) {
      const value = clampText(readMultiValue(p[name]), 300);
      return value ? { property: name, value: value } : null;
    }).filter(Boolean);
    return {
      id: id,
      name: clampText(p.name, 120),
      domain: clampText(p.domain, 120),
      industry: humanizeEnum(p.industry),
      employees: toNumberOrNull(p.numberofemployees),
      annualRevenue: toNumberOrNull(p.annualrevenue),
      lifecycleStage: clampText(p.lifecyclestage, 60),
      location: clampText([p.city, p.country].filter(function (v) { return !isBlank(v); }).join(', '), 120),
      description: clampText(p.description, 300),
      techStack: techStack
    };
  });

  const companyNameById = {};
  companies.forEach(function (c) { companyNameById[c.id] = c.name; });

  const attendees = meeting.externalAttendees.map(function (a) {
    const contact = contactsByEmail[a.email];
    const p = contact ? contact.properties : null;
    const companyIds = contact ? (state.contactCompanyIds[contact.id] || []) : [];
    return {
      email: a.email,
      name: (p && fullName(p.firstname, p.lastname)) || a.name || null,
      response: a.response,
      inCrm: Boolean(contact),
      contactId: contact ? contact.id : null,
      jobTitle: p ? clampText(p.jobtitle, 120) : null,
      lifecycleStage: p ? clampText(p.lifecyclestage, 60) : null,
      leadStatus: p ? clampText(p.hs_lead_status, 60) : null,
      lastContacted: p ? clampText(p.notes_last_contacted, 40) : null,
      lastActivity: p ? clampText(p.hs_last_sales_activity_timestamp || p.notes_last_updated, 40) : null,
      timesContacted: p ? toNumberOrNull(p.num_contacted_notes) : null,
      company: companyIds.map(function (id) { return companyNameById[id]; }).filter(Boolean)[0] || (p ? clampText(p.company, 120) : null)
    };
  });

  const deals = state.relevantDealIds.filter(function (id) { return state.deals[id]; }).map(function (id) {
    const p = state.deals[id].properties;
    const stage = state.dealStageLabels[String(p.dealstage)] || null;
    const notes = (state.dealNoteIds[id] || []).map(function (noteId) { return state.notes[noteId]; }).filter(Boolean)
      .map(function (n) { return { timestamp: clampText(n.properties.hs_timestamp, 40), text: stripHtml(n.properties.hs_note_body) }; })
      .filter(function (n) { return n.text; })
      .sort(function (a, b) { return (toMs(b.timestamp) || 0) - (toMs(a.timestamp) || 0); })
      .slice(0, cfg.maxNotesPerDeal);
    return {
      id: id,
      name: clampText(p.dealname, 150),
      stage: stage ? clampText(stage.label, 80) : clampText(p.dealstage, 80),
      pipeline: stage ? clampText(stage.pipeline, 80) : clampText(p.pipeline, 80),
      amount: toNumberOrNull(p.amount),
      currency: isBlank(p.deal_currency_code) ? cfg.currencyCode : String(p.deal_currency_code).toUpperCase(),
      closeDate: clampText(p.closedate, 40),
      isClosed: p.hs_is_closed === 'true',
      isWon: p.hs_is_closed_won === 'true',
      nextStep: clampText(p.hs_next_step, 200),
      notes: notes
    };
  });

  const openDeals = deals.filter(function (d) { return !d.isClosed; });
  const currencies = uniqueStrings(openDeals.map(function (d) { return d.currency; }));
  const pipeline = {
    openDealCount: openDeals.length,
    openPipelineValue: openDeals.reduce(function (sum, d) { return sum + (d.amount || 0); }, 0),
    currency: currencies.length === 1 ? currencies[0] : cfg.currencyCode,
    mixedCurrencies: currencies.length > 1,
    dealsWithoutAmount: openDeals.filter(function (d) { return d.amount === null; }).length
  };

  const tickets = state.openTicketIds.filter(function (id) { return state.tickets[id]; }).map(function (id) {
    const p = state.tickets[id].properties;
    const stage = state.ticketStageLabels[String(p.hs_pipeline_stage)] || null;
    return {
      id: id,
      subject: clampText(p.subject, 150),
      priority: clampText(p.hs_ticket_priority, 20),
      stage: stage ? clampText(stage.label, 80) : clampText(p.hs_pipeline_stage, 80),
      createdAt: clampText(p.createdate, 40)
    };
  });

  let assignedRep = null;
  if (state.owner && state.owner.email) {
    assignedRep = { email: state.owner.email, name: fullName(state.owner.firstName, state.owner.lastName), source: state.ownerSource || 'hubspot_owner' };
  } else if (meeting.organizerEmail && meeting.internalAttendees.some(function (a) { return a.email === meeting.organizerEmail; })) {
    assignedRep = { email: meeting.organizerEmail, name: null, source: 'meeting_organizer' };
  } else if (meeting.internalAttendees.length) {
    assignedRep = { email: meeting.internalAttendees[0].email, name: meeting.internalAttendees[0].name, source: 'internal_attendee' };
  } else if (cfg.fallbackRecipientEmail) {
    assignedRep = { email: cfg.fallbackRecipientEmail, name: null, source: 'fallback_recipient' };
  }

  const gaps = state.gaps.slice();
  if (attendees.every(function (a) { return !a.inCrm; })) gaps.push('no_attendees_found_in_crm');
  if (!companies.length) gaps.push('no_company_matched');
  if (pipeline.mixedCurrencies) gaps.push('open_deals_use_mixed_currencies');
  if (!assignedRep) gaps.push('no_recipient_resolved');

  return {
    meeting: {
      key: meeting.key,
      provider: meeting.provider,
      title: meeting.title,
      start: meeting.start,
      end: meeting.end,
      minutesUntilStart: meeting.minutesUntilStart,
      conferenceUrl: meeting.conferenceUrl,
      calendarUrl: meeting.calendarUrl,
      organizerEmail: meeting.organizerEmail,
      internalAttendees: meeting.internalAttendees.map(function (a) { return { email: a.email, name: a.name }; })
    },
    portal: state.account,
    attendees: attendees,
    companies: companies,
    deals: deals,
    pipeline: pipeline,
    tickets: tickets,
    assignedRep: assignedRep,
    dataGaps: uniqueStrings(gaps)
  };
}
// </n8n-core:fetcher>

module.exports = {
  HUBSPOT_STAGES,
  CONTACT_PROPERTIES,
  COMPANY_BASE_PROPERTIES,
  DEAL_PROPERTIES,
  NOTE_PROPERTIES,
  TICKET_PROPERTIES,
  FREE_EMAIL_DOMAINS,
  stripHtml,
  createFetchState,
  planStage,
  absorbStage,
  buildDossier
};
