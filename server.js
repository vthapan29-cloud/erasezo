/* Linkllo dashboard + API — Express + Postgres.
 * Auth is built here (Railway Postgres has no auth of its own): bcrypt password
 * hashing + JWT session cookies + Google OAuth (server-side code flow with
 * account-merge by email). */
"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const db = require("./db");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret-change-me";
const APP_URL = process.env.APP_URL || ("http://localhost:" + PORT);
const COOKIE = "linkllo_token";
const DAILY_FREE = Number(process.env.DAILY_FREE || 15);
const PROD = process.env.NODE_ENV === "production";

const app = express();
app.use(express.json());
app.use(cookieParser());

/* ---------- helpers ---------- */
function sign(uid) { return jwt.sign({ uid }, JWT_SECRET, { expiresIn: "7d" }); }
function setAuthCookie(res, uid) {
  res.cookie(COOKIE, sign(uid), { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 7 * 864e5 });
}
function clearAuthCookie(res) { res.clearCookie(COOKIE, { httpOnly: true, sameSite: "lax", secure: PROD }); }
function auth(req, res, next) {
  const t = req.cookies && req.cookies[COOKIE];
  if (!t) return res.status(401).json({ error: "not_authenticated" });
  try { req.userId = jwt.verify(t, JWT_SECRET).uid; next(); }
  catch (e) { return res.status(401).json({ error: "invalid_token" }); }
}
const utcMidnight = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

async function userPublic(id) {
  const u = (await db.query(
    "select id, email, username, avatar_url, auth_provider, google_id, referral_code from users where id=$1", [id]
  )).rows[0];
  if (!u) return null;
  const total = Number((await db.query("select coalesce(sum(delta),0) s from credit_ledger where user_id=$1", [id])).rows[0].s);
  const today = Number((await db.query(
    "select coalesce(sum(delta),0) s from credit_ledger where user_id=$1 and created_at >= $2", [id, utcMidnight()]
  )).rows[0].s);
  const sub = (await db.query("select status, plan from subscriptions where user_id=$1", [id])).rows[0];
  return {
    userId: u.id, email: u.email, username: u.username || u.email.split("@")[0],
    avatarUrl: u.avatar_url, authProvider: u.auth_provider, googleId: u.google_id,
    referralCode: u.referral_code,
    plan: (sub && sub.status === "active") ? (sub.plan || "pro") : "free",
    subscriptionStatus: (sub && sub.status) || "none",
    credits: { total, today, dailyQuota: DAILY_FREE },
  };
}

// Grant today's free quota once per UTC day (idempotent).
async function grantDailyIfNeeded(uid) {
  const has = (await db.query(
    "select 1 from credit_ledger where user_id=$1 and reason='daily_free' and created_at >= $2 limit 1",
    [uid, utcMidnight()]
  )).rows[0];
  if (!has) await db.query("insert into credit_ledger(user_id, delta, reason) values ($1,$2,'daily_free')", [uid, DAILY_FREE]);
}

/* ---------- auth: email + password ---------- */
app.post("/api/auth/register", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const username = req.body.username ? String(req.body.username).trim() : null;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "invalid_email" });
    if (password.length < 8) return res.status(400).json({ error: "weak_password", message: "Password must be at least 8 characters." });
    const exists = (await db.query("select id, auth_provider from users where email=$1", [email])).rows[0];
    if (exists) return res.status(409).json({ error: "email_taken" });
    const hash = await bcrypt.hash(password, 12);
    const u = (await db.query(
      "insert into users(email, username, auth_provider, password_hash) values ($1,$2,'password',$3) returning id",
      [email, username, hash]
    )).rows[0];
    await grantDailyIfNeeded(u.id);
    setAuthCookie(res, u.id);
    res.json({ ok: true, user: await userPublic(u.id) });
  } catch (e) { res.status(500).json({ error: "server_error", message: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const u = (await db.query("select id, password_hash, auth_provider from users where email=$1", [email])).rows[0];
    if (!u || !u.password_hash) return res.status(401).json({ error: "invalid_credentials" });
    if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: "invalid_credentials" });
    await grantDailyIfNeeded(u.id);
    setAuthCookie(res, u.id);
    res.json({ ok: true, user: await userPublic(u.id) });
  } catch (e) { res.status(500).json({ error: "server_error", message: e.message }); }
});

app.post("/api/auth/logout", (req, res) => { clearAuthCookie(res); res.json({ ok: true }); });

app.get("/api/me", auth, async (req, res) => {
  const u = await userPublic(req.userId);
  if (!u) { clearAuthCookie(res); return res.status(401).json({ error: "not_authenticated" }); }
  res.json(u);
});

app.get("/api/credits", auth, async (req, res) => {
  const total = Number((await db.query("select coalesce(sum(delta),0) s from credit_ledger where user_id=$1", [req.userId])).rows[0].s);
  const today = Number((await db.query("select coalesce(sum(delta),0) s from credit_ledger where user_id=$1 and created_at >= $2", [req.userId, utcMidnight()])).rows[0].s);
  res.json({ total, today, dailyQuota: DAILY_FREE });
});

