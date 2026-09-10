// ================================================================
// FWS Command Center — Accounts Receivable Aging
// Deploy as: api/ar-aging.js
// ================================================================
// Version: v1.0
//
// PURPOSE: the last of the four original "Business Vital Signs"
// groupings. This is the one piece that genuinely needs Xero — real
// payment/due status doesn't exist anywhere in HubSpot at all
// (validation_status only tracks whether OUR system confirmed the
// invoice before sending it, nothing about whether the client has
// actually paid).
//
// Calls out to fws-xero-reader's existing read-only query proxy
// rather than talking to Xero directly — Command Center has no Xero
// credentials of its own, by design, same separation used throughout
// this build.
//
// Aging buckets follow the standard framework: 0-30 (current), 31-60,
// 61-90, 90+ days past due date. A healthy distribution has ~80% or
// more in the current bucket (industry benchmark). Also flags client
// concentration WITHIN receivables specifically — a single client
// making up 20-25%+ of total overdue $ is a distinct, elevated risk
// signal from general revenue concentration, since it means a single
// late payment could create real cash pressure.
//
// Usage: GET /api/ar-aging
// ================================================================

const XERO_READER_BASE_URL = process.env.XERO_READER_BASE_URL || 'https://fws-xero-reader.vercel.app';

const AR_CONCENTRATION_RISK_THRESHOLD_PERCENT = 20;

function bucketFor(daysOverdue) {
  if (daysOverdue <= 0) return 'notYetDue';
  if (daysOverdue <= 30) return 'current_0_30';
  if (daysOverdue <= 60) return 'overdue_31_60';
  if (daysOverdue <= 90) return 'overdue_61_90';
  return 'overdue_90_plus';
}

export default async function handler(req, res) {
  try {
    const where = 'Status=="AUTHORISED" AND Type=="ACCREC" AND AmountDue>0';
    const url = `${XERO_READER_BASE_URL}/api/query?resource=Invoices&where=${encodeURIComponent(where)}&order=DueDate ASC`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ status: 'error', error: 'fws-xero-reader query failed', details: data });
    }

    const invoices = data.Invoices || [];
    const now = new Date();

    const buckets = { notYetDue: 0, current_0_30: 0, overdue_31_60: 0, overdue_61_90: 0, overdue_90_plus: 0 };
    const byClient = new Map();
    let totalOutstanding = 0;

    for (const inv of invoices) {
      const dueDate = new Date(inv.DueDateString || inv.DueDate);
      const daysOverdue = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
      const amountDue = parseFloat(inv.AmountDue) || 0;
      const bucket = bucketFor(daysOverdue);

      buckets[bucket] += amountDue;
      totalOutstanding += amountDue;

      const clientName = inv.Contact?.Name || 'Unknown';
      if (!byClient.has(clientName)) byClient.set(clientName, { name: clientName, amountDue: 0, invoiceCount: 0, oldestDaysOverdue: 0 });
      const entry = byClient.get(clientName);
      entry.amountDue += amountDue;
      entry.invoiceCount++;
      entry.oldestDaysOverdue = Math.max(entry.oldestDaysOverdue, daysOverdue);
    }

    const roundedBuckets = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, Math.round(v * 100) / 100]));
    const currentPercent = totalOutstanding > 0 ? Math.round(((buckets.notYetDue + buckets.current_0_30) / totalOutstanding) * 1000) / 10 : null;

    const clients = [...byClient.values()]
      .map((c) => ({
        name: c.name,
        amountDue: Math.round(c.amountDue * 100) / 100,
        percentOfTotalReceivables: totalOutstanding > 0 ? Math.round((c.amountDue / totalOutstanding) * 1000) / 10 : 0,
        concentrationRisk: totalOutstanding > 0 && (c.amountDue / totalOutstanding) * 100 >= AR_CONCENTRATION_RISK_THRESHOLD_PERCENT,
        invoiceCount: c.invoiceCount,
        oldestDaysOverdue: c.oldestDaysOverdue,
      }))
      .sort((a, b) => b.amountDue - a.amountDue);

    return res.status(200).json({
      status: 'ok',
      checkedAt: now.toISOString(),
      totalOutstanding: Math.round(totalOutstanding * 100) / 100,
      currentPercent, // industry healthy benchmark: ~80%+
      buckets: roundedBuckets,
      concentrationRiskThresholdPercent: AR_CONCENTRATION_RISK_THRESHOLD_PERCENT,
      clientCount: clients.length,
      clients,
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
