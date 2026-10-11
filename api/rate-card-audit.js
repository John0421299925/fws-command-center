// ================================================================
// FWS Command Center — "Things that don't add up" (rate card audit)
// Deploy as: api/rate-card-audit.js
// ================================================================
// Version: v1.0
//
// PURPOSE: John, 11 Oct 2026: it is not enough to fix the rate card once; next
// month and the months after must not go the same way, and he must not have to
// download files or open web addresses to find out. This runs the check by
// itself and the dashboard shows the result. It puts two things side by side:
//   - the XERO half: every priced line James billed in the month (read from the
//     Xero reader's /api/invoice-lines, all statuses including drafts), and
//   - the RATE CARD half: every service in HubSpot with the client it is linked to.
// and reports what does not add up:
//   noService      a client + kind of charge James billed that has no active service
//                  for that client (the rate card has a hole)
//   priceDiffs     James's price differs from the nearest service price for that client
//   belowCost      rate card services priced below cost, or within 5% of cost;
//                  each marked known = true if it is on KNOWN_BELOW_COST below
//   linkProblems   services linked to a supplier only (no client), or to the wrong
//                  side (north/south, east/west)
//   unmatchedXero  a Xero client with no match in HubSpot (a client James bills that
//                  the rate card does not know about)
//   adHoc          one-off charges with no service type (listed, not a fault)
//   notComparable  lines billed as a lump sum or in a different unit from the rate card
//                  (CLV, Glenthorne, the Pheasant Nest flat grease price): listed, not a fault
// Default month is LAST month (Sydney time); ?month=2026-09 picks another.
// Admin only. Needs XERO_READER_KEY on this project, as ar-aging.js does.
//
// MAINTENANCE (this file holds three small lists, all near the top):
//   CONTACT_MAP        how a Xero client name finds its HubSpot client. A new client
//                      that is not in it shows under unmatchedXero: add a line.
//   KNOWN_BELOW_COST   services John has accepted at James's below-cost price.
//   IGNORE_CONTACTS    Xero clients to leave out (lost accounts, e.g. Röhlig).
// ================================================================

import { verifySession } from '../lib/auth.js';
import { hubspotPost, sydneyYMD } from '../lib/hubspotInvoiceData.js';

const XERO_READER_BASE_URL = process.env.XERO_READER_BASE_URL || 'https://fws-xero-reader.vercel.app';

// [regex on the lower-case Xero contact name, regex on the lower-case HubSpot company names]
const CONTACT_MAP = [
  ['eastbound', 'm4 east'], ['westbound', 'm4 west'], ['pheasants nest north', 'pheasant nest - northbound'], ['pheasants nest south', 'pheasant nest - southbound'],
  ['wyong north', 'm1 - wyong - northbound'], ['wyong south', 'alison \\(wyong\\)'], ['mt annan', 'mt annan'], ['carseldine', 'carseldine'],
  ['chinchilla|c/o urbis services pty ltd \\(', 'chinchilla'], ['glenthorne', 'glenthorne'], ['jax tyres', 'jax tyres'], ['bc coatings', 'bc coatings'],
  ['singleton', 'mcdougalls'], ['muswellbrook', 'muswellbrook'], ['deepwater', 'deepwater'], ['dp 1298679', 'surry hills'], ['gvsc', 'glenrose'], ['harrington', 'fairfield'],
  ['nivad', 'karingal'], ['ocean ink', 'ocean ink'], ['picton', 'picton'], ['sekisui', 'sekisui'], ['the trust company', 'freddy'], ['milton village', 'milton village'],
  ['park sydney', 'park sydney'], ['schofield', 'schofields'], ['helson', 'richmond mall'], ['\\(unsw\\)', 'unsw'], ['syd uni', 'sydney university'], ['carlton', 'melbourne university'],
  ['big fish', 'big fish'], ['command 51', 'command 51'],
];
const IGNORE_CONTACTS = /r(ö|o)hlig/i;

