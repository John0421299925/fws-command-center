// FWS Command Centre — Pending Quote Approvals (list)
// Version: v1.4
//
// v1.4: the list shows two groups. "Awaiting approval" (all replies in, not yet generated) and
// "Approved, not sent" (generated, waiting for the client send). A quote drops off once it is sent.
// Ownership: each person sees the quotes they requested. John and James also see unowned quotes
// (those made before requester tracking). Approved, not-sent quotes are marked in the subject.
// v1.3: any logged-in person (admin, ops, or a rep) can use the list.
// v1.2: shared verifySession() from lib/auth.js.
// v1.1: site-wide session check.

const { verifySession, findUserWithPassword } = require("../lib/auth");

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const QUOTATION_PIPELINE_ID = "2136460779";
const STAGE_COMPARING = "3704618465";   // awaiting approval
const STAGE_DRAFTED = "3712875969";     // approved, not yet sent
const ADMIN_USERNAMES_EMAILS = ["john.murray@futurewaste.com.au", "james@futurewaste.com.au"];

function requesterOf(content) {
  const m = String(content || "").match(/REQUESTED_BY:([^\s]+)/);
  return m ? m[1].trim().toLowerCase() : null;
}

module.exports = async (req, res) => {
  const session = verifySession(req);
  if (!session) {
    res.status(401).json({ status: "error", error: "Not authenticated" });
    return;
  }

  const { user } = await findUserWithPassword(session.username);
  const caller = ((user && user.email) || "").trim().toLowerCase();
  const isAdmin = ADMIN_USERNAMES_EMAILS.includes(caller);

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
              { propertyName: "hs_pipeline_stage", operator: "IN", values: [STAGE_COMPARING, STAGE_DRAFTED] },
            ],
          },
        ],
        properties: ["subject", "hs_lastmodifieddate", "hs_pipeline_stage", "content"],
        sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
        limit: 100,
      }),
    });

    if (!hubspotResp.ok) {
      const text = await hubspotResp.text();
      res.status(hubspotResp.status).json({ status: "error", error: text });
      return;
    }

    const data = await hubspotResp.json();
    const quotes = (data.results || [])
      .filter((t) => {
        const owner = requesterOf(t.properties.content);
        if (owner === null) return isAdmin;                 // unowned: John and James only
        return owner === caller;                            // owned: the requester only
      })
      .map((t) => {
        const approved = t.properties.hs_pipeline_stage === STAGE_DRAFTED;
        const subject = t.properties.subject || "";
        return {
          ticket_id: t.id,
          subject: approved ? `Approved, not sent: ${subject}` : subject,
          status: approved ? "approved_not_sent" : "awaiting_approval",
          last_modified: t.properties.hs_lastmodifieddate,
        };
      });

    res.status(200).json({ status: "ok", quotes });
  } catch (err) {
    res.status(500).json({ status: "error", error: String(err) });
  }
};
