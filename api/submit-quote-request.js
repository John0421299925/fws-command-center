// FWS Command Centre — Submit Quote Request Proxy
// Deploy as: api/submit-quote-request.js
// Version: v1.0
//
// PURPOSE: lets a rep kick off a new quote request directly from the
// Sales Command Centre — structured fields or freeform text — instead
// of writing an email to quotes@futurewaste.com.au by hand. Same
// CORS-avoidance proxy pattern already used by approve-quote.js and
// send-quote-to-client.js: Command Centre's own server calls the Auto
// Quotation Agent server-to-server, then relays the result back to
// the page.
//
// Contains NO business logic of its own — forwards the request body
// exactly as given and relays whatever the agent decides (ok /
// needs_clarification / validation_error / error), same principle as
// approve-invoice.js: the real logic stays in exactly one place.
//
// Open to ANY logged-in role — requesting a quote is core rep work,
// same reasoning as quotes-pending.js / approve-quote.js.
//
// Usage: POST /api/submit-quote-request
//   body: either structured fields (waste_type + suburb/full_site_
//   address, plus optional extras) or { freeform_text, client_name }
//   — see the Auto Quotation Agent's own documentation for the full
//   field list.
// ================================================================

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

  try {
    const resp = await fetch(`${AUTO_QUOTATION_AGENT_BASE}/api/submit_quote_request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ status: "error", error: String(err) });
  }
};
