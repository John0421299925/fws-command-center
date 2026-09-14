// FWS Command Centre — Quote Comparison Proxy
// Version: v1.0
//
// Server-side proxy to the Auto Quotation Agent's get_comparison_data
// endpoint — same pattern already used for Agent Health/Exceptions,
// so the browser never has to make a cross-origin call to a different
// Vercel project directly.

const AUTO_QUOTATION_AGENT_BASE = "https://fws-auto-quotation-agent.vercel.app";

module.exports = async (req, res) => {
  const { ticket_id } = req.query;
  if (!ticket_id) {
    res.status(400).json({ status: "error", error: "ticket_id query parameter is required" });
    return;
  }

  try {
    const resp = await fetch(
      `${AUTO_QUOTATION_AGENT_BASE}/api/get_comparison_data?ticket_id=${encodeURIComponent(ticket_id)}`
    );
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ status: "error", error: String(err) });
  }
};
