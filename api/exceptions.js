// FWS Command Center — Exceptions & Alerts Feed
// v1.1 — 17 Aug 2026
// v1.1: FIX — was using GET /crm/v3/objects/tickets with a `sorts`
//   query param, which that endpoint silently ignores (sorting is
//   only supported on the Search endpoint). This meant we were
//   pulling an arbitrary batch of tickets instead of the true most
//   recent ones — some genuinely old still-open tickets were showing
//   up while truly recent ones may have been missed. Now uses
//   POST /crm/v3/objects/tickets/search, which properly supports
//   sorting by createdate.
// v1.0: Pulls open HubSpot tickets (Agent 2/3 already create tickets
//   specifically when something needs human attention — failed
//   invoices, Client Not Found, overdue checks, etc.) so "open
//   tickets" genuinely IS the exceptions feed, no separate logic
//   needed. Closed-vs-open detection confirmed correct against this
//   portal's real pipeline metadata (isClosed / ticketState fields).

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

async function getRecentTickets() {
  // v1.1 FIX: the plain GET list endpoint doesn't actually support a
  // `sorts` query param (that's a Search-API-only feature) — it was
  // silently ignored, so v1.0 returned an arbitrary batch of tickets
  // rather than the true most-recent ones. Using the real Search
  // endpoint here instead, which does support sorting properly.
  const properties = ['subject', 'hs_pipeline_stage', 'createdate', 'hs_ticket_priority'];
  const data = await hubspotPost('/crm/v3/objects/tickets/search', {
    limit: 100,
    properties,
    sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
  });
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
