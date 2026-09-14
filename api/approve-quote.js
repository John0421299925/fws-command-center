// FWS Command Centre — Approve & Generate Quote Proxy
// Version: v1.1
//
// v1.1: Added the site-wide session-cookie check (see login.js /
//       whoami.js) — this endpoint generates and files real client
//       quotes, so it especially must not be callable without a valid
//       session.
//
// Server-side proxy to the Auto Quotation Agent's
// approve_and_generate_quote endpoint — the single button that both
// generates the client quote and counts as approval. POST because
// this is a state-changing action (generates files, attaches to
// HubSpot, sends an email), even though the underlying agent endpoint
// itself is a GET.

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

  const { ticket_id, company } = req.body || {};
  if (!ticket_id || !company) {
    res.status(400).json({ status: "error", error: "ticket_id and company are required" });
    return;
  }

  try {
    const url =
      `${AUTO_QUOTATION_AGENT_BASE}/api/approve_and_generate_quote` +
      `?ticket_id=${encodeURIComponent(ticket_id)}&company=${encodeURIComponent(company)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ status: "error", error: String(err) });
  }
};
