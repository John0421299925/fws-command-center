// FWS Command Centre — Auth check endpoint
// Version: v2.0
//
// v2.0: now returns the logged-in person's identity (name, ownerId,
// role) instead of just {status:"ok"} — every page can use this to
// greet the person by name, and — for the Sales Command Centre
// specifically — to know which rep's data to display. This is still
// only a UX convenience: the REAL protection is that every
// data-bearing api/*.js file verifies the session itself via
// lib/auth.js's verifySession() before returning anything, exactly
// as before.

const { verifySession } = require("../lib/auth");

module.exports = async (req, res) => {
  const session = verifySession(req);
  if (!session) {
    res.status(401).json({ status: "error", error: "Not authenticated" });
    return;
  }
  res.status(200).json({ status: "ok", ...session });
};
