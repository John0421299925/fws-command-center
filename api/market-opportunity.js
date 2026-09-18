// ================================================================
// FWS Command Center — Market Opportunity (Aged Care & Retirement)
// Deploy as: api/market-opportunity.js
// ================================================================
// Version: v1.0
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
    const resp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/companies/search`, {
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
