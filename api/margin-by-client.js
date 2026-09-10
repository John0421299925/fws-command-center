// ================================================================
// FWS Command Center — Margin by Client
// Deploy as: api/margin-by-client.js
// ================================================================
// Version: v1.0
//
// PURPOSE: the first real piece of the "Business Vital Signs" card.
// Genuine per-client margin, calculated entirely from data already
// sitting in HubSpot — no re-parsing supplier PDFs, no Xero needed at
// all — thanks to webhook.js v5.5.65Agent now persisting the real
// supplier cost onto each line item's native hs_cost_of_goods_sold
// field, alongside the client price that was already there.
//
// Margin per client = (sum of client prices - sum of supplier costs)
//                      / sum of client prices
//
// Only counts invoices with validation_status = "Passed" — anything
// still "Needs Review" hasn't been confirmed correct yet and shouldn't
// count toward a real margin figure.
//
// NOTE: this only reflects invoices created SINCE webhook.js
// v5.5.65Agent went live (9 Sept 2026) — older line items were never
// given a cost_of_goods_sold value, so early results will be thin
// until real invoice history accumulates.
//
// Usage: GET /api/margin-by-client?from=2026-09-01&to=2026-09-30
// Defaults to the start of the current calendar month through now.
// ================================================================

const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;
const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const PORTAL_ID = '441953864';

// Same 15.5% minimum markup already used throughout the invoice
// automation — a client sitting below this is a genuine flag.
const MARGIN_TARGET_PERCENT = 15.5;

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

async function fetchPassedInvoices(fromMs, toMs) {
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

async function getAssociatedCompanies(invoiceId) {
  const resp = await fetch(`${HUBSPOT_API_BASE}/crm/v4/objects/invoices/${invoiceId}/associations/companies`, {
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.results || [];
}

async function getCompanyName(companyId, companyNameCache) {
  if (companyNameCache.has(companyId)) return companyNameCache.get(companyId);
  const resp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/companies/${companyId}?properties=name,type`, {
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const type = (data.properties.type || '').toLowerCase();
  const result = type.includes('client') ? { id: companyId, name: data.properties.name } : null;
  companyNameCache.set(companyId, result);
  return result;
}

async function getLineItemsForInvoice(invoiceId) {
  const assocResp = await fetch(`${HUBSPOT_API_BASE}/crm/v4/objects/invoices/${invoiceId}/associations/line_items`, {
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
  });
  if (!assocResp.ok) return [];
  const assocData = await assocResp.json();
  const lineItemIds = (assocData.results || []).map((r) => r.toObjectId);
  if (lineItemIds.length === 0) return [];

  const batchResp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/line_items/batch/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: ['quantity', 'price', 'hs_cost_of_goods_sold'],
      inputs: lineItemIds.map((id) => ({ id })),
    }),
  });
  if (!batchResp.ok) return [];
  const batchData = await batchResp.json();
  return batchData.results || [];
}

export default async function handler(req, res) {
  if (!HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_SERVICE_KEY not configured' });
  }

  try {
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    const fromMs = req.query?.from ? new Date(req.query.from).getTime() : defaultFrom.getTime();
    const toMs = req.query?.to ? new Date(req.query.to).getTime() : now.getTime();

    const invoices = await fetchPassedInvoices(fromMs, toMs);

    const companyNameCache = new Map();
    const byClient = new Map(); // clientId -> { name, revenue, cost, invoiceCount, lineItemsWithCost, lineItemsTotal }

    for (const invoice of invoices) {
      const companies = await getAssociatedCompanies(invoice.id);
      let client = null;
      for (const c of companies) {
        const found = await getCompanyName(c.toObjectId, companyNameCache);
        if (found) { client = found; break; }
      }
      if (!client) continue; // no client company found — skip, don't guess

      const lineItems = await getLineItemsForInvoice(invoice.id);
      if (!byClient.has(client.id)) {
        byClient.set(client.id, { name: client.name, revenue: 0, cost: 0, invoiceCount: 0, lineItemsWithCost: 0, lineItemsTotal: 0 });
      }
      const entry = byClient.get(client.id);
      entry.invoiceCount++;

      for (const li of lineItems) {
        const qty = parseFloat(li.properties.quantity) || 0;
        const price = parseFloat(li.properties.price) || 0;
        const cogs = li.properties.hs_cost_of_goods_sold;
        entry.revenue += qty * price;
        entry.lineItemsTotal++;
        if (cogs !== undefined && cogs !== null && cogs !== '') {
          entry.cost += qty * parseFloat(cogs);
          entry.lineItemsWithCost++;
        }
      }
    }

    const clients = [...byClient.values()].map((c) => {
      const marginPercent = c.revenue > 0 ? ((c.revenue - c.cost) / c.revenue) * 100 : null;
      return {
        name: c.name,
        revenue: Math.round(c.revenue * 100) / 100,
        cost: Math.round(c.cost * 100) / 100,
        marginPercent: marginPercent !== null ? Math.round(marginPercent * 10) / 10 : null,
        belowTarget: marginPercent !== null ? marginPercent < MARGIN_TARGET_PERCENT : null,
        invoiceCount: c.invoiceCount,
        // Flags when older line items (pre-v5.5.65Agent, no cost data)
        // are diluting this client's figure — a low coverage % means
        // "trust this number less, not enough real cost data yet".
        costDataCoveragePercent: c.lineItemsTotal > 0 ? Math.round((c.lineItemsWithCost / c.lineItemsTotal) * 1000) / 10 : 0,
      };
    }).sort((a, b) => (a.marginPercent ?? 999) - (b.marginPercent ?? 999));

    return res.status(200).json({
      status: 'ok',
      periodFrom: new Date(fromMs).toISOString().split('T')[0],
      periodTo: new Date(toMs).toISOString().split('T')[0],
      marginTargetPercent: MARGIN_TARGET_PERCENT,
      clientCount: clients.length,
      clients,
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
