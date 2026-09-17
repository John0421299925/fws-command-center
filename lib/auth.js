// FWS Command Centre — Shared session helpers
// Deploy as: lib/auth.js
// Version: v1.0
//
// v1.0: NEW — real per-person login, replacing the old single shared
// CC_PASSWORD gate. Every Command Centre user (John, James, and any
// future sales rep) now has their own username/password, stored in a
// new CC_USERS env var as a JSON array, e.g.:
//   [
//     {"username":"james","password":"...","name":"James Whelan","ownerId":"359341020","role":"admin"},
//     {"username":"john","password":"...","name":"John Murray","ownerId":"81087158","role":"admin"}
//   ]
// This matters specifically for the Sales Command Centre: each rep's
// dashboard must be scoped server-side to THEIR OWN client companies
// only, driven by who is actually logged in — never trusted to a URL
// parameter a rep could edit to see someone else's numbers. The
// session cookie now carries that identity (ownerId, name, role),
// signed with a dedicated CC_SESSION_SECRET — previously the shared
// password itself doubled as the signing secret, which no longer
// makes sense once there isn't one shared password for everyone.
//
// role: "admin" sees the full company-wide Command Centre (Rate
// Card, company-wide Business Vital Signs, Exceptions feed, etc.) in
// addition to their own Sales CC view. role: "rep" sees only their
// own Sales CC view, scoped to their ownerId. Any endpoint that's
// company-wide rather than per-rep should check role === "admin" in
// addition to verifying the session exists at all.
//
// IMPORTANT — this changes the session cookie's format entirely (old:
// "expiry.hmac(expiry)" signed with CC_PASSWORD; new:
// "base64(payload).hmac(payload)" signed with CC_SESSION_SECRET).
// Every OTHER protected api/*.js file that currently has its own
// inline copy of the old verification logic will start rejecting all
// requests until it's updated to use verifySession() from this file
// instead — it fails CLOSED (denies access) rather than open, so
// nothing is exposed in the meantime, but those endpoints need
// updating before the rest of the Command Centre works again.

const crypto = require("crypto");

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = "cc_session";

function getUsers() {
  const raw = process.env.CC_USERS;
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("CC_USERS is not valid JSON:", err.message);
    return [];
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

// Checks a submitted username/password against CC_USERS. Returns the
// matching user object (password stripped out) on success, or null.
function findUser(username, password) {
  const users = getUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return null;
  if (!timingSafeStringEqual(password, user.password)) return null;
  const { password: _pw, ...safeUser } = user;
  return safeUser;
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
// decoded identity ({username, name, ownerId, role}) if valid, or
// null if the cookie is missing, expired, or tampered with.
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
  createSessionCookieValue,
  verifySession,
  sessionCookieHeader,
  clearCookieHeader,
};
