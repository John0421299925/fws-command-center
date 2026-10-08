// FWS Command Center — Agent Status Checker
// v1.6
// v1.6: NEW — three changes, all for the Agent Health cards:
//   (1) A TIME SAVER card ("Time Saver (CRM Capture)"). Time Saver
//       already had a real health check (/api/health: is it still
//       watching the crm.agent@ mailbox, and how long until that watch
//       needs renewing) - it simply had no card here.
//   (2) AMBER "warning". A health check can now answer status
//       "warning" (HTTP 200, status "warning") and the card shows it as
//       amber instead of forcing a choice between green and red. First
//       user: Agent 1 v1.15 - it is still watching the mailbox (not red)
//       but has invoice emails waiting longer than the 30-minute sweep
//       should allow, or emails that gave up after repeated failures.
//       Anything else that is not "ok" is still "error" (red), exactly as
//       in v1.5.
//   (3) VERSION FOR EVERY CARD. Agent 1's and Time Saver's health checks
//       report health but not their version, so an agent can now carry an
//       optional versionUrl (their plain /webhook check) which is read
//       alongside the health check. It is best-effort: if it fails the
//       card just shows no version - it can never change a card's status.
// v1.5: NEW — three real health checks added, directly prompted by
//   two genuine incidents this week that nothing on this dashboard
//   caught: fws-xero-reader's and clv-invoice-automation's Xero
//   connections both silently lost their authorization on Xero's
//   side (confirmed via each project's own /connections check), and
//   separately, nothing here could confirm or contradict a stale
//   belief that Agent 1 was paused — it had genuinely been
//   re-enabled three days earlier. All three new agents ask the real
//   thing a real question (is the subscription still there, is the
//   tenant still connected) rather than just confirming a deployment
//   responds, which every existing check already does and which
//   would have stayed green through both incidents.
//   Also improved checkAgent(): it now parses the JSON body even on
//   a non-200 response (connection-check.js returns real error
//   detail this way), and surfaces a genuine detail/error message
//   from the body — data.detail, then data.error, then a
//   Connected-to-X message built from organisationName on a
//   successful connection-check.js response — rather than only ever
//   showing a bare "HTTP 403" for anything that isn't a plain
//   reachability check. A response with HTTP 200 but a JSON
//   status !== "ok" (the shape all three new checks use, so a real
//   problem still shows even though the endpoint itself responded
//   fine) now maps to "error", not "unknown" — this is a strictly
//   more correct read for the three new agents (a red dot instead of
//   an ambiguous amber one) and changes nothing observable for the
//   three original agents, none of which have ever returned anything
//   but status "ok".
// v1.4: swapped the old inline single-shared-password cookie check
//   for the shared verifySession() from lib/auth.js — required now
//   that the Command Centre has moved to real per-person logins (see
//   lib/auth.js / api/login.js). No role restriction added: this is
//   just agent version/health, not client or pricing data, so any
//   logged-in person (admin, ops, or a future rep) can see it.
// v1.3: Added the site-wide session-cookie check (see login.js /
//   whoami.js in the project root) — for consistency with every other
//   endpoint now that the whole Command Centre is gated, even though
//   this one only reveals agent version/health, not business data.
// v1.2: Agent 1 re-enabled (mailbox subscription live again, filename-
//   signal classifier fix deployed v1.8, renewal cron confirmed working)
//   — cleared its manualNote back to null. This field is still hand-set,
//   not live-detected (the health-check URL itself can't tell whether
//   Agent 1's subscription actually exists or not), so it needs the same
//   manual update whenever a genuinely paused sub-system changes state.
//   Enrichment Agent's note left untouched — still paused by John.
// v1.1 — added manualNote field (hand-set, not live-detected) so paused
//   sub-systems (Agent 1, Enrichment Agent) show clearly even though the
//   parent endpoint still reports "ok". Also cleaned up version string
//   parsing — some agents pack extra description text into the version
//   field itself, so we now split on " - " and keep only the first part.
// v1.0 — Checks all known agents server-side (avoids browser CORS issues)
//   and returns a single combined JSON response for the dashboard.

import { verifySession } from '../lib/auth.js';

