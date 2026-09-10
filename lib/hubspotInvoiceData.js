// ================================================================
// FWS Command Center — shared HubSpot invoice data helpers
// Deploy as: lib/hubspotInvoiceData.js
// ================================================================
// Version: v1.0
//
// Extracted from margin-by-client.js so revenue-by-client.js (and
// whatever comes after) can reuse the same proven fetching logic
// instead of duplicating it — same principle used throughout this
// whole build (e.g. clv-invoice-automation's exported Xero functions).
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

  const batchResp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/line_items/batch/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // hs_sku doubles as the GL/revenue account code (see
      // clv-invoice-automation webhook.js v5.5.57Agent) — reusing it
      // here lets revenue-by-waste-type work without any new data.
      properties: ['quantity', 'price', 'hs_cost_of_goods_sold', 'hs_sku', 'name'],
      inputs: lineItemIds.map((id) => ({ id })),
    }),
  });
  if (!batchResp.ok) {
    const errText = await batchResp.text();
    throw new Error(`Could not batch-read line_items for invoice ${invoiceId} (${batchResp.status}): ${errText}`);
  }
  const batchData = await batchResp.json();
  return batchData.results || [];
}

export function resolvePeriod(query) {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const fromMs = query?.from ? new Date(query.from).getTime() : defaultFrom.getTime();
  const toMs = query?.to ? new Date(query.to).getTime() : now.getTime();
  return { fromMs, toMs };
}
