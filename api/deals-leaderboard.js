// ================================================================
// FWS Command Center — Deal Pipeline Leaderboard (rep-facing)
// Deploy as: api/deals-leaderboard.js
// ================================================================
// Version: v1.0
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
import { fetchAllDeals, getOwnerNamesById } from '../lib/hubspotDealsData.js';

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

    const [allDeals, ownerNamesById] = await Promise.all([
      fetchAllDeals(),
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

    const myDeals = myOwnerId
      ? openDeals
          .filter((d) => d.properties.hubspot_owner_id === myOwnerId)
          .map((d) => ({
            name: d.properties.dealname,
            amount: Math.round((parseFloat(d.properties.amount) || 0) * 100) / 100,
          }))
          .sort((a, b) => b.amount - a.amount)
      : [];

    return res.status(200).json({
      status: 'ok',
      periodLabel,
      leaderboard,
      myDeals,
      myOwnerIdResolved: myOwnerId !== null,
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
