# ⚠️ Disclaimer & Limitation of Liability

**Use at your own risk.** The code, workflows, and scripts in this repository (`n8n-hubspot-meeting-agenda-pre-brief-generator`) are provided for educational and architectural demonstration purposes. I publish them as a reference implementation, not as a managed product or a professional service.

## 1. No Warranty ("As-Is" Provision)

All software, n8n JSON blueprints (`workflow.json`), and JavaScript modules are provided **"AS IS" and "AS AVAILABLE"**, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, accuracy, and non-infringement. I do not warrant that the code is error-free, that it runs without interruption, or that it is compatible with any particular n8n version, HubSpot portal configuration, calendar provider, LLM provider, Slack workspace, or mail server. Third-party API shapes, rate limits, and node parameters change over time; verify every node and request against your own environment.

## 2. Data Protection & Privacy Compliance

This software reads calendar events and attendee details, retrieves CRM records about those attendees and their companies, transmits a summary of that data to a third-party large language model (LLM) provider, and delivers the result over Slack or email. **You are solely responsible** for ensuring every one of those steps complies with the data protection and privacy laws that apply to you and to the people whose data is processed, including but not limited to:

- the EU and UK **General Data Protection Regulation (GDPR / UK GDPR)**,
- the **California Consumer Privacy Act** as amended by the **California Privacy Rights Act (CCPA/CPRA)**,
- the UK **Privacy and Electronic Communications Regulations (PECR)** and the EU ePrivacy rules,
- and any other regional, national, or sector-specific privacy law.

That responsibility covers, among other things: a lawful basis for processing meeting attendees' data; transparency toward those attendees; a data processing agreement and an international-transfer mechanism with your LLM provider; the provider's data retention and model-training settings; honouring access, deletion, and objection requests; retention of briefs in Slack and email; and restricting briefs to people with a legitimate need to see them. The engine sends only a minimal context to the LLM and redacts email addresses and phone numbers by default (`REDACT_PII_FOR_LLM=true`), but those measures are not a substitute for your own legal review.

## 3. API Rate-Limit & CRM Quota Risk

Each briefed meeting makes up to fifteen read-only HubSpot API calls, one LLM request, and one or more Slack or email sends. High-volume calendars, short polling intervals, or many parallel meetings can exhaust HubSpot API rate limits and daily quotas, LLM provider rate limits and spend budgets, and Slack or SMTP sending limits, causing delayed, partial, or missing briefs. **You must test in an isolated HubSpot developer test account or sandbox portal**, with `SANDBOX_MODE=true` and `DRY_RUN=true`, before connecting production credentials, and you must monitor API usage and LLM spend after deployment.

## 4. Assumption of Risk & Limitation of Liability

By using, copying, modifying, or deploying any part of this repository, you assume all risk associated with that use. **In no event shall dhRobin Systems or the author (DH Robin) be liable** for any direct, indirect, incidental, special, exemplary, or consequential damages, including but not limited to:

- inaccurate, incomplete, outdated, or fabricated content in LLM-generated briefings;
- missed, delayed, duplicated, or misdirected notifications;
- briefs delivered to the wrong recipient, channel, or audience;
- lost deals, damaged customer relationships, or other downstream commercial errors;
- regulatory fines, privacy complaints, or contractual claims;
- API overage charges, LLM spend, or service suspensions;

however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence), even if advised of the possibility of such damage.

**LLM output is not fact.** Every brief can contain errors. Verify names, figures, commitments, and context against the CRM before relying on or repeating anything in a brief.

## 5. Production Testing Required

Treat every brief as something that cannot be recalled once delivered. Before you set `DRY_RUN=false`, `SANDBOX_MODE=false`, and `ALLOW_PRODUCTION_MODE=true`:

1. Run the full test suite (`npm test`).
2. Review dry-run previews for representative meetings.
3. Run against a sandbox portal with sandbox Slack and email targets, and audit every brief.
4. Confirm your LLM provider agreement and retention settings.
5. Confirm with whoever owns the CRM, the calendar, and the Slack workspace that this processing is approved.

## 6. Third-Party Services

HubSpot, n8n, Google Calendar, Microsoft Outlook and Graph, OpenAI, Slack, and any other product named in this repository are trademarks of their respective owners. This project is independent and is not affiliated with, endorsed by, or sponsored by any of them. You are responsible for complying with each service's terms of service, acceptable use policy, rate limits, and security requirements.

---

The software itself is licensed under the MIT License. See [LICENSE](LICENSE). Copyright (c) 2026 dhRobin Systems.
