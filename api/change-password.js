// FWS Command Centre — Change Password endpoint
// Deploy as: api/change-password.js
// Version: v1.0
//
// PURPOSE: lets a logged-in person set their own password, replacing
// the shared temporary "Welcome to SCC" everyone was given at launch.
// Requires the person's CURRENT password (re-verifies identity, same
// as any real "change password" flow) plus the new one, twice.
//
// Writes the whole updated CC_USERS list back to Vercel via
// saveLiveUsers() (lib/auth.js) — same real-write pattern already
// proven for Xero's refresh token. Because login.js/findUser() always
// fetch the LIVE current value (never a stale cached copy — see
// lib/auth.js v2.0), the new password is guaranteed to work on the
// very next login attempt, not "eventually, once something else
// redeploys".
//
// Does NOT touch the person's current session — their existing
// cc_session cookie stays valid, since the session only ever carries
// identity (username/name/ownerId/role), never the password itself.
// They don't need to log back in immediately after changing it.
//
// Usage: POST /api/change-password { currentPassword, newPassword }
// ================================================================

const { verifySession, findUserWithPassword, saveLiveUsers } = require("../lib/auth");

const MIN_PASSWORD_LENGTH = 8;

function timingSafeStringEqual(a, b) {
  const crypto = require("crypto");
  const aBuf = Buffer.from(String(a || ""));
  const bBuf = Buffer.from(String(b || ""));
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

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

  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    res.status(400).json({ status: "error", error: "currentPassword and newPassword are both required" });
    return;
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ status: "error", error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }

  try {
    const { user, allUsers } = await findUserWithPassword(session.username);
    if (!user) {
      res.status(404).json({ status: "error", error: "Your account could not be found in CC_USERS — contact John or James" });
      return;
    }

    if (!timingSafeStringEqual(currentPassword, user.password)) {
      res.status(401).json({ status: "error", error: "Current password is incorrect" });
      return;
    }

    // Replace this one user's password, leaving everyone else and
    // every other field (role, ownerId, canEditRateCard) untouched.
    const updatedUsers = allUsers.map((u) =>
      u.username === session.username ? { ...u, password: newPassword } : u
    );

    await saveLiveUsers(updatedUsers);

    res.status(200).json({ status: "ok", message: "Password changed successfully." });
  } catch (error) {
    res.status(500).json({ status: "error", error: error.message });
  }
};
