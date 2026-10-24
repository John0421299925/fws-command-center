// FWS Command Centre — Today: tasks due today and overdue
// Version: v1.2
//
// v1.2 (24 Oct 2026): task links open the task in HubSpot's Tasks view. The old record/0-27 link gave a
// "page not found", because HubSpot doesn't open tasks as record pages.
//
// v1.1 (23 Oct 2026): also returns tasks coming up in the next 7 days (grouped as "upcoming"), so a task
// booked for next Tuesday shows ahead of time. Each task carries its group: overdue / today / upcoming.
//
// v1.0 (23 Oct 2026): the "what needs doing today" list. Reads open HubSpot tasks (the ones Time Saver
// creates, and any made in HubSpot itself) that are due by the end of today, Sydney time, plus anything
// overdue. Ownership: each rep sees only their own tasks; John and James see everyone's, including tasks
// with no owner. Read-only - nothing is changed here.

const { verifySession, findUserWithPassword } = require("../lib/auth");

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const ADMIN_EMAILS = ["john.murray@futurewaste.com.au", "james@futurewaste.com.au"];
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || "441953864";
const TYPE_LABELS = { CALL: "Call", EMAIL: "Email", TODO: "To-do" };
const UPCOMING_DAYS = 7;

// Sydney is UTC+11 in daylight saving (first Sunday in October, 2am, to first Sunday in April, 3am), else +10.
function firstSunday(year, month) {          // month is 1-12
  const d = new Date(Date.UTC(year, month - 1, 1));
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
function sydneyOffsetHours(utc) {
  const y = utc.getUTCFullYear();
  const start = new Date(firstSunday(y, 10).getTime() + (2 - 10) * 3600e3);
  const end = new Date(firstSunday(y, 4).getTime() + (3 - 11) * 3600e3);
  return (utc < end || utc >= start) ? 11 : 10;
}
// End of today in Sydney, as a UTC timestamp in milliseconds.
function endOfSydneyTodayMs(now = new Date()) {
  const off = sydneyOffsetHours(now);
  const local = new Date(now.getTime() + off * 3600e3);
  const endLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 23, 59, 59, 999);
  return endLocal - off * 3600e3;
}
function startOfSydneyTodayMs(now = new Date()) {
  return endOfSydneyTodayMs(now) - 86400e3 + 1;
}

async function hubspot(path, init = {}) {
  return fetch(`${HUBSPOT_API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

module.exports = async (req, res) => {
  const session = verifySession(req);
  if (!session) {
    res.status(401).json({ status: "error", error: "Not authenticated" });
    return;
  }
  const { user } = await findUserWithPassword(session.username);
  const caller = ((user && user.email) || "").trim().toLowerCase();
  const isAdmin = ADMIN_EMAILS.includes(caller);

  try {
    // Owners: id -> name, and the caller's own owner id
    const ownersResp = await hubspot("/crm/v3/owners?limit=100");
    const owners = {};
    let myOwnerId = null;
    if (ownersResp.ok) {
      for (const o of (await ownersResp.json()).results || []) {
        owners[String(o.id)] = [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || `owner ${o.id}`;
        if ((o.email || "").toLowerCase() === caller) myOwnerId = String(o.id);
      }
    }
    if (!isAdmin && !myOwnerId) {
      res.status(200).json({ status: "ok", isAdmin, tasks: [], note: "You are not set up as a HubSpot user yet, so there are no tasks to show." });
      return;
    }

    const filters = [
      { propertyName: "hs_task_status", operator: "NEQ", value: "COMPLETED" },
      { propertyName: "hs_timestamp", operator: "LTE", value: String(endOfSydneyTodayMs() + UPCOMING_DAYS * 86400e3) },
    ];
    if (!isAdmin) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: myOwnerId });

    const tasks = [];
    let after;
    for (let page = 0; page < 5; page++) {
      const body = {
        filterGroups: [{ filters }],
        properties: ["hs_task_subject", "hs_task_status", "hs_timestamp", "hs_task_type", "hs_task_priority", "hubspot_owner_id"],
        sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
        limit: 100,
        ...(after ? { after } : {}),
      };
      const resp = await hubspot("/crm/v3/objects/tasks/search", { method: "POST", body: JSON.stringify(body) });
      if (!resp.ok) {
        const text = await resp.text();
        res.status(resp.status).json({ status: "error", error: resp.status === 403 ? "The Command Centre's HubSpot key needs the tasks read scope." : text });
        return;
      }
      const data = await resp.json();
      tasks.push(...(data.results || []));
      after = data.paging && data.paging.next && data.paging.next.after;
      if (!after) break;
    }

    const todayStart = startOfSydneyTodayMs();
    const todayEnd = endOfSydneyTodayMs();
    const out = tasks.map((t) => {
      const p = t.properties || {};
      const due = Date.parse(p.hs_timestamp);
      const ownerId = p.hubspot_owner_id ? String(p.hubspot_owner_id) : null;
      return {
        id: t.id,
        subject: p.hs_task_subject || "(no subject)",
        due: p.hs_timestamp,
        overdue: Number.isFinite(due) && due < todayStart,
        group: !Number.isFinite(due) ? "today" : due < todayStart ? "overdue" : due <= todayEnd ? "today" : "upcoming",
        type: TYPE_LABELS[(p.hs_task_type || "").toUpperCase()] || "To-do",
        priority: p.hs_task_priority || null,
        owner: ownerId ? (owners[ownerId] || `owner ${ownerId}`) : "No owner",
        mine: ownerId !== null && ownerId === myOwnerId,
        url: `https://app.hubspot.com/tasks/${PORTAL_ID}/view/all/task/${t.id}`,
      };
    });

    res.status(200).json({
      status: "ok",
      isAdmin,
      overdueCount: out.filter((x) => x.group === "overdue").length,
      todayCount: out.filter((x) => x.group === "today").length,
      upcomingCount: out.filter((x) => x.group === "upcoming").length,
      upcomingDays: UPCOMING_DAYS,
      tasks: out,
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: String(err) });
  }
};

module.exports._test = { sydneyOffsetHours, endOfSydneyTodayMs, startOfSydneyTodayMs };
