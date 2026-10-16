// FWS Command Centre — Submit Quote Request Proxy
// Version: v1.1
//
// v1.1: passes the logged-in person's email (X-Requested-By) and the shared
// secret (X-CC-Secret) to the Quote Agent, so the RFP ticket records who asked
// for it. The email comes from CC_USERS, not the browser.
// v1.0: first release. Forwards the request body to the Auto Quotation Agent.
//
// Open to any logged-in person. Requesting pricing is core rep work.

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
    const resp = await fetch(`${AUTO_QUOTATION_AGENT_BASE}/api/submit_quote_request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CC-Secret": secret, "X-Requested-By": requester },
      body: JSON.stringify(req.body || {}),
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
