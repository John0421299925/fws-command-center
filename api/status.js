// FWS Command Center — Agent Status Checker
// v1.1 — 17 Aug 2026
// v1.1: added manualNote field (hand-set, not live-detected) so paused
//   sub-systems (Agent 1, Enrichment Agent) show clearly even though the
//   parent endpoint still reports "ok". Also cleaned up version string
//   parsing — some agents pack extra description text into the version
//   field itself, so we now split on " - " and keep only the first part.
// v1.0 — Checks all known agents server-side (avoids browser CORS issues)
//   and returns a single combined JSON response for the dashboard.

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
    manualNote: "Agent 1 (mailbox intake): Paused",
  },
  {
    id: "enrichment-agent",
    name: "Enrichment Agent",
    url: "https://fws-enrichment-agent.vercel.app/api/enrich?vertical=aged_care",
    manualNote: "Paused by John",
  },
];

function cleanVersion(rawVersion) {
  if (!rawVersion) return null;
  // Some agents include a trailing description after " - "; keep only
  // the actual version token.
  return String(rawVersion).split(" - ")[0].trim();
}

async function checkAgent(agent) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(agent.url, { signal: controller.signal });
    clearTimeout(timeout);
    const responseMs = Date.now() - started;

    if (!res.ok) {
      return {
        id: agent.id,
        name: agent.name,
        status: "error",
        detail: `HTTP ${res.status}`,
        responseMs,
        manualNote: agent.manualNote,
      };
    }

    const data = await res.json();
    return {
      id: agent.id,
      name: agent.name,
      status: data.status === "ok" ? "ok" : "unknown",
      version: cleanVersion(data.version),
      responseMs,
      manualNote: agent.manualNote,
    };
  } catch (err) {
    return {
      id: agent.id,
      name: agent.name,
      status: "unreachable",
      detail: err.name === "AbortError" ? "Timed out" : "Request failed",
      responseMs: Date.now() - started,
      manualNote: agent.manualNote,
    };
  }
}

export default async function handler(req, res) {
  const results = await Promise.all(AGENTS.map(checkAgent));
  res.status(200).json({
    checkedAt: new Date().toISOString(),
    agents: results,
  });
}
