// FWS Command Centre — Quote Comparison Proxy
// Version: v1.1
//
// v1.1: Added the site-wide session-cookie check (see login.js /
//       whoami.js) — this endpoint returns real supplier and client
//       pricing data, so it must reject unauthenticated requests
//       directly.
//
// Server-side proxy to the Auto Quotation Agent's get_comparison_data
// endpoint — same pattern already used for Agent Health/Exceptions,
// so the browser never has to make a cross-origin call to a different
// Vercel project directly.

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

  const { ticket_id } = req.query;
  if (!ticket_id) {
    res.status(400).json({ status: "error", error: "ticket_id query parameter is required" });
    return;
  }

  try {
    const resp = await fetch(
      `${AUTO_QUOTATION_AGENT_BASE}/api/get_comparison_data?ticket_id=${encodeURIComponent(ticket_id)}`
    );
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ status: "error", error: String(err) });
  }
};
