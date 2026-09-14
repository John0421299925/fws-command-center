// FWS Command Centre — Send Quote to Client Proxy
// Version: v1.0
//
// Server-side proxy to the Auto Quotation Agent's
// send_quote_to_client endpoint — the genuine "send to client" action.
// Requires the same session-cookie check as every other endpoint on
// this site (see login.js / whoami.js), and additionally, this one
// sends a real email to someone outside FWS — Command Centre's own
// UI is responsible for showing the person the exact recipient
// address and getting explicit confirmation before ever calling this.

const crypto = require("crypto");

const AUTO_QUOTATION_AGENT_BASE = "https://fws-auto-quotation-agent.vercel.app";

function isAuthenticated(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)cc_session=([^;]+)/);
  if (!match) return false;
  const [expiryStr, signature] = decodeURIComponent(match[1]).split(".");
  const expiry = Number(expiryStr);
  if (!expiry || Date.now() > expiry) return false;
  const expected = crypto
    .createHmac("sha256", process.env.CC_PASSWORD || "")
    .update(String(expiry))
    .digest("hex");
  const sigBuf = Buffer.from(signature || "");
  const expBuf = Buffer.from(expected);
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}

module.exports = async (req, res) => {
  if (!isAuthenticated(req)) {
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