// service IDs John accepted at James's below-cost (or at-cost) price: shown as known, not as new
const KNOWN_BELOW_COST = new Set(['683982006750', '727919516129', '704835596747', '692658275784', '688560920000', '688524675577', '694431169003', '694524729842', '688677334463',
  '690476456384', '690767217087', '690476467667', '690457834967',
  // thin (under 5%) but James's own prices, accepted 11 Oct 2026
  '695494965711', '694893534664', '688677334509', '634052641272', '694108818878', '696547167700']);

const SUPPLIER_NAMES = /^(bingo industries|remondis australia pty ltd|hlw group|jr richards|waste free \(aust\) pty ltd|power waste management pty ltd|redirect recycling pty ltd|premier waste|wanless waste management - qld|any company)$/i;

function lineKind(d) {
  if (/fuel|levey|surcharge/.test(d) && !/enviro/.test(d)) return 'fuel levy';
  if (/admin|maintenance/.test(d)) return 'admin / maintenance';
  if (/enviro|\bepa\b/.test(d)) return 'environmental levy';
  if (/excess/.test(d)) return 'excess weight';
  if (/deliver/.test(d)) return 'delivery';
  if (/organic|orgain/.test(d)) return 'organic';
  if (/grease|sludge|septic|effluent|\bpits?\b|\bdaf\b|\btank|pump/.test(d)) return 'grease / liquid';
  if (/cardboard|paper|\bpac\b|recycl|co.?mingle|comingle/.test(d)) return 'recycling';
  if (/rental|\brent\b|hire/.test(d)) return 'bin rental';
  if (/labou?r/.test(d)) return 'labour';
  if (/\btip|tonne|disposal charge/.test(d)) return 'general waste';   // a tipping / disposal fee is the waste service itself
  if (/transport|change.?over|hook/.test(d)) return 'transport / hook lift';
  if (/general|waste coll|f\/l|front lift|r\/l|rear lift|collection|putrescible|\bservice\b/.test(d)) return 'general waste';
  return 'other';
}
const SERVICE_KIND = { 'General Waste': 'general waste', 'Paper and Cardboard': 'recycling', 'Co-Mingle': 'recycling', 'Organic Waste': 'organic', 'Excess Disposal Charge': 'excess weight', 'Grease Trap': 'grease / liquid',
  'Liquid Waste': 'grease / liquid', 'All Waste Type': 'fuel levy', 'Environmental Levy': 'environmental levy', 'Admin Fee': 'admin / maintenance', 'Transport - HL, Vac, Tanker, Tautliner': 'transport / hook lift',
  'Labour': 'labour', 'Delivery - Bins': 'delivery' };
const serviceKind = (s) => (/maintenance/i.test(s.hs_name || '') ? 'admin / maintenance' : (/excess/i.test(s.hs_name || '') ? 'excess weight' : (SERVICE_KIND[s.waste_type] || 'other')));

function directionConflict(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  for (const [x, y] of [['northbound', 'southbound'], ['east', 'west']]) {
    if ((a.includes(x) && b.includes(y) && !a.includes(y) && !b.includes(x)) || (a.includes(y) && b.includes(x) && !a.includes(x) && !b.includes(y))) return true;
  }
  return false;
}

