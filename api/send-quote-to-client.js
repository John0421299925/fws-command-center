// FWS Command Centre — Send Quote to Client Proxy
// Version: v1.1
//
// v1.1: swapped the old inline single-shared-password cookie check
// for the shared verifySession() from lib/auth.js — required now
// that the Command Centre has moved to real per-person logins (see
// lib/auth.js / api/login.js). No role restriction: sending a quote
// to a client is core to a sales rep's actual job, same reasoning as
// approve-quote.js and quotes-pending.js — any logged-in person
// (admin, ops, or a future rep) can use this.
//
// Server-side proxy to the Auto Quotation Agent's
// send_quote_to_client endpoint — the genuine "send to client" action.
// Requires the same session-cookie check as every other endpoint on
// this site (see login.js / whoami.js), and additionally, this one
// sends a real email to someone outside FWS — Command Centre's own
// UI is responsible for showing the person the exact recipient
// address and getting explicit confirmation before ever calling this.

const { verifySession } = require("../lib/auth");

const AUTO_QUOTATION_AGENT_BASE = "https://fws-auto-quotation-agent.vercel.app";

module.exports = async (req, res) => {
  const session = verifySession(req);
  if (!session) {
    res.status(401).json({ status: "error", error: "Not authenticated" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ status: "error", error: "Use POST" });
    return;
  }

  const { ticket_id, company, client_email, custom_message } = req.body || {};
  if (!ticket_id || !company || !client_email) {
    res.status(400).json({
      status: "error",
      error: "ticket_id, company, and client_email are all required",
    });
    return;
  }

  try {
    const resp = await fetch(`${AUTO_QUOTATION_AGENT_BASE}/api/send_quote_to_client`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket_id, company, client_email, custom_message }),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ status: "error", error: String(err) });
  }
};
