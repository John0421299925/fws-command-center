// ================================================================
// FWS Command Center — Margin by Client
// Deploy as: api/margin-by-client.js
// ================================================================
// Version: v1.2
//
// PURPOSE: genuine per-client margin, calculated entirely from data
// already sitting in HubSpot — no re-parsing supplier PDFs, no Xero
// needed — thanks to webhook.js v5.5.65Agent persisting the real
// supplier cost onto each line item's native hs_cost_of_goods_sold
// field, alongside the client price that was already there.
//
// Margin per client = (sum of client prices - sum of supplier costs)
//                      / sum of client prices
//
// Only counts invoices with validation_status = "Passed". Confirmed
// working against a real invoice (CLV UNSW Kensington, 10 Sept 2026):
// revenue and cost matched the real Xero draft and Veryfi logs
// exactly, margin calculated correctly, belowTarget flag fired
// correctly.
//
// v1.1: fixed a silent failure that was masking a real permissions
// gap (Command Center's HubSpot key was missing line_items read
// scope) — errors now surface instead of quietly returning zeros.
// v1.2: refactored to use the shared lib/hubspotInvoiceData.js module
// instead of duplicating invoice/line-item fetching logic, now that
// revenue-by-client.js needs the exact same underlying data.
//
// Usage: GET /api/margin-by-client?from=2026-09-01&to=2026-09-30
// Defaults to the start of the current calendar month through now.
// ================================================================

import { fetchPassedInvoices, getClientCompany, getLineItemsForInvoice, resolvePeriod } from '../lib/hubspotInvoiceData.js';

const MARGIN_TARGET_PERCENT = 15.5;

export default async function handler(req, res) {
  if (!process.env.HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_SERVICE_KEY not configured' });
  }

  try {
    const { fromMs, toMs } = resolvePeriod(req.query);
    const invoices = await fetchPassedInvoices(fromMs, toMs);

    const companyNameCache = new Map();
    const byClient = new Map();

    for (const invoice of invoices) {
      const client = await getClientCompany(invoice.id, companyNameCache);
      if (!client) continue;

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
