
// FWS Command Center — Agent Status Checker
// v1.0 — 17 Aug 2026
// Checks all known agents server-side (avoids browser CORS issues) and
// returns a single combined JSON response for the dashboard to display.

const AGENTS = [
  {
    id: "invoice-automation",
    name: "Invoice Automation",
    url: "https://clv-invoice-automation.vercel.app/api/webhook",
  },
  {
    id: "hubspot-agent",
    name: "HubSpot Agent (2 & 3)",
    url: "https://fws-hubspot-agent-a4be.vercel.app/api/webhook",
  },
  {
    id: "enrichment-agent",
    name: "Enrichment Agent",
    url: "https://fws-enrichment-agent.vercel.app/api/enrich?vertical=aged_care",
  },
];

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
      };
    }

    const data = await res.json();
    return {
      id: agent.id,
      name: agent.name,
      status: data.status === "ok" ? "ok" : "unknown",
      version: data.version || null,
      message: data.message || null,
      responseMs,
    };
  } catch (err) {
    return {
      id: agent.id,
      name: agent.name,
      status: "unreachable",
      detail: err.name === "AbortError" ? "Timed out" : "Request failed",
      responseMs: Date.now() - started,
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
