// ================================================================
// FWS Command Center — Invoices still to come (missing-invoice check)
// Deploy as: api/missing-invoices.js
// ================================================================
// Version: v1.2
//
// v1.2: FIX - a HELD invoice is no longer reported as missing. John, 10 Oct
// 2026: the dashboard said "4 likely missing" and one of them was Fairfield
// Forum, whose invoice does exist, it is simply held in HubSpot (Needs Review)
// until the prices are agreed. Held invoices dated last month are now read as
// well (lib v1.9) and a client or supplier that has one is listed in a new
// onHold list with the reason "Held for review", showing the held invoice's
// date and amount, instead of in likelyMissing. They are counted separately
// (onHoldCount) and do not turn the heading red, but they stay visible,
// because a held invoice is still money that has not gone out. Nothing else
// changed.
//
// v1.1: NEW - the check now also starts from the RATE CARD, not just from past
// invoices. v1.0 could only see a client the system had already invoiced, and
// the system only began on 10 Sept 2026, so it could not see Deepwater Plaza
// (the case that started this): the system has never invoiced it. Now every
// client with an ACTIVE bin service on the rate card is expected to be billed
// every month, and two new things are flagged for LAST MONTH:
//   "Active client, no invoice"      - the client has an active service but no
//                                      invoice from anyone for last month
//   "Supplier invoice missing"       - the client WAS billed, but a supplier
//                                      that has an active bin service for it
//                                      has no invoice (e.g. Bingo came, Remondis
//                                      did not)
// Both go in likelyMissing, each with a "reason". The v1.0 history check
// (billed two months running / once in two months) still runs for everything
// the rate card does not cover, and a pair is never listed twice.
// What counts as a monthly bin service: its name is not a fee, levy, grease
// trap, tanker, sludge, rental, transport and so on (see NOT_A_BIN_SERVICE).
// Lost accounts need no list any more: their services are marked "Moved to
// another SP", so they are not Active, so they are not expected. The
// IGNORE_NAMES list still applies to the history check.
// Supplier names differ between the rate card ("Bingo Industries") and the
// invoice titles ("Bingo Waste Services"), so suppliers are compared by
// family (Bingo, Remondis, Waste Free, Premier, Wanless, JR Richards); a
// supplier outside that list is never reported as missing, to avoid noise.
// A service linked to more than one company counts as billed if ANY of its
// companies has an invoice.
//
// v1.0: PURPOSE: catch an invoice that should have arrived but has not, before
// anyone has to notice by accident. John, 10 Oct 2026: the one active client
// with no September invoice (Deepwater Plaza, Bingo's organic bins) was only
// found by hand. This looks at every client + supplier pair, month by month,
// using the SUPPLIER'S invoice date (the same date the Command Center now
// reports billing by, see lib/hubspotInvoiceData.js v1.6), and lists the
// pairs that were billed before but have nothing for LAST MONTH:
//   likelyMissing  - billed in BOTH of the two months before last month, but
//                    not last month. A regular monthly bill that has stopped.
//   toCheck        - billed in only ONE of those two months. Grease trap and
//                    pump-out invoices are not monthly, so they land here
//                    most months, and so does anything newer than two months.
// A pair drops off the list by itself the moment its invoice arrives, so
// early in a month (before the month-end run has finished) it is simply a
// list of what is still outstanding.
//
// Only PASSED invoices count, as everywhere else on the dashboard. Client and
// supplier are read from the invoice title ("Client - Supplier - date"), which
// the invoice automation has always written that way.
//
// Admin only (company-wide). Usage: GET /api/missing-invoices
// ================================================================

import { verifySession } from '../lib/auth.js';
import { fetchPassedInvoices, hubspotPost, sydneyYMD } from '../lib/hubspotInvoiceData.js';

// History check only (v1.0): names left off because the account has gone.
const IGNORE_NAMES = ['röhlig', 'rohlig'];

// v1.1: services whose name says they are a fee or a liquid/irregular service, not a monthly bin collection
const NOT_A_BIN_SERVICE = /grease|tanker|sludge|effluent|cooking oil|levy|\bfee\b|surcharge|excess|futile|monthly|rental|admin|public holiday|delivery|change.?over|transport/i;

