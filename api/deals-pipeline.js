// ================================================================
// FWS Command Center — Shared HubSpot Deals & Churn helpers
// Deploy as: lib/hubspotDealsData.js
// ================================================================
// Version: v1.2
//
// v1.2: FIX - real incident (24 Sept 2026): the churn revenue
// estimate in deals-pipeline.js was scanning EVERY passed invoice
// company-wide over a 90-day window just to check which ones
// belonged to a handful of churned companies. Call volume was heavy
// enough to exhaust the HubSpot key's per-second rate limit for the
// WHOLE page — confirmed directly in HubSpot's own API call log,
// which showed "You have reached your secondly limit" — taking down
// completely unrelated, previously-reliable cards (Quotes awaiting
// approval) as collateral damage, not just its own. Added
// getInvoiceIdsForCompany()/batchReadInvoiceSummaries(): looks up
// ONLY the churned companies' own invoices directly via a reverse
// association, instead of scanning everyone's. See
// getInvoiceIdsForCompany()'s own comment for the full reasoning.
//
// PURPOSE: shared logic for the new Deal Pipeline dashboard (admin
// view) and the rep-facing pipeline leaderboard — real HubSpot Deals
// data (73 real deals confirmed in this portal, owned by John Murray
// and James Whelan today), plus a churn signal built on two real,
// confirmed fields John already uses manually:
//   - Company.type = "No Longer a Client" — a full account loss
//   - Services.service_status = "Cancelled" — one service dropped,
//     not necessarily the whole account (not yet used by v1.0's
//     churn card below, which only counts full account loss; kept
//     here as a documented extension point since John specifically
//     flagged it as the more granular signal)
//
// Follows the exact same shared-module pattern as
// lib/hubspotInvoiceData.js (used by margin-by-client.js /
// revenue-by-client.js) — one place for the HubSpot calls, reused by
// both the admin and rep-facing endpoints, so they can never quietly
// disagree about how a number is calculated.
//
// Every HubSpot POST goes through fetchWithRetry() — applied
// proactively here, not after a real failure, given the two
// confirmed 429 incidents already found this week in
// market-opportunity.js and exceptions.js, both fixed the same way.
// ================================================================

const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;
const HUBSPOT_API_BASE = 'https://api.hubapi.com';

// Same retry helper as market-opportunity.js v1.1 / exceptions.js
// v2.4 — recognises a HubSpot 429 specifically, respects Retry-After
// when present, retries up to 3 times before giving up. Any other
// non-ok response is not retried.
async function fetchWithRetry(url, options, maxAttempts = 3) {
  let attempt = 0;
  let waitMs = 1000;

  while (true) {
    const resp = await fetch(url, options);
    if (resp.status !== 429) return resp;

    attempt++;
    if (attempt >= maxAttempts) return resp;

    const retryAfterHeader = resp.headers.get('Retry-After');
    const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : waitMs;
    console.log(`⏳ HubSpot rate-limited (429) — retrying in ${Math.round(retryAfterMs)}ms (attempt ${attempt}/${maxAttempts})`);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    waitMs *= 2;
  }
}

async function hubspotPost(path, body) {
  const resp = await fetchWithRetry(`${HUBSPOT_API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`HubSpot API error (${resp.status}): ${errText}`);
  }
  return resp.json();
}

async function hubspotGet(path) {
  const resp = await fetchWithRetry(`${HUBSPOT_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`HubSpot API error (${resp.status}): ${errText}`);
  }
  return resp.json();
}

// ----------------------------------------------------------------
// Pipeline stage labels — Deals stages come back from search as raw
// IDs (e.g. "1573434813"), never labels. Cached the same way Agent
// 2's own ticket-pipeline cache works (fws-hubspot-agent-a4be
// webhook.py, _get_ticket_pipeline()) — one hour TTL, refreshed
// lazily.
// ----------------------------------------------------------------
let dealPipelineCache = { pipelineId: null, stageLabelsById: {}, fetchedAt: 0 };
const PIPELINE_CACHE_TTL_MS = 60 * 60 * 1000;

async function getDealPipelineStages() {
  const now = Date.now();
  if (dealPipelineCache.pipelineId && (now - dealPipelineCache.fetchedAt) < PIPELINE_CACHE_TTL_MS) {
    return dealPipelineCache;
  }
  const data = await hubspotGet('/crm/v3/pipelines/deals');
  const pipelines = data.results || [];
  // Default pipeline — this portal only has one ("default"), per
  // memory (Quotation pipeline ID 2136460779 is a SEPARATE object,
  // not this one). Falls back to the first pipeline returned if a
  // literal "default" isn't found by that exact label.
  // v1.1: FIX — confirmed via a real screenshot of the HubSpot Deals
  // board (24 Sept 2026): the actual pipeline is named "Client
  // Acquisition pipeline", not "Sales Pipeline" (a guess, never
  // verified against real data — caught before deployment rather
  // than after, thanks to John checking the mockup against the real
  // board first). Real stages confirmed in the same screenshot:
  // Initial outreach, Needs assessment, Solution proposal, Solution
  // presentation, Objection handling, Finalizing terms, Closed
  // Won/Lost — none of which are hardcoded anywhere in this file,
  // since stage labels are always read live from this same API call.
  const chosen = pipelines.find((p) => p.label?.toLowerCase() === 'client acquisition pipeline') || pipelines[0];
  if (!chosen) throw new Error('No deal pipelines found on this HubSpot account');

  const stageLabelsById = {};
  for (const stage of chosen.stages || []) {
    stageLabelsById[stage.id] = stage.label;
  }

  dealPipelineCache = { pipelineId: chosen.id, stageLabelsById, fetchedAt: now };
  return dealPipelineCache;
}

