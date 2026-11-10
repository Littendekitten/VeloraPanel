// VeloraPanel server for Render.com (free). Enables disabled accounts of the Velora game project.
const http = require("http"), fs = require("fs"), path = require("path");
const admin = require("firebase-admin");

const ADMINS = ["littendekitten@gmail.com", "kitacatservice@gmail.com"];

if (!process.env.GAME_SERVICE_ACCOUNT) { console.error("Missing env var GAME_SERVICE_ACCOUNT."); process.exit(1); }
const panelApp = admin.initializeApp({ projectId: "velorapanel" }, "panel"); // only verifies panel logins
const auth = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.GAME_SERVICE_ACCOUNT)) }, "game").auth();

const fmt = (u) => ({ uid: u.uid, email: u.email || "", name: u.displayName || "", disabled: u.disabled,
  lastSignIn: u.metadata.lastSignInTime || "" });
const fail = (code, msg) => Object.assign(new Error(msg), { status: code });

async function handle(token, d) {
  let t;
  try { t = await panelApp.auth().verifyIdToken(token); } catch { throw fail(401, "Please sign in again."); }
  if (!t.email_verified || !ADMINS.includes((t.email || "").toLowerCase())) throw fail(403, "Not an admin.");
  try {
    if (d.action === "lookup") {
      const q = String(d.query || "").trim(); if (!q) throw fail(400, "Enter an email or UID.");
      return fmt(q.includes("@") ? await auth.getUserByEmail(q) : await auth.getUser(q));
    }
    if (d.action === "list") {
      const out = []; let pt;
      do { const p = await auth.listUsers(1000, pt); p.users.filter((u) => u.disabled).forEach((u) => out.push(fmt(u))); pt = p.pageToken; } while (pt);
      return out;
    }
    if (d.action === "enable") {
      if (!d.uid) throw fail(400, "Bad request.");
      const u = await auth.updateUser(d.uid, { disabled: false });
      console.log(`${t.email} enabled ${u.email || d.uid}`);
      return fmt(u);
    }
    throw fail(400, "Unknown action.");
  } catch (e) {
    if (e.status) throw e;
    if (e.code === "auth/user-not-found") throw fail(404, "No account found.");
    console.error(e); throw fail(500, "Something went wrong.");
  }
}

http.createServer((req, res) => {
  const send = (c, o) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
  }
  if (req.method === "POST" && req.url === "/api") {
    let body = ""; req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", async () => {
      try { send(200, await handle((req.headers.authorization || "").replace("Bearer ", ""), JSON.parse(body || "{}"))); }
      catch (e) { send(e.status || 500, { error: e.message }); }
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(process.env.PORT || 3000, "0.0.0.0", () => console.log("VeloraPanel running"));
