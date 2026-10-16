// FWS Command Centre — Send Quote to Client Proxy
// Version: v1.2
//
// v1.2: passes the logged-in person's email to the Quote Agent (X-Requested-By)
// with the shared secret (X-CC-Secret). The agent sends the quote only if that
// person requested it. The browser cannot set the requester: it is taken from
// the login record in CC_USERS.
// v1.1: uses the shared verifySession() from lib/auth.js.
//
// Server-side proxy to the Auto Quotation Agent's send_quote_to_client
// endpoint. Sends a real email to someone outside FWS, so the page must show
// the recipient and get explicit confirmation before calling this.

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

  const { ticket_id, company, client_email, custom_message } = req.body || {};
  if (!ticket_id || !company || !client_email) {
    res.status(400).json({ status: "error", error: "ticket_id, company, and client_email are all required" });
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
    const resp = await fetch(`${AUTO_QUOTATION_AGENT_BASE}/api/send_quote_to_client`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CC-Secret": secret, "X-Requested-By": requester },
      body: JSON.stringify({ ticket_id, company, client_email, custom_message }),
    });
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
