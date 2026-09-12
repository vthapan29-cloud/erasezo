/* Suspend, disable and delete are three different things in the UI, so they had
 * better be three different things on the server. Plus the per-user analytics
 * the drawer renders. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";

const assert = require("assert");
const jwt = require("jsonwebtoken");
const srv = require("../server");
const db = srv.db;

let base, server;
const jars = { admin: "" };
async function req(jar, path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {},
    jar && jars[jar] ? { Cookie: jars[jar] } : {});
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  const r = await fetch(base + path, opts);
  const sc = r.headers.get("set-cookie");
  if (jar && sc) {
    for (const part of sc.split(/,(?=\s*erasezo)/)) {
      const kv = part.trim().split(";")[0];
      const rest = jars[jar] ? jars[jar].split("; ").filter((c) => c.split("=")[0] !== kv.split("=")[0]) : [];
      jars[jar] = rest.concat(kv).join("; ");
    }
  }
  return r;
}
const asUser = (uid) => ({ Authorization: "Bearer " + jwt.sign({ uid }, "test-secret", { expiresIn: "1h" }) });

(async () => {
  await db.init();
  server = require("http").createServer(srv.app).listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const ADMIN = { email: "owner@erasezo.com", password: "OwnerPass123!x" };
  process.env.ADMIN_EMAIL = ADMIN.email; process.env.ADMIN_PASSWORD = ADMIN.password;
  await srv.ensureAdminFromEnv();
  await req("admin", "/api/admin/login", { method: "POST", body: ADMIN });

  await req(null, "/api/auth/register", { method: "POST", body: { email: "sam@u.com", password: "UserPass123!", username: "sam" } });
  const sam = (await db.query("select id from users where email='sam@u.com'")).rows[0].id;

  // 1) Suspension is NOT disabling. A suspended account keeps its session and
  //    its billing — it just can't spend. If these two did the same thing there
  //    would be no reason for two controls.
  await req("admin", `/api/admin/users/${sam}/suspend`, { method: "POST", body: { reason: "Reviewing unusual usage", days: 7 } });
  const login = await req(null, "/api/auth/login", { method: "POST", body: { email: "sam@u.com", password: "UserPass123!" } });
  assert.strictEqual(login.status, 200, "a suspended account can still sign in");
  const spend = await fetch(base + "/api/credits/consume", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, asUser(sam)), body: "{}" });
  assert.strictEqual(spend.status, 403, "but cannot spend credits");
  assert.strictEqual((await spend.json()).data.reason, "account_suspended");
  const status = (await (await fetch(base + "/api/credits/status", { headers: asUser(sam) })).json()).data;
  assert.strictEqual(status.suspended, true, "and is told why rather than failing silently");
  assert.strictEqual(status.suspension.reason, "Reviewing unusual usage");
  console.log("ok - suspend blocks spending while leaving sign-in and billing alone");

  // 2) A dated suspension lifts itself. A flag someone has to remember to clear
  //    is how an account stays locked long after the reason has passed.
  await db.query("update users set suspended_until = now() - interval '1 day' where id=$1", [sam]);
  const afterExpiry = await fetch(base + "/api/credits/consume", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, asUser(sam)), body: "{}" });
  assert.strictEqual(afterExpiry.status, 200, "an expired suspension stops applying on its own");
  console.log("ok - a dated suspension expires without anyone clearing it");

  // 3) Suspending needs a reason, because the account is shown it.
  assert.strictEqual((await req("admin", `/api/admin/users/${sam}/suspend`, { method: "POST", body: { days: 3 } })).status, 400, "a suspension with no reason is refused");
  const me = await (await req("admin", "/api/admin/me")).json();
  assert.strictEqual((await req("admin", `/api/admin/users/${me.userId}/suspend`, { method: "POST", body: { reason: "oops" } })).status, 400, "an admin can't suspend themselves");
  console.log("ok - suspension requires a reason and can't be aimed at yourself");

  // 4) Disable is the harder stop: no sign-in at all.
  await req("admin", `/api/admin/users/${sam}`, { method: "PATCH", body: { disabled: true } });
  assert.strictEqual((await req(null, "/api/auth/login", { method: "POST", body: { email: "sam@u.com", password: "UserPass123!" } })).status, 403, "a disabled account cannot sign in");
  const dead = await fetch(base + "/api/credits/consume", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, asUser(sam)), body: "{}" });
  assert.strictEqual(dead.status, 403, "and an already-issued token cannot spend either");
  await req("admin", `/api/admin/users/${sam}`, { method: "PATCH", body: { disabled: false } });
  console.log("ok - disable blocks sign-in outright, a different thing from suspend");

  // 5) Delete needs the email typed, refuses admin accounts and refuses self —
  //    a destructive action one stray click from a populated list is a matter
  //    of time.
  assert.strictEqual((await req("admin", `/api/admin/users/${sam}`, { method: "DELETE", body: {} })).status, 400, "no confirmation, no delete");
  assert.strictEqual((await req("admin", `/api/admin/users/${sam}`, { method: "DELETE", body: { confirmEmail: "wrong@u.com" } })).status, 400, "wrong confirmation is refused");
  assert.strictEqual((await req("admin", `/api/admin/users/${me.userId}`, { method: "DELETE", body: { confirmEmail: ADMIN.email } })).status, 400, "you can't delete yourself");
  console.log("ok - delete demands the exact email and refuses self-deletion");

  // 6) The delete takes the account's rows with it. These tables carry no
  //    foreign keys, so an orphaned ledger row would silently rejoin whichever
  //    account is next given that serial id.
  await db.query("insert into credit_ledger(user_id, delta, reason) values ($1, 5, 'test')", [sam]);
  await req("admin", `/api/admin/users/${sam}`, { method: "PATCH", body: { subscription: { status: "active", plan: "pro" } } });
  assert.strictEqual((await req("admin", `/api/admin/users/${sam}`, { method: "DELETE", body: { confirmEmail: "sam@u.com" } })).status, 200, "delete succeeds with the right confirmation");
  assert.strictEqual((await db.query("select count(*)::int c from credit_ledger where user_id=$1", [sam])).rows[0].c, 0, "the ledger went with it");
  assert.strictEqual((await db.query("select count(*)::int c from subscriptions where user_id=$1", [sam])).rows[0].c, 0, "so did the subscription");
  const trail = await (await req("admin", "/api/admin/audit?action=user.delete")).json();
  assert.strictEqual(trail.entries[0].detail.email, "sam@u.com", "and the audit entry outlives the account it describes");
  console.log("ok - deleting an account takes its rows with it and is recorded");

  // 7) The drawer's Overview renders from this, so it has to be there.
  await req(null, "/api/auth/register", { method: "POST", body: { email: "ana@u.com", password: "UserPass123!" } });
  const ana = (await db.query("select id from users where email='ana@u.com'")).rows[0].id;
  await fetch(base + "/api/credits/consume", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, asUser(ana)), body: JSON.stringify({ amount: 3 }) });
  const detail = await (await req("admin", `/api/admin/users/${ana}`)).json();
  assert.ok(detail.analytics, "the detail view carries analytics");
  assert.strictEqual(detail.analytics.spent30, 3, "spend over 30 days");
  assert.strictEqual(detail.analytics.activeDays, 1, "days with any usage");
  assert.ok(Array.isArray(detail.analytics.daily) && detail.analytics.daily.length, "a daily series for the chart");
  assert.ok(detail.analytics.lastActive, "and when they last used it");
  console.log("ok - per-user analytics are served for the drawer's Overview");

  // 8) None of it is reachable without an admin session.
  for (const [m, p] of [["POST", `/api/admin/users/${ana}/suspend`], ["DELETE", `/api/admin/users/${ana}`]]) {
    assert.strictEqual((await req(null, p, { method: m, body: {} })).status, 401, `${m} ${p} needs an admin session`);
  }
  console.log("ok - suspend and delete are behind the admin gate");

  // 9) An admin deduction can't overdraw an account. A negative balance means
  //    the user has to earn back past zero before spending again — never what
  //    "take some credits off" was meant to do.
  const before = (await db.query("select credit_balance from users where id=$1", [ana])).rows[0].credit_balance;
  const over = await req("admin", `/api/admin/users/${ana}/credits`, { method: "POST", body: { delta: -(before + 500) } });
  assert.strictEqual(over.status, 400, "an overdrawing deduction is refused");
  assert.strictEqual((await over.json()).error, "insufficient_balance");
  assert.strictEqual((await db.query("select credit_balance from users where id=$1", [ana])).rows[0].credit_balance, before, "and nothing was taken");
  const ok = await req("admin", `/api/admin/users/${ana}/credits`, { method: "POST", body: { delta: -2 } });
  assert.strictEqual(ok.status, 200, "a deduction within the balance still works");
  console.log("ok - an admin deduction cannot push a balance negative");

  server.close();
  console.log("\nALL USER-CONTROL TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