async function loadServices() {
  const services = [];
  let after;
  for (let page = 0; page < 30; page++) {
    const data = await hubspotPost('/crm/v3/objects/0-162/search', {
      limit: 100, after, sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      properties: ['hs_name', 'service_status', 'service_provider', 'waste_type', 'unit_cost_from_service_provider', 'unit_cost_to_client', 'bin_rental'],
      filterGroups: [{ filters: [{ propertyName: 'hs_name', operator: 'HAS_PROPERTY' }] }],
    });
    services.push(...(data.results || []));
    after = data.paging?.next?.after;
    if (!after) break;
  }
  const idsByService = new Map();
  for (let i = 0; i < services.length; i += 100) {
    const data = await hubspotPost('/crm/v4/associations/0-162/companies/batch/read', { inputs: services.slice(i, i + 100).map((s) => ({ id: String(s.id) })) });
    for (const r of data.results || []) idsByService.set(String(r.from?.id), (r.to || []).map((t) => String(t.toObjectId)));
  }
  const all = [...new Set([...idsByService.values()].flat())];
  const nameById = new Map();
  for (let i = 0; i < all.length; i += 100) {
    const data = await hubspotPost('/crm/v3/objects/companies/batch/read', { properties: ['name'], inputs: all.slice(i, i + 100).map((id) => ({ id })) });
    for (const c of data.results || []) nameById.set(String(c.id), String(c.properties?.name || '').replace(/\s+/g, ' ').trim());
  }
  return services.map((s) => {
    const p = s.properties || {};
    const companies = (idsByService.get(String(s.id)) || []).map((id) => nameById.get(id) || '').filter(Boolean);
    return {
      id: String(s.id), name: String(p.hs_name || '').trim(), status: p.service_status || '', waste_type: p.waste_type || '', hs_name: p.hs_name || '',
      cost: parseFloat(p.unit_cost_from_service_provider) || 0, price: parseFloat(p.unit_cost_to_client) || 0, rental: String(p.bin_rental || '').toLowerCase() === 'yes',
      companies, clientCompanies: companies.filter((c) => !SUPPLIER_NAMES.test(c)), kind: serviceKind({ hs_name: p.hs_name, waste_type: p.waste_type }),
    };
  });
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  if (session.role !== 'admin') return res.status(403).json({ status: 'error', error: 'This view is company-wide and restricted to admin accounts' });
  const readerKey = process.env.XERO_READER_KEY;
  if (!readerKey) return res.status(500).json({ status: 'error', error: 'XERO_READER_KEY is not set on the Command Center project, so it cannot read Xero. Add it in Vercel with the same value as fws-xero-reader.' });

  try {
    const now = new Date();
    const { y, m } = sydneyYMD(now);
    let monthKey = String(req.query?.month || '');
    if (!/^\d{4}-\d{2}$/.test(monthKey)) monthKey = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
    const [my, mm] = monthKey.split('-').map(Number);
    const from = `${monthKey}-01`;
    const to = new Date(Date.UTC(my, mm, 0)).toISOString().slice(0, 10);

    const resp = await fetch(`${XERO_READER_BASE_URL}/api/invoice-lines?from=${from}&to=${to}&format=json`, { headers: { 'x-reader-key': readerKey } });
    const xdata = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const hint = resp.status === 401 ? ' (the reader rejected the key: check XERO_READER_KEY is the same on both projects)' : '';
      return res.status(resp.status).json({ status: 'error', error: `fws-xero-reader invoice export failed${hint}`, details: xdata });
    }
    const xrows = (xdata.rows || []).filter((r) => Number(r.UnitAmount) > 0);

    const services = (await loadServices()).filter((s) => s.status === 'Active');

    // ---------- the Xero half against the rate card ----------
    const noService = []; const priceDiffs = []; const adHoc = []; const notComparable = []; const unmatchedMap = new Map();
    const groups = new Map();   // company pattern || kind || price -> lines
    for (const r of xrows) {
      const contact = String(r.Contact || ''); const lc = contact.toLowerCase();
      if (IGNORE_CONTACTS.test(contact)) continue;
      const hit = CONTACT_MAP.find(([cp]) => new RegExp(cp).test(lc));
      if (!hit) { const u = unmatchedMap.get(contact) || { contact, lines: 0, amount: 0 }; u.lines++; u.amount += Number(r.LineAmount) || 0; unmatchedMap.set(contact, u); continue; }
      const kind = lineKind(String(r.LineDescription || '').toLowerCase());
      const k = `${hit[1]}||${kind}||${Number(r.UnitAmount).toFixed(4)}`;
      const g = groups.get(k) || { company: hit[1], kind, price: Number(r.UnitAmount), lines: 0, amount: 0, example: r.LineDescription, contact };
      g.lines++; g.amount += Number(r.LineAmount) || 0;
      groups.set(k, g);
    }
    const clientServices = (companyPattern) => services.filter((s) => s.companies.join(' | ').toLowerCase().match(new RegExp(companyPattern)));
    const reported = new Set();
    for (const g of groups.values()) {
      const mine = clientServices(g.company);
      if (g.kind === 'other') { adHoc.push({ client: g.contact, charge: String(g.example || '').slice(0, 60), price: g.price, lines: g.lines, amount: Math.round(g.amount * 100) / 100 }); continue; }
      if (g.kind === 'bin rental') { if (!mine.some((s) => s.rental)) { const key = `${g.company}||rental`; if (!reported.has(key)) { reported.add(key); noService.push({ client: g.contact, kind: 'bin rental', lines: g.lines, amount: Math.round(g.amount * 100) / 100, prices: [g.price], example: String(g.example || '').slice(0, 60) }); } } continue; }
      const same = mine.filter((s) => s.kind === g.kind);
      if (same.length === 0) { noService.push({ client: g.contact, kind: g.kind, lines: g.lines, amount: Math.round(g.amount * 100) / 100, prices: [g.price], example: String(g.example || '').slice(0, 60) }); continue; }
      if (g.kind === 'fuel levy') continue;   // billed as a percentage: presence is all that is checked
      const nearest = same.reduce((a, b) => (Math.abs(b.price - g.price) < Math.abs(a.price - g.price) ? b : a));
      const diff = g.price - nearest.price;
      const ratio = nearest.price > 0 ? g.price / nearest.price : 1;
      if (ratio > 3 || ratio < 0.34) { notComparable.push({ client: g.contact, kind: g.kind, xeroPrice: g.price, rateCardPrice: nearest.price, lines: g.lines, amount: Math.round(g.amount * 100) / 100, why: 'Billed as a lump sum or in a different unit' }); continue; }
      if (Math.abs(diff) > Math.max(0.005, nearest.price * 0.005)) priceDiffs.push({ client: g.contact, kind: g.kind, service: nearest.name, serviceId: nearest.id, xeroPrice: g.price, rateCardPrice: nearest.price, difference: Math.round(diff * 10000) / 10000, lines: g.lines, amount: Math.round(g.amount * 100) / 100 });
    }

    // ---------- the rate card on its own ----------
    const belowCost = [];
    for (const s of services) {
      if (!(s.cost > 0)) continue;
      if (s.kind === 'fuel levy') continue;
      const ratio = s.price / s.cost;
      if (s.price < s.cost - 0.0049 || ratio < 1.05) belowCost.push({ service: s.name, serviceId: s.id, cost: s.cost, price: s.price, margin: Math.round((ratio - 1) * 1000) / 10, kind: s.price < s.cost - 0.0049 ? 'below cost' : 'thin', known: KNOWN_BELOW_COST.has(s.id) });
    }
    const linkProblems = [];
    for (const s of services) {
      if (s.clientCompanies.length === 0) { linkProblems.push({ service: s.name, serviceId: s.id, problem: 'Linked to a supplier only: no client company' }); continue; }
      if (s.clientCompanies.every((c) => directionConflict(s.name, c))) linkProblems.push({ service: s.name, serviceId: s.id, problem: `Linked to the wrong side: ${s.clientCompanies.join(' / ')}` });
    }
    const byAmount = (a, b) => (b.amount || 0) - (a.amount || 0);
    noService.sort(byAmount); priceDiffs.sort(byAmount); adHoc.sort(byAmount); notComparable.sort(byAmount);
    belowCost.sort((a, b) => (a.known === b.known ? a.margin - b.margin : a.known ? 1 : -1));
    const unmatchedXero = [...unmatchedMap.values()].map((u) => ({ ...u, amount: Math.round(u.amount * 100) / 100 })).sort(byAmount);

    return res.status(200).json({
      status: 'ok', asAt: now.toISOString(), month: monthKey, from, to, xeroLines: xrows.length, activeServices: services.length,
      counts: { noService: noService.length, priceDiffs: priceDiffs.length, belowCostNew: belowCost.filter((b) => !b.known).length, belowCostKnown: belowCost.filter((b) => b.known).length, linkProblems: linkProblems.length, unmatchedXero: unmatchedXero.length, adHoc: adHoc.length, notComparable: notComparable.length },
      noService, priceDiffs, belowCost, linkProblems, unmatchedXero, adHoc, notComparable,
      note: 'Every priced Xero line for the month is checked against the active services on the right client. "Known" below-cost items are the ones John has accepted at James\'s price; anything new shows without that mark.',
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
