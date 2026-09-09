/* Erasezo dashboard + API — Express + Postgres.
 * Auth is built here (Railway Postgres has no auth of its own): bcrypt password
 * hashing + JWT session cookies + Google OAuth (server-side code flow with
 * account-merge by email). */
"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
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
// verify: keeps the exact bytes around. Razorpay signs the raw payload, so the
// HMAC must be taken over what was actually sent — re-serialising the parsed
// object would reorder keys and never match. limit caps request-body DoS.
app.use(express.json({ limit: "64kb", verify: (req, res, buf) => { req.rawBody = buf; } }));
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
  const u = (await db.query("select is_admin, disabled from users where id=$1", [payload.uid])).rows[0];
  if (!u || !u.is_admin || u.disabled) return res.status(403).json({ error: "not_admin" });
  req.userId = payload.uid;
  next();
}
function auth(req, res, next) {
  // Cookie for the website; Bearer for the extension's background worker, whose
  // requests are cross-site from a chrome-extension:// origin and so never
  // carry the SameSite=Lax cookie.
  const bearer = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  const t = (req.cookies && req.cookies[COOKIE]) || (bearer && bearer[1]);
  if (!t) return res.status(401).json({ error: "not_authenticated" });
  try { req.userId = jwt.verify(t, JWT_SECRET).uid; next(); }
  catch (e) { return res.status(401).json({ error: "invalid_token" }); }
}
const utcMidnight = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

