// VeloraPanel server (Render.com). Full admin over the Velora game project: accounts + Firestore.
const http = require("http"), fs = require("fs"), path = require("path");
const admin = require("firebase-admin");

const ADMINS = ["littendekitten@gmail.com", "kitacatservice@gmail.com"];
if (!process.env.GAME_SERVICE_ACCOUNT) { console.error("Missing env var GAME_SERVICE_ACCOUNT."); process.exit(1); }

const panelApp = admin.initializeApp({ projectId: "velorapanel" }, "panel"); // only verifies panel logins
const gameApp = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.GAME_SERVICE_ACCOUNT)) }, "game");
const auth = gameApp.auth(), db = gameApp.firestore();
const { Timestamp, GeoPoint, DocumentReference, FieldPath } = admin.firestore;

// Keep Firestore types (timestamps etc.) intact when editing as JSON.
const ser = (v) => {
  if (v instanceof Timestamp) return { __type: "timestamp", value: v.toDate().toISOString() };
  if (v instanceof GeoPoint) return { __type: "geopoint", lat: v.latitude, lng: v.longitude };
  if (v instanceof DocumentReference) return { __type: "ref", path: v.path };
  if (Buffer.isBuffer(v)) return { __type: "bytes", value: v.toString("base64") };
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)]));
  return v;
};
const de = (v) => {
  if (Array.isArray(v)) return v.map(de);
  if (v && typeof v === "object") {
    if (v.__type === "timestamp") { const d = new Date(v.value); if (isNaN(d)) throw fail(400, "Bad timestamp: " + v.value); return Timestamp.fromDate(d); }
    if (v.__type === "geopoint") return new GeoPoint(v.lat, v.lng);
    if (v.__type === "ref") return db.doc(v.path);
    if (v.__type === "bytes") return Buffer.from(v.value, "base64");
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, de(x)]));
  }
  return v;
};

const fmt = (u) => ({ uid: u.uid, email: u.email || "", name: u.displayName || "", disabled: u.disabled,
  lastSignIn: u.metadata.lastSignInTime || "" });
const fail = (code, msg) => Object.assign(new Error(msg), { status: code });
const segs = (p) => String(p || "").split("/").filter(Boolean);
const colRef = (p) => { const s = segs(p); if (!s.length || s.length % 2 === 0) throw fail(400, "Not a collection path."); return db.collection(s.join("/")); };
const docRef = (p) => { const s = segs(p); if (!s.length || s.length % 2 === 1) throw fail(400, "Not a document path."); return db.doc(s.join("/")); };

async function handle(token, d) {
  let t;
  try { t = await panelApp.auth().verifyIdToken(token); } catch { throw fail(401, "Please sign in again."); }
  if (!t.email_verified || !ADMINS.includes((t.email || "").toLowerCase())) throw fail(403, "Not an admin.");
  const log = (m) => console.log(`[${new Date().toISOString()}] ${t.email} ${m}`);

  try {
    switch (d.action) {
      // ----- accounts -----
      case "lookup": {
        const q = String(d.query || "").trim(); if (!q) throw fail(400, "Enter an email or UID.");
        return fmt(q.includes("@") ? await auth.getUserByEmail(q) : await auth.getUser(q));
      }
      case "list": {
        if (!d.onlyBanned) { const p = await auth.listUsers(100, d.pageToken || undefined); return { users: p.users.map(fmt), next: p.pageToken || null }; }
        const out = []; let pt;
        do { const p = await auth.listUsers(1000, pt); p.users.filter((u) => u.disabled).forEach((u) => out.push(fmt(u))); pt = p.pageToken; } while (pt);
        return { users: out, next: null };
      }
      case "setDisabled": case "deleteUser": {
        if (!d.uid) throw fail(400, "Bad request.");
        const target = await auth.getUser(d.uid);
        if (ADMINS.includes((target.email || "").toLowerCase()) && !(d.action === "setDisabled" && d.disabled === false))
          throw fail(400, "Refusing to ban/delete an admin account.");
        if (d.action === "deleteUser") { await auth.deleteUser(d.uid); log(`deleted user ${target.email || d.uid}`); return { ok: true }; }
        if (typeof d.disabled !== "boolean") throw fail(400, "Bad request.");
        const u = await auth.updateUser(d.uid, { disabled: d.disabled });
        if (d.disabled) await auth.revokeRefreshTokens(d.uid); // kick them out of existing sessions
        log(`${d.disabled ? "banned" : "enabled"} ${u.email || d.uid}`);
        return fmt(u);
      }
      // ----- firestore -----
      case "fsRoot": return (await db.listCollections()).map((c) => c.id);
      case "fsList": {
        let q = colRef(d.path).orderBy(FieldPath.documentId()).limit(50);
        if (d.after) q = q.startAfter(String(d.after));
        return (await q.get()).docs.map((x) => x.id);
      }
      case "fsGet": {
        const ref = docRef(d.path), snap = await ref.get();
        return { exists: snap.exists, data: snap.exists ? ser(snap.data()) : {}, subs: (await ref.listCollections()).map((c) => c.id) };
      }
      case "fsSet": {
        if (!d.data || typeof d.data !== "object" || Array.isArray(d.data)) throw fail(400, "Document must be a JSON object.");
        await docRef(d.path).set(de(d.data)); log(`saved ${d.path}`); return { ok: true };
      }
      case "fsDelete": await docRef(d.path).delete(); log(`deleted doc ${d.path}`); return { ok: true };
    }
    throw fail(400, "Unknown action.");
  } catch (e) {
    if (e.status) throw e;
    if (e.code === "auth/user-not-found") throw fail(404, "No account found.");
    console.error(e); throw fail(500, e.message || "Something went wrong.");
  }
}

http.createServer((req, res) => {
  const send = (c, o) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
  }
  if (req.method === "POST" && req.url === "/api") {
    let body = ""; req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", async () => {
      try { send(200, await handle((req.headers.authorization || "").replace("Bearer ", ""), JSON.parse(body || "{}"))); }
      catch (e) { send(e.status || 500, { error: e.message }); }
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(process.env.PORT || 3000, "0.0.0.0", () => console.log("VeloraPanel running"));
