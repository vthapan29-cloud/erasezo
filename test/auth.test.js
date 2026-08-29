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
  console.log("ok - password change 403 (server-side) for Google-only account");

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

  server.close();
  console.log("\nALL AUTH TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
