// FWS Command Centre — Quote Comparison Proxy
// Version: v1.2
//
// v1.2: uses the per-person login (verifySession from lib/auth.js) and passes the
// logged-in person's email (X-Requested-By) and the shared secret (X-CC-Secret).
// Calls the Quote Agent's comparison_for_approval endpoint, which shows a Client
// Quote's own prices, or a supplier comparison, and only to the person who
// requested the quote.
// v1.1: site-wide session check.
//
// Server-side proxy: the browser never calls the Quote Agent directly.

const { verifySession, findUserWithPassword } = require("../lib/auth");

const AUTO_QUOTATION_AGENT_BASE = "https://fws-auto-quotation-agent.vercel.app";

module.exports = async (req, res) => {
  const session = verifySession(req);
  if (!session) {
    res.status(401).json({ status: "error", error: "Not authenticated" });
    return;
  }

  const { ticket_id } = req.query;
  if (!ticket_id) {
    res.status(400).json({ status: "error", error: "ticket_id query parameter is required" });
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
    const resp = await fetch(
      `${AUTO_QUOTATION_AGENT_BASE}/api/comparison_for_approval?ticket_id=${encodeURIComponent(ticket_id)}`,
      { headers: { "X-CC-Secret": secret, "X-Requested-By": requester } }
    );
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
