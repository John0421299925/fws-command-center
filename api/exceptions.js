// FWS Command Center — Exceptions & Alerts Feed
// v1.0 — 17 Aug 2026
// Pulls open HubSpot tickets (Agent 2/3 already create tickets
// specifically when something needs human attention — failed
// invoices, Client Not Found, overdue checks, etc.) so "open tickets"
// genuinely IS the exceptions feed, no separate logic needed.
//
// To correctly tell "open" from "closed" we first ask HubSpot for the
// real ticket pipeline stage setup (every portal can configure this
// differently) rather than guessing at stage names.

const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;
const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const PORTAL_ID = '441953864';

async function hubspotFetch(path) {
  const resp = await fetch(`${HUBSPOT_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`HubSpot API error (${resp.status}): ${errText}`);
  }
  return resp.json();
}

async function getClosedStageIds() {
  const data = await hubspotFetch('/crm/v3/pipelines/tickets');
  const closedIds = new Set();
  for (const pipeline of data.results || []) {
    for (const stage of pipeline.stages || []) {
      const isClosed =
        stage.metadata?.isClosed === 'true' ||
        stage.metadata?.ticketState === 'CLOSED' ||
        /closed/i.test(stage.label || '');
      if (isClosed) closedIds.add(stage.id);
    }
  }
  return closedIds;
}

async function getRecentTickets() {
  const properties = ['subject', 'hs_pipeline_stage', 'createdate', 'hs_ticket_priority'];
  const data = await hubspotFetch(
    `/crm/v3/objects/tickets?limit=100&properties=${properties.join(',')}&sorts=-createdate`
  );
  return data.results || [];
}

export default async function handler(req, res) {
  if (!HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_SERVICE_KEY not configured' });
  }

  try {
    const [closedStageIds, tickets] = await Promise.all([
      getClosedStageIds(),
      getRecentTickets(),
    ]);

    const openTickets = tickets
      .filter((t) => !closedStageIds.has(t.properties.hs_pipeline_stage))
      .slice(0, 20)
      .map((t) => ({
        id: t.id,
        subject: t.properties.subject || '(no subject)',
        priority: t.properties.hs_ticket_priority || null,
        createdAt: t.properties.createdate,
        url: `https://app.hubspot.com/contacts/${PORTAL_ID}/ticket/${t.id}`,
      }));

    return res.status(200).json({
      status: 'ok',
      checkedAt: new Date().toISOString(),
      openCount: openTickets.length,
      tickets: openTickets,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