async function userPublic(id) {
  const u = (await db.query(
    "select id, email, username, avatar_url, auth_provider, google_id, referral_code, daily_quota, disabled from users where id=$1", [id]
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
    disabled: !!u.disabled,
    credits: { total, today, dailyQuota: u.daily_quota == null ? DAILY_FREE : u.daily_quota },
  };
}

/* What this account is actually entitled to, in one place so the extension,
 * the dashboard and the Control Room can never disagree. Precedence:
 *   1. users.daily_quota — an explicit per-account decision by an admin
 *   2. the plan behind an ACTIVE subscription
 *   3. the free plan
 * A quota below zero means unlimited. */
async function entitlement(uid) {
  const u = (await db.query("select daily_quota from users where id=$1", [uid])).rows[0];
  const sub = (await db.query("select status, plan from subscriptions where user_id=$1", [uid])).rows[0];
  const planId = (sub && sub.status === "active" && sub.plan) ? sub.plan : "free";
  const plan = (await db.query("select id, name, daily_quota from plans where id=$1", [planId])).rows[0]
    || (await db.query("select id, name, daily_quota from plans where id='free'")).rows[0]
    || { id: "free", name: "Free", daily_quota: DAILY_FREE };

  const override = u && u.daily_quota != null ? u.daily_quota : null;
  const quota = override != null ? override : plan.daily_quota;
  return {
    planId: plan.id, planName: plan.name,
    quota,
    unlimited: quota < 0,
    source: override != null ? "user_override" : (sub && sub.status === "active" ? "subscription" : "free_plan"),
    subscriptionStatus: (sub && sub.status) || "none",
  };
}

async function balanceOf(uid) {
  const r = (await db.query("select credit_balance from users where id=$1", [uid])).rows[0];
  return r ? Number(r.credit_balance) : 0;
}

/* The single way credits ever move. The ledger is the audit trail; the balance
 * column is the counter that gets enforced, and the two are written together.
 *
 * A grant just adds. A spend passes `requireBalance`, which puts the check
 * INSIDE the UPDATE's WHERE clause: two concurrent spends cannot both pass it,
 * because the second one re-evaluates against the row the first already wrote.
 * Doing this as "read the sum, decide, then insert" is what lets someone spend
 * their last credit twice by double-clicking. */
async function moveCredits(uid, delta, reason, { requireBalance = false } = {}) {
  const sql = requireBalance
    ? "update users set credit_balance = credit_balance + $2 where id=$1 and credit_balance >= $3 returning credit_balance"
    : "update users set credit_balance = credit_balance + $2 where id=$1 returning credit_balance";
  const params = requireBalance ? [uid, delta, -delta] : [uid, delta];
  const r = await db.query(sql, params);
  if (!r.rows[0]) return null; // insufficient, or no such user
  await db.query("insert into credit_ledger(user_id, delta, reason) values ($1,$2,$3)", [uid, delta, reason]);
  return Number(r.rows[0].credit_balance);
}

/* Tops the balance UP TO the day's quota rather than adding to it. Adding meant
 * an account that sat idle for a fortnight came back with a fortnight's worth
 * of credits — the reason live accounts are sitting on 180. Topping up keeps
 * "N per day" honest, while an admin bonus that already puts someone above
 * their quota is left alone rather than being cancelled out. */
async function grantDailyIfNeeded(uid) {
  const already = (await db.query(
    "select 1 from credit_ledger where user_id=$1 and reason='daily_free' and created_at >= $2 limit 1",
    [uid, utcMidnight()]
  )).rows[0];
  if (already) return;
  const ent = await entitlement(uid);
  if (ent.unlimited) return; // nothing to meter
  const topUp = ent.quota - (await balanceOf(uid));
  if (topUp <= 0) return;
  await moveCredits(uid, topUp, "daily_free");
}

// The shape the extension's worker and sidepanel already expect.
async function creditStatus(uid) {
  const ent = await entitlement(uid);
  const balance = await balanceOf(uid);
  const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
  return {
    kind: ent.unlimited ? "paid" : (ent.subscriptionStatus === "active" ? "paid" : "free"),
    plan: ent.planId, planName: ent.planName,
    remaining: ent.unlimited ? 999999 : Math.max(0, balance),
    limit: ent.unlimited ? 0 : ent.quota, // the client reads limit 0 as unlimited
    unlimited: ent.unlimited,
    emailVerified: true, isEmailVerified: true,
    resetAt: reset.toISOString(),
    unavailable: false,
  };
}

/* A disabled account must be turned away at every door, not just the one the
 * ticket mentioned — password login, the extension's own login, and the Google
 * callback all funnel through here. */
const DISABLED_BODY = { error: "account_disabled", message: "This account has been disabled." };

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
  } catch (e) { console.error("[auth]", e && e.message); res.status(500).json({ error: "server_error" }); }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const u = (await db.query("select id, password_hash, auth_provider, disabled from users where email=$1", [email])).rows[0];
    if (!u || !u.password_hash) return res.status(401).json({ error: "invalid_credentials" });
    if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: "invalid_credentials" });
    if (u.disabled) return res.status(403).json(DISABLED_BODY);
    await grantDailyIfNeeded(u.id);
    setAuthCookie(res, u.id);
    res.json({ ok: true, user: await userPublic(u.id) });
  } catch (e) { console.error("[auth]", e && e.message); res.status(500).json({ error: "server_error" }); }
});

app.post("/api/auth/logout", (req, res) => { clearAuthCookie(res); res.json({ ok: true }); });

app.get("/api/me", auth, async (req, res) => {
  const u = await userPublic(req.userId);
  if (!u) { clearAuthCookie(res); return res.status(401).json({ error: "not_authenticated" }); }
  res.json(u);
});

app.get("/api/credits", auth, async (req, res) => {
  const total = await balanceOf(req.userId);
  const today = Number((await db.query("select coalesce(sum(delta),0) s from credit_ledger where user_id=$1 and created_at >= $2", [req.userId, utcMidnight()])).rows[0].s);
  const ent = await entitlement(req.userId);
  res.json({ total, today, dailyQuota: ent.quota, plan: ent.planId, unlimited: ent.unlimited });
});

/* ---------- credits the extension actually spends ----------
 * extCors + Bearer: these are called by the extension's background worker,
 * which is cross-origin and cannot send the session cookie.
 *
 * The response is wrapped as {success, data:{…}} because that is the shape the
 * already-built sidepanel destructures; changing it would mean editing minified
 * bundle code for no gain. */
