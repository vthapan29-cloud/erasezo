/* Erasezo dashboard + API — Express + Postgres.
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
const totp = require("./totp");

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";
// Fail fast rather than silently signing sessions with a guessable secret.
if (PROD && !process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set. Refusing to start in production with an insecure default.");
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret-change-me";
const APP_URL = process.env.APP_URL || ("http://localhost:" + PORT);
const COOKIE = "erasezo_token";
const DAILY_FREE = Number(process.env.DAILY_FREE || 15);

const app = express();
// Railway terminates TLS at its edge and forwards over its internal network,
// so without this, req.ip is the edge's address for every request — the rate
// limiter below would bucket all users together instead of by real client IP.
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" })); // auth payloads are tiny; caps request-body DoS
app.use(cookieParser());

/* ---------- security headers ---------- */
// Hand-rolled instead of the `helmet` package — a handful of headers, easy to
// audit inline, no extra dependency for a small app.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; " +
    // Everything the site and the Control Room talk to is now this same origin —
    // the panel's separate Supabase backend is gone.
    "connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  if (PROD) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
});

/* ---------- rate limiting (in-memory, per IP) ---------- */
// No new dependency for a single-instance app: a small sliding-window counter
// keyed by IP + route group. Applied only to auth endpoints (the ones worth
// brute-forcing or hammering) — never to /api/me or static assets.
const RATE_BUCKETS = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + ":" + req.ip;
    const now = Date.now();
    let b = RATE_BUCKETS.get(key);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; RATE_BUCKETS.set(key, b); }
    b.count++;
    if (b.count > max) {
      res.setHeader("Retry-After", Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: "rate_limited", message: "Too many attempts — try again shortly." });
    }
    next();
  };
}
// Periodic sweep so the map doesn't grow unbounded over a long-running process.
setInterval(() => { const now = Date.now(); for (const [k, b] of RATE_BUCKETS) if (now > b.resetAt) RATE_BUCKETS.delete(k); }, 10 * 60e3).unref();
const authLimiter = rateLimit("auth", 20, 5 * 60e3); // 20 attempts / 5 min / IP

/* ---------- helpers ---------- */
function sign(uid, claims) { return jwt.sign(Object.assign({ uid }, claims || {}), JWT_SECRET, { expiresIn: "7d" }); }
function setAuthCookie(res, uid) {
  res.cookie(COOKIE, sign(uid), { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 7 * 864e5 });
}
function clearAuthCookie(res) { res.clearCookie(COOKIE, { httpOnly: true, sameSite: "lax", secure: PROD }); }

/* The Control Room session is deliberately a SEPARATE cookie carrying its own
 * `adm` claim, minted only by /api/admin/login after the password and (when
 * enabled) the TOTP code are both satisfied.
 *
 * Sharing the ordinary user cookie would mean an admin who merely signed in on
 * the normal site — where no second factor is asked for — would carry a session
 * the panel accepts, quietly bypassing 2FA. Separate cookie, separate claim,
 * separate lifetime: 12h rather than 7 days, since this one opens the panel. */
