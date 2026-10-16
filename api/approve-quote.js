// FWS Command Centre — Approve & Generate Quote Proxy
// Version: v1.3
//
// v1.3: passes the logged-in person's email (X-Requested-By) and the shared
// secret (X-CC-Secret) to the Quote Agent. The agent generates the quote only
// if that person requested it. The email comes from CC_USERS, not the browser.
// v1.2: uses the shared verifySession() from lib/auth.js.
// v1.1: site-wide session check.
//
// Server-side proxy to the Auto Quotation Agent's approve_and_generate_quote
// endpoint. POST here because it generates files, files them to HubSpot and
// emails a copy.

const { verifySession, findUserWithPassword } = require("../lib/auth");

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

  const { ticket_id, company } = req.body || {};
  if (!ticket_id || !company) {
    res.status(400).json({ status: "error", error: "ticket_id and company are required" });
    return;
  }

  const { user } = await findUserWithPassword(session.username);
  const requester = ((user && user.email) || "").trim().toLowerCase();
  if (!requester) {
    res.status(400).json({ status: "error", error: "Your login has no email address. Ask John to add it." });
    return;
  }
  const secret = process.env.CC_PROXY_SECRET;
  if (!secret) {
    res.status(500).json({ status: "error", error: "CC_PROXY_SECRET is not set on the Command Centre" });
    return;
  }

  try {
    const url =
      `${AUTO_QUOTATION_AGENT_BASE}/api/approve_and_generate_quote` +
      `?ticket_id=${encodeURIComponent(ticket_id)}&company=${encodeURIComponent(company)}`;
    const resp = await fetch(url, { headers: { "X-CC-Secret": secret, "X-Requested-By": requester } });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (err) {
      data = { status: "error", error: `The quote agent replied with HTTP ${resp.status}, not data.`, detail: text.slice(0, 200) };
    }
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ status: "error", error: String(err) });
  }
};
