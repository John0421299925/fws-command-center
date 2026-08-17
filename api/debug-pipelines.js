// FWS Command Center — TEMPORARY diagnostic tool
// Shows the real ticket pipeline/stage structure so we can fix
// exceptions.js's "is this closed?" detection correctly instead of
// guessing. Delete this file once no longer needed.

const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;
const HUBSPOT_API_BASE = 'https://api.hubapi.com';

export default async function handler(req, res) {
  if (!HUBSPOT_SERVICE_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_SERVICE_KEY not configured' });
  }
  try {
    const resp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/pipelines/tickets`, {
      headers: { Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}` },
    });
    const data = await resp.json();

    const simplified = (data.results || []).map((pipeline) => ({
      pipelineLabel: pipeline.label,
      stages: (pipeline.stages || []).map((s) => ({
        id: s.id,
        label: s.label,
        metadata: s.metadata,
      })),
    }));

    return res.status(200).json({ status: 'ok', pipelines: simplified });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