const ADMIN_COOKIE = "erasezo_admin";
const ADMIN_TTL_MS = 12 * 3600e3;
function setAdminCookie(res, uid) {
  res.cookie(ADMIN_COOKIE, jwt.sign({ uid, adm: true }, JWT_SECRET, { expiresIn: "12h" }),
    { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: ADMIN_TTL_MS });
}
async function adminAuth(req, res, next) {
  const t = req.cookies && req.cookies[ADMIN_COOKIE];
  if (!t) return res.status(401).json({ error: "not_authenticated" });
  let payload;
  try { payload = jwt.verify(t, JWT_SECRET); }
  catch (e) { return res.status(401).json({ error: "invalid_token" }); }
  if (payload.adm !== true) return res.status(403).json({ error: "not_admin" });
  // Re-read the flag every request: revoking admin in the database must take
  // effect immediately, not whenever an issued token happens to expire.
  const u = (await db.query("select is_admin from users where id=$1", [payload.uid])).rows[0];
  if (!u || !u.is_admin) return res.status(403).json({ error: "not_admin" });
  req.userId = payload.uid;
  next();
}
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
app.post("/api/auth/register", authLimiter, async (req, res) => {
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

app.post("/api/auth/login", authLimiter, async (req, res) => {
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
app.patch("/api/user/password", auth, authLimiter, async (req, res) => {
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

/* ---------- extension bridge: mint a bearer session for the logged-in cookie user ----------
 * Called ONLY by page/webBridge.js — a content script running ON erasezo.com,
 * so this is a same-origin fetch(credentials:'include'); the httpOnly cookie is
 * what authenticates it (via the `auth` middleware), never a value the
 * extension has to read directly. The returned token is then relayed into the
 * extension's OWN storage via its existing `erasioAuthSync` message action —
 * nothing here talks to any third-party (erasio.io) server. */
app.get("/api/ext/session", auth, authLimiter, async (req, res) => {
  const me = await userPublic(req.userId);
  if (!me) return res.status(401).json({ error: "not_authenticated" });
  res.json(extSessionPayload(req.userId, me));
});

function extSessionPayload(uid, me) {
  const token = sign(uid); // reused as both access + refresh — see webBridge.js note
  return {
    data: {
      accessToken: token, refreshToken: token,
      user: { username: me.username, name: me.username, email: me.email, is_email_verified: true, emailVerified: true },
    },
    // Also top-level, for the /api/ext/session caller (webBridge.js), which
    // reads these directly rather than via .data.
    accessToken: token, refreshToken: token,
    user: { username: me.username, name: me.username, email: me.email, is_email_verified: true, emailVerified: true },
  };
}

/* ---------- extension sidepanel bridge: the ORIGINAL bundled UI's own login
 * form and refresh logic (a separate surface from the website + user.html).
 * It used to POST straight to erasio.io — a real credential-leak to an
 * unrelated third party's server from a form branded "Sign in to Erasezo".
 * These mirror that exact request/response shape but run on OUR OWN backend.
 *
 * CORS: these are called by the extension's BACKGROUND SERVICE WORKER, whose
 * origin is chrome-extension://<id> — genuinely cross-origin from
 * erasezo.com, unlike /api/me or /api/ext/session (same-origin content-script
 * calls). Restricted to that exact extension origin, not a wildcard. */
const EXTENSION_ORIGIN = "chrome-extension://obmfaiblgoplljdpiembdcdjeohllfcd";
function extCors(req, res, next) {
  if (req.headers.origin === EXTENSION_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", EXTENSION_ORIGIN);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

app.post("/api/ext/login", extCors, authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const u = (await db.query("select id, password_hash, auth_provider from users where email=$1", [email])).rows[0];
    if (!u || !u.password_hash) return res.status(401).json({ message: "invalid_credentials" });
    if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ message: "invalid_credentials" });
    await grantDailyIfNeeded(u.id);
    setAuthCookie(res, u.id); // also signs the browser in on erasezo.com, if a tab visits it later
    res.json(extSessionPayload(u.id, await userPublic(u.id)));
  } catch (e) { res.status(500).json({ message: "server_error" }); }
});

app.post("/api/ext/logout", extCors, (req, res) => { res.json({ ok: true }); }); // stateless JWT — nothing to revoke server-side

app.post("/api/ext/refresh", extCors, authLimiter, async (req, res) => {
  try {
    const decoded = jwt.verify(String(req.body.refreshToken || ""), JWT_SECRET);
    const me = await userPublic(decoded.uid);
    if (!me) return res.status(401).json({ message: "invalid_token" });
    res.json(extSessionPayload(decoded.uid, me));
  } catch (e) { res.status(401).json({ message: "invalid_token" }); }
});

/* ---------- Control Room (super admin) ----------
 * This replaces the panel's former Supabase project outright. That setup put a
 * second account, a second password and a mandatory confirmation email between
 * the owner and their own dashboard — and the free-tier project auto-paused
 * once already, taking the panel down with it. One database, one login. */
// Two buckets, because the risk differs. /api/admin/login is reachable by
// anyone, so it stays tight. The 2FA endpoints already require a valid admin
// session, so the only brute-force target there is the 6-digit code — 20 per
// 5 min still leaves a million codes centuries out of reach, without
// rate-limiting a legitimate owner out of their own 2FA setup.
const adminLoginLimiter = rateLimit("adminLogin", 10, 5 * 60e3);
const admin2faLimiter = rateLimit("admin2fa", 20, 5 * 60e3);

app.post("/api/admin/login", adminLoginLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const code = String(req.body.code || "");
    const u = (await db.query(
      "select id, password_hash, is_admin, totp_enabled, totp_secret from users where email=$1", [email]
    )).rows[0];

    // Same reply for "no such user", "wrong password" and "not an admin", so
    // this endpoint can't be used to discover which accounts are admins.
    const ok = u && u.password_hash && await bcrypt.compare(password, u.password_hash);
    if (!ok || !u.is_admin) return res.status(401).json({ error: "invalid_credentials" });

    if (u.totp_enabled) {
      if (!code) return res.status(401).json({ error: "totp_required" });
      if (!totp.verify(u.totp_secret, code)) return res.status(401).json({ error: "totp_invalid" });
    }
    setAdminCookie(res, u.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "server_error" }); }
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { httpOnly: true, sameSite: "lax", secure: PROD });
  res.json({ ok: true });
});

app.get("/api/admin/me", adminAuth, async (req, res) => {
  const u = (await db.query("select email, username, totp_enabled from users where id=$1", [req.userId])).rows[0];
  res.json({ userId: req.userId, email: u.email, username: u.username, isAdmin: true, totpEnabled: !!u.totp_enabled });
});

