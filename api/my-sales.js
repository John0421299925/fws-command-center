// ================================================================
// FWS Command Center — My Sales (rep-scoped revenue & margin)
// Deploy as: api/my-sales.js
// ================================================================
// Version: v1.0
//
// PURPOSE: the actual heart of the Sales Command Centre — a rep's own
// revenue and margin, scoped ONLY to client companies they personally
// own in HubSpot (hubspot_owner_id), driven entirely by who is
// logged in — never a URL parameter, never trusted from the client.
// This is the rep-scoped sibling of margin-by-client.js and
// revenue-by-client.js, which remain company-wide and admin-only.
//
// Reuses the exact same underlying helpers as the admin endpoints
// (fetchPassedInvoices, getClientCompany, getLineItemsForInvoice,
// resolvePeriod from lib/hubspotInvoiceData.js) so the numbers are
// guaranteed to be calculated the same way — only the filtering step
// differs: every invoice whose client's ownerId doesn't match the
// logged-in session's ownerId is simply skipped.
//
// Available to ANY logged-in session (admin or rep) — an admin
// (John, James) hitting this would just see their own personal book
// (5 and 37 client companies respectively, per the owner distribution
// confirmed 16 Sept 2026), which is a reasonable, harmless result,
// not something that needs blocking.
//
// Usage: GET /api/my-sales?period=month|ytd|fy
// Defaults to period=month when neither period nor from/to is given.
// ================================================================

import { verifySession } from '../lib/auth.js';
import { fetchPassedInvoices, getClientCompany, getLineItemsForInvoice, resolvePeriod } from '../lib/hubspotInvoiceData.js';

const MARGIN_TARGET_PERCENT = 15.5;

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }
  if (!session.ownerId) {
    return res.status(200).json({
      status: 'ok',
      periodLabel: 'this month',
      totalRevenue: 0,
      totalCost: 0,
      blendedMarginPercent: null,
      clientCount: 0,
      clients: [],
      note: 'No HubSpot owner ID is set on this account — nothing can be scoped to you yet.',
    });
  }

  if (!process.env.HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_SERVICE_KEY not configured' });
  }

  try {
    const { fromMs, toMs, periodLabel } = resolvePeriod(req.query);
    const invoices = await fetchPassedInvoices(fromMs, toMs);

    const companyNameCache = new Map();
    const byClient = new Map();

    for (const invoice of invoices) {
      const client = await getClientCompany(invoice.id, companyNameCache);
      if (!client) continue;

      // The actual scoping step — everything else in this file is
      // identical to margin-by-client.js / revenue-by-client.js.
      if (String(client.ownerId) !== String(session.ownerId)) continue;

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

    let totalRevenue = 0;
    let totalCost = 0;

    const clients = [...byClient.values()].map((c) => {
      const marginPercent = c.revenue > 0 ? ((c.revenue - c.cost) / c.revenue) * 100 : null;
      totalRevenue += c.revenue;
      totalCost += c.cost;
      return {
        name: c.name,
        revenue: Math.round(c.revenue * 100) / 100,
        cost: Math.round(c.cost * 100) / 100,
        marginPercent: marginPercent !== null ? Math.round(marginPercent * 10) / 10 : null,
        belowTarget: marginPercent !== null ? marginPercent < MARGIN_TARGET_PERCENT : null,
        invoiceCount: c.invoiceCount,
        costDataCoveragePercent: c.lineItemsTotal > 0 ? Math.round((c.lineItemsWithCost / c.lineItemsTotal) * 1000) / 10 : 0,
      };
    }).sort((a, b) => b.revenue - a.revenue);

    const blendedMarginPercent = totalRevenue > 0 ? Math.round(((totalRevenue - totalCost) / totalRevenue) * 1000) / 10 : null;

    return res.status(200).json({
      status: 'ok',
      periodFrom: new Date(fromMs).toISOString().split('T')[0],
      periodTo: new Date(toMs).toISOString().split('T')[0],
      periodLabel,
      marginTargetPercent: MARGIN_TARGET_PERCENT,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      blendedMarginPercent,
      clientCount: clients.length,
      clients,
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