// v1.1: supplier families, matched on the start of the name with spaces and punctuation removed
const FAMILIES = [['bingo', 'bingo'], ['remondis', 'remondis'], ['wastefree', 'wastefree'], ['premier', 'premier'], ['wanless', 'wanless'], ['jrrichards', 'jrrichards'], ['futurewaste', 'jrrichards'], ['hlw', 'hlw'], ['cleanaway', 'cleanaway']];
// Irregular suppliers: never expected every month
const NOT_MONTHLY_FAMILIES = new Set(['hlw', 'cleanaway']);

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = (key) => MONTH_NAMES[Number(key.slice(5, 7)) - 1].slice(0, 3);
const LABEL = (key) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const supplierFamily = (name) => {
  const k = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [prefix, fam] of FAMILIES) if (k.startsWith(prefix)) return fam;
  return null;
};

// "Client - Site - Supplier - 2026-09-30 23:09:00" -> { company, supplier }
function parseInvoiceTitle(title) {
  const m = /^(.*)\s-\s(.+?)\s-\s\d{4}-\d{2}-\d{2}(?:[ T][\d:.]+Z?)?\s*$/.exec(String(title || ''));
  if (!m) return null;
  const company = m[1].replace(/\s+/g, ' ').trim();
  const supplier = m[2].replace(/\s+/g, ' ').trim();
  return company && supplier ? { company, supplier } : null;
}

function prettySupplier(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '') === 'wastefree' ? 'Waste Free' : name;
}

function isIgnored(company, supplier) {
  const hay = `${company} ${supplier}`.toLowerCase();
  return IGNORE_NAMES.some((n) => hay.includes(n));
}

