// ================================================================
// FWS Command Center — Invoices Awaiting Approval
// Deploy as: api/awaiting-approval.js
// ================================================================
// Version: v1.2
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
// directly, not just rely on the dashboard page being behind a login
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

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }
  if (session.role !== 'admin') {
    return res.status(403).json({ status: 'error', error: 'This view is company-wide and restricted to admin accounts' });
  }

  try {
    const where = 'Status=="DRAFT" AND Type=="ACCREC"';
    const url = `${XERO_READER_BASE_URL}/api/query?resource=Invoices&where=${encodeURIComponent(where)}&order=Date ASC`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ status: 'error', error: 'fws-xero-reader query failed', details: data });
    }

    const invoices = data.Invoices || [];
    const now = new Date();

    let totalAmount = 0;
    let stuckCount = 0;
    let stuckAmount = 0;
    let oldest = null;

    const items = invoices.map((inv) => {
      const createdDate = new Date(inv.DateString || inv.Date);
      const businessDaysWaiting = businessDaysElapsed(createdDate, now);
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
