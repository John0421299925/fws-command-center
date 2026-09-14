// FWS Command Centre — Login endpoint
// Version: v1.0
//
// Checks the submitted password against CC_PASSWORD (Vercel env var).
// On success, sets a signed, httpOnly session cookie valid for 30 days.
// The cookie is a simple "expiry.signature" pair, where signature is an
// HMAC-SHA256 of the expiry timestamp using CC_PASSWORD as the secret —
// no database or session store needed. Every protected endpoint (and
// each page's own client-side check) verifies this same cookie the
// same way; see the top of any protected api/*.js file for the
// matching verification snippet.

const crypto = require("crypto");

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = "cc_session";

function signExpiry(expiry, secret) {
  return crypto.createHmac("sha256", secret).update(String(expiry)).digest("hex");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ status: "error", error: "Use POST" });
    return;
  }

  const { password } = req.body || {};
  const expectedPassword = process.env.CC_PASSWORD;

  if (!expectedPassword) {
    res.status(500).json({ status: "error", error: "CC_PASSWORD is not configured" });
    return;
  }

  const providedBuf = Buffer.from(String(password || ""));
  const expectedBuf = Buffer.from(String(expectedPassword));
  const matches =
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!matches) {
    res.status(401).json({ status: "error", error: "Incorrect password" });
    return;
  }

  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const signature = signExpiry(expiry, expectedPassword);
  const cookieValue = `${expiry}.${signature}`;

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`
  );
  res.status(200).json({ status: "ok" });
};