app.get("/api/credits/status", extCors, auth, async (req, res) => {
  await grantDailyIfNeeded(req.userId);
  res.json({ success: true, data: await creditStatus(req.userId) });
});

app.post("/api/credits/consume", extCors, auth, async (req, res) => {
  const amount = Math.max(1, Math.min(parseInt(req.body && req.body.amount, 10) || 1, 100));
  const ent = await entitlement(req.userId);
  if (ent.unlimited) {
    // Recorded at zero cost so usage reporting stays truthful for unlimited
    // plans without the balance drifting.
    await db.query("insert into credit_ledger(user_id, delta, reason) values ($1,0,'usage_unlimited')", [req.userId]);
    return res.json({ success: true, data: Object.assign({ ok: true }, await creditStatus(req.userId)) });
  }

  await grantDailyIfNeeded(req.userId);

  const reason = String((req.body && req.body.note) || "usage").slice(0, 60);
  const left = await moveCredits(req.userId, -amount, reason, { requireBalance: true });
  if (left === null) {
    return res.status(402).json({
      success: false,
      data: Object.assign({ ok: false, reason: "insufficient_credits" }, await creditStatus(req.userId)),
    });
  }
  res.json({ success: true, data: Object.assign({ ok: true }, await creditStatus(req.userId)) });
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
    const u = (await db.query("select id, password_hash, auth_provider, disabled from users where email=$1", [email])).rows[0];
    if (!u || !u.password_hash) return res.status(401).json({ message: "invalid_credentials" });
    if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ message: "invalid_credentials" });
    if (u.disabled) return res.status(403).json(DISABLED_BODY);
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
      "select id, password_hash, is_admin, disabled, totp_enabled, totp_secret from users where email=$1", [email]
    )).rows[0];

    // Same reply for "no such user", "wrong password" and "not an admin", so
    // this endpoint can't be used to discover which accounts are admins.
    const ok = u && u.password_hash && await bcrypt.compare(password, u.password_hash);
    if (!ok || !u.is_admin) return res.status(401).json({ error: "invalid_credentials" });
    if (u.disabled) return res.status(403).json(DISABLED_BODY);

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

/* ---------- Control Room: the people using the extension ----------
 * The panel could previously only see this browser's own extension storage, so
 * registered users — everyone who signed up through Google included — were
 * invisible to it. These read the real users table. */

// Assembled in one statement rather than a query per user: with a row per
// account that would be a textbook N+1, and the credit figures are aggregates
// over the whole ledger anyway. The ledger is folded down in derived tables
// rather than correlated per-row subqueries — one pass over credit_ledger
// instead of four per user.
const USER_SELECT = `
  select u.id, u.email, u.username, u.avatar_url, u.auth_provider, u.google_id,
         u.is_admin, u.disabled, u.daily_quota, u.created_at,
         sp.daily_quota plan_quota, sp.name plan_name, fp.daily_quota free_quota,
         coalesce(s.status,'none') sub_status, s.plan sub_plan, s.provider sub_provider,
         s.current_period_end, s.provider_subscription_id,
         u.credit_balance::int balance,
         coalesce(cl.used_total,0)::int used_total,
         coalesce(td.used_today,0)::int used_today,
         coalesce(td.granted_today,0)::int granted_today
  from users u
  left join subscriptions s on s.user_id = u.id
  -- Resolve the SAME entitlement the server enforces. Reading only
  -- users.daily_quota here meant the panel showed a Pro subscriber "15/day"
  -- while the extension let them have 500 — the panel and the enforcement
  -- disagreeing is worse than either being wrong on its own.
  left join plans sp on sp.id = s.plan and s.status = 'active'
  left join plans fp on fp.id = 'free'
  left join (
    select user_id,
           sum(case when delta < 0 then -delta else 0 end) used_total
    from credit_ledger group by user_id
  ) cl on cl.user_id = u.id
  left join (
    select user_id,
           sum(case when delta < 0 then -delta else 0 end) used_today,
           sum(case when delta > 0 then delta else 0 end) granted_today
    from credit_ledger where created_at >= $1 group by user_id
  ) td on td.user_id = u.id`;