const AGENTS = [
  {
    id: "invoice-automation",
    name: "Invoice Automation",
    url: "https://clv-invoice-automation.vercel.app/api/webhook",
    manualNote: null,
  },
  {
    id: "hubspot-agent",
    name: "HubSpot Agent (2 & 3)",
    url: "https://fws-hubspot-agent-a4be.vercel.app/api/webhook",
    manualNote: null,
  },
  {
    id: "enrichment-agent",
    name: "Enrichment Agent",
    url: "https://fws-enrichment-agent.vercel.app/api/enrich?vertical=aged_care",
    manualNote: "Paused by John",
  },
  // v1.5: NEW — real subscription check, not just reachability. See
  // fws-hubspot-agent-a4be's own webhook.py v1.45 changelog for the
  // full incident this was built to catch.
  // v1.6: also reports waiting / gave-up emails as an amber warning
  // (Agent 1 v1.15), and its version is read from its plain check.
  {
    id: "agent1",
    name: "Agent 1 (Mailbox Intake)",
    url: "https://fws-hubspot-agent-a4be.vercel.app/api/agent1-health",
    versionUrl: "https://fws-hubspot-agent-a4be.vercel.app/api/agent1-webhook",
    manualNote: null,
  },
  // v1.6: NEW — Time Saver (the CRM capture agent, fws-sales-crm-agent).
  // Real check: is it still watching crm.agent@futurewaste.com.au.
  {
    id: "time-saver",
    name: "Time Saver (CRM Capture)",
    url: "https://fws-sales-crm-agent.vercel.app/api/health",
    versionUrl: "https://fws-sales-crm-agent.vercel.app/api/webhook",
    manualNote: null,
  },
  // v1.5: NEW — reuses clv-invoice-automation's existing
  // connection-check.js (already built, already proven — not a new
  // file on that side), which checks BOTH Xero's /connections list
  // AND makes a real authenticated Organisation lookup, genuinely
  // stronger evidence than a /connections check alone.
  {
    id: "xero-invoicing",
    name: "Xero Connection — Invoicing",
    url: "https://clv-invoice-automation.vercel.app/api/connection-check",
    manualNote: null,
  },
  // v1.5: NEW — fws-xero-reader had no equivalent file at all (a
  // genuinely empty api/ folder besides auth.js/callback.js/query.js,
  // confirmed by checking directly rather than assuming), so this is
  // a new file there: api/xero-health.js.
  {
    id: "xero-reader",
    name: "Xero Connection — Reader",
    url: "https://fws-xero-reader.vercel.app/api/xero-health",
    manualNote: null,
  },
];

function cleanVersion(rawVersion) {
  if (!rawVersion) return null;
  // Some agents include a trailing description after " - "; keep only
  // the actual version token.
  return String(rawVersion).split(" - ")[0].trim();
}

// v1.6: best-effort version lookup from an agent's plain check. Never
// throws and never affects a card's status - no version is simply
// shown as no version.
async function fetchVersion(versionUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(versionUrl, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    return cleanVersion(data && data.version);
  } catch {
    return null;
  }
}

async function checkAgent(agent) {
  const started = Date.now();
  // v1.6: start the version lookup alongside the health check, not after it
  const versionPromise = agent.versionUrl ? fetchVersion(agent.versionUrl) : Promise.resolve(null);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(agent.url, { signal: controller.signal });
    clearTimeout(timeout);
    const responseMs = Date.now() - started;

    // v1.5: parse the JSON body regardless of res.ok — several of the
    // new health checks (and connection-check.js) put a real,
    // meaningful error message in the body even on a non-200 response,
    // and that's far more useful than a bare HTTP status code.
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!data) {
      return {
        id: agent.id,
        name: agent.name,
        status: res.ok ? "ok" : "error",
        version: await versionPromise,
        detail: `HTTP ${res.status}`,
        responseMs,
        manualNote: agent.manualNote,
      };
    }

    const isOk = data.status === "ok";
    // v1.6: "warning" (amber) is a real answer from a health check, not an error
    const status = isOk ? "ok" : data.status === "warning" ? "warning" : "error";
    // v1.5: prefer an explicit detail/error message from the body;
    // fall back to a Connected-to-X message for connection-check.js's
    // success shape (which has no top-level "detail" field), then
    // finally to a bare HTTP status if nothing else is available.
    const detail =
      data.detail ||
      data.error ||
      (isOk && data.organisationName ? `Connected to "${data.organisationName}"` : undefined) ||
      (!res.ok ? `HTTP ${res.status}` : undefined);

    return {
      id: agent.id,
      name: agent.name,
      status,
      version: cleanVersion(data.version) || (await versionPromise),
      detail,
      responseMs,
      manualNote: agent.manualNote,
    };
  } catch (err) {
    return {
      id: agent.id,
      name: agent.name,
      status: "unreachable",
      version: await versionPromise,
      detail: err.name === "AbortError" ? "Timed out" : "Request failed",
      responseMs: Date.now() - started,
      manualNote: agent.manualNote,
    };
  }
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }

  const results = await Promise.all(AGENTS.map(checkAgent));
  res.status(200).json({
    checkedAt: new Date().toISOString(),
    agents: results,
  });
}
