// FWS Command Centre — Login endpoint
// Version: v2.0
//
// v2.0: REPLACED the single shared CC_PASSWORD with real per-person
// accounts. Each person (John, James, and any future sales rep) has
// their own username/password, defined in the new CC_USERS env var —
// see lib/auth.js for the exact JSON shape and why this matters (the
// Sales Command Centre needs to know WHO is logged in, not just
// whether *someone* knows the password, so each rep's dashboard can
// be scoped server-side to their own clients only).
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
  const user = findUser(username, password);

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