// Mirrors entitlement()'s precedence: an admin's per-account decision, then
// the plan behind an active subscription, then free.
function effectiveQuota(r) {
  if (r.daily_quota != null) return r.daily_quota;
  if (r.plan_quota != null) return r.plan_quota;
  if (r.free_quota != null) return r.free_quota;
  return DAILY_FREE;
}

function shapeUser(r) {
  return {
    userId: r.id, email: r.email, username: r.username || r.email.split("@")[0],
    avatarUrl: r.avatar_url,
    authProvider: r.google_id ? "google" : r.auth_provider,
    isAdmin: r.is_admin, disabled: r.disabled, createdAt: r.created_at,
    credits: {
      balance: r.balance, usedToday: r.used_today, usedTotal: r.used_total,
      grantedToday: r.granted_today,
      dailyQuota: effectiveQuota(r),
      unlimited: effectiveQuota(r) < 0,
      quotaIsOverride: r.daily_quota != null,
      quotaSource: r.daily_quota != null ? "user_override"
        : (r.plan_quota != null ? "plan" : "free_plan"),
    },
    subscription: {
      status: r.sub_status, plan: r.sub_plan, provider: r.sub_provider,
      currentPeriodEnd: r.current_period_end, providerSubscriptionId: r.provider_subscription_id,
    },
  };
}

app.get("/api/admin/users", adminAuth, async (req, res) => {
  // Cap the page size: an unbounded limit from the query string is a cheap way
  // to make the server assemble the entire table on demand.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const q = String(req.query.q || "").trim().toLowerCase();
  const params = [utcMidnight()];
  let where = "";
  if (q) {
    // Parameterised, and the wildcards are added here rather than taken from
    // the caller, so a value like "%" can't become a match-everything scan.
    params.push("%" + q + "%");
    where = ` where lower(u.email) like $${params.length} or lower(coalesce(u.username,'')) like $${params.length}`;
  }
  params.push(limit, offset);
  const rows = (await db.query(
    `${USER_SELECT}${where} order by u.created_at desc limit $${params.length - 1} offset $${params.length}`, params
  )).rows;
  const total = (await db.query(
    `select count(*)::int c from users u${q ? " where lower(u.email) like $1 or lower(coalesce(u.username,'')) like $1" : ""}`,
    q ? ["%" + q + "%"] : []
  )).rows[0].c;
  res.json({ users: rows.map(shapeUser), total, limit, offset });
});

app.get("/api/admin/users/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "bad_id" });
  const r = (await db.query(`${USER_SELECT} where u.id = $2`, [utcMidnight(), id])).rows[0];
  if (!r) return res.status(404).json({ error: "not_found" });
  const ledger = (await db.query(
    "select delta, reason, created_at from credit_ledger where user_id=$1 order by created_at desc limit 25", [id]
  )).rows;
  res.json(Object.assign(shapeUser(r), { ledger }));
});

