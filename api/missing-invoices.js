// ================================================================
// FWS Command Center — Invoices still to come (missing-invoice check)
// Deploy as: api/missing-invoices.js
// ================================================================
// Version: v1.0
//
// PURPOSE: catch an invoice that should have arrived but has not, before
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
// Lost accounts: put a client or supplier name (lower case, any part of it) in
// IGNORE_NAMES below and it never appears. Röhlig is already there: it has gone
// to another supplier, so its invoices have rightly stopped.
//
// Admin only (company-wide). Usage: GET /api/missing-invoices
// ================================================================

import { verifySession } from '../lib/auth.js';
import { fetchPassedInvoices, sydneyYMD } from '../lib/hubspotInvoiceData.js';

const IGNORE_NAMES = ['röhlig', 'rohlig'];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = (key) => MONTH_NAMES[Number(key.slice(5, 7)) - 1].slice(0, 3);
const LABEL = (key) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

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

    const pairs = new Map();
    for (const inv of invoices) {
      const month = String(inv.billingDate || '').slice(0, 7);
      if (month !== kLast && month !== kP1 && month !== kP2) continue;
      const parsed = parseInvoiceTitle(inv.properties?.hs_title);
      if (!parsed || isIgnored(parsed.company, parsed.supplier)) continue;
      const pairKey = `${parsed.company.toLowerCase()}||${parsed.supplier.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      if (!pairs.has(pairKey)) pairs.set(pairKey, { company: parsed.company, supplier: prettySupplier(parsed.supplier), months: {} });
      const entry = pairs.get(pairKey);
      const slot = entry.months[month] || (entry.months[month] = { count: 0, amount: 0, lastDate: '' });
      slot.count++;
      slot.amount += parseFloat(inv.properties?.hs_amount_billed) || 0;
      if (inv.billingDate > slot.lastDate) slot.lastDate = inv.billingDate;
    }

    let billedLastMonth = 0;
    const likelyMissing = [];
    const toCheck = [];
    for (const e of pairs.values()) {
      if (e.months[kLast]) { billedLastMonth++; continue; }
      const had = [kP1, kP2].filter((k) => e.months[k]);
      if (had.length === 0) continue;
      const latestKey = had[0];   // kP1 (the month just before last month) is newer than kP2
      const item = {
        client: e.company,
        supplier: e.supplier,
        lastInvoiceDate: e.months[latestKey].lastDate,
        lastAmount: Math.round(e.months[latestKey].amount * 100) / 100,
        monthsBilled: [kP2, kP1].filter((k) => e.months[k]).map(SHORT),
      };
      (had.length === 2 ? likelyMissing : toCheck).push(item);
    }
    const byValue = (a, b) => b.lastAmount - a.lastAmount;
    likelyMissing.sort(byValue);
    toCheck.sort(byValue);

    return res.status(200).json({
      status: 'ok',
      asAt: now.toISOString(),
      lastMonth: LABEL(kLast),
      comparedWith: [LABEL(kP2), LABEL(kP1)],
      billedLastMonth,
      likelyMissingCount: likelyMissing.length,
      toCheckCount: toCheck.length,
      likelyMissing,
      toCheck,
      note: 'Counted by the supplier invoice date. Grease trap and pump-out invoices are not monthly, so they often show under "to check". A pair disappears from this list as soon as its invoice arrives.',
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
