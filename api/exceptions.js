// FWS Command Center — Exceptions & Alerts Feed
// v2.0 — 17 Aug 2026
// v2.0: REBUILT on the real signals, per John's correction — "open
//   ticket" was too broad (most open tickets are just normal in-
//   flight invoices moving through Invoiced→Payment stages, not
//   exceptions). The two genuine exception sources are:
//     1. Agent 2's flag: Invoice records (object 0-53) with
//        validation_status = "Needs Review" (SP pricing variance,
//        services not found, etc.) — NOT a ticket. Agent 2's own
//        ticket-creation step for these has a known unresolved bug,
//        so checking tickets alone would miss these entirely.
//     2. Agent 3's flag: tickets sitting in the "Overdue" pipeline
//        stage (confirmed id 3506368961 in this portal) — drafts
//        that sat in Xero too long without completing.
// v1.x: showed ALL open tickets — too noisy, superseded by this.

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

export default async function handler(req, res) {
  if (!HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_SERVICE_KEY not configured' });
  }

  try {
    const [needsReview, overdue] = await Promise.all([
      getNeedsReviewInvoices(),
      getOverdueTickets(),
    ]);

    const combined = [...needsReview, ...overdue].sort(
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
