// ================================================================
// FWS Command Center — Deal Pipeline (admin)
// Deploy as: api/deals-pipeline.js
// ================================================================
// Version: v1.3
//
// v1.3: NEW - optional ?pipelineId= query param, per John's explicit
// request (24 Sept 2026) for a real pipeline-selector dropdown, in
// case another Deals pipeline gets created later. Omitted falls back
// to the Client Acquisition default, so nothing changes for existing
// callers. Response now also includes the full pipelines list and
// which one is currently selected, for the dropdown to populate
// itself from real data.
//
// v1.2: FIX - real bug found by John (24 Sept 2026): deals were being
// pulled from the WHOLE portal, not just the Client Acquisition
// pipeline this dashboard represents — fetchAllDeals() had no
// pipeline filter at all. See hubspotDealsData.js v1.3's own
// changelog for the actual fix; this file just needed to sequence
// getDealPipelineStages() BEFORE fetchAllDeals() now, since the
// latter needs the former's pipelineId to filter correctly.
//
// v1.1: FIX - real incident (24 Sept 2026): estimateMonthlyRevenueForCompanies()
// used to scan every passed invoice company-wide over a 90-day window
// just to find the few belonging to churned companies — call volume
// heavy enough to exhaust the HubSpot key's per-second rate limit for
// the WHOLE page (confirmed directly in HubSpot's own API call log:
// "You have reached your secondly limit"), taking down completely
// unrelated, previously-reliable cards as collateral damage. Rewritten
// to look up only the churned companies' own invoices directly (see
// lib/hubspotDealsData.js v1.2's new getInvoiceIdsForCompany()).
//
// PURPOSE: real HubSpot Deals data for the admin Command Center —
// open pipeline value, weighted pipeline, a deals-by-stage
// breakdown, new clients won this period (count + $, from real
// Closed Won deals), and clients lost this period (count + $, from
// the real "No Longer a Client" company signal, NOT from Deals —
// churn is an account-loss event, not a deal outcome, confirmed with
// John: he specifically means an existing client leaving, which
// Closed Lost deals don't reliably capture).
//
// "Clients lost" $ value is an ESTIMATE — the average of that
// client's real invoiced revenue over the 90 days before their
// hs_lastmodifieddate (see lib/hubspotDealsData.js's own caveat on
// why that date is a proxy, not an exact churn timestamp), reusing
// the exact same invoice/line-item aggregation already proven in
// margin-by-client.js / revenue-by-client.js — not a separately
// invented calculation.
//
// Optional ?ownerId=<id> filters pipeline/won figures to one person
// (used by the admin dropdown — "Company (all)" sends no ownerId).
// Churn stays company-wide regardless of ownerId — a lost ACCOUNT
// doesn't cleanly belong to one rep's own book the way an open deal
// does, and John didn't ask for it scoped that way.
//
// Usage: GET /api/deals-pipeline?period=month|ytd|fy&ownerId=<id>
// ================================================================

import { verifySession } from '../lib/auth.js';
import { resolvePeriod, getLineItemsForInvoice } from '../lib/hubspotInvoiceData.js';
import { getDealPipelineStages, getAllDealPipelines, getOwnerNamesById, fetchAllDeals, fetchChurnedCompanies, getInvoiceIdsForCompany, batchReadInvoiceSummaries } from '../lib/hubspotDealsData.js';

const CLOSED_STAGE_PATTERN = /closed/i;

function isClosedDeal(deal) {
  return deal.properties.hs_is_closed_won === 'true' || deal.properties.hs_is_closed_lost === 'true';
}

