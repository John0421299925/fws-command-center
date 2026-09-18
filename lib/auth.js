// FWS Command Centre — Shared session helpers
// Deploy as: lib/auth.js
// Version: v2.0
//
// v2.0: ADDED getLiveUsers() and made findUser() async — real fix
// needed to make Change Password actually reliable. Vercel env vars
// do NOT hot-reload into already-running function instances; a
// password change written to CC_USERS via Vercel's API could
// silently fail to "take" for a warm instance still holding the old
// value in process.env — the exact same trap already hit once with
// Xero's refresh token (see clv-invoice-automation's getXeroToken()).
// The fix is the same pattern: always fetch the CURRENT live value of
// CC_USERS directly from Vercel's own Environment Variables API at
// the moment of login, rather than trusting process.env, which can
// only ever reflect whatever was true when this instance last cold-
// started. Falls back to process.env.CC_USERS if VERCEL_TOKEN/
// VERCEL_PROJECT_ID are missing or the API call fails — same
// graceful-fallback behaviour as the Xero pattern.
//
// v1.0: real per-person login, replacing the old single shared
// CC_PASSWORD gate. Every Command Centre user (John, James, and any
// future sales rep) now has their own username/password, stored in a
// CC_USERS env var as a JSON array, e.g.:
//   [
//     {"username":"james","password":"...","name":"James Whelan","ownerId":"359341020","role":"admin","canEditRateCard":true},
//     {"username":"john","password":"...","name":"John Murray","ownerId":"81087158","role":"admin","canEditRateCard":true}
//   ]
// This matters specifically for the Sales Command Centre: each rep's
// dashboard must be scoped server-side to THEIR OWN client companies
// only, driven by who is actually logged in — never trusted to a URL
// parameter a rep could edit to see someone else's numbers. The
// session cookie carries that identity (ownerId, name, role,
// canEditRateCard), signed with a dedicated CC_SESSION_SECRET.
//
// role: "admin" sees the full company-wide Command Centre in
// addition to their own Sales CC view. role: "rep" sees only their
// own Sales CC view, scoped to their ownerId. canEditRateCard is a
// fully independent flag — it's what lets Christine (role "rep")
// still see the Rate Card section, unrelated to her role.

const crypto = require("crypto");

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = "cc_session";

function getUsersFromEnv() {
  const raw = process.env.CC_USERS;
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("CC_USERS is not valid JSON:", err.message);
    return [];
  }
}

// v2.0: fetches the CURRENT live value of CC_USERS from Vercel's own
// Environment Variables API — the same two-step pattern already
// proven working for Xero's refresh token (list env vars to find the
// variable's id, then fetch that variable's value with decrypt=true).
// Falls back to the plain process.env copy if VERCEL_TOKEN/
// VERCEL_PROJECT_ID aren't configured, or if either API call fails —
// never lets a fetch problem take the whole login system down.
async function getLiveUsers() {
  const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
  const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;

  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
    return getUsersFromEnv();
  }

  try {
    const listRes = await fetch(`https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env?decrypt=true`, {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    });
    const { envs } = await listRes.json();
    const existing = envs?.find((e) => e.key === "CC_USERS");
    if (!existing) return getUsersFromEnv();

    const valRes = await fetch(`https://api.vercel.com/v1/projects/${VERCEL_PROJECT_ID}/env/${existing.id}?decrypt=true`, {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    });
    const valData = await valRes.json();
    if (!valData.value) return getUsersFromEnv();

    try {
      return JSON.parse(valData.value);
    } catch (err) {
      console.error("CC_USERS (live from Vercel) is not valid JSON:", err.message);
      return getUsersFromEnv();
    }
  } catch (err) {
    console.error(`Could not fetch live CC_USERS from Vercel, falling back to cached env var: ${err.message}`);
    return getUsersFromEnv();
  }
}

// v2.0: writes the FULL updated user list back to CC_USERS via
// Vercel's API — used only by change-password.js. Same two-step
// pattern: find the env var's id, then PATCH its value.
async function saveLiveUsers(users) {
  const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
  const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;

  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
    throw new Error("VERCEL_TOKEN or VERCEL_PROJECT_ID is not configured — cannot save password changes");
  }

  const listRes = await fetch(`https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env`, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  });
  const { envs } = await listRes.json();
  const existing = envs?.find((e) => e.key === "CC_USERS");
  if (!existing) {
    throw new Error("CC_USERS environment variable not found on this project");
  }

  const patchRes = await fetch(`https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env/${existing.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(users), target: existing.target || ["production", "preview"] }),
  });
  if (!patchRes.ok) {
    const errText = await patchRes.text();
    throw new Error(`Could not save updated CC_USERS to Vercel: ${errText}`);
  }
}

function getSessionSecret() {
  return process.env.CC_SESSION_SECRET || "";
}

function timingSafeStringEqual(a, b) {
  const aBuf = Buffer.from(String(a || ""));
  const bBuf = Buffer.from(String(b || ""));
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

// v2.0: now ASYNC — always checks against the live current CC_USERS
// value, never a potentially-stale cached copy. Returns the matching
// user object (password stripped out) on success, or null.
async function findUser(username, password) {
  const users = await getLiveUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return null;
  if (!timingSafeStringEqual(password, user.password)) return null;
  const { password: _pw, ...safeUser } = user;
  return safeUser;
}

// v2.0: used by change-password.js — finds a user's FULL record
// (including their real current password, needed to verify the
// "current password" field before allowing a change) plus the whole
// live list, so change-password.js can modify one entry and write
// the complete array straight back.
async function findUserWithPassword(username) {
  const users = await getLiveUsers();
  const user = users.find((u) => u.username === username);
  return { user: user || null, allUsers: users };
}

// Builds the signed session cookie value for a given user identity.
function createSessionCookieValue(user) {
  const secret = getSessionSecret();
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const payload = {
    username: user.username,
    name: user.name,
    ownerId: user.ownerId,
    role: user.role || "rep",
    canEditRateCard: Boolean(user.canEditRateCard),
    expiry,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
  return `${payloadB64}.${signature}`;
}

// Verifies the cc_session cookie on an incoming request. Returns the
// decoded identity ({username, name, ownerId, role, canEditRateCard})
// if valid, or null if the cookie is missing, expired, or tampered
// with. Deliberately synchronous and does NOT touch CC_USERS at all —
// the session itself already carries everything needed, so a
// password change never invalidates an existing logged-in session.
function verifySession(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)cc_session=([^;]+)/);
  if (!match) return null;

  const cookieValue = decodeURIComponent(match[1]);
  const dotIndex = cookieValue.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const payloadB64 = cookieValue.slice(0, dotIndex);
  const signature = cookieValue.slice(dotIndex + 1);

  const secret = getSessionSecret();
  const expectedSignature = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
  if (!timingSafeStringEqual(signature, expectedSignature)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch (err) {
    return null;
  }

  if (!payload.expiry || Date.now() > payload.expiry) return null;

  return {
    username: payload.username,
    name: payload.name,
    ownerId: payload.ownerId,
    role: payload.role || "rep",
    canEditRateCard: Boolean(payload.canEditRateCard),
  };
}

function sessionCookieHeader(cookieValue, maxAgeSeconds) {
  return `${COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  findUser,
  findUserWithPassword,
  saveLiveUsers,
  createSessionCookieValue,
  verifySession,
  sessionCookieHeader,
  clearCookieHeader,
};
