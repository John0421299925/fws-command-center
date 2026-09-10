// ================================================================
// FWS Command Center — Revenue by Client
// Deploy as: api/revenue-by-client.js
// ================================================================
// Version: v1.0
//
// PURPOSE: the second piece of the "Business Vital Signs" card —
// revenue per client, sorted highest first, plus each client's share
// of total revenue (concentration risk — flagged once a single client
// crosses 20%, the threshold multiple industry sources agree marks
// real dependency exposure), and a revenue-by-waste-type breakdown
// using the GL code already sitting on each line item (hs_sku) — no
// new data needed, same field webhook.js already persists.
//
// Built on the same shared lib/hubspotInvoiceData.js as
// margin-by-client.js, rather than duplicating the invoice/line-item
// fetching logic a second time.
//
// Usage: GET /api/revenue-by-client?from=2026-09-01&to=2026-09-30
// Defaults to the start of the current calendar month through now.
// ================================================================

import { fetchPassedInvoices, getClientCompany, getLineItemsForInvoice, resolvePeriod } from '../lib/hubspotInvoiceData.js';

// Multiple independent sources agree: a single client above ~20-25%
// of total revenue is where real concentration exposure begins.
const CONCENTRATION_RISK_THRESHOLD_PERCENT = 20;

export default async function handler(req, res) {
  if (!process.env.HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_SERVICE_KEY not configured' });
  }

  try {
    const { fromMs, toMs } = resolvePeriod(req.query);
    const invoices = await fetchPassedInvoices(fromMs, toMs);

    const companyNameCache = new Map();
    const byClient = new Map();
    const byWasteType = new Map();
    let totalRevenue = 0;

    for (const invoice of invoices) {
      const client = await getClientCompany(invoice.id, companyNameCache);
      if (!client) continue;

      const lineItems = await getLineItemsForInvoice(invoice.id);
      if (!byClient.has(client.id)) {
        byClient.set(client.id, { name: client.name, revenue: 0, invoiceCount: 0 });
      }
      const entry = byClient.get(client.id);
      entry.invoiceCount++;

      for (const li of lineItems) {
        const qty = parseFloat(li.properties.quantity) || 0;
        const price = parseFloat(li.properties.price) || 0;
        const lineRevenue = qty * price;
        entry.revenue += lineRevenue;
        totalRevenue += lineRevenue;

        // hs_sku carries the GL/revenue account code (e.g. "202
        // General Waste") — already persisted by webhook.js, reused
        // here as a ready-made waste-type grouping key rather than
        // parsing line item descriptions ourselves.
        const wasteType = li.properties.hs_sku || 'Uncategorised';
        byWasteType.set(wasteType, (byWasteType.get(wasteType) || 0) + lineRevenue);
      }
    }

    const clients = [...byClient.values()].map((c) => {
      const revenue = Math.round(c.revenue * 100) / 100;
      const percentOfTotal = totalRevenue > 0 ? Math.round((c.revenue / totalRevenue) * 1000) / 10 : 0;
      return {
        name: c.name,
        revenue,
        percentOfTotal,
        concentrationRisk: percentOfTotal >= CONCENTRATION_RISK_THRESHOLD_PERCENT,
        invoiceCount: c.invoiceCount,
      };
    }).sort((a, b) => b.revenue - a.revenue);

    const revenueByWasteType = [...byWasteType.entries()]
      .map(([wasteType, revenue]) => ({
        wasteType,
        revenue: Math.round(revenue * 100) / 100,
        percentOfTotal: totalRevenue > 0 ? Math.round((revenue / totalRevenue) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    return res.status(200).json({
      status: 'ok',
      periodFrom: new Date(fromMs).toISOString().split('T')[0],
      periodTo: new Date(toMs).toISOString().split('T')[0],
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      concentrationRiskThresholdPercent: CONCENTRATION_RISK_THRESHOLD_PERCENT,
      clientCount: clients.length,
      clients,
      revenueByWasteType,
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