app.patch("/api/admin/users/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "bad_id" });
  const b = req.body || {};

  // Locking yourself out of the only admin account can't be undone from the
  // panel, so the two settings that could do it are refused on your own row.
  if (id === req.userId && (b.disabled === true || b.isAdmin === false)) {
    return res.status(400).json({ error: "cannot_lock_self_out" });
  }
  if (typeof b.disabled === "boolean") await db.query("update users set disabled=$1 where id=$2", [b.disabled, id]);
  if (typeof b.isAdmin === "boolean") await db.query("update users set is_admin=$1 where id=$2", [b.isAdmin, id]);
  if ("dailyQuota" in b) {
    const q = b.dailyQuota === null ? null : parseInt(b.dailyQuota, 10);
    if (q !== null && (!Number.isInteger(q) || q < 0 || q > 100000)) return res.status(400).json({ error: "bad_quota" });
    await db.query("update users set daily_quota=$1 where id=$2", [q, id]);
  }
  if (b.subscription) {
    const status = String(b.subscription.status || "none");
    if (["none", "active", "cancelled", "past_due"].indexOf(status) === -1) return res.status(400).json({ error: "bad_status" });
    const plan = b.subscription.plan ? String(b.subscription.plan).slice(0, 40) : null;
    await db.query(
      `insert into subscriptions (user_id, status, plan, provider, updated_at) values ($1,$2,$3,'manual',now())
       on conflict (user_id) do update set status=$2, plan=$3, provider='manual', updated_at=now()`,
      [id, status, plan]
    );
  }
  const r = (await db.query(`${USER_SELECT} where u.id = $2`, [utcMidnight(), id])).rows[0];
  if (!r) return res.status(404).json({ error: "not_found" });
  res.json(shapeUser(r));
});

// Credits move only by appending to the ledger — never by overwriting a balance
// — so every adjustment stays attributable after the fact.
app.post("/api/admin/users/:id/credits", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const delta = parseInt(req.body && req.body.delta, 10);
  if (!Number.isInteger(id) || !Number.isInteger(delta) || delta === 0) return res.status(400).json({ error: "bad_request" });
  if (Math.abs(delta) > 1000000) return res.status(400).json({ error: "delta_too_large" });
  if (!(await db.query("select 1 from users where id=$1", [id])).rows[0]) return res.status(404).json({ error: "not_found" });
  const reason = String((req.body && req.body.reason) || "admin_adjust").slice(0, 60);
  await moveCredits(id, delta, reason);
  const r = (await db.query(`${USER_SELECT} where u.id = $2`, [utcMidnight(), id])).rows[0];
  res.json(shapeUser(r));
});

/* ---------- Control Room: plans ----------
 * What each tier actually grants. Before this, "pro" was a bare string on a
 * subscription with nothing behind it — setting it changed a label and nothing
 * a user could do. */
app.get("/api/admin/plans", adminAuth, async (req, res) => {
  const plans = (await db.query("select * from plans order by sort_order, id")).rows;
  // How many people are on each, so a plan is never edited or retired blind.
  const counts = (await db.query(
    "select plan, count(*)::int c from subscriptions where status='active' and plan is not null group by plan"
  )).rows.reduce((m, r) => { m[r.plan] = r.c; return m; }, {});
  res.json({
    plans: plans.map((p) => ({
      id: p.id, name: p.name, dailyQuota: p.daily_quota, unlimited: p.daily_quota < 0,
      priceInr: p.price_inr, razorpayPlanId: p.razorpay_plan_id,
      active: p.active, sortOrder: p.sort_order,
      activeSubscribers: counts[p.id] || 0,
    })),
  });
});

function readPlanBody(b) {
  const quota = parseInt(b.dailyQuota, 10);
  if (!Number.isInteger(quota) || quota < -1 || quota > 1000000) return { error: "bad_quota" };
  const price = parseInt(b.priceInr, 10);
  if (!Number.isInteger(price) || price < 0 || price > 10000000) return { error: "bad_price" };
  const name = String(b.name || "").trim().slice(0, 60);
  if (!name) return { error: "bad_name" };
  return {
    name, quota, price,
    razorpayPlanId: b.razorpayPlanId ? String(b.razorpayPlanId).trim().slice(0, 80) : null,
    active: b.active !== false,
    sortOrder: Number.isInteger(parseInt(b.sortOrder, 10)) ? parseInt(b.sortOrder, 10) : 0,
  };
}

app.post("/api/admin/plans", adminAuth, async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(id)) return res.status(400).json({ error: "bad_id" });
  const v = readPlanBody(b);
  if (v.error) return res.status(400).json({ error: v.error });
  if ((await db.query("select 1 from plans where id=$1", [id])).rows[0]) return res.status(409).json({ error: "already_exists" });
  await db.query(
    "insert into plans (id, name, daily_quota, price_inr, razorpay_plan_id, active, sort_order) values ($1,$2,$3,$4,$5,$6,$7)",
    [id, v.name, v.quota, v.price, v.razorpayPlanId, v.active, v.sortOrder]
  );
  res.json({ ok: true });
});

