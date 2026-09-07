// FWS Command Center — Exceptions & Alerts Feed
// v2.1 — 7 Sept 2026
// v2.1: ADDED a third genuine exception source, alongside the existing
//   two — invoices flagged xero_draft_stuck = true by the new
//   xero-draft-check.js cron (in the fws-invoice-automation project).
//   This catches a different failure point than the other two: it's
//   not that the invoice failed to reach Xero (that's Agent 2's flag)
//   or that a ticket sat too long (Agent 3's flag) — it's that the
//   invoice DID reach Xero successfully as a Draft, but has sat there
//   more than 3 business days without being authorised. Read directly
//   off the Invoice record (0-53), same pattern as validation_status.
// v2.0: REBUILT on the real signals, per John's correction — "open
//   ticket" was too broad (most open tickets are just normal in-
//   flight invoices moving through Invoiced→Payment stages, not
//   exceptions). The two genuine exception sources were:
//     1. Agent 2's flag: Invoice records (object 0-53) with
//        validation_status = "Needs Review" (SP pricing variance,
//        services not found, etc.) — NOT a ticket. Agent 2's own
//        ticket-creation step for these has a known unresolved bug,
//        so checking tickets alone would miss these entirely.
//     2. Agent 3's flag: tickets sitting in the "Overdue" pipeline
//        stage (confirmed id 3506368961 in this portal) — drafts
//        that sat in Xero too long without completing.
// v1.x: showed ALL open tickets — too noisy, superseded by v2.0.

const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;
const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const PORTAL_ID = '441953864';
const OVERDUE_STAGE_ID = '3506368961';

async function hubspotPost(path, body) {
  const resp = await fetch(`${HUBSPOT_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`HubSpot API error (${resp.status}): ${errText}`);
  }
  return resp.json();
}

async function getNeedsReviewInvoices() {
  const data = await hubspotPost('/crm/v3/objects/0-53/search', {
    limit: 100,
    properties: ['validation_status', 'validation_issues', 'supplier_invoice_number', 'createdate'],
    filterGroups: [
      { filters: [{ propertyName: 'validation_status', operator: 'EQ', value: 'Needs Review' }] },
    ],
    sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
  });
  return (data.results || []).map((r) => ({
    kind: 'invoice_review',
    id: r.id,
    subject: r.properties.supplier_invoice_number
      ? `Invoice ${r.properties.supplier_invoice_number}: ${r.properties.validation_issues || 'Needs review'}`
      : `Invoice needs review: ${r.properties.validation_issues || '(no details)'}`,
    createdAt: r.properties.createdate,
    url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-53/${r.id}`,
  }));
}

async function getOverdueTickets() {
  const data = await hubspotPost('/crm/v3/objects/tickets/search', {
    limit: 100,
    properties: ['subject', 'createdate'],
    filterGroups: [
      { filters: [{ propertyName: 'hs_pipeline_stage', operator: 'EQ', value: OVERDUE_STAGE_ID }] },
    ],
    sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
  });
  return (data.results || []).map((t) => ({
    kind: 'overdue_ticket',
    id: t.id,
    subject: `Overdue: ${t.properties.subject || '(no subject)'}`,
    createdAt: t.properties.createdate,
    url: `https://app.hubspot.com/contacts/${PORTAL_ID}/ticket/${t.id}`,
  }));
}

// v2.1: third source — invoices that DID reach Xero as a Draft, but
// have sat un-authorised past 3 business days (flagged by the
// separate xero-draft-check.js cron, which owns the actual Xero API
// call — this file only ever reads the flag it already wrote to
// HubSpot, never talks to Xero directly).
async function getStuckXeroDrafts() {
  const data = await hubspotPost('/crm/v3/objects/0-53/search', {
    limit: 100,
    properties: ['supplier_invoice_number', 'xero_invoice_number', 'createdate'],
    filterGroups: [
      { filters: [{ propertyName: 'xero_draft_stuck', operator: 'EQ', value: 'true' }] },
    ],
    sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
  });
  return (data.results || []).map((r) => ({
    kind: 'xero_draft_stuck',
    id: r.id,
    subject: `Xero draft stuck: ${r.properties.xero_invoice_number || r.properties.supplier_invoice_number || '(invoice ' + r.id + ')'} not yet authorised`,
    createdAt: r.properties.createdate,
    url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-53/${r.id}`,
  }));
}

export default async function handler(req, res) {
  if (!HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_SERVICE_KEY not configured' });
  }

  try {
    const [needsReview, overdue, stuckDrafts] = await Promise.all([
      getNeedsReviewInvoices(),
      getOverdueTickets(),
      getStuckXeroDrafts(),
    ]);

    const combined = [...needsReview, ...overdue, ...stuckDrafts].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    return res.status(200).json({
      status: 'ok',
      checkedAt: new Date().toISOString(),
      openCount: combined.length,
      tickets: combined,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
