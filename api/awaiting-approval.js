// ================================================================
// FWS Command Center — Invoices Awaiting Approval
// Deploy as: api/awaiting-approval.js
// ================================================================
// Version: v1.3
//
// v1.3: TWO changes.
// (1) The Xero reader (fws-xero-reader /api/query) now requires a
// shared secret, so this endpoint sends it as an x-reader-key header.
// The secret is XERO_READER_KEY, a Vercel environment variable that must
// be set on THIS project (the Command Center) with exactly the same value
// as on fws-xero-reader. If it is missing here, the endpoint says so
// plainly; if the reader rejects the key (HTTP 401) the error says to
// check that the two values match.
// (2) FIX - how long a draft has been waiting is no longer measured from the
// INVOICE date. Since clv-invoice-automation v5.5.97Agent (10 Oct 2026) a
// draft carries the SUPPLIER'S invoice date, e.g. 30 September, but is
// created days later (the month-end run happens on 3 to 9 October). Measured
// from the invoice date, a draft created this morning would already have
// "waited" 3 or more business days and be counted as stuck. The clock now
// starts at Xero's UpdatedDateUTC, i.e. when the draft was created or last
// edited, and falls back to the invoice date only if Xero did not return
// it. Each item also shows the invoice date. The "stuck" threshold, and
// every field the dashboard already reads, are unchanged.
// NOTE: the separate xero-draft-check.js cron in clv-invoice-automation
// measures the same way and needs the same fix before the next month end.
//
// v1.2: swapped the old inline single-shared-password cookie check
// for the shared verifySession() from lib/auth.js — required now
// that the Command Centre has moved to real per-person logins (see
// lib/auth.js / api/login.js). Also restricted to admin sessions:
// this is every invoice awaiting approval company-wide, not any one
// rep's own book.
// v1.1: Added the site-wide session-cookie check (see login.js /
// whoami.js in the project root) — this endpoint returns real invoice
// and client data, so it must reject unauthenticated requests
// directly, not just rely on the dashboard page itself being behind a login
// screen.
//
// PURPOSE: a live count + age breakdown of every Xero invoice still
// sitting in DRAFT — i.e. created, but not yet reviewed/authorised by
// James. This is the "how many, and how long" companion to the
// existing xero-draft-check.js cron (in clv-invoice-automation),
// which only ever fires a one-off alert once a single invoice crosses
// 3 business days in Draft. That checker answers "is anything stuck
// right now?"; this endpoint answers "what does the whole pile look
// like at a glance?" — same threshold, same definition of "stuck",
// just aggregated for the dashboard instead of alerted one at a time.
//
// Deliberately mirrors ar-aging.js's shape (same fws-xero-reader
// query pattern, same style of bucketing) since it's the same
// lifecycle stage's data, just before authorisation instead of after.
//
// Usage: GET /api/awaiting-approval
// ================================================================

import { verifySession } from '../lib/auth.js';

const XERO_READER_BASE_URL = process.env.XERO_READER_BASE_URL || 'https://fws-xero-reader.vercel.app';

// Matches the 3-business-day threshold already confirmed and in use
// by clv-invoice-automation's xero-draft-check.js — kept identical so
// the dashboard card and the alert email can never disagree about
// what counts as "stuck".
const STUCK_BUSINESS_DAYS_THRESHOLD = 3;

function businessDaysElapsed(fromDate, toDate) {
  const cursor = new Date(fromDate);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(toDate);
  end.setHours(0, 0, 0, 0);
  let count = 0;
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    const day = cursor.getDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

// v1.3: Xero sends timestamps as "/Date(1723450000000+0000)/"
function parseXeroDate(value) {
  const m = /\/Date\((-?\d+)/.exec(String(value || ''));
  if (m) return new Date(Number(m[1]));
  if (value && !Number.isNaN(new Date(value).getTime())) return new Date(value);
  return null;
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }
  if (session.role !== 'admin') {
    return res.status(403).json({ status: 'error', error: 'This view is company-wide and restricted to admin accounts' });
  }

  // v1.3: the secret the Xero reader now requires
  const readerKey = process.env.XERO_READER_KEY;
  if (!readerKey) {
    return res.status(500).json({ status: 'error', error: 'XERO_READER_KEY is not set on the Command Center project, so it cannot read Xero. Add it in Vercel with the same value as fws-xero-reader.' });
  }

  try {
    const where = 'Status=="DRAFT" AND Type=="ACCREC"';
    const url = `${XERO_READER_BASE_URL}/api/query?resource=Invoices&where=${encodeURIComponent(where)}&order=Date ASC`;

    const response = await fetch(url, { headers: { 'x-reader-key': readerKey } });
    const data = await response.json();

    if (!response.ok) {
      const hint = response.status === 401 ? ' (the reader rejected the key: check XERO_READER_KEY is the same on both projects)' : '';
      return res.status(response.status).json({ status: 'error', error: `fws-xero-reader query failed${hint}`, details: data });
    }

    const invoices = data.Invoices || [];
    const now = new Date();

    let totalAmount = 0;
    let stuckCount = 0;
    let stuckAmount = 0;
    let oldest = null;

    const items = invoices.map((inv) => {
      // v1.3: the clock starts when the draft was created or last edited, NOT at the invoice date
      const waitingSince = parseXeroDate(inv.UpdatedDateUTC) || new Date(inv.DateString || inv.Date);
      const businessDaysWaiting = businessDaysElapsed(waitingSince, now);
      const total = parseFloat(inv.Total) || 0;
      const isStuck = businessDaysWaiting >= STUCK_BUSINESS_DAYS_THRESHOLD;

      totalAmount += total;
      if (isStuck) {
        stuckCount++;
        stuckAmount += total;
      }

      const item = {
        invoiceNumber: inv.InvoiceNumber,
        client: inv.Contact?.Name || 'Unknown',
        total: Math.round(total * 100) / 100,
        invoiceDate: String(inv.DateString || '').slice(0, 10) || null,
        businessDaysWaiting,
        stuck: isStuck,
      };

      if (!oldest || businessDaysWaiting > oldest.businessDaysWaiting) {
        oldest = item;
      }

      return item;
    });

    // Sort oldest-waiting-first, so the dashboard table naturally
    // surfaces the ones needing attention at the top.
    items.sort((a, b) => b.businessDaysWaiting - a.businessDaysWaiting);

    return res.status(200).json({
      status: 'ok',
      checkedAt: now.toISOString(),
      stuckThresholdBusinessDays: STUCK_BUSINESS_DAYS_THRESHOLD,
      totalCount: invoices.length,
      totalAmount: Math.round(totalAmount * 100) / 100,
      stuckCount,
      stuckAmount: Math.round(stuckAmount * 100) / 100,
      oldest: oldest ? { invoiceNumber: oldest.invoiceNumber, client: oldest.client, businessDaysWaiting: oldest.businessDaysWaiting } : null,
      items,
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
