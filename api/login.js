// FWS Command Centre — Login endpoint
// Version: v2.1
//
// v2.1: findUser() is now async (see lib/auth.js v2.0) — always
// checks against the CURRENT live CC_USERS value from Vercel's API,
// not a potentially-stale cached copy, so a password changed via
// change-password.js is guaranteed to work on the very next login
// attempt.
// v2.0: REPLACED the single shared CC_PASSWORD with real per-person
// accounts, defined in CC_USERS.
// v1.1 (superseded): showed the real server error text on failure
// instead of a hardcoded "Incorrect password" message — that
// behaviour is preserved here.

const { findUser, createSessionCookieValue, sessionCookieHeader, SESSION_MAX_AGE_MS } = require("../lib/auth");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ status: "error", error: "Use POST" });
    return;
  }

  if (!process.env.CC_USERS) {
    res.status(500).json({ status: "error", error: "CC_USERS is not configured" });
    return;
  }
  if (!process.env.CC_SESSION_SECRET) {
    res.status(500).json({ status: "error", error: "CC_SESSION_SECRET is not configured" });
    return;
  }

  const { username, password } = req.body || {};
  const user = await findUser(username, password);

  if (!user) {
    res.status(401).json({ status: "error", error: "Incorrect username or password" });
    return;
  }

  const cookieValue = createSessionCookieValue(user);
  res.setHeader("Set-Cookie", sessionCookieHeader(cookieValue, Math.floor(SESSION_MAX_AGE_MS / 1000)));
  res.status(200).json({
    status: "ok",
    name: user.name,
    role: user.role || "rep",
    canEditRateCard: Boolean(user.canEditRateCard),
  });
};