app.patch("/api/admin/plans/:id", adminAuth, async (req, res) => {
  const id = String(req.params.id);
  const v = readPlanBody(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const r = await db.query(
    "update plans set name=$2, daily_quota=$3, price_inr=$4, razorpay_plan_id=$5, active=$6, sort_order=$7 where id=$1",
    [id, v.name, v.quota, v.price, v.razorpayPlanId, v.active, v.sortOrder]
  );
  if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

app.delete("/api/admin/plans/:id", adminAuth, async (req, res) => {
  const id = String(req.params.id);
  // `free` is the fallback every unsubscribed account resolves to; deleting it
  // would silently drop everyone to the hardcoded default.
  if (id === "free") return res.status(400).json({ error: "cannot_delete_free" });
  const inUse = (await db.query("select count(*)::int c from subscriptions where plan=$1 and status='active'", [id])).rows[0].c;
  if (inUse > 0) return res.status(409).json({ error: "plan_in_use", message: inUse + " active subscriber(s) are on this plan. Move them first, or just deactivate it." });
  const r = await db.query("delete from plans where id=$1", [id]);
  if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

app.get("/api/admin/stats", adminAuth, async (req, res) => {
  const midnight = utcMidnight();
  const week = new Date(Date.now() - 7 * 864e5).toISOString();
  const one = async (sql, params) => (await db.query(sql, params)).rows[0].c;
  res.json({
    users: {
      total: await one("select count(*)::int c from users"),
      newToday: await one("select count(*)::int c from users where created_at >= $1", [midnight]),
      newThisWeek: await one("select count(*)::int c from users where created_at >= $1", [week]),
      google: await one("select count(*)::int c from users where google_id is not null"),
      disabled: await one("select count(*)::int c from users where disabled"),
    },
    subscriptions: {
      active: await one("select count(*)::int c from subscriptions where status='active'"),
      cancelled: await one("select count(*)::int c from subscriptions where status='cancelled'"),
      pastDue: await one("select count(*)::int c from subscriptions where status='past_due'"),
    },
    credits: {
      usedToday: await one("select coalesce(-sum(delta),0)::int c from credit_ledger where delta<0 and created_at >= $1", [midnight]),
      usedThisWeek: await one("select coalesce(-sum(delta),0)::int c from credit_ledger where delta<0 and created_at >= $1", [week]),
      outstanding: await one("select coalesce(sum(delta),0)::int c from credit_ledger"),
    },
    defaults: { dailyFree: DAILY_FREE },
  });
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
  const existing = (await db.query("select id, google_id, disabled from users where email=$1", [email])).rows[0];
  let uid;
  if (existing) {
    // Signing in with Google must not be a way around a disabled account.
    if (existing.disabled) { const e = new Error("account_disabled"); e.disabled = true; throw e; }
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
  } catch (e) {
    if (e && e.disabled) return res.status(403).send("This account has been disabled.");
    // Deliberately not echoing e.message: reflecting an error string into an
    // HTML response is how a stray bit of attacker-influenced text becomes XSS.
    console.error("[oauth] callback failed:", e && e.message);
    res.status(500).send("Sign-in failed. Please try again.");
  }
});

/* ---------- Razorpay webhook ----------
 * The only way a subscription becomes active without an admin doing it by hand.
 * Razorpay signs each delivery with the webhook secret; an unsigned or
 * mis-signed request is discarded before anything is read out of its body,
 * because this endpoint is public and its body would otherwise amount to an
 * attacker-supplied instruction to grant a paid plan.
 *
 * NOT yet exercised against live Razorpay — the account's keys aren't set up,
 * so the signature and mapping paths are covered by tests only. Send a test
 * event from the Razorpay dashboard before trusting this with real money. */
function razorpaySignatureValid(req) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !req.rawBody) return false;
  const sent = Buffer.from(String(req.get("x-razorpay-signature") || ""));
  const exp = Buffer.from(crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex"));
  // Length is compared first because timingSafeEqual throws, rather than
  // returning false, when the two buffers differ in size.
  return exp.length === sent.length && crypto.timingSafeEqual(exp, sent);
}

// Maps a Razorpay subscription state onto the three this app acts on. Anything
// unlisted is acknowledged but changes nothing — guessing at an unknown state
// is how a lapsed subscription silently keeps its paid features.
const RZP_STATUS = {
  "subscription.activated": "active", "subscription.charged": "active",
  "subscription.resumed": "active", "subscription.authenticated": "active",
  "subscription.halted": "past_due", "subscription.pending": "past_due",
  "subscription.cancelled": "cancelled", "subscription.completed": "cancelled",
  "subscription.paused": "cancelled",
};

app.post("/api/webhooks/razorpay", async (req, res) => {
  if (!razorpaySignatureValid(req)) return res.status(401).json({ error: "bad_signature" });
  const body = req.body || {};
  const event = String(body.event || "");

  // Razorpay retries deliveries, so the same "charged" event can arrive more
  // than once; recording the id makes a replay a no-op rather than a re-grant.
  const eventId = String(req.get("x-razorpay-event-id") || "");
  if (eventId) {
    if ((await db.query("select 1 from webhook_events where id=$1", [eventId])).rows[0]) {
      return res.json({ ok: true, duplicate: true });
    }
    await db.query("insert into webhook_events(id, provider, event) values ($1,'razorpay',$2)", [eventId, event]);
  }

  const status = RZP_STATUS[event];
  if (!status) return res.json({ ok: true, ignored: event });

  const sub = ((body.payload || {}).subscription || {}).entity || {};
  const notes = sub.notes || {};
  // The account is identified by what we put in `notes` when the subscription
  // is created; email is the fallback for one created by hand in the dashboard.
  let uid = parseInt(notes.user_id, 10);
  if (!Number.isInteger(uid) && notes.email) {
    const r = (await db.query("select id from users where email=$1", [String(notes.email).toLowerCase()])).rows[0];
    uid = r && r.id;
  }
  if (!Number.isInteger(uid)) {
    console.warn("[razorpay] no matching user for", event, "subscription", sub.id);
    return res.json({ ok: true, unmatched: true });
  }

  const periodEnd = sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null;
  await db.query(
    `insert into subscriptions (user_id, provider_subscription_id, status, plan, provider, current_period_end, updated_at)
     values ($1,$2,$3,$4,'razorpay',$5,now())
     on conflict (user_id) do update set provider_subscription_id=$2, status=$3, plan=$4,
       provider='razorpay', current_period_end=$5, updated_at=now()`,
    [uid, sub.id || null, status, notes.plan || sub.plan_id || null, periodEnd]
  );
  res.json({ ok: true });
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
/* The extension's sidepanel links out to these paths. They used to point at
 * erasio.io — a third party — so every one of them sent our own users to
 * someone else's site. They point here now, and these redirects make sure that
 * lands somewhere real instead of a 404. Replace with actual pages as they
 * get written. */
const LINK_REDIRECTS = {
  "/register": "/", "/signup": "/", "/forgot-password": "/",
  "/subscribe": "/dashboard", "/dashboard/settings": "/dashboard",
  "/tool": "/dashboard", "/guide": "/dashboard", "/contact": "/dashboard",
  "/privacy": "/dashboard",
  "/image-watermark-removal-settings-guide": "/dashboard",
  "/video-watermark-removal-settings-guide": "/dashboard",
};
Object.keys(LINK_REDIRECTS).forEach((from) => {
  app.get(from, (req, res) => res.redirect(302, LINK_REDIRECTS[from]));
});

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
