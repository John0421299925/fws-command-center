// ================================================================
// FWS Command Center — Shared HubSpot Invoice Data helpers
// Deploy as: lib/hubspotInvoiceData.js
// ================================================================
// Version: v1.5
//
// v1.5: FIX - real "stuck loading" bug found 24 Sept 2026, the same
// day deals-pipeline.js's churn revenue estimate started using this
// file: every single fetch() call in this module had ZERO retry
// handling for a HubSpot 429 — not something new to this file, it's
// been this way the whole time, but it only became a real, visible
// problem once a genuinely heavy new consumer arrived. The churn
// estimate loops over every passed invoice in a 90-day window,
// calling getClientCompany()/getLineItemsForInvoice() for each one —
// fired concurrently with margin-by-client.js, revenue-by-client.js,
// ar-aging.js, and now deals-pipeline.js itself on the very same page
// load, all sharing one HubSpot key. A 429 anywhere in that burst
// used to throw straight out as an unhandled failure — explaining
// both real symptoms reported together: the dashboard getting stuck
// on "Loading…", and the Deal Pipeline's owner dropdown never
// populating (same failed request, same root cause, not two separate
// bugs). Fixed the same way as market-opportunity.js v1.1 and
// exceptions.js v2.4: a fetchWithRetry() helper that recognises a 429
// specifically, respects Retry-After when present, and retries up to
// 3 times before giving up — applied to every fetch() in this file,
// not just the ones a new caller happens to exercise hardest.
//
// v1.4: NEW — getClientCompany() now rolls up to a client's PARENT
// company when one is set (hs_parent_company_id), instead of always
// returning the individual site company. This fixes "Largest client"
// and "Revenue/Margin by client" treating each site of a multi-site
// client (Urbis, JLL/Jones Lang LaSalle, CLV/Campus Living Villages,
// Röhlig, CBRE, Colliers) as its own separate client — e.g. Urbis's
// 12 real sites were each showing up individually, so "Largest
// client" showed one Urbis site at 27.6% instead of Urbis as a
// whole. The real relationship now exists in HubSpot as a genuine
// Parent Company association (set 21 Sept 2026, 24 site records
// across 6 groups — see hs_parent_company_id, confirmed via direct
// HubSpot check to already be in real use elsewhere in this portal
// for the unrelated aged-care Market Opportunity prospecting feature,
// so this is adding to an existing working mechanism, not introducing
// a new one).
//
// How it works: when a site company has hs_parent_company_id set,
// its resolved identity becomes the PARENT's {id, name, ownerId}
// instead of its own — so every site under one parent lands in the
// same bucket in every caller's byClient Map, with zero changes
// needed in margin-by-client.js or revenue-by-client.js themselves.
// A site with no parent set (the vast majority of clients, which
// genuinely are single-site) resolves exactly as before — this is
// purely additive for anyone not in a group.
// Parent lookups are cached in the same companyNameCache the callers
// already pass in, keyed by the parent's own company ID, so multiple
// sites sharing one parent (e.g. all 12 Urbis sites) only trigger one
// extra HubSpot fetch for the parent's name/owner, not one per site.
// If the parent lookup itself fails for any reason (network error,
// permissions), this falls back to the site's own identity rather
// than losing that revenue from the report entirely — a rollup
// failing safe is better than a client silently vanishing from the
// dashboard.
// NOTE: only rolls up one level (site → immediate parent). No known
// case in this portal chains a parent to its own further parent, and
// nothing here currently needs it — worth revisiting only if that
// ever changes.
//
// v1.3: getClientCompany() now also returns each client's
// hubspot_owner_id (as ownerId) — purely additive, existing callers
// only read .name/.id and are unaffected. This is what lets the new
// rep-scoped my-sales.js endpoint filter invoices down to only the
// logged-in rep's own client companies, for the Sales Command Centre.
//
// v1.2: FIX — getLineItemsForInvoice() now chunks its batch-read into
// groups of 100 (HubSpot's hard per-request cap), same fix already
// applied to approve.js's fetchCurrentLineItems() for the identical
// limit. Confirmed real: invoice 717716410843 (Glenrose, 123 line
// items) 400'd the moment it entered this month's query for the
// first time. See batchReadLineItems() below.
//
// v1.1: resolvePeriod() now understands a `period` shortcut
// (?period=month|ytd|fy) alongside the existing explicit ?from=&to=
// override, per John's request to switch Revenue/Blended Margin
// between "this month", calendar year-to-date, and Australian
// financial-year-to-date (1 July - 30 June) from a dropdown on the
// dashboard. Explicit from/to still wins if both are given — the
// shortcut only decides the DEFAULT from date when neither is
// supplied. Also now returns periodLabel so callers (and the
// dashboard) don't need to duplicate the same month/ytd/fy
// human-readable naming logic themselves.
//
// Shared logic used by margin-by-client.js and revenue-by-client.js,
// so invoice/line-item fetching isn't duplicated across endpoints
// (same principle as clv-invoice-automation's exported Xero
// functions).
// ================================================================

