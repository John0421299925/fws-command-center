// FWS Command Centre — Forgot Password endpoint
// Deploy as: api/forgot-password.js
// Version: v1.0
//
// PURPOSE: real self-service unlock, built after James got genuinely
// locked out of Command Centre with no way back in except John or
// James manually editing CC_USERS by hand. Takes just a username,
// and — if it matches a real account with an email on file — sends a
// signed, 45-minute reset link via Resend (see lib/auth.js v2.1's
// generateResetToken() for how the link is made self-invalidating
// without needing any separate token store).
//
// Deliberately returns the SAME generic success message whether or
// not the username actually exists, and whether or not sending the
// email succeeded — never reveals which usernames are real accounts.
// Real send failures are still logged server-side (console.error),
// so a genuine problem (e.g. RESEND_API_KEY missing) is still visible
// in Vercel's logs, just not leaked to whoever's using the form.
//
// Usage: POST /api/forgot-password { username }
// ================================================================

const { findUserWithPassword, generateResetToken } = require("../lib/auth");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const GENERIC_MESSAGE = "If that username exists, a password reset link has been sent to the email on file.";

async function sendResetEmail(toAddress, resetUrl) {
  if (!RESEND_API_KEY) {
    console.error("forgot-password: RESEND_API_KEY not configured — cannot send reset email");
    return;
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "FWS Command Centre <invoicing@futurewaste.com.au>",
      to: [toAddress],
      subject: "Reset your Command Centre password",
      html: `
        <p>Someone (hopefully you) asked to reset the password for the FWS Command Centre.</p>
        <p><a href="${resetUrl}">Click here to set a new password</a></p>
        <p>This link works once, and only for the next 45 minutes. If you didn't ask for this, you can safely ignore it — your password won't change unless this link is actually used.</p>
      `,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`forgot-password: Resend send failed (${resp.status}): ${errText}`);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ status: "error", error: "Use POST" });
    return;
  }

  const { username } = req.body || {};
  if (!username) {
    res.status(400).json({ status: "error", error: "username is required" });
    return;
  }

  try {
    const { user } = await findUserWithPassword(username);

    if (user && user.email) {
      const token = generateResetToken(user);
      const resetUrl = `https://${req.headers.host}/reset-password.html?username=${encodeURIComponent(user.username)}&token=${encodeURIComponent(token)}`;
      await sendResetEmail(user.email, resetUrl);
    } else if (user && !user.email) {
      console.error(`forgot-password: user "${username}" has no email on file in CC_USERS — cannot send reset link`);
    }
    // Deliberately no branch for "user not found" beyond the log —
    // the response is identical either way, see file header note.

    res.status(200).json({ status: "ok", message: GENERIC_MESSAGE });
  } catch (error) {
    console.error(`forgot-password: unexpected error: ${error.message}`);
    // Still return the generic success shape — a person locked out
    // shouldn't be shown a stack trace, and shouldn't learn anything
    // about whether their username exists from an error either.
    res.status(200).json({ status: "ok", message: GENERIC_MESSAGE });
  }
};
