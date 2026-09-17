// FWS Command Centre — Pending Quote Approvals
// Version: v1.3
//
// v1.3: FIX — v1.2 wrongly restricted this to admin/ops sessions.
// Quotes are core to a sales rep's actual job, not company-wide admin
// data the way AR/AP/margin are — any logged-in person (admin, ops,
// or a future rep) needs to see quotes awaiting approval. Removed the
// role restriction entirely; only a valid session is required now.
// Once per-rep quote attribution exists, a rep-scoped filter (only
// MY quotes) could be added here, but that's a future refinement, not
// a reason to lock reps out entirely today.
// v1.2: swapped the old inline single-shared-password cookie check
// for the shared verifySession() from lib/auth.js — required now
// that the Command Centre has moved to real per-person logins (see
// lib/auth.js / api/login.js).
// v1.1: Added the site-wide session-cookie check (see login.js /
//       whoami.js for how the cookie is created and verified) — this
//       endpoint returns real client/pricing-adjacent data, so it must
//       reject unauthenticated requests directly, not just rely on the
//       page itself being behind a login screen.
//
// Lists every quotation ticket currently sitting in the "Comparing
// Quotes" stage — meaning all expected SPs have replied and a
// comparison is ready for review. Uses the existing Command Centre
// HubSpot Service Key (already has the "tickets" scope).

const { verifySession } = require("../lib/auth");

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const QUOTATION_PIPELINE_ID = "2136460779";
const QUOTATION_STAGE_COMPARING_QUOTES = "3704618465";

module.exports = async (req, res) => {
  const session = verifySession(req);
  if (!session) {
    res.status(401).json({ status: "error", error: "Not authenticated" });
    return;
  }

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
