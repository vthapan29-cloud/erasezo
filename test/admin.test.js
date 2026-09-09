/* Control Room auth: the admin gate, the 2FA flow, and the specific ways each
 * could be walked around. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";

const assert = require("assert");
const srv = require("../server");
const totp = require("../totp");
const db = srv.db;

let base, server;
// Two independent cookie jars: the admin session and an ordinary user session
// must not be able to stand in for each other.
const jars = { admin: "", user: "" };
async function req(jar, path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {},
    jars[jar] ? { Cookie: jars[jar] } : {});
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  const r = await fetch(base + path, opts);
  const sc = r.headers.get("set-cookie");
  if (sc) {
    for (const part of sc.split(/,(?=\s*erasezo)/)) {
      const kv = part.trim().split(";")[0];
      const existing = jars[jar] ? jars[jar].split("; ").filter((c) => c.split("=")[0] !== kv.split("=")[0]) : [];
      jars[jar] = existing.concat(kv).join("; ");
    }
  }
  return r;
}
const code = (secret) => totp.codeAt(secret, Math.floor(Date.now() / 1000 / 30));

(async () => {
  await db.init();
  server = require("http").createServer(srv.app).listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const ADMIN = { email: "owner@erasezo.com", password: "OwnerPass123!x" };
  const USER = { email: "normal@erasezo.com", password: "NormalPass123!" };

  // Seed the owner exactly the way production does — through the env bootstrap.
  process.env.ADMIN_EMAIL = ADMIN.email;
  process.env.ADMIN_PASSWORD = ADMIN.password;
  await srv.ensureAdminFromEnv();
  const seeded = (await db.query("select is_admin from users where email=$1", [ADMIN.email])).rows[0];
  assert.ok(seeded && seeded.is_admin, "env bootstrap creates the owner as an admin");
  await srv.ensureAdminFromEnv(); // must be idempotent — it runs on every boot
  const dupes = (await db.query("select count(*)::int c from users where email=$1", [ADMIN.email])).rows[0];
  assert.strictEqual(dupes.c, 1, "re-running the bootstrap does not duplicate the account");
  console.log("ok - env bootstrap creates the owner account, idempotently");

  // 1) Nothing without a session.
  assert.strictEqual((await req("admin", "/api/admin/me")).status, 401, "no session → 401");
  console.log("ok - /api/admin/me refuses an anonymous caller");

  // 2) A non-admin gets the SAME answer as a bad password, so this endpoint
  //    can't be used to find out which accounts are admins.
  await req("user", "/api/auth/register", { method: "POST", body: USER });
  const rNonAdmin = await req("user", "/api/admin/login", { method: "POST", body: USER });
  const rBadPw = await req("user", "/api/admin/login", { method: "POST", body: { email: ADMIN.email, password: "wrong-password" } });
  assert.strictEqual(rNonAdmin.status, 401, "non-admin rejected");
  assert.deepStrictEqual(await rNonAdmin.json(), await rBadPw.json(), "non-admin and wrong-password are indistinguishable");
  console.log("ok - admin login leaks no way to enumerate which accounts are admins");

  // 3) THE BYPASS THAT MATTERS: signing in on the ordinary site sets the normal
  //    session cookie. That must not open the panel — otherwise an admin who
  //    logged in through the front door would skip 2FA entirely.
  await req("user", "/api/auth/login", { method: "POST", body: ADMIN });
  assert.ok(jars.user.includes("erasezo_token"), "ordinary login did set the normal session cookie");
  assert.strictEqual((await req("user", "/api/admin/me")).status, 401, "ordinary session cannot open the panel");
  console.log("ok - an ordinary site session never grants Control Room access");

  // 4) The real admin login.
  assert.strictEqual((await req("admin", "/api/admin/login", { method: "POST", body: ADMIN })).status, 200, "admin login succeeds");
  const me = await (await req("admin", "/api/admin/me")).json();
  assert.strictEqual(me.email, ADMIN.email);
  assert.strictEqual(me.isAdmin, true);
  assert.strictEqual(me.totpEnabled, false, "2FA starts off");
  console.log("ok - admin signs in and /api/admin/me reports the account");

  // 5) Settings round-trip, scoped to the admin session.
  await req("admin", "/api/admin/settings", { method: "PUT", body: { image: { nccAccept: 0.42 } } });
  const got = await (await req("admin", "/api/admin/settings")).json();
  assert.strictEqual(got.image.nccAccept, 0.42, "settings persist");
  assert.strictEqual((await req("user", "/api/admin/settings")).status, 401, "settings are not readable without the admin session");
  console.log("ok - settings save and load, and stay behind the admin gate");

  // 6) 2FA enrolment only takes effect once a real code proves the app is set
  //    up — a mistyped setup must not lock the owner out.
  const setup = await (await req("admin", "/api/admin/2fa/setup", { method: "POST" })).json();
  assert.ok(setup.secret && setup.otpauthUrl.startsWith("otpauth://totp/"), "setup returns a secret and an otpauth URL");
  assert.strictEqual((await (await req("admin", "/api/admin/me")).json()).totpEnabled, false, "still off before a code is confirmed");
  assert.strictEqual((await req("admin", "/api/admin/2fa/enable", { method: "POST", body: { code: "000000" } })).status, 400, "a wrong code does not enable it");
  assert.strictEqual((await req("admin", "/api/admin/2fa/enable", { method: "POST", body: { code: code(setup.secret) } })).status, 200, "a real code enables it");
  assert.strictEqual((await (await req("admin", "/api/admin/me")).json()).totpEnabled, true, "2FA now on");
  console.log("ok - 2FA enables only after a genuine code, never on a mistyped setup");

  // 7) With 2FA on, the password alone stops being enough.
  jars.admin = "";
  const noCode = await req("admin", "/api/admin/login", { method: "POST", body: ADMIN });
  assert.strictEqual(noCode.status, 401);
  assert.strictEqual((await noCode.json()).error, "totp_required", "password alone is refused, and says why");
  assert.strictEqual((await req("admin", "/api/admin/me")).status, 401, "no session was issued on that attempt");
  const wrongCode = await req("admin", "/api/admin/login", { method: "POST", body: Object.assign({ code: "000000" }, ADMIN) });
  assert.strictEqual((await wrongCode.json()).error, "totp_invalid", "a wrong code is refused");
  assert.strictEqual((await req("admin", "/api/admin/login", { method: "POST", body: Object.assign({ code: code(setup.secret) }, ADMIN) })).status, 200, "password + code gets in");
  console.log("ok - once 2FA is on, a leaked password alone cannot sign in");

  // 8) Turning 2FA off needs both factors — a borrowed open session must not be
  //    enough to strip the second factor off the account.
  assert.strictEqual((await req("admin", "/api/admin/2fa/disable", { method: "POST", body: { password: ADMIN.password } })).status, 401, "session + password alone cannot disable 2FA");
  assert.strictEqual((await req("admin", "/api/admin/2fa/disable", { method: "POST", body: { password: "wrong", code: code(setup.secret) } })).status, 401, "wrong password cannot disable 2FA");
  console.log("ok - disabling 2FA demands both factors");

  // 9) Revoking admin in the database takes effect on the very next request,
  //    not whenever the issued token happens to expire.
  await db.query("update users set is_admin=false where email=$1", [ADMIN.email]);
  assert.strictEqual((await req("admin", "/api/admin/me")).status, 403, "revoked admin loses access immediately");
  await db.query("update users set is_admin=true where email=$1", [ADMIN.email]);
  assert.strictEqual((await req("admin", "/api/admin/me")).status, 200, "and regains it when restored");
  console.log("ok - admin rights are re-checked per request, not cached in the token");

  server.close();
  console.log("\nALL ADMIN TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
