// FWS Command Centre — Reset Password endpoint
// Deploy as: api/reset-password.js
// Version: v1.0
//
// PURPOSE: the second half of the forgotten-password flow — takes
// the username/token pair from the emailed link plus a new password,
// verifies the token (lib/auth.js's verifyResetToken(), which also
// handles expiry and self-invalidation), and writes the new password
// back via saveLiveUsers() — the exact same real-write pattern
// change-password.js already uses, so this is guaranteed to work on
// the very next login attempt (see lib/auth.js v2.0's own note on why
// that's genuinely true and not just assumed).
//
// Deliberately does NOT require an existing session — this is the
// whole point of the flow: it's for someone who is currently locked
// out and can't log in at all.
//
// Usage: POST /api/reset-password { username, token, newPassword }
// ================================================================

const { verifyResetToken, findUserWithPassword, saveLiveUsers } = require("../lib/auth");

const MIN_PASSWORD_LENGTH = 8;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ status: "error", error: "Use POST" });
    return;
  }

  const { username, token, newPassword } = req.body || {};
  if (!username || !token || !newPassword) {
    res.status(400).json({ status: "error", error: "username, token, and newPassword are all required" });
    return;
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ status: "error", error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }

  try {
    const isValid = await verifyResetToken(username, token);
    if (!isValid) {
      res.status(401).json({ status: "error", error: "This reset link is invalid or has expired — request a new one." });
      return;
    }

    const { user, allUsers } = await findUserWithPassword(username);
    if (!user) {
      res.status(404).json({ status: "error", error: "Account not found." });
      return;
    }

    const updatedUsers = allUsers.map((u) =>
      u.username === username ? { ...u, password: newPassword } : u
    );
    await saveLiveUsers(updatedUsers);

    res.status(200).json({ status: "ok", message: "Password reset — you can log in with your new password now." });
  } catch (error) {
    res.status(500).json({ status: "error", error: error.message });
  }
};
