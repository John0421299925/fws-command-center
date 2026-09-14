// FWS Command Centre — Pending Quote Approvals
// Version: v1.0
//
// Lists every quotation ticket currently sitting in the "Comparing
// Quotes" stage — meaning all expected SPs have replied and a
// comparison is ready for review. Read-only; uses the existing
// Command Centre HubSpot Service Key (already has the "tickets" scope,
// nothing new needed here).

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const QUOTATION_PIPELINE_ID = "2136460779";
const QUOTATION_STAGE_COMPARING_QUOTES = "3704618465";

module.exports = async (req, res) => {
  try {
    const hubspotResp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/tickets/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              { propertyName: "hs_pipeline", operator: "EQ", value: QUOTATION_PIPELINE_ID },
              { propertyName: "hs_pipeline_stage", operator: "EQ", value: QUOTATION_STAGE_COMPARING_QUOTES },
            ],
          },
        ],
        properties: ["subject", "hs_lastmodifieddate"],
        sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
        limit: 50,
      }),
    });

    if (!hubspotResp.ok) {
      const text = await hubspotResp.text();
      res.status(hubspotResp.status).json({ status: "error", error: text });
      return;
    }

    const data = await hubspotResp.json();
    const quotes = (data.results || []).map((t) => ({
      ticket_id: t.id,
      subject: t.properties.subject,
      last_modified: t.properties.hs_lastmodifieddate,
    }));

    res.status(200).json({ status: "ok", quotes });
  } catch (err) {
    res.status(500).json({ status: "error", error: String(err) });
  }
};
