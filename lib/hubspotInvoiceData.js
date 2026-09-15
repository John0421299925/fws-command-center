// ================================================================
// FWS Command Center — Shared HubSpot Invoice Data helpers
// Deploy as: lib/hubspotInvoiceData.js
// ================================================================
// Version: v1.2
//
// v1.2: FIX — getLineItemsForInvoice() now chunks its batch-read into
// groups of 100 (HubSpot's hard per-request cap), same fix already
// applied to approve.js's fetchCurrentLineItems() for the identical
// limit. Confirmed real: invoice 717716410843 (Glenrose, 123 line
// items) 400'd the moment it entered this month's query for the
// first time. See batchReadLineItems() below.
//
// v1.1: resolvePeriod() now understands a `period` shortcut
// (?period=month|ytd|fy) alongside the existing explicit ?from=&to=
// override, per John's request to switch Revenue/Blended Margin
// between "this month", calendar year-to-date, and Australian
// financial-year-to-date (1 July - 30 June) from a dropdown on the
// dashboard. Explicit from/to still wins if both are given — the
// shortcut only decides the DEFAULT from date when neither is
// supplied. Also now returns periodLabel so callers (and the
// dashboard) don't need to duplicate the same month/ytd/fy
// human-readable naming logic themselves.
//
// Shared logic used by margin-by-client.js and revenue-by-client.js,
// so invoice/line-item fetching isn't duplicated across endpoints
// (same principle as clv-invoice-automation's exported Xero
// functions).
// ================================================================

const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;
const HUBSPOT_API_BASE = 'https://api.hubapi.com';

async function hubspotPost(path, body) {
  const resp = await fetch(`${HUBSPOT_API_BASE}${path}`, {
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

export async function fetchPassedInvoices(fromMs, toMs) {
  const results = [];
  let after = undefined;
  for (let page = 0; page < 20; page++) {
    const data = await hubspotPost('/crm/v3/objects/0-53/search', {
      limit: 100,
      after,
      properties: ['hs_title', 'validation_status', 'hs_createdate'],
      filterGroups: [{
        filters: [
          { propertyName: 'validation_status', operator: 'EQ', value: 'Passed' },
          { propertyName: 'hs_createdate', operator: 'GTE', value: String(fromMs) },
          { propertyName: 'hs_createdate', operator: 'LTE', value: String(toMs) },
        ],
      }],
    });
    results.push(...(data.results || []));
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return results;
}

export async function getAssociatedCompanies(invoiceId) {
  const resp = await fetch(`${HUBSPOT_API_BASE}/crm/v4/objects/invoices/${invoiceId}/associations/companies`, {
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.results || [];
}

export async function getClientCompany(invoiceId, companyNameCache) {
  const companies = await getAssociatedCompanies(invoiceId);
  for (const c of companies) {
    if (companyNameCache.has(c.toObjectId)) {
      const cached = companyNameCache.get(c.toObjectId);
      if (cached) return cached;
      continue;
    }
    const resp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/companies/${c.toObjectId}?properties=name,type`, {
      headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    const type = (data.properties.type || '').toLowerCase();
    const result = type.includes('client') ? { id: c.toObjectId, name: data.properties.name } : null;
    companyNameCache.set(c.toObjectId, result);
    if (result) return result;
  }
  return null;
}

// v1.2: FIX — real incident, confirmed by John running the live
// dashboard: invoice 717716410843 (Glenrose Village, 123 line items —
// the same invoice that hit approve.js's identical limit earlier)
// returned a 400 the moment its validation_status flipped to
// "Passed" and it entered this month's query for the first time.
// HubSpot's batch/read endpoint hard-caps at 100 inputs per call —
// this function was never given the same chunking fix already
// applied to approve.js's fetchCurrentLineItems(), since it's a
// separate file. Fixed the same way: split into chunks of 100 and
// concatenate the results, rather than sending every ID in one call.
async function batchReadLineItems(lineItemIds) {
  const CHUNK_SIZE = 100;
  const allResults = [];
  for (let i = 0; i < lineItemIds.length; i += CHUNK_SIZE) {
    const chunk = lineItemIds.slice(i, i + CHUNK_SIZE);
    const batchResp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/line_items/batch/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // hs_sku doubles as the GL/revenue account code (see
        // clv-invoice-automation webhook.js v5.5.57Agent) — reused by
        // revenue-by-client.js for the waste-type breakdown, no new
        // data needed.
        properties: ['quantity', 'price', 'hs_cost_of_goods_sold', 'hs_sku', 'name'],
        inputs: chunk.map((id) => ({ id })),
      }),
    });
    if (!batchResp.ok) {
      const errText = await batchResp.text();
      throw new Error(`Could not batch-read line_items chunk starting at index ${i} (${batchResp.status}): ${errText}`);
    }
    const batchData = await batchResp.json();
    allResults.push(...(batchData.results || []));
  }
  return allResults;
}

export async function getLineItemsForInvoice(invoiceId) {
  const assocResp = await fetch(`${HUBSPOT_API_BASE}/crm/v4/objects/invoices/${invoiceId}/associations/line_items`, {
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
  });
  if (!assocResp.ok) {
    const errText = await assocResp.text();
    throw new Error(`Could not read line_items association for invoice ${invoiceId} (${assocResp.status}): ${errText}`);
  }
  const assocData = await assocResp.json();
  const lineItemIds = (assocData.results || []).map((r) => r.toObjectId);
  if (lineItemIds.length === 0) return [];

  try {
    return await batchReadLineItems(lineItemIds);
  } catch (error) {
    throw new Error(`Could not batch-read line_items for invoice ${invoiceId}: ${error.message}`);
  }
}

// v1.1: `period` shortcuts. Explicit from/to (if BOTH given) still
// take precedence over the shortcut entirely — this only changes what
// the DEFAULT from-date is when the caller hasn't specified one.
export function resolvePeriod(query) {
  const now = new Date();
  const period = query?.period || 'month';

  let defaultFrom;
  let periodLabel;

  if (period === 'ytd') {
    // Calendar year-to-date: 1 Jan through now.
    defaultFrom = new Date(now.getFullYear(), 0, 1);
    periodLabel = 'year to date';
  } else if (period === 'fy') {
    // Australian financial year: 1 July - 30 June. If we're
    // currently in Jan-Jun, the current FY started 1 July LAST
    // calendar year; if Jul-Dec, it started 1 July THIS year.
    const fyStartYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    defaultFrom = new Date(fyStartYear, 6, 1);
    periodLabel = 'FY to date';
  } else {
    // 'month' (default, and the fallback for any unrecognised value)
    defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    periodLabel = 'this month';
  }

  const fromMs = query?.from ? new Date(query.from).getTime() : defaultFrom.getTime();
  const toMs = query?.to ? new Date(query.to).getTime() : now.getTime();

  // If the caller passed explicit from/to, the shortcut label no
  // longer describes the actual range accurately — fall back to a
  // generic label rather than mislabel a custom range as "FY to date".
  const explicitRange = Boolean(query?.from || query?.to);

  return { fromMs, toMs, periodLabel: explicitRange ? 'custom range' : periodLabel };
}