const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;
const HUBSPOT_API_BASE = 'https://api.hubapi.com';

// v1.5: NEW — same retry helper already proven in market-opportunity.js
// v1.1 and exceptions.js v2.4, applied here after a real incident: this
// file had ZERO rate-limit handling anywhere, and a new heavy consumer
// (deals-pipeline.js's churn revenue estimate, which loops over every
// invoice in a 90-day window through getClientCompany/
// getLineItemsForInvoice) started firing concurrently with everything
// else already competing for the same HubSpot key on page load —
// exactly the condition that's tripped a real 429 twice already this
// week elsewhere. Every raw fetch() in this file now goes through this,
// not just the ones added most recently.
async function fetchWithRetry(url, options, maxAttempts = 3) {
  let attempt = 0;
  let waitMs = 1000;

  while (true) {
    const resp = await fetch(url, options);
    if (resp.status !== 429) return resp;

    attempt++;
    if (attempt >= maxAttempts) return resp;

    const retryAfterHeader = resp.headers.get('Retry-After');
    const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : waitMs;
    console.log(`⏳ HubSpot rate-limited (429) — retrying in ${Math.round(retryAfterMs)}ms (attempt ${attempt}/${maxAttempts})`);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    waitMs *= 2;
  }
}

async function hubspotPost(path, body) {
  const resp = await fetchWithRetry(`${HUBSPOT_API_BASE}${path}`, {
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

export async function fetchPassedInvoices(fromMs, toMs) {
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

export async function getAssociatedCompanies(invoiceId) {
  const resp = await fetchWithRetry(`${HUBSPOT_API_BASE}/crm/v4/objects/invoices/${invoiceId}/associations/companies`, {
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.results || [];
}

// v1.4: NEW — fetches a parent company's own name/owner for the
// rollup. Deliberately separate from the site-level fetch above (that
// one also needs `type` and `hs_parent_company_id`, which a parent
// HO record doesn't need checked). Never throws: a failed parent
// lookup returns null so the caller can fall back to the site's own
// identity instead of losing that revenue from the report entirely.
async function fetchParentCompanyIdentity(parentId) {
  try {
    const resp = await fetchWithRetry(`${HUBSPOT_API_BASE}/crm/v3/objects/companies/${parentId}?properties=name,hubspot_owner_id`, {
      headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      id: Number(parentId),
      name: data.properties.name,
      ownerId: data.properties.hubspot_owner_id || null,
    };
  } catch {
    return null;
  }
}

export async function getClientCompany(invoiceId, companyNameCache) {
  const companies = await getAssociatedCompanies(invoiceId);
  for (const c of companies) {
    if (companyNameCache.has(c.toObjectId)) {
      const cached = companyNameCache.get(c.toObjectId);
      if (cached) return cached;
      continue;
    }
    // v1.3: also fetch hubspot_owner_id — purely additive, existing
    // callers (margin-by-client.js, revenue-by-client.js) only read
    // .name and .id and are unaffected. This is what lets a new
    // rep-scoped endpoint (my-sales.js) filter to only the logged-in
    // rep's own client companies, for the Sales Command Centre.
    // v1.4: also fetch hs_parent_company_id — see the rollup logic
    // below.
    const resp = await fetchWithRetry(`${HUBSPOT_API_BASE}/crm/v3/objects/companies/${c.toObjectId}?properties=name,type,hubspot_owner_id,hs_parent_company_id`, {
      headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    const type = (data.properties.type || '').toLowerCase();
    if (!type.includes('client')) {
      companyNameCache.set(c.toObjectId, null);
      continue;
    }

    const siteIdentity = { id: c.toObjectId, name: data.properties.name, ownerId: data.properties.hubspot_owner_id || null };
    const parentId = data.properties.hs_parent_company_id;

    let result = siteIdentity;
    if (parentId) {
      // v1.4: roll this site up to its parent's identity, so every
      // site sharing one parent lands in the same bucket for every
      // caller. Cached under the PARENT's own id (not the site's),
      // so the next site sharing this parent skips the extra fetch.
      if (companyNameCache.has(parentId)) {
        const cachedParent = companyNameCache.get(parentId);
        if (cachedParent) result = cachedParent;
      } else {
        const parentIdentity = await fetchParentCompanyIdentity(parentId);
        if (parentIdentity) {
          companyNameCache.set(parentId, parentIdentity);
          result = parentIdentity;
        }
        // else: parent lookup failed — fall back to siteIdentity
        // (already the default for `result`) rather than dropping
        // this invoice's revenue from the report.
      }
    }

    companyNameCache.set(c.toObjectId, result);
    return result;
  }
  return null;
}

// v1.2: FIX — real incident, confirmed by John running the live
// dashboard: invoice 717716410843 (Glenrose Village, 123 line items —
// the same invoice that hit approve.js's identical limit earlier)
// returned a 400 the moment its validation_status flipped to
// "Passed" and it entered this month's query for the first time.
// HubSpot's batch/read endpoint hard-caps at 100 inputs per call —
// this function was never given the same chunking fix already
// applied to approve.js's fetchCurrentLineItems(), since it's a
// separate file. Fixed the same way: split into chunks of 100 and
// concatenate the results, rather than sending every ID in one call.
async function batchReadLineItems(lineItemIds) {
  const CHUNK_SIZE = 100;
  const allResults = [];
  for (let i = 0; i < lineItemIds.length; i += CHUNK_SIZE) {
    const chunk = lineItemIds.slice(i, i + CHUNK_SIZE);
    const batchResp = await fetchWithRetry(`${HUBSPOT_API_BASE}/crm/v3/objects/line_items/batch/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // hs_sku doubles as the GL/revenue account code (see
        // clv-invoice-automation webhook.js v5.5.57Agent) — reused by
        // revenue-by-client.js for the waste-type breakdown, no new
        // data needed.
        properties: ['quantity', 'price', 'hs_cost_of_goods_sold', 'hs_sku', 'name'],
        inputs: chunk.map((id) => ({ id })),
      }),
    });
    if (!batchResp.ok) {
      const errText = await batchResp.text();
      throw new Error(`Could not batch-read line_items chunk starting at index ${i} (${batchResp.status}): ${errText}`);
    }
    const batchData = await batchResp.json();
    allResults.push(...(batchData.results || []));
  }
  return allResults;
}

export async function getLineItemsForInvoice(invoiceId) {
  const assocResp = await fetchWithRetry(`${HUBSPOT_API_BASE}/crm/v4/objects/invoices/${invoiceId}/associations/line_items`, {
    headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
  });
  if (!assocResp.ok) {
    const errText = await assocResp.text();
    throw new Error(`Could not read line_items association for invoice ${invoiceId} (${assocResp.status}): ${errText}`);
  }
  const assocData = await assocResp.json();
  const lineItemIds = (assocData.results || []).map((r) => r.toObjectId);
  if (lineItemIds.length === 0) return [];

  try {
    return await batchReadLineItems(lineItemIds);
  } catch (error) {
    throw new Error(`Could not batch-read line_items for invoice ${invoiceId}: ${error.message}`);
  }
}

// v1.1: `period` shortcuts. Explicit from/to (if BOTH given) still
// take precedence over the shortcut entirely — this only changes what
// the DEFAULT from-date is when the caller hasn't specified one.
export function resolvePeriod(query) {
  const now = new Date();
  const period = query?.period || 'month';

  let defaultFrom;
  let periodLabel;

  if (period === 'ytd') {
    // Calendar year-to-date: 1 Jan through now.
    defaultFrom = new Date(now.getFullYear(), 0, 1);
    periodLabel = 'year to date';
  } else if (period === 'fy') {
    // Australian financial year: 1 July - 30 June. If we're
    // currently in Jan-Jun, the current FY started 1 July LAST
    // calendar year; if Jul-Dec, it started 1 July THIS year.
    const fyStartYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    defaultFrom = new Date(fyStartYear, 6, 1);
    periodLabel = 'FY to date';
  } else {
    // 'month' (default, and the fallback for any unrecognised value)
    defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    periodLabel = 'this month';
  }

  const fromMs = query?.from ? new Date(query.from).getTime() : defaultFrom.getTime();
  const toMs = query?.to ? new Date(query.to).getTime() : now.getTime();

  // If the caller passed explicit from/to, the shortcut label no
  // longer describes the actual range accurately — fall back to a
  // generic label rather than mislabel a custom range as "FY to date".
  const explicitRange = Boolean(query?.from || query?.to);

  return { fromMs, toMs, periodLabel: explicitRange ? 'custom range' : periodLabel };
}