// v1.1: every ACTIVE bin service on the rate card, with its client company/companies
async function loadExpectedClients() {
  const services = [];
  let after;
  for (let page = 0; page < 10; page++) {
    const data = await hubspotPost('/crm/v3/objects/0-162/search', {
      limit: 100,
      after,
      properties: ['hs_name', 'service_provider'],
      filterGroups: [{ filters: [{ propertyName: 'service_status', operator: 'EQ', value: 'Active' }] }],
    });
    services.push(...(data.results || []));
    after = data.paging?.next?.after;
    if (!after) break;
  }
  const bin = services.filter((s) => !NOT_A_BIN_SERVICE.test(String(s.properties?.hs_name || '')));
  if (bin.length === 0) return [];

  const companyIdsByService = new Map();
  for (let i = 0; i < bin.length; i += 100) {
    const chunk = bin.slice(i, i + 100);
    const data = await hubspotPost('/crm/v4/associations/0-162/companies/batch/read', { inputs: chunk.map((s) => ({ id: String(s.id) })) });
    for (const r of data.results || []) {
      companyIdsByService.set(String(r.from?.id), (r.to || []).map((t) => String(t.toObjectId)));
    }
  }
  const allCompanyIds = [...new Set([...companyIdsByService.values()].flat())];
  const nameById = new Map();
  for (let i = 0; i < allCompanyIds.length; i += 100) {
    const data = await hubspotPost('/crm/v3/objects/companies/batch/read', { properties: ['name'], inputs: allCompanyIds.slice(i, i + 100).map((id) => ({ id })) });
    for (const c of data.results || []) nameById.set(String(c.id), c.properties?.name || '');
  }

  // one "client unit" per distinct set of companies
  const units = new Map();
  for (const s of bin) {
    const ids = (companyIdsByService.get(String(s.id)) || []).filter((id) => nameById.get(id));
    if (ids.length === 0) continue;
    const unitKey = [...ids].sort().join(',');
    if (!units.has(unitKey)) units.set(unitKey, { names: ids.map((id) => nameById.get(id).replace(/\s+/g, ' ').trim()), providers: new Map() });
    const provider = String(s.properties?.service_provider || '').trim();
    const fam = supplierFamily(provider);
    if (fam && !units.get(unitKey).providers.has(fam)) units.get(unitKey).providers.set(fam, provider);
  }
  return [...units.values()];
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }
  if (session.role !== 'admin') {
    return res.status(403).json({ status: 'error', error: 'This view is company-wide and restricted to admin accounts' });
  }

  try {
    const now = new Date();
    const { y, m } = sydneyYMD(now);   // m is 1-12: the CURRENT month in Sydney
    const start = (k) => Date.UTC(y, m - 1 - k, 1);   // first day of the month k months ago (k=1 is last month)
    const key = (k) => new Date(start(k)).toISOString().slice(0, 7);
    const kLast = key(1), kP1 = key(2), kP2 = key(3);

    const invoices = await fetchPassedInvoices(start(3), start(0) - 1);

    // v1.2: invoices that exist but are HELD (Needs Review), dated last month
    let heldInvoices = [];
    try { heldInvoices = await fetchPassedInvoices(start(1), start(0) - 1, 'Needs Review'); } catch (e) { console.log(`⚠️ Could not read held invoices for the missing-invoice check: ${e.message}`); }
    const heldBy = new Map();   // company key -> Map(family|'' -> { supplier, amount, lastDate })
    for (const inv of heldInvoices) {
      if (String(inv.billingDate || '').slice(0, 7) !== kLast) continue;
      const parsed = parseInvoiceTitle(inv.properties?.hs_title);
      if (!parsed) continue;
      const ck = norm(parsed.company);
      const fam = supplierFamily(parsed.supplier) || '';
      if (!heldBy.has(ck)) heldBy.set(ck, new Map());
      const slot = heldBy.get(ck).get(fam) || { supplier: prettySupplier(parsed.supplier), amount: 0, lastDate: '' };
      slot.amount += parseFloat(inv.properties?.hs_amount_billed) || 0;
      if (inv.billingDate > slot.lastDate) slot.lastDate = inv.billingDate;
      heldBy.get(ck).set(fam, slot);
    }
    const heldFor = (nameKeys, family) => {   // family null = any supplier
      let found = null;
      for (const nk of nameKeys) {
        const fams = heldBy.get(nk);
        if (!fams) continue;
        for (const [f, slot] of fams) {
          if (family && f !== family) continue;
          found = found ? { ...found, amount: found.amount + slot.amount, lastDate: slot.lastDate > found.lastDate ? slot.lastDate : found.lastDate } : { ...slot };
        }
      }
      return found;
    };

    const pairs = new Map();
    for (const inv of invoices) {
      const month = String(inv.billingDate || '').slice(0, 7);
      if (month !== kLast && month !== kP1 && month !== kP2) continue;
      const parsed = parseInvoiceTitle(inv.properties?.hs_title);
      if (!parsed) continue;
      const pairKey = `${norm(parsed.company)}||${parsed.supplier.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      if (!pairs.has(pairKey)) pairs.set(pairKey, { company: parsed.company, supplier: prettySupplier(parsed.supplier), family: supplierFamily(parsed.supplier), months: {} });
      const entry = pairs.get(pairKey);
      const slot = entry.months[month] || (entry.months[month] = { count: 0, amount: 0, lastDate: '' });
      slot.count++;
      slot.amount += parseFloat(inv.properties?.hs_amount_billed) || 0;
      if (inv.billingDate > slot.lastDate) slot.lastDate = inv.billingDate;
    }

    // what was billed last month, by company: the supplier families that billed it
    const billedLast = new Map();
    for (const e of pairs.values()) {
      if (!e.months[kLast]) continue;
      const k = norm(e.company);
      if (!billedLast.has(k)) billedLast.set(k, new Set());
      billedLast.get(k).add(e.family);
    }

    // the latest earlier billing of this client (and supplier family, if given), for the "last invoiced" columns
    const historyOf = (companyNames, family) => {
      const keys = companyNames.map(norm);
      let best = null;
      const seen = new Set();
      for (const e of pairs.values()) {
        if (!keys.includes(norm(e.company))) continue;
        if (family && e.family !== family) continue;
        for (const k of [kP1, kP2]) {
          if (!e.months[k]) continue;
          seen.add(k);
          if (!best || k > best.k) best = { k, lastDate: e.months[k].lastDate, amount: e.months[k].amount };
        }
      }
      return best ? { ...best, months: [...seen].sort().map(SHORT) } : null;
    };

    const likelyMissing = [];
    const toCheck = [];
    const onHold = [];
    const covered = new Set();   // `${companyKey}||${family}` or `${companyKey}||*`: already listed from the rate card

    // ---- v1.1: from the rate card ----
    let expectedUnits = [];
    try { expectedUnits = await loadExpectedClients(); } catch (e) { console.log(`⚠️ Could not read the rate card services for the missing-invoice check: ${e.message}`); }
    for (const unit of expectedUnits) {
      const nameKeys = unit.names.map(norm);
      const billedFamilies = new Set();
      let billedAtAll = false;
      for (const nk of nameKeys) if (billedLast.has(nk)) { billedAtAll = true; for (const f of billedLast.get(nk)) billedFamilies.add(f); }

      if (!billedAtAll) {
        const heldAll = heldFor(nameKeys, null);
        if (heldAll) {
          onHold.push({ client: unit.names[0], supplier: heldAll.supplier, reason: 'Held for review', lastInvoiceDate: heldAll.lastDate, lastAmount: Math.round(heldAll.amount * 100) / 100, monthsBilled: [] });
          for (const nk of nameKeys) covered.add(`${nk}||*`);
          continue;
        }
        const providers = [...unit.providers.values()];
        const h = historyOf(unit.names, null);
        likelyMissing.push({
          client: unit.names[0],
          supplier: providers.length ? providers.map(prettySupplier).join(' / ') : '—',
          reason: 'Active client, no invoice',
          lastInvoiceDate: h ? h.lastDate : null,
          lastAmount: h ? Math.round(h.amount * 100) / 100 : 0,
          monthsBilled: h ? h.months : [],
        });
        for (const nk of nameKeys) covered.add(`${nk}||*`);
        continue;
      }
      for (const [fam, provider] of unit.providers) {
        if (NOT_MONTHLY_FAMILIES.has(fam) || billedFamilies.has(fam)) continue;
        const heldFam = heldFor(nameKeys, fam);
        if (heldFam) {
          onHold.push({ client: unit.names[0], supplier: prettySupplier(provider), reason: 'Held for review', lastInvoiceDate: heldFam.lastDate, lastAmount: Math.round(heldFam.amount * 100) / 100, monthsBilled: [] });
          for (const nk of nameKeys) covered.add(`${nk}||${fam}`);
          continue;
        }
        const h = historyOf(unit.names, fam);
        likelyMissing.push({
          client: unit.names[0],
          supplier: prettySupplier(provider),
          reason: 'Supplier invoice missing',
          lastInvoiceDate: h ? h.lastDate : null,
          lastAmount: h ? Math.round(h.amount * 100) / 100 : 0,
          monthsBilled: h ? h.months : [],
        });
        for (const nk of nameKeys) covered.add(`${nk}||${fam}`);
      }
    }

    // ---- v1.0: from past invoices, for everything not already listed ----
    let billedLastMonth = 0;
    for (const e of pairs.values()) {
      if (e.months[kLast]) { billedLastMonth++; continue; }
      if (isIgnored(e.company, e.supplier)) continue;
      const ck = norm(e.company);
      if (covered.has(`${ck}||*`) || (e.family && covered.has(`${ck}||${e.family}`))) continue;
      const heldPair = heldFor([ck], e.family || '');
      if (heldPair) {
        onHold.push({ client: e.company, supplier: heldPair.supplier, reason: 'Held for review', lastInvoiceDate: heldPair.lastDate, lastAmount: Math.round(heldPair.amount * 100) / 100, monthsBilled: [] });
        continue;
      }
      const had = [kP1, kP2].filter((k) => e.months[k]);
      if (had.length === 0) continue;
      const item = {
        client: e.company,
        supplier: e.supplier,
        reason: had.length === 2 ? 'Billed two months running' : 'Billed once recently',
        lastInvoiceDate: e.months[had[0]].lastDate,
        lastAmount: Math.round(e.months[had[0]].amount * 100) / 100,
        monthsBilled: [kP2, kP1].filter((k) => e.months[k]).map(SHORT),
      };
      (had.length === 2 ? likelyMissing : toCheck).push(item);
    }
    const byValue = (a, b) => b.lastAmount - a.lastAmount;
    likelyMissing.sort(byValue);
    toCheck.sort(byValue);
    onHold.sort(byValue);

    return res.status(200).json({
      status: 'ok',
      asAt: now.toISOString(),
      lastMonth: LABEL(kLast),
      comparedWith: [LABEL(kP2), LABEL(kP1)],
      billedLastMonth,
      likelyMissingCount: likelyMissing.length,
      onHoldCount: onHold.length,
      toCheckCount: toCheck.length,
      likelyMissing,
      onHold,
      toCheck,
      note: 'Starts from the rate card: every client with an active bin service should have an invoice each month. Also looks at past invoices (supplier invoice date). Grease trap and pump-out invoices are not monthly, so they often show under "to check". An invoice that exists but is held for review shows under "on hold", not as missing. A line disappears as soon as its invoice arrives.',
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
