// FWS Command Center — Approve Invoice Proxy
// v1.0 — 7 Sept 2026
//
// PURPOSE: the Command Center frontend cannot safely call
// clv-invoice-automation's api/approve endpoint directly from the
// browser — cross-origin requests from fws-command-center.vercel.app
// to clv-invoice-automation.vercel.app hit the same CORS problem
// already solved once before for Agent Health (which is why those
// cards go through this project's own api/status.js instead of
// hitting each agent's URL directly from the page). This is the same
// fix, applied to the new "Confirm & Create Xero Draft" button:
// Command Center's own server calls clv-invoice-automation server-side
// (server-to-server requests aren't subject to browser CORS), and
// just passes the result back to the page.
//
// This file deliberately contains NO business logic of its own — it
// only forwards the invoiceId and relays whatever approve.js decides.
// The actual "confirm and create Xero draft" logic stays in exactly
// one place (clv-invoice-automation), same principle as everywhere
// else in this build: no duplicated logic across projects.

const INVOICE_AUTOMATION_BASE = process.env.INVOICE_AUTOMATION_BASE_URL || 'https://clv-invoice-automation.vercel.app';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      message: 'Command Center — Approve Invoice proxy',
      version: 'v1.0',
      forwardsTo: `${INVOICE_AUTOMATION_BASE}/api/approve`,
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const invoiceId = req.body?.invoiceId;
  if (!invoiceId) {
    return res.status(400).json({ status: 'error', error: 'Missing required field: invoiceId' });
  }

  try {
    const upstreamResponse = await fetch(`${INVOICE_AUTOMATION_BASE}/api/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId }),
    });
    const upstreamData = await upstreamResponse.json();

    // Relay the upstream status code and body as-is — this proxy
    // makes no judgement calls of its own about success/failure.
    return res.status(upstreamResponse.status).json(upstreamData);
  } catch (error) {
    return res.status(502).json({
      status: 'error',
      error: `Could not reach invoice automation service: ${error.message}`,
    });
  }
}
