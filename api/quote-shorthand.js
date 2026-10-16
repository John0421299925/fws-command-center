// FWS Command Centre — Quote shorthand proxy
// Deploy as: api/quote-shorthand.js
// Version: v1.1
// v1.1: calls the Quote Agent's single route /api/quote_from_shorthand and passes
//       the step as "action". Shows the real problem when the agent returns a non-JSON page.
//
// PURPOSE: lets a logged-in rep read back and build a quote from their
// shorthand, straight from the Sales Command Centre. Same proxy pattern as
// submit-quote-request.js: this file contains no quote logic. It checks the
// rep's session, adds the rep's own email (from CC_USERS, never from the
// browser), then passes the request to the Auto Quotation Agent.
//
// The agent refuses any request without the shared secret, so only this
// proxy can make these calls. The requester is set here, from the session,
// so a rep cannot request a quote in someone else's name.
//
// Usage: POST /api/quote-shorthand
//   body: { step: "read-back", text: "..." }
//      or { step: "build", text: "...", client, contact, site, site_address,
//           first_name, sequence, margin, excess_rate, grease_rate,
//           client_email, confirm }

const { verifySession, findUserWithPassword } = require("../lib/auth");

const AUTO_QUOTATION_AGENT_BASE = "https://fws-auto-quotation-agent.vercel.app";
const AGENT_PATH = "/api/quote_from_shorthand";
const STEPS = { "read-back": true, build: true };

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

  const body = req.body || {};
  if (!STEPS[body.step]) {
    res.status(400).json({ status: "error", error: "step must be read-back or build" });
    return;
  }

  // The rep's email comes from their CC_USERS record, not from the browser.
  const { user } = await findUserWithPassword(session.username);
  const requester = (user && user.email || "").trim().toLowerCase();
  if (!requester) {
    res.status(400).json({ status: "error", error: "Your login has no email address. Ask John to add it." });
    return;
  }

  const secret = process.env.CC_PROXY_SECRET;
  if (!secret) {
    res.status(500).json({ status: "error", error: "CC_PROXY_SECRET is not set on the Command Centre" });
    return;
  }

  // Drop anything the browser sent that tries to set identity or secrets.
  const { requested_by, requester: _r, ...clean } = body;
  const { step, ...payload } = clean;
  payload.action = step;

  try {
    const resp = await fetch(`${AUTO_QUOTATION_AGENT_BASE}${AGENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CC-Secret": secret,
        "X-Requested-By": requester,
      },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      // The agent sent a page, not JSON: show what it did, so the real cause is visible.
      data = { status: "error", error: `The quote agent replied with HTTP ${resp.status}, not data.`,
               detail: text.slice(0, 200) };
    }
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ status: "error", error: String(err) });
  }
};
