// FWS Command Centre — Logout endpoint
// Version: v1.0
//
// Clears the cc_session cookie by setting it expired, then redirects
// to the login page.

module.exports = async (req, res) => {
  res.setHeader(
    "Set-Cookie",
    "cc_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
  res.writeHead(302, { Location: "/login.html" });
  res.end();
};