// ----------------------------------------------------------------
// Owner names — same pattern as Agent 2's _refresh_owner_cache, just
// the read direction reversed (id → name here, name → id there,
// since each caller needs a different lookup shape).
// ----------------------------------------------------------------
let ownerCache = { byId: {}, fetchedAt: 0 };
const OWNER_CACHE_TTL_MS = 60 * 60 * 1000;

async function getOwnerNamesById() {
  const now = Date.now();
  if (Object.keys(ownerCache.byId).length > 0 && (now - ownerCache.fetchedAt) < OWNER_CACHE_TTL_MS) {
    return ownerCache.byId;
  }
  const byId = {};
  let after;
  do {
    const url = `/crm/v3/owners?limit=100${after ? `&after=${after}` : ''}`;
    const data = await hubspotGet(url);
    for (const owner of data.results || []) {
      byId[owner.id] = `${owner.firstName || ''} ${owner.lastName || ''}`.trim();
    }
    after = data.paging?.next?.after;
  } while (after);
  ownerCache = { byId, fetchedAt: now };
  return byId;
}

// ----------------------------------------------------------------
// Deals — fetches every deal in the pipeline, real amount/stage/
// owner/close-date/weighted-pipeline fields. No date filter here
// deliberately: open deals have no closedate to filter on, and the
// caller needs both open AND (for the won/lost cards) recently-closed
// deals in one pass. Callers filter by closedate themselves for the
// won/lost calculation.
// ----------------------------------------------------------------
async function fetchAllDeals() {
  const results = [];
  let after;
  do {
    const data = await hubspotPost('/crm/v3/objects/deals/search', {
      limit: 100,
      after,
      properties: [
        'dealname', 'amount', 'dealstage', 'pipeline', 'closedate',
        'hubspot_owner_id', 'hs_is_closed_won', 'hs_is_closed_lost',
        'hs_weighted_pipeline_in_company_currency',
      ],
    });
    results.push(...(data.results || []));
    after = data.paging?.next?.after;
  } while (after);
  return results;
}

// ----------------------------------------------------------------
// Churn — full account loss. Uses hs_lastmodifieddate as a proxy for
// "when this changed to No Longer a Client" — the real caveat, worth
// keeping visible rather than hiding: hs_lastmodifieddate updates on
// ANY property edit to the record, not specifically this one, so a
// company whose type was flipped weeks ago but had some unrelated
// field touched this month would be miscounted as churning THIS
// month. No dedicated "date type last changed" field exists in
// HubSpot to do this more precisely. Acceptable starting point, not
// a precise audit trail — revisit if this caveat ever matters enough
// to warrant a dedicated timestamp property written at the point the
// type is actually changed.
// ----------------------------------------------------------------
async function fetchChurnedCompanies(fromMs, toMs) {
  const data = await hubspotPost('/crm/v3/objects/companies/search', {
    limit: 100,
    filterGroups: [{
      filters: [
        { propertyName: 'type', operator: 'EQ', value: 'No Longer a Client' },
        { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(fromMs) },
        { propertyName: 'hs_lastmodifieddate', operator: 'LTE', value: String(toMs) },
      ],
    }],
    properties: ['name', 'hs_lastmodifieddate'],
  });
  return data.results || [];
}

// ----------------------------------------------------------------
// Direct, company-scoped invoice lookup — v1.2. Replaces the earlier
// approach of scanning EVERY passed invoice company-wide over a
// 90-day window just to check which ones happened to belong to a
// handful of churned companies. That scan was the real cause of a
// genuine incident (24 Sept 2026): the churn revenue estimate's call
// volume was heavy enough to exhaust the HubSpot key's per-second
// rate limit for the WHOLE page, taking down previously-reliable,
// completely unrelated cards (e.g. Quotes awaiting approval) as
// collateral damage — not just its own card. Churned companies are
// typically few (0-2 in this portal's real data), so looking up
// THEIR invoices directly is dramatically cheaper than scanning
// everyone's.
// ----------------------------------------------------------------
async function getInvoiceIdsForCompany(companyId) {
  const ids = [];
  let after;
  do {
    const url = `/crm/v4/objects/companies/${companyId}/associations/invoices${after ? `?after=${after}` : ''}`;
    const data = await hubspotGet(url);
    ids.push(...(data.results || []).map((r) => r.toObjectId));
    after = data.paging?.next?.after;
  } while (after);
  return ids;
}

async function batchReadInvoiceSummaries(invoiceIds) {
  if (invoiceIds.length === 0) return [];
  const CHUNK_SIZE = 100;
  const allResults = [];
  for (let i = 0; i < invoiceIds.length; i += CHUNK_SIZE) {
    const chunk = invoiceIds.slice(i, i + CHUNK_SIZE);
    const data = await hubspotPost('/crm/v3/objects/0-53/batch/read', {
      properties: ['validation_status', 'hs_createdate'],
      inputs: chunk.map((id) => ({ id })),
    });
    allResults.push(...(data.results || []));
  }
  return allResults;
}

export {
  fetchWithRetry,
  hubspotPost,
  hubspotGet,
  getDealPipelineStages,
  getOwnerNamesById,
  fetchAllDeals,
  fetchChurnedCompanies,
  getInvoiceIdsForCompany,
  batchReadInvoiceSummaries,
};
