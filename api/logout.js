// FWS Command Centre — Logout endpoint
// Version: v1.1
//
// v1.1: uses the shared clearCookieHeader() from lib/auth.js instead
// of a hardcoded string, so it can never drift out of sync with the
// cookie name/attributes login.js actually sets.

const { clearCookieHeader } = require("../lib/auth");

module.exports = async (req, res) => {
  res.setHeader("Set-Cookie", clearCookieHeader());
  res.writeHead(302, { Location: "/login.html" });
  res.end();
};