// v1.1: FIX — real incident (24 Sept 2026): this used to scan EVERY
// passed invoice company-wide over a 90-day window just to check
// which ones belonged to a handful of churned companies — heavy
// enough to exhaust the HubSpot key's per-second rate limit for the
// WHOLE page, confirmed directly in HubSpot's own API call log.
// Rewritten to look up ONLY the churned companies' own invoices
// directly (getInvoiceIdsForCompany — a reverse association, not a
// scan), typically a handful of calls total instead of hundreds.
// Rough monthly revenue estimate for a churned client — average of
// their real invoiced revenue over the 90 days before they were
// flagged "No Longer a Client".
async function estimateMonthlyRevenueForCompanies(companyIds, asOfMs) {
  if (companyIds.length === 0) return {};
  const fromMs = asOfMs - 90 * 24 * 60 * 60 * 1000;
  const monthlyEstimate = {};

  for (const companyId of companyIds) {
    const invoiceIds = await getInvoiceIdsForCompany(companyId);
    if (invoiceIds.length === 0) {
      monthlyEstimate[companyId] = 0;
      continue;
    }

    const summaries = await batchReadInvoiceSummaries(invoiceIds);
    const passedInWindow = summaries.filter((inv) => {
      if (inv.properties.validation_status !== 'Passed') return false;
      const createdMs = inv.properties.hs_createdate ? new Date(inv.properties.hs_createdate).getTime() : null;
      return createdMs !== null && createdMs >= fromMs && createdMs <= asOfMs;
    });

    let total = 0;
    for (const inv of passedInWindow) {
      const lineItems = await getLineItemsForInvoice(inv.id);
      for (const li of lineItems) {
        const qty = parseFloat(li.properties.quantity) || 0;
        const price = parseFloat(li.properties.price) || 0;
        total += qty * price;
      }
    }
    // 90 days of real revenue → average monthly figure.
    monthlyEstimate[companyId] = Math.round((total / 3) * 100) / 100;
  }

  return monthlyEstimate;
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }
  if (session.role !== 'admin') {
    return res.status(403).json({ status: 'error', error: 'This view is company-wide and restricted to admin accounts' });
  }

  if (!process.env.HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ status: 'error', error: 'HUBSPOT_SERVICE_KEY not configured' });
  }

  try {
    const { fromMs, toMs, periodLabel } = resolvePeriod(req.query);
    const ownerIdFilter = req.query.ownerId || null;
    // v1.3: NEW — optional pipeline selector. Omitted (or an unknown
    // id) falls back to the Client Acquisition default inside
    // getDealPipelineStages(), so this is fully backward compatible.
    const pipelineIdFilter = req.query.pipelineId || undefined;

    // v1.2: FIX — stages must resolve FIRST now, since fetchAllDeals()
    // needs its pipelineId to filter correctly (see
    // hubspotDealsData.js v1.3). Deals and owners can still run
    // together once that's known.
    const [stages, allPipelines] = await Promise.all([
      getDealPipelineStages(pipelineIdFilter),
      getAllDealPipelines(),
    ]);
    const [allDeals, ownerNamesById] = await Promise.all([
      fetchAllDeals(stages.pipelineId),
      getOwnerNamesById(),
    ]);

    const dealsInScope = ownerIdFilter
      ? allDeals.filter((d) => d.properties.hubspot_owner_id === ownerIdFilter)
      : allDeals;

    const openDeals = dealsInScope.filter((d) => !isClosedDeal(d));
    const openPipelineTotal = openDeals.reduce((sum, d) => sum + (parseFloat(d.properties.amount) || 0), 0);
    const weightedPipelineTotal = openDeals.reduce(
      (sum, d) => sum + (parseFloat(d.properties.hs_weighted_pipeline_in_company_currency) || 0), 0
    );

    const byStage = new Map();
    for (const deal of openDeals) {
      const stageId = deal.properties.dealstage;
      const label = stages.stageLabelsById[stageId] || `(unrecognised stage ${stageId})`;
      if (!byStage.has(label)) byStage.set(label, { count: 0, amount: 0 });
      const entry = byStage.get(label);
      entry.count++;
      entry.amount += parseFloat(deal.properties.amount) || 0;
    }
    const dealsByStage = [...byStage.entries()]
      .map(([stage, v]) => ({ stage, count: v.count, amount: Math.round(v.amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);

    const wonThisPeriod = dealsInScope.filter((d) => {
      if (d.properties.hs_is_closed_won !== 'true') return false;
      const closedMs = d.properties.closedate ? new Date(d.properties.closedate).getTime() : null;
      return closedMs !== null && closedMs >= fromMs && closedMs <= toMs;
    });
    const newClientsWon = {
      count: wonThisPeriod.length,
      amount: Math.round(wonThisPeriod.reduce((sum, d) => sum + (parseFloat(d.properties.amount) || 0), 0) * 100) / 100,
    };

    // Churn — company-wide always, see file header note above.
    const churnedCompanies = await fetchChurnedCompanies(fromMs, toMs);
    const monthlyRevenueByCompanyId = await estimateMonthlyRevenueForCompanies(
      churnedCompanies.map((c) => c.id),
      toMs
    );
    const clientsLost = {
      count: churnedCompanies.length,
      amount: Math.round(
        churnedCompanies.reduce((sum, c) => sum + (monthlyRevenueByCompanyId[c.id] || 0), 0) * 100
      ) / 100,
    };

    // Which owners actually have open deals right now — feeds the
    // admin dropdown's person list, so it never shows someone with
    // zero real deals as a selectable option.
    const ownerIdsWithDeals = [...new Set(allDeals.map((d) => d.properties.hubspot_owner_id).filter(Boolean))];
    const owners = ownerIdsWithDeals.map((id) => ({ id, name: ownerNamesById[id] || `Owner ${id}` }));

    return res.status(200).json({
      status: 'ok',
      periodLabel,
      ownerIdFilter,
      owners,
      pipelines: allPipelines,
      selectedPipelineId: stages.pipelineId,
      openPipelineTotal: Math.round(openPipelineTotal * 100) / 100,
      weightedPipelineTotal: Math.round(weightedPipelineTotal * 100) / 100,
      dealsByStage,
      newClientsWon,
      clientsLost,
      clientsLostNote: 'Estimated $ value — average of each client\'s real invoiced revenue over the 90 days before they were flagged "No Longer a Client". Count and timing use hs_lastmodifieddate as a proxy (see lib/hubspotDealsData.js for the caveat).',
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
