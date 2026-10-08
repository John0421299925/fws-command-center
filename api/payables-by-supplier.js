// ================================================================
// FWS Command Center — Payables by Supplier (what suppliers billed us)
// Deploy as: api/payables-by-supplier.js
// ================================================================
// Version: v1.0
//
// PURPOSE: the supplier-by-supplier breakdown behind the "Payables"
// card that sits beside Revenue on the dashboard (index.html v1.38/
// v1.39). For the chosen period it totals, per supplier, the cost on
// the passed HubSpot invoices — i.e. what each supplier billed FWS
// through the invoice automation, paid or not (the UNPAID balance is
// a different question, answered by the Xero-based ap-aging.js) — and
// alongside it the revenue FWS billed its clients on those same
// invoices, so each supplier's margin is visible too.
//
// HOW THE SUPPLIER IS KNOWN: every invoice's dedupe_key embeds the
// supplier's plain-text name — "<id>|<Supplier name>|<invoice no>",
// e.g. "140627290595|Remondis Australia Pty Ltd|2636094" — written by
// clv-invoice-automation since the dedupe_key fix of 1 Aug 2026. This
// is deliberately NOT read from a vendor-company association: those
// are known to be missing on real invoices (confirmed 16 Sept 2026),
// whereas dedupe_key is reliable. Invoices created before dedupe_key
// existed (or without one) are not guessed at: they are grouped under
// "Unknown supplier" so the total still reconciles.
//
// HOW IT RECONCILES: it follows exactly the same rules as the
// Payables card (the "cost" figures margin-by-client.js returns):
// the same passed invoices for the same period, only invoices whose
// client company resolves are counted, and cost on a line is
// quantity x hs_cost_of_goods_sold. So the total here equals the
// Payables card, and the dashboard says so (or flags a difference).
//
// Built on the same shared lib/hubspotInvoiceData.js as
// margin-by-client.js and revenue-by-client.js; nothing in that file
// needed to change. The only new HubSpot call is one batch read of
// the invoices' dedupe_key (chunks of 100, HubSpot's hard cap, with
// the same 429 retry used elsewhere).
//
// Usage: GET /api/payables-by-supplier?period=month|ytd|fy
//   or:  GET /api/payables-by-supplier?from=2026-09-01&to=2026-09-30
// Admin only, same as revenue-by-client.js: this is company-wide.
// ================================================================

import { verifySession } from '../lib/auth.js';
import { fetchPassedInvoices, getClientCompany, getLineItemsForInvoice, resolvePeriod } from '../lib/hubspotInvoiceData.js';

const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;
const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const UNKNOWN_SUPPLIER = 'Unknown supplier (no supplier on the invoice record)';

// Same 429 handling already used in hubspotInvoiceData.js, market-
// opportunity.js and exceptions.js (that copy is not exported, and
// this endpoint should not depend on changing a shared file).
async function fetchWithRetry(url, options, maxAttempts = 3) {
  let attempt = 0;
  let waitMs = 1000;
  while (true) {
    const resp = await fetch(url, options);
    if (resp.status !== 429) return resp;
    attempt++;
    if (attempt >= maxAttempts) return resp;
    const retryAfterHeader = resp.headers && resp.headers.get ? resp.headers.get('Retry-After') : null;
    const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : waitMs;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    waitMs *= 2;
  }
}

// invoice id -> dedupe_key, read 100 at a time (HubSpot's batch cap).
async function readDedupeKeys(invoiceIds) {
  const keys = new Map();
  const CHUNK_SIZE = 100;
  for (let i = 0; i < invoiceIds.length; i += CHUNK_SIZE) {
    const chunk = invoiceIds.slice(i, i + CHUNK_SIZE);
    const resp = await fetchWithRetry(`${HUBSPOT_API_BASE}/crm/v3/objects/0-53/batch/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: ['dedupe_key'], inputs: chunk.map((id) => ({ id })) }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Could not read invoice dedupe keys (${resp.status}): ${errText}`);
    }
    const data = await resp.json();
    for (const r of data.results || []) {
      keys.set(String(r.id), (r.properties && r.properties.dedupe_key) || '');
    }
  }
  return keys;
}

