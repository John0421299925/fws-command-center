// ================================================================
// FWS Command Center — Deal Pipeline Leaderboard (rep-facing)
// Deploy as: api/deals-leaderboard.js
// ================================================================
// Version: v1.2
//
// v1.2: NEW - "My deals by stage" breakdown, agreed with John 24
// Sept 2026, same bar-chart shape as the admin Deal Pipeline's own
// "Deals by stage" but scoped to just the logged-in rep's own open
// deals. Each entry in myDeals also now carries its own stage label,
// for a small "stage" column on the existing deal table. Same
// private-detail boundary as everywhere else on this endpoint: a
// rep sees their OWN breakdown in full, never a colleague's.
//
// v1.1: FIX - same real bug as deals-pipeline.js: deals were being
// pulled from the whole portal, not just the Client Acquisition
// pipeline. See hubspotDealsData.js v1.3's changelog for the actual
// fix; this file just needed to sequence getDealPipelineStages()
// before fetchAllDeals() to get the pipelineId it now requires.
//
// PURPOSE: the rep-facing half of the Deal Pipeline feature — a
// genuine leaderboard (everyone's OPEN pipeline total and deal
// count, ranked), visible to every logged-in rep, but with a
// deliberate boundary John set explicitly: totals create healthy
// competition, but individual deal DETAIL (which client, what
// stage, negotiation status) stays private — a rep only ever sees
// their own deals in full, never a colleague's named accounts.
//
// Reuses the exact same fetchAllDeals()/getOwnerNamesById() as the
// admin api/deals-pipeline.js, so a leaderboard total here and the
// admin's own "Open pipeline" figure for that same person can never
// quietly disagree.
//
// NOTE: identifying "this rep's own deals" needs the logged-in
// session to carry a HubSpot owner id (session.ownerId) — the exact
// same thing api/my-sales.js already needs to scope revenue/margin
// to a rep's own clients. If lib/auth.js's session shape doesn't
// actually include this, "your deals" below falls back to matching
// the session's name against HubSpot owner names — a real fallback,
// but PLEASE VERIFY session.ownerId genuinely exists once this is
// deployed (compare against my-sales.js, which already relies on it)
// rather than trust the fallback silently.
//
// Usage: GET /api/deals-leaderboard?period=month|ytd|fy
// ================================================================

import { verifySession } from '../lib/auth.js';
import { resolvePeriod } from '../lib/hubspotInvoiceData.js';
import { fetchAllDeals, getOwnerNamesById, getDealPipelineStages } from '../lib/hubspotDealsData.js';

function isClosedDeal(deal) {
  return deal.properties.hs_is_closed_won === 'true' || deal.properties.hs_is_closed_lost === 'true';
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }

  if (!process.env.HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ status: 'error', error: 'HUBSPOT_SERVICE_KEY not configured' });
  }

  try {
    const { periodLabel } = resolvePeriod(req.query);

    // v1.1: FIX — same real bug as deals-pipeline.js: deals must be
    // filtered to the Client Acquisition pipeline, not pulled from
    // the whole portal. Stages resolve first since fetchAllDeals()
    // needs the pipelineId.
    const stages = await getDealPipelineStages();
    const [allDeals, ownerNamesById] = await Promise.all([
      fetchAllDeals(stages.pipelineId),
      getOwnerNamesById(),
    ]);

    const openDeals = allDeals.filter((d) => !isClosedDeal(d));

    // Rank every owner with at least one open deal — totals only.
    const byOwner = new Map();
    for (const deal of openDeals) {
      const ownerId = deal.properties.hubspot_owner_id;
      if (!ownerId) continue;
      if (!byOwner.has(ownerId)) byOwner.set(ownerId, { openPipelineTotal: 0, dealCount: 0 });
      const entry = byOwner.get(ownerId);
      entry.openPipelineTotal += parseFloat(deal.properties.amount) || 0;
      entry.dealCount++;
    }

    // See file header NOTE — session.ownerId is the expected, primary
    // way to identify "this person's own deals"; name-matching is a
    // fallback only, not the intended long-term path.
    const myOwnerId = session.ownerId
      || Object.entries(ownerNamesById).find(([, name]) => name === session.name)?.[0]
      || null;

    const leaderboard = [...byOwner.entries()]
      .map(([ownerId, v]) => ({
        ownerId,
        name: ownerNamesById[ownerId] || `Owner ${ownerId}`,
        isYou: ownerId === myOwnerId,
        openPipelineTotal: Math.round(v.openPipelineTotal * 100) / 100,
        dealCount: v.dealCount,
      }))
      .sort((a, b) => b.openPipelineTotal - a.openPipelineTotal);

    const myOpenDeals = myOwnerId
      ? openDeals.filter((d) => d.properties.hubspot_owner_id === myOwnerId)
      : [];

    const myDeals = myOpenDeals
      .map((d) => ({
        name: d.properties.dealname,
        amount: Math.round((parseFloat(d.properties.amount) || 0) * 100) / 100,
        stage: stages.stageLabelsById[d.properties.dealstage] || `(unrecognised stage ${d.properties.dealstage})`,
      }))
      .sort((a, b) => b.amount - a.amount);

    // v1.2: NEW — per-rep stage breakdown, per John's request (24
    // Sept 2026), same bar-chart shape as the admin Deal Pipeline's
    // own "Deals by stage" but scoped to just this rep's own deals —
    // same private-detail boundary as myDeals above, just grouped
    // differently.
    const byStage = new Map();
    for (const deal of myOpenDeals) {
      const label = stages.stageLabelsById[deal.properties.dealstage] || `(unrecognised stage ${deal.properties.dealstage})`;
      if (!byStage.has(label)) byStage.set(label, { count: 0, amount: 0 });
      const entry = byStage.get(label);
      entry.count++;
      entry.amount += parseFloat(deal.properties.amount) || 0;
    }
    const myDealsByStage = [...byStage.entries()]
      .map(([stage, v]) => ({ stage, count: v.count, amount: Math.round(v.amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);

    return res.status(200).json({
      status: 'ok',
      periodLabel,
      leaderboard,
      myDeals,
      myDealsByStage,
      myOwnerIdResolved: myOwnerId !== null,
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
