// ================================================================
// FWS Command Center — Accounts Payable Aging (largest suppliers)
// Deploy as: api/ap-aging.js
// ================================================================
// Version: v1.1
//
// v1.1: Added the site-wide session-cookie check (see login.js /
// whoami.js in the project root for how the cookie is created and
// verified) — this endpoint returns real supplier/payables data, so
// it must reject unauthenticated requests directly, not just rely on
// the dashboard page itself being behind a login screen.
//
// PURPOSE: the payables mirror of ar-aging.js — same structure, same
// buckets, just Type=="ACCPAY" (bills FWS owes suppliers) instead of
// Type=="ACCREC" (money clients owe FWS), grouped by supplier instead
// of client.
//
// Calls out to fws-xero-reader's existing read-only query proxy, same
// as ar-aging.js — Command Center has no Xero credentials of its own.
//
// KNOWN OPEN QUESTION, confirmed by John (10 Sept 2026): at least one
// real supplier (Remondis) is split across several separate Xero
// Contact records — the exact same fragmentation problem found on the
// client side with Urbis (13 separate HubSpot companies, one per
// site, no parent record). This means "largest supplier" here may
// currently UNDER-count true supplier concentration, the same way
// per-site client grouping under-counts true client concentration.
// Deliberately NOT attempting automatic consolidation yet — the real
// Xero contact naming pattern for split suppliers hasn't been seen
// yet (fws-xero-reader is still on Demo Company, pending James's
// live-org login), and guessing at a normalization rule before seeing
// real data risks the same kind of over-eager fuzzy-match mistake
// already found and fixed once in clv-invoice-automation's own vendor
// matching (Premier Waste / Wanless false-positive). Revisit once
// real supplier names are visible.
//
// Usage: GET /api/ap-aging
// ================================================================

import crypto from 'crypto';

const XERO_READER_BASE_URL = process.env.XERO_READER_BASE_URL || 'https://fws-xero-reader.vercel.app';

const AP_CONCENTRATION_NOTE_THRESHOLD_PERCENT = 20;

function isAuthenticated(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)cc_session=([^;]+)/);
  if (!match) return false;
  const [expiryStr, signature] = decodeURIComponent(match[1]).split('.');
  const expiry = Number(expiryStr);
  if (!expiry || Date.now() > expiry) return false;
  const expected = crypto.createHmac('sha256', process.env.CC_PASSWORD || '').update(String(expiry)).digest('hex');
  const sigBuf = Buffer.from(signature || '');
  const expBuf = Buffer.from(expected);
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}

function bucketFor(daysOverdue) {
  if (daysOverdue <= 0) return 'notYetDue';
  if (daysOverdue <= 30) return 'current_0_30';
  if (daysOverdue <= 60) return 'overdue_31_60';
  if (daysOverdue <= 90) return 'overdue_61_90';
  return 'overdue_90_plus';
}

export default async function handler(req, res) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }

  try {
    const where = 'Status=="AUTHORISED" AND Type=="ACCPAY" AND AmountDue>0';
    const url = `${XERO_READER_BASE_URL}/api/query?resource=Invoices&where=${encodeURIComponent(where)}&order=DueDate ASC`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ status: 'error', error: 'fws-xero-reader query failed', details: data });
    }

    const bills = data.Invoices || [];
    const now = new Date();

    const buckets = { notYetDue: 0, current_0_30: 0, overdue_31_60: 0, overdue_61_90: 0, overdue_90_plus: 0 };
    const bySupplier = new Map();
    let totalOwing = 0;

    for (const bill of bills) {
      const dueDate = new Date(bill.DueDateString || bill.DueDate);
      const daysOverdue = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
      const amountDue = parseFloat(bill.AmountDue) || 0;
      const bucket = bucketFor(daysOverdue);

      buckets[bucket] += amountDue;
      totalOwing += amountDue;

      // NOT normalized/consolidated — see file header note. A supplier
      // split across several Xero contacts (confirmed: Remondis) will
      // show as separate rows here until real naming patterns are
      // seen and a safe consolidation rule can be designed.
      const supplierName = bill.Contact?.Name || 'Unknown';
      if (!bySupplier.has(supplierName)) bySupplier.set(supplierName, { name: supplierName, amountOwing: 0, billCount: 0, oldestDaysOverdue: 0 });
      const entry = bySupplier.get(supplierName);
      entry.amountOwing += amountDue;
      entry.billCount++;
      entry.oldestDaysOverdue = Math.max(entry.oldestDaysOverdue, daysOverdue);
    }

    const roundedBuckets = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, Math.round(v * 100) / 100]));
    const currentPercent = totalOwing > 0 ? Math.round(((buckets.notYetDue + buckets.current_0_30) / totalOwing) * 1000) / 10 : null;

    const suppliers = [...bySupplier.values()]
      .map((s) => ({
        name: s.name,
        amountOwing: Math.round(s.amountOwing * 100) / 100,
        percentOfTotalPayables: totalOwing > 0 ? Math.round((s.amountOwing / totalOwing) * 1000) / 10 : 0,
        concentrationNote: totalOwing > 0 && (s.amountOwing / totalOwing) * 100 >= AP_CONCENTRATION_NOTE_THRESHOLD_PERCENT,
        billCount: s.billCount,
        oldestDaysOverdue: s.oldestDaysOverdue,
      }))
      .sort((a, b) => b.amountOwing - a.amountOwing);

    return res.status(200).json({
      status: 'ok',
      checkedAt: now.toISOString(),
      totalOwing: Math.round(totalOwing * 100) / 100,
      currentPercent,
      buckets: roundedBuckets,
      concentrationNoteThresholdPercent: AP_CONCENTRATION_NOTE_THRESHOLD_PERCENT,
      supplierCount: suppliers.length,
      suppliers,
      note: 'Supplier names shown exactly as recorded in Xero — not consolidated. A supplier split across multiple Xero contacts (confirmed: Remondis) will appear as separate rows until a safe consolidation rule is designed from real data.',
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
