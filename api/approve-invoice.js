// FWS Command Center — Approve Invoice Proxy
// v1.1 — 14 Sept 2026
// v1.1: Added the site-wide session-cookie check (see login.js /
//   whoami.js in the project root) — this endpoint confirms real
//   invoices and creates real Xero drafts, so it especially must not
//   be callable without a valid session.
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

import crypto from 'crypto';

const INVOICE_AUTOMATION_BASE = process.env.INVOICE_AUTOMATION_BASE_URL || 'https://clv-invoice-automation.vercel.app';

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

export default async function handler(req, res) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      message: 'Command Center — Approve Invoice proxy',
      version: 'v1.1',
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