app.get("/api/admin/settings", adminAuth, async (req, res) => {
  const r = (await db.query("select settings from admin_settings where user_id=$1", [req.userId])).rows[0];
  res.json((r && r.settings) || {});
});

app.put("/api/admin/settings", adminAuth, async (req, res) => {
  const settings = req.body && typeof req.body === "object" ? req.body : {};
  await db.query(
    `insert into admin_settings (user_id, settings, updated_at) values ($1,$2,now())
     on conflict (user_id) do update set settings=$2, updated_at=now()`,
    [req.userId, JSON.stringify(settings)]
  );
  res.json({ ok: true });
});

/* 2FA. Enrolment stores the secret but leaves it disabled until a code proves
 * the authenticator is really set up — otherwise a mistyped scan would lock the
 * owner out of their own panel on the next sign-in. */
app.post("/api/admin/2fa/setup", adminAuth, admin2faLimiter, async (req, res) => {
  const u = (await db.query("select email, totp_enabled from users where id=$1", [req.userId])).rows[0];
  if (u.totp_enabled) return res.status(409).json({ error: "already_enabled" });
  const secret = totp.generateSecret();
  await db.query("update users set totp_secret=$1 where id=$2", [secret, req.userId]);
  res.json({ secret, otpauthUrl: totp.otpauthUrl(secret, u.email) });
});

app.post("/api/admin/2fa/enable", adminAuth, admin2faLimiter, async (req, res) => {
  const u = (await db.query("select totp_secret from users where id=$1", [req.userId])).rows[0];
  if (!u.totp_secret) return res.status(400).json({ error: "no_pending_secret" });
  if (!totp.verify(u.totp_secret, req.body && req.body.code)) return res.status(400).json({ error: "totp_invalid" });
  await db.query("update users set totp_enabled=true where id=$1", [req.userId]);
  res.json({ ok: true });
});

app.post("/api/admin/2fa/disable", adminAuth, admin2faLimiter, async (req, res) => {
  const u = (await db.query("select password_hash, totp_secret, totp_enabled from users where id=$1", [req.userId])).rows[0];
  if (!u.totp_enabled) return res.json({ ok: true });
  // Both factors again to turn it off — a borrowed open session shouldn't be
  // enough to strip the second factor off the account.
  const pwOk = u.password_hash && await bcrypt.compare(String((req.body && req.body.password) || ""), u.password_hash);
  if (!pwOk || !totp.verify(u.totp_secret, req.body && req.body.code)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  await db.query("update users set totp_enabled=false, totp_secret=null where id=$1", [req.userId]);
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
// redirect:false — public/admin is a real directory, and static's default
// "add a trailing slash" redirect for directories fights the /admin route
// below into a redirect loop. Assets under /admin/ still serve normally.
app.use(express.static(path.join(__dirname, "public"), { redirect: false }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get(["/login", "/signin"], (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
// Control Room. No server-side gate on purpose: the page ships no data of its
// own — every byte it shows comes from Supabase, where the admins-table RLS
// policy plus mandatory TOTP decide what a caller may read, so serving the
// shell to an anonymous visitor reveals nothing. Its asset refs are
// root-absolute, which resolves identically here and at the extension root —
// same file, no build step, no trailing-slash edge case.
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
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
/* Bootstraps the owner account from env, so the very first admin exists without
 * anyone needing shell access to the database. Idempotent: safe on every boot.
 * Setting ADMIN_PASSWORD to a new value and redeploying is also the password
 * reset path — there is no self-serve reset for an account this privileged. */
async function ensureAdminFromEnv() {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!email || !password) return;
  if (password.length < 12) { console.warn("[admin] ADMIN_PASSWORD is under 12 chars — refusing to set it."); return; }
  const hash = await bcrypt.hash(password, 12);
  const existing = (await db.query("select id from users where email=$1", [email])).rows[0];
  if (existing) {
    await db.query("update users set password_hash=$1, is_admin=true where id=$2", [hash, existing.id]);
    console.log("[admin] owner account updated:", email);
  } else {
    const u = (await db.query(
      "insert into users(email, username, auth_provider, password_hash, is_admin) values ($1,$2,'password',$3,true) returning id",
      [email, email.split("@")[0], hash]
    )).rows[0];
    await grantDailyIfNeeded(u.id);
    console.log("[admin] owner account created:", email);
  }
}

async function start() {
  await db.init();
  await ensureAdminFromEnv();
  if (require.main === module) {
    scheduleDailyReset();
    app.listen(PORT, () => console.log("Erasezo web on " + APP_URL));
  }
}
if (require.main === module) start().catch((e) => { console.error("boot failed:", e); process.exit(1); });

module.exports = { app, start, db, userPublic, grantDailyIfNeeded, mergeOrCreateGoogleUser, dailyResetAll, ensureAdminFromEnv };
