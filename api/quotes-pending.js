// FWS Command Centre — Pending Quote Approvals
// Version: v1.1
//
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

const crypto = require("crypto");

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const QUOTATION_PIPELINE_ID = "2136460779";
const QUOTATION_STAGE_COMPARING_QUOTES = "3704618465";

function isAuthenticated(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)cc_session=([^;]+)/);
  if (!match) return false;
  const [expiryStr, signature] = decodeURIComponent(match[1]).split(".");
  const expiry = Number(expiryStr);
  if (!expiry || Date.now() > expiry) return false;
  const expected = crypto
    .createHmac("sha256", process.env.CC_PASSWORD || "")
    .update(String(expiry))
    .digest("hex");
  const sigBuf = Buffer.from(signature || "");
  const expBuf = Buffer.from(expected);
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}

module.exports = async (req, res) => {
  if (!isAuthenticated(req)) {
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
