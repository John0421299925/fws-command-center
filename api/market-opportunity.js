// ================================================================
// FWS Command Center — Market Opportunity (Aged Care & Retirement)
// Deploy as: api/market-opportunity.js
// ================================================================
// Version: v1.1
//
// v1.1: FIX - real bug found via live Vercel logs (22 Sept 2026):
// sumCompanyProperty() paginates through HubSpot's Search API 100
// records at a time, firing each page's request immediately with NO
// handling for a rate-limited response — a 429 just threw straight
// out as a fatal error, surfacing as "Could not load" on both Market
// Opportunity cards. Confirmed directly in the logs: the SECOND of
// the two HubSpot calls this endpoint fires (residential_beds and
// total_units, run in parallel via Promise.all) came back 429, right
// as the rest of the dashboard was also loading — Revenue, Margin,
// AR/AP aging, and Market Opportunity itself all fire their own
// HubSpot calls within moments of each other on page load, all
// sharing the same HUBSPOT_SERVICE_KEY and therefore the same rate
// limit. Two concurrent paginated loops here, with no pause between
// pages, made this endpoint specifically the one most likely to
// occasionally lose that race — HubSpot's Search API has a stricter
// rate limit than most of its other endpoints, and pagination alone
// (no delay, no backoff) can trip it under load even without any
// other endpoint competing for the same key.
// Fixed by wrapping each page's HubSpot request in a small retry
// helper (fetchWithRetry) that specifically recognises a 429,
// respects HubSpot's own Retry-After header when present (falling
// back to a short default wait if it isn't), and retries up to 3
// times with the wait doubling each attempt, before finally giving up
// and surfacing a real error. This is a genuine fix for a transient,
// recoverable condition — not a workaround that hides a real problem;
// a 429 here always meant "try again shortly", never "this request is
// wrong". Every other line in this file — the formula, the rates, the
// note about these companies not being existing clients — is
// unchanged from v1.0.
//
// PURPOSE: the "what's possible" number for the Sales Command Centre
// — the real, live-counted Aged Care and Retirement Village
// enrichment data already sitting in HubSpot, turned into a concrete
// rep earning-potential figure. Confirmed 16-17 Sept 2026 that none
// of these companies are current FWS clients — this is genuinely
// untapped opportunity, not double-counted against real revenue.
//
// Cross-validated against John's own historical NSW aged-care
// spreadsheet (30 June 2022): HubSpot's live residential_beds total
// (73,370) landed within 0.4% of the spreadsheet's own independently
// pre-calculated total (73,673) — strong confirmation this enrichment
// data is genuinely accurate, not a rough guess.
//
// RATES: real historical per-bed/per-unit costs John personally
// managed as a rep, not invented figures:
//   - Aged Care: $420/bed/year (Summit Care rate — John's own
//     description: "about the norm"). Genuinely CONSERVATIVE: this
//     rate is ~3 years old (no July price increases applied since),
//     and doesn't include Grease Trap or other ancillary streams many
//     of these sites likely also need alongside General Waste, Paper/
//     Cardboard, Co-Mingle, and Medical Waste.
//   - Retirement Villages: $205/unit/year (Uniting rate — genuinely a
//     different site type from Aged Care, over-55 independent living,
//     not residential beds, so kept as its own separate calculation
//     rather than blended into the Aged Care figure).
//
// FORMULA (agreed with John 16-17 Sept 2026):
//   potential revenue = volume × rate
//   gross profit       = potential revenue × 15% margin
//   rep full potential = gross profit × 40% (rep's share of GP)
//   rep realistic      = rep full potential × 20% win rate
//
// Deliberately visible to EVERY logged-in role (admin and rep alike)
// — this is a motivational/recruiting figure, not sensitive per-
// client financial data, so it isn't gated the way AR/AP/margin are.
//
// Usage: GET /api/market-opportunity
// ================================================================

import { verifySession } from '../lib/auth.js';

const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;
const HUBSPOT_API_BASE = 'https://api.hubapi.com';

const AGED_CARE_RATE_PER_BED = 420;
const RETIREMENT_VILLAGE_RATE_PER_UNIT = 205;
const MARGIN_PERCENT = 0.15;
const REP_SHARE_OF_GP_PERCENT = 0.40;
const WIN_RATE_PERCENT = 0.20;

