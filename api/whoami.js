// FWS Command Centre — Auth check endpoint
// Version: v1.0
//
// Cheap endpoint every page calls on load to check whether the visitor
// has a valid session; if not, the page redirects to /login.html. This
// is a UX convenience only — the REAL protection is that every
// data-bearing api/*.js file verifies the same cookie itself before
// returning anything, so even if someone views a page's HTML directly
// without running its JS, no real data is exposed.

const crypto = require("crypto");

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
  res.status(200).json({ status: "ok" });
};