/* ---------- profile ---------- */
app.get("/api/user/profile", auth, async (req, res) => res.json(await userPublic(req.userId)));

app.patch("/api/user/profile", auth, async (req, res) => {
  // Username only — email is immutable server-side (never read from the body).
  const username = req.body.username != null ? String(req.body.username).trim().slice(0, 40) : null;
  if (!username) return res.status(400).json({ error: "username_required" });
  await db.query("update users set username=$1 where id=$2", [username, req.userId]);
  res.json(await userPublic(req.userId));
});

/* ---------- security: change password ---------- */
app.patch("/api/user/password", auth, async (req, res) => {
  const u = (await db.query("select auth_provider, password_hash from users where id=$1", [req.userId])).rows[0];
  if (!u) return res.status(401).json({ error: "not_authenticated" });
  // Server-side block for OAuth-only accounts — not just a hidden UI.
  if (u.auth_provider === "google" || !u.password_hash) {
    return res.status(403).json({ error: "oauth_only", message: "Your account uses Google sign-in. Password management is not available for OAuth-only accounts." });
  }
  const cur = String(req.body.currentPassword || "");
  const next = String(req.body.newPassword || "");
  if (next.length < 8) return res.status(400).json({ error: "weak_password" });
  if (!(await bcrypt.compare(cur, u.password_hash))) return res.status(400).json({ error: "wrong_current_password" });
  await db.query("update users set password_hash=$1 where id=$2", [await bcrypt.hash(next, 12), req.userId]);
  // Invalidate other sessions: rotate this one (a real impl would track a token
  // version; here we simply re-issue the current session's cookie).
  setAuthCookie(res, req.userId);
  res.json({ ok: true });
});

// MERGE-BY-EMAIL: if a user with this verified email already exists (e.g. a
// password account), link googleId to that row — never create a duplicate.
async function mergeOrCreateGoogleUser(info) {
  const email = String(info.email || "").toLowerCase();
  const existing = (await db.query("select id, google_id from users where email=$1", [email])).rows[0];
  let uid;
  if (existing) {
    if (!existing.google_id) await db.query("update users set google_id=$1 where id=$2", [info.sub, existing.id]);
    uid = existing.id;
  } else {
    uid = (await db.query(
      "insert into users(email, username, avatar_url, auth_provider, google_id) values ($1,$2,$3,'google',$4) returning id",
      [email, info.name || null, info.picture || null, info.sub]
    )).rows[0].id;
  }
  await grantDailyIfNeeded(uid);
  return uid;
}

/* ---------- Google OAuth (server-side code flow, merge by email) ---------- */
app.get("/api/auth/google", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).send("Google OAuth not configured (GOOGLE_CLIENT_ID missing).");
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: APP_URL + "/api/auth/google/callback",
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
  });
  res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + p.toString());
});

app.get("/api/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: APP_URL + "/api/auth/google/callback", grant_type: "authorization_code",
      }),
    });
    const tok = await tokenRes.json();
    if (!tok.access_token) return res.status(400).send("Google token exchange failed");
    const info = await (await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + tok.access_token } })).json();
    if (info.email_verified === false || !info.email) return res.status(400).send("Unverified Google email");
    const uid = await mergeOrCreateGoogleUser(info);
    setAuthCookie(res, uid);
    res.redirect("/dashboard");
  } catch (e) { res.status(500).send("OAuth error: " + e.message); }
});

/* ---------- static pages ---------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get(["/login", "/signin"], (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/healthz", (req, res) => res.json({ ok: true }));

/* ---------- daily free-quota reset (real scheduled job, in-process) ---------- */
async function dailyResetAll() {
  const rows = (await db.query("select id from users")).rows;
  for (const r of rows) { try { await grantDailyIfNeeded(r.id); } catch (e) {} }
  console.log("[cron] daily free quota granted to", rows.length, "users @", new Date().toISOString());
}
function scheduleDailyReset() {
  const now = new Date();
  const next = new Date(now); next.setUTCHours(24, 0, 5, 0); // 00:00:05 next UTC day
  const ms = next - now;
  setTimeout(function run() { dailyResetAll().catch(() => {}); setInterval(() => dailyResetAll().catch(() => {}), 24 * 3600e3); }, ms);
  console.log("[cron] daily reset scheduled in", Math.round(ms / 1000), "s (at next UTC midnight)");
}

/* ---------- boot ---------- */
async function start() {
  await db.init();
  if (require.main === module) {
    scheduleDailyReset();
    app.listen(PORT, () => console.log("Linkllo web on " + APP_URL));
  }
}
if (require.main === module) start().catch((e) => { console.error("boot failed:", e); process.exit(1); });

module.exports = { app, start, db, userPublic, grantDailyIfNeeded, mergeOrCreateGoogleUser, dailyResetAll };