// v1.1: NEW — small retry helper, specifically for HubSpot's 429
// "too many requests" response. Respects HubSpot's own Retry-After
// header (seconds) when it's present; falls back to a short default
// wait when it isn't, doubling on each subsequent retry. Any other
// non-ok response is NOT retried — a real error (bad auth, bad
// request) should still fail immediately and clearly, not get masked
// behind three silent retries.
async function fetchWithRetry(url, options, maxAttempts = 3) {
  let attempt = 0;
  let waitMs = 1000;

  while (true) {
    const resp = await fetch(url, options);
    if (resp.status !== 429) return resp;

    attempt++;
    if (attempt >= maxAttempts) return resp; // give up — caller handles the non-ok status as a real error

    const retryAfterHeader = resp.headers.get('Retry-After');
    const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : waitMs;
    console.log(`⏳ HubSpot rate-limited (429) — retrying in ${Math.round(retryAfterMs)}ms (attempt ${attempt}/${maxAttempts})`);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    waitMs *= 2;
  }
}

// Sums a numeric property across every Company record that has it set,
// paginating through HubSpot's search API 100 at a time. There's no
// native server-side SUM in the public Search API, so this sums
// client-side — fine at this scale (under 1,000 records either way).
async function sumCompanyProperty(propertyName) {
  let after = undefined;
  let total = 0;
  let count = 0;

  do {
    const body = {
      filterGroups: [{ filters: [{ propertyName, operator: 'HAS_PROPERTY' }] }],
      properties: [propertyName],
      limit: 100,
      after,
    };
    // v1.1: FIX — was a plain fetch() with no retry at all, so a
    // transient HubSpot 429 threw straight out as a fatal error. Now
    // goes through fetchWithRetry, which specifically waits and
    // retries on a 429 (a genuinely recoverable condition) before
    // giving up.
    const resp = await fetchWithRetry(`${HUBSPOT_API_BASE}/crm/v3/objects/companies/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`HubSpot search failed for ${propertyName} (${resp.status}): ${errText}`);
    }
    const data = await resp.json();
    for (const result of data.results || []) {
      const value = parseFloat(result.properties[propertyName]);
      if (!isNaN(value)) {
        total += value;
        count++;
      }
    }
    after = data.paging?.next?.after;
  } while (after);

  return { total, count };
}

function calculateSegment(volume, rate) {
  const potentialRevenue = volume * rate;
  const grossProfit = potentialRevenue * MARGIN_PERCENT;
  const repFullPotential = grossProfit * REP_SHARE_OF_GP_PERCENT;
  const repRealistic = repFullPotential * WIN_RATE_PERCENT;
  return {
    potentialRevenue: Math.round(potentialRevenue * 100) / 100,
    grossProfit: Math.round(grossProfit * 100) / 100,
    repFullPotential: Math.round(repFullPotential * 100) / 100,
    repRealistic: Math.round(repRealistic * 100) / 100,
  };
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }

  if (!HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_SERVICE_KEY not configured' });
  }

  try {
    const [agedCareData, retirementData] = await Promise.all([
      sumCompanyProperty('residential_beds'),
      sumCompanyProperty('total_units'),
    ]);

    const agedCareCalc = calculateSegment(agedCareData.total, AGED_CARE_RATE_PER_BED);
    const retirementCalc = calculateSegment(retirementData.total, RETIREMENT_VILLAGE_RATE_PER_UNIT);

    return res.status(200).json({
      status: 'ok',
      checkedAt: new Date().toISOString(),
      assumptions: {
        marginPercent: MARGIN_PERCENT * 100,
        repShareOfGrossProfitPercent: REP_SHARE_OF_GP_PERCENT * 100,
        winRatePercent: WIN_RATE_PERCENT * 100,
      },
      agedCare: {
        companyCount: agedCareData.count,
        totalBeds: agedCareData.total,
        ratePerBedPerYear: AGED_CARE_RATE_PER_BED,
        rateSource: 'Summit Care (John\'s own managed rate, ~2022) — conservative: no price increases applied since, excludes Grease Trap and other ancillary streams',
        ...agedCareCalc,
      },
      retirementVillages: {
        companyCount: retirementData.count,
        totalUnits: retirementData.total,
        ratePerUnitPerYear: RETIREMENT_VILLAGE_RATE_PER_UNIT,
        rateSource: 'Uniting (John\'s own managed rate, ~2022)',
        ...retirementCalc,
      },
      combined: {
        repRealisticTotal: Math.round((agedCareCalc.repRealistic + retirementCalc.repRealistic) * 100) / 100,
      },
      note: 'None of these companies are current FWS clients (confirmed 16-17 Sept 2026) — this is genuinely untapped opportunity, not overlapping with real revenue shown elsewhere on this dashboard.',
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