// "<id>|<Supplier name>|<invoice no>" -> "Supplier name", or '' when
// the key is missing or not in that shape.
export function supplierFromDedupeKey(dedupeKey) {
  const parts = String(dedupeKey || '').split('|');
  if (parts.length < 3) return '';
  return parts[1].replace(/\s+/g, ' ').trim();
}

const round2 = (n) => Math.round(n * 100) / 100;

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }
  if (session.role !== 'admin') {
    return res.status(403).json({ status: 'error', error: 'This view is company-wide and restricted to admin accounts' });
  }

  if (!process.env.HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_SERVICE_KEY not configured' });
  }

  try {
    const { fromMs, toMs, periodLabel } = resolvePeriod(req.query);
    const invoices = await fetchPassedInvoices(fromMs, toMs);

    // Same rule as margin-by-client.js: an invoice only counts once
    // its client company resolves. Keeping this identical is what
    // makes the total here equal the Payables card.
    const companyNameCache = new Map();
    const counted = [];
    for (const invoice of invoices) {
      const client = await getClientCompany(invoice.id, companyNameCache);
      if (client) counted.push(invoice);
    }

    const dedupeKeys = await readDedupeKeys(counted.map((inv) => String(inv.id)));

    // Group on a case/space-insensitive key, show the name as first seen.
    const bySupplier = new Map();
    let totalPayables = 0;
    let totalRevenue = 0;
    let costedRevenue = 0;

    for (const invoice of counted) {
      const supplierName = supplierFromDedupeKey(dedupeKeys.get(String(invoice.id))) || UNKNOWN_SUPPLIER;
      const groupKey = supplierName.toLowerCase();
      if (!bySupplier.has(groupKey)) {
        bySupplier.set(groupKey, { name: supplierName, payables: 0, revenue: 0, costedRevenue: 0, invoiceCount: 0 });
      }
      const entry = bySupplier.get(groupKey);
      entry.invoiceCount++;

      const lineItems = await getLineItemsForInvoice(invoice.id);
      for (const li of lineItems) {
        const qty = parseFloat(li.properties.quantity) || 0;
        const price = parseFloat(li.properties.price) || 0;
        const unitCost = parseFloat(li.properties.hs_cost_of_goods_sold) || 0;
        const lineRevenue = qty * price;
        const lineCost = qty * unitCost;

        entry.payables += lineCost;
        entry.revenue += lineRevenue;
        totalPayables += lineCost;
        totalRevenue += lineRevenue;
        if (unitCost > 0) {
          entry.costedRevenue += lineRevenue;
          costedRevenue += lineRevenue;
        }
      }
    }

    const suppliers = [...bySupplier.values()].map((s) => ({
      name: s.name,
      payables: round2(s.payables),
      percentOfTotal: totalPayables > 0 ? Math.round((s.payables / totalPayables) * 1000) / 10 : 0,
      revenue: round2(s.revenue),
      marginPercent: s.revenue > 0 ? Math.round(((s.revenue - s.payables) / s.revenue) * 1000) / 10 : null,
      invoiceCount: s.invoiceCount,
      costDataCoveragePercent: s.revenue > 0 ? Math.round((s.costedRevenue / s.revenue) * 100) : 100,
      isUnknown: s.name === UNKNOWN_SUPPLIER,
    })).sort((a, b) => {
      // Unknown always last, otherwise biggest payables first.
      if (a.isUnknown !== b.isUnknown) return a.isUnknown ? 1 : -1;
      return b.payables - a.payables;
    });

    return res.status(200).json({
      status: 'ok',
      periodFrom: new Date(fromMs).toISOString().split('T')[0],
      periodTo: new Date(toMs).toISOString().split('T')[0],
      periodLabel,
      totalPayables: round2(totalPayables),
      totalRevenue: round2(totalRevenue),
      invoiceCount: counted.length,
      supplierCount: suppliers.filter((s) => !s.isUnknown).length,
      costDataCoveragePercent: totalRevenue > 0 ? Math.round((costedRevenue / totalRevenue) * 100) : 100,
      suppliers,
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
