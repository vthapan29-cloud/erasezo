/* The admin audit trail. Its whole value is being complete and unforgeable, so
 * these check that actions land, that refused sign-ins land, and that nothing
 * exposed can rewrite it. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";

const assert = require("assert");
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
// audit() is fire-and-forget by design, so give the write a moment to land.
const settle = () => new Promise((r) => setTimeout(r, 120));
async function entries() {
  await settle();
  return (await (await req("admin", "/api/admin/audit?limit=200")).json()).entries;
}
const find = (list, action) => list.filter((e) => e.action === action);

(async () => {
  await db.init();
  server = require("http").createServer(srv.app).listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const ADMIN = { email: "owner@erasezo.com", password: "OwnerPass123!x" };
  process.env.ADMIN_EMAIL = ADMIN.email; process.env.ADMIN_PASSWORD = ADMIN.password;
  await srv.ensureAdminFromEnv();

  // 1) A refused sign-in is recorded even though there is no session behind it
  //    — that is the entry you want when someone is trying to get in.
  await req(null, "/api/admin/login", { method: "POST", body: { email: ADMIN.email, password: "wrong" } });
  await req("admin", "/api/admin/login", { method: "POST", body: ADMIN });
  const afterLogin = await entries();
  const failed = find(afterLogin, "admin.login_failed")[0];
  assert.ok(failed, "the refused attempt was recorded");
  assert.strictEqual(failed.actor_id, null, "with no actor id, since there was no session");
  assert.strictEqual(failed.actor_email, ADMIN.email, "but the attempted email is kept");
  assert.strictEqual(failed.detail.reason, "bad_credentials");
  assert.ok(find(afterLogin, "admin.login").length === 1, "and the successful sign-in too");
  console.log("ok - refused and successful admin sign-ins are both recorded");

  // 2) Account changes record what actually changed, not merely that something did.
  await req(null, "/api/auth/register", { method: "POST", body: { email: "victim@u.com", password: "UserPass123!" } });
  const uid = (await db.query("select id from users where email='victim@u.com'")).rows[0].id;
  await req("admin", `/api/admin/users/${uid}`, { method: "PATCH", body: { disabled: true } });
  await req("admin", `/api/admin/users/${uid}`, { method: "PATCH", body: { dailyQuota: 99 } });
  await req("admin", `/api/admin/users/${uid}`, { method: "PATCH", body: { subscription: { status: "active", plan: "pro" } } });
  await req("admin", `/api/admin/users/${uid}/credits`, { method: "POST", body: { delta: 25, reason: "goodwill" } });
  const afterUser = await entries();
  const dis = find(afterUser, "user.disable")[0];
  assert.ok(dis && dis.detail.email === "victim@u.com", "the disable names the account, not just an id");
  assert.strictEqual(dis.actor_email, ADMIN.email, "and names who did it");
  const quota = find(afterUser, "user.quota")[0];
  assert.strictEqual(quota.detail.to, 99, "the quota change records the new value");
  assert.strictEqual(quota.detail.from, null, "and the old one");
  assert.strictEqual(find(afterUser, "user.subscription")[0].detail.plan, "pro");
  assert.strictEqual(find(afterUser, "user.credits")[0].detail.delta, 25);
  console.log("ok - account changes record who, what, and the value before and after");

  // 3) A no-op PATCH writes nothing. A log full of "changed nothing" is a log
  //    nobody reads.
  const before = (await entries()).length;
  await req("admin", `/api/admin/users/${uid}`, { method: "PATCH", body: { disabled: true } });
  assert.strictEqual((await entries()).length, before, "re-sending the same value records nothing");
  console.log("ok - a change that changes nothing is not logged");

  // 4) Plan edits keep the previous values, and a delete copies the row in —
  //    after the delete there is nothing left to look up.
  await req("admin", "/api/admin/plans/pro", { method: "PATCH", body: { name: "Pro", dailyQuota: 750, priceInr: 699, active: true } });
  await req("admin", "/api/admin/plans", { method: "POST", body: { id: "temp", name: "Temp", dailyQuota: 5, priceInr: 0 } });
  await req("admin", "/api/admin/plans/temp", { method: "DELETE" });
  const afterPlans = await entries();
  const upd = find(afterPlans, "plan.update")[0];
  assert.strictEqual(upd.detail.from.daily_quota, 500, "the edit kept the previous quota");
  assert.strictEqual(upd.detail.to.dailyQuota, 750);
  assert.strictEqual(find(afterPlans, "plan.delete")[0].detail.name, "Temp", "the deleted plan's values survive it");
  console.log("ok - plan edits keep the previous values and deletes keep the deleted row");

  // 5) The log is admin-only, and append-only: no exposed route can change it.
  assert.strictEqual((await req(null, "/api/admin/audit")).status, 401, "the log needs an admin session");
  for (const [method, path] of [["PATCH", "/api/admin/audit"], ["DELETE", "/api/admin/audit"], ["POST", "/api/admin/audit"], ["DELETE", "/api/admin/audit/1"]]) {
    const r = await req("admin", path, { method });
    assert.ok(r.status === 404 || r.status === 405, `${method} ${path} is not a route (got ${r.status})`);
  }
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  assert.ok(!/delete from admin_audit|update admin_audit/i.test(src), "no code path edits or clears the log");
  console.log("ok - the log is admin-only and nothing exposed can rewrite it");

  // 6) Filtering works and doesn't become an injection point.
  const filtered = await (await req("admin", "/api/admin/audit?action=user.disable")).json();
  assert.ok(filtered.entries.length >= 1 && filtered.entries.every((e) => e.action === "user.disable"), "filter narrows to one action");
  const evil = await req("admin", "/api/admin/audit?action=" + encodeURIComponent("' or 1=1--"));
  assert.strictEqual(evil.status, 200, "a SQL-ish filter value is just a value");
  assert.strictEqual((await evil.json()).entries.length, 0, "and matches nothing");
  console.log("ok - filtering narrows results and is parameterised");

  server.close();
  console.log("\nALL AUDIT TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
