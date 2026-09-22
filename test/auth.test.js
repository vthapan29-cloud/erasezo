/* Integration tests against an in-memory Postgres (pg-mem). Verifies the real
 * auth + credits + merge logic — no mocks of our own code. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";
process.env.DAILY_FREE = "15";

const assert = require("assert");
const jwt = require("jsonwebtoken");
const srv = require("../server");
const db = srv.db;

let base, server, cookie = "";
async function req(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {}, cookie ? { Cookie: cookie } : {});
  const r = await fetch(base + path, opts);
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return r;
}

(async () => {
  await db.init();
  server = require("http").createServer(srv.app).listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  // 1) register → 200 + session; /api/me shows the daily free grant
  let r = await req("/api/auth/register", { method: "POST", body: JSON.stringify({ email: "a@x.com", password: "password123", username: "alpha" }) });
  assert.strictEqual(r.status, 200, "register 200");
  let me = await (await req("/api/me")).json();
  assert.strictEqual(me.email, "a@x.com", "me email");
  assert.strictEqual(me.hasPassword, true, "a password account reports that email sign-in is available");
  assert.ok(!("password_hash" in me), "the password hash is not part of the profile");
  assert.strictEqual(me.credits.today, 15, "daily free quota granted on register");
  assert.strictEqual(me.plan, "free", "default plan free");
  console.log("ok - register + session + daily free credits");

  // 2) wrong password → 401
  const saved = cookie; cookie = "";
  r = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "a@x.com", password: "WRONG" }) });
  assert.strictEqual(r.status, 401, "wrong password 401");
  cookie = saved;
  console.log("ok - wrong password rejected");

  // 3) profile PATCH updates username; email is immutable server-side
  r = await req("/api/user/profile", { method: "PATCH", body: JSON.stringify({ username: "alpha2", email: "hacker@x.com" }) });
  me = await r.json();
  assert.strictEqual(me.username, "alpha2", "username updated");
  assert.strictEqual(me.email, "a@x.com", "email NOT changed via body (immutable)");
  console.log("ok - profile username persists; email immutable");

  // 4) password change on a password account → 200
  r = await req("/api/user/password", { method: "PATCH", body: JSON.stringify({ currentPassword: "password123", newPassword: "newpassword123" }) });
  assert.strictEqual(r.status, 200, "password change 200 for password account");
  console.log("ok - password change allowed + hashed for password account");

  // 5) password change on a Google-only account → 403 (server-side, not just UI)
  await db.query("insert into users(email, auth_provider, google_id) values ($1,'google',$2)", ["g@x.com", "gid-1"]);
  const gid = (await db.query("select id from users where email=$1", ["g@x.com"])).rows[0].id;
  const gcookie = "erasezo_token=" + jwt.sign({ uid: gid }, "test-secret");
  r = await fetch(base + "/api/user/password", { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: gcookie }, body: JSON.stringify({ currentPassword: "x", newPassword: "newpassword123" }) });
  assert.strictEqual(r.status, 403, "google-only password change 403");
  const blocked = await r.json();
  assert.strictEqual(blocked.error, "oauth_only", "missing password is refused as oauth_only");
  console.log("ok - password change 403 (server-side) for Google-only account");

  // 5b) A Google account can add a password once. Email login already accepts
  //     any row with a hash, and Google sign-in keeps using google_id.
  const gMeBefore = await (await fetch(base + "/api/me", { headers: { Cookie: gcookie } })).json();
  assert.strictEqual(gMeBefore.hasPassword, false, "google-only account has no password yet");
  assert.strictEqual(gMeBefore.authProvider, "google");
  assert.ok(!("password_hash" in gMeBefore), "hash stays off the profile for a google account too");

  const weak = await fetch(base + "/api/user/password", {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: gcookie },
    body: JSON.stringify({ newPassword: "short" }),
  });
  assert.strictEqual(weak.status, 400, "a short password is refused");
  assert.strictEqual((await weak.json()).error, "weak_password");

  const anon = await fetch(base + "/api/user/password", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newPassword: "brand-new-password" }),
  });
  assert.strictEqual(anon.status, 401, "setting a password requires a session");

  const added = await fetch(base + "/api/user/password", {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: gcookie },
    body: JSON.stringify({ newPassword: "google-pass-123" }),
  });
  assert.strictEqual(added.status, 200, "google account can set a password once");
  const gRow = (await db.query("select auth_provider, google_id, password_hash from users where email=$1", ["g@x.com"])).rows[0];
  assert.strictEqual(gRow.auth_provider, "google", "adding a password does not relabel the account");
  assert.strictEqual(gRow.google_id, "gid-1", "google link is untouched");
  assert.ok(gRow.password_hash && gRow.password_hash !== "google-pass-123", "the new password is stored hashed");

  const gMeAfter = await (await fetch(base + "/api/me", { headers: { Cookie: gcookie } })).json();
  assert.strictEqual(gMeAfter.hasPassword, true, "profile now reports a password");

  const gLogin = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "g@x.com", password: "google-pass-123" }),
  });
  assert.strictEqual(gLogin.status, 200, "email login accepts the password added to a google account");
  const gExt = await fetch(base + "/api/ext/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "g@x.com", password: "google-pass-123" }),
  });
  assert.strictEqual(gExt.status, 200, "the extension login accepts it too");

  const again = await fetch(base + "/api/user/password", {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: gcookie },
    body: JSON.stringify({ newPassword: "another-password" }),
  });
  assert.strictEqual(again.status, 409, "a second set does not overwrite the password");
  assert.strictEqual((await again.json()).error, "password_exists");

  const wrongCur = await fetch(base + "/api/user/password", {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: gcookie },
    body: JSON.stringify({ currentPassword: "nope", newPassword: "changed-pass-123" }),
  });
  assert.strictEqual(wrongCur.status, 400, "changing still requires the current password");
  assert.strictEqual((await wrongCur.json()).error, "wrong_current_password");

  const changed = await fetch(base + "/api/user/password", {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: gcookie },
    body: JSON.stringify({ currentPassword: "google-pass-123", newPassword: "changed-pass-123" }),
  });
  assert.strictEqual(changed.status, 200, "once a password exists, a google account can change it");
  assert.strictEqual((await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "g@x.com", password: "google-pass-123" }),
  })).status, 401, "the previous password no longer signs in");
  assert.strictEqual((await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "g@x.com", password: "changed-pass-123" }),
  })).status, 200, "the replacement password signs in");

  const pwSet = await req("/api/user/password", {
    method: "POST", body: JSON.stringify({ newPassword: "should-not-apply" }),
  });
  assert.strictEqual(pwSet.status, 409, "a password account cannot set over an existing password");

  // Two sets at once: the UPDATE ... WHERE password_hash IS NULL lets one win.
  await db.query("insert into users(email, auth_provider, google_id) values ($1,'google',$2)", ["g2@x.com", "gid-2"]);
  const g2 = (await db.query("select id from users where email=$1", ["g2@x.com"])).rows[0].id;
  const g2cookie = "erasezo_token=" + jwt.sign({ uid: g2 }, "test-secret");
  const raced = await Promise.all([0, 1].map(() => fetch(base + "/api/user/password", {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: g2cookie },
    body: JSON.stringify({ newPassword: "race-password-1" }),
  })));
  const raceStatuses = raced.map((x) => x.status).sort();
  assert.deepStrictEqual(raceStatuses, [200, 409], "only one of two simultaneous sets stores a password");
  console.log("ok - google account can add a password, then change it; a missing password cannot be changed");

  // 6) MERGE: google login for an email that already has a password account →
  //    links googleId to the SAME row, no duplicate user
  await db.query("insert into users(email, auth_provider, password_hash) values ($1,'password',$2)", ["merge@x.com", "hash"]);
  const before = Number((await db.query("select count(*)::int c from users")).rows[0].c);
  const mergedId = await srv.mergeOrCreateGoogleUser({ email: "merge@x.com", sub: "g-merge", email_verified: true, name: "Merged" });
  const after = Number((await db.query("select count(*)::int c from users")).rows[0].c);
  const row = (await db.query("select id, google_id from users where email=$1", ["merge@x.com"])).rows[0];
  assert.strictEqual(before, after, "no duplicate user created on google merge");
  assert.strictEqual(row.id, mergedId, "merged into existing row");
  assert.strictEqual(row.google_id, "g-merge", "googleId linked to existing account");
  console.log("ok - google login merges into existing email account (no duplicate)");

  // 7) daily reset is idempotent (running it again same day does NOT double-credit)
  const a = Number((await db.query("select coalesce(sum(delta),0)::int s from credit_ledger where user_id=(select id from users where email='a@x.com')")).rows[0].s);
  await srv.dailyResetAll();
  const b = Number((await db.query("select coalesce(sum(delta),0)::int s from credit_ledger where user_id=(select id from users where email='a@x.com')")).rows[0].s);
  assert.strictEqual(a, b, "daily reset idempotent within the same UTC day");
  console.log("ok - daily reset idempotent (no double credit)");

  // 8) Google OAuth carries a CSRF state. Without it, a stolen `code` posted
  //    at our callback would sign the attacker into the victim's browser.
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  const oauth = await fetch(base + "/api/auth/google", { redirect: "manual" });
  assert.strictEqual(oauth.status, 302, "google auth redirects");
  const loc = oauth.headers.get("location") || "";
  assert.ok(/[?&]state=/.test(loc), "authorization URL includes state");
  const setCookie = oauth.headers.get("set-cookie") || "";
  assert.ok(/erasezo_oauth_state=/.test(setCookie), "state is stored in an httpOnly cookie");
  const noState = await fetch(base + "/api/auth/google/callback?code=x", { redirect: "manual" });
  assert.strictEqual(noState.status, 400, "callback without the state cookie is refused");
  console.log("ok - Google OAuth rejects a callback that does not carry state");

  server.close();
  console.log("\nALL AUTH TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
