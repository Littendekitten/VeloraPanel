const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

// Service-account JSON of the project whose players you want to unban (velora-5246f).
const GAME_KEY = defineSecret("VELORA_SERVICE_ACCOUNT");
const ADMINS = ["littendekitten@gmail.com", "kitacatservice@gmail.com"];

admin.initializeApp(); // VeloraPanel project: audit log
let gameApp;
const gameAuth = () => {
  if (!gameApp) gameApp = admin.initializeApp(
    { credential: admin.credential.cert(JSON.parse(GAME_KEY.value())) }, "game");
  return gameApp.auth();
};

const fmt = (u) => ({
  uid: u.uid, email: u.email || "", name: u.displayName || "",
  disabled: u.disabled, created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime || "",
});

exports.panel = onCall({ region: "europe-west1", secrets: [GAME_KEY] }, async (req) => {
  // Real security check, done server-side on every call.
  const t = req.auth && req.auth.token;
  if (!t || !t.email_verified || !ADMINS.includes((t.email || "").toLowerCase()))
    throw new HttpsError("permission-denied", "Not an admin.");

  const { action, query, uid, disabled } = req.data || {};
  const auth = gameAuth();

  try {
    if (action === "lookup") {
      const q = String(query || "").trim();
      if (!q) throw new HttpsError("invalid-argument", "Enter an email or UID.");
      const u = q.includes("@") ? await auth.getUserByEmail(q) : await auth.getUser(q);
      return fmt(u);
    }
    if (action === "list") {
      const out = []; let token;
      for (let i = 0; i < 10; i++) {
        const page = await auth.listUsers(1000, token);
        page.users.filter((u) => u.disabled).forEach((u) => out.push(fmt(u)));
        token = page.pageToken; if (!token) break;
      }
      return out;
    }
    if (action === "setDisabled") {
      if (!uid || typeof disabled !== "boolean") throw new HttpsError("invalid-argument", "Bad request.");
      const u = await auth.updateUser(uid, { disabled });
      await admin.firestore().collection("auditLog").add({
        admin: t.email, action: disabled ? "ban" : "unban", targetUid: uid,
        targetEmail: u.email || "", at: admin.firestore.FieldValue.serverTimestamp(),
      });
      return fmt(u);
    }
    throw new HttpsError("invalid-argument", "Unknown action.");
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    if (e.code === "auth/user-not-found") throw new HttpsError("not-found", "No account found.");
    console.error(e); throw new HttpsError("internal", "Something went wrong.");
  }
});
