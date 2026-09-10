/* The endpoints the account dashboard renders from, and the ways they could
 * hand one user another user's data. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";

const assert = require("assert");
const jwt = require("jsonwebtoken");
const srv = require("../server");
const db = srv.db;

let base, server;
const asUser = (uid) => ({ Authorization: "Bearer " + jwt.sign({ uid }, "test-secret", { expiresIn: "1h" }) });
async function get(path, uid) {
  return fetch(base + path, { headers: uid ? asUser(uid) : {} });
}

(async () => {
  await db.init();
  server = require("http").createServer(srv.app).listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  await fetch(base + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@u.com", password: "UserPass123!", username: "aaa" }),
  });
  await fetch(base + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "b@u.com", password: "UserPass123!", username: "bbb" }),
  });
  const a = (await db.query("select id from users where email='a@u.com'")).rows[0].id;
  const b = (await db.query("select id from users where email='b@u.com'")).rows[0].id;

  // 1) The dashboard's own data needs a session.
  assert.strictEqual((await get("/api/me")).status, 401, "/api/me needs auth");
  assert.strictEqual((await get("/api/usage")).status, 401, "/api/usage needs auth");
  console.log("ok - the dashboard's data is not served to an anonymous caller");

  // 2) Plans are public — the upgrade view has to render before anyone
  //    subscribes — but must not leak operational detail.
  const plans = await (await get("/api/plans")).json();
  assert.ok(plans.plans.length >= 3, "plans are listed publicly");
  assert.ok(plans.plans.every((p) => !("razorpayPlanId" in p)), "no Razorpay ids in the public list");
  await db.query("insert into plans (id,name,daily_quota,price_inr,active) values ('hidden','Hidden',5,0,false)");
  const after = await (await get("/api/plans")).json();
  assert.ok(!after.plans.some((p) => p.id === "hidden"), "a deactivated plan is not offered");
  console.log("ok - /api/plans is public, hides inactive tiers and leaks no billing ids");

  // 3) THE ONE THAT MATTERS: usage is scoped to the caller. The ledger is a
  //    record of what someone did, and one account must never see another's.
  await fetch(base + "/api/credits/consume", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, asUser(b)), body: "{}" });
  const aUsage = await (await get("/api/usage", a)).json();
  const bUsage = await (await get("/api/usage", b)).json();
  assert.ok(!aUsage.recent.some((r) => r.reason === "usage"), "user A does not see user B's spend");
  assert.ok(bUsage.recent.some((r) => r.reason === "usage"), "user B does see their own");
  // And there is no id parameter that could be pointed at someone else.
  const spoof = await (await get("/api/usage?user_id=" + b, a)).json();
  assert.deepStrictEqual(spoof.recent, aUsage.recent, "a user_id in the query changes nothing");
  console.log("ok - usage is scoped to the caller and can't be pointed at another account");

  // 4) /api/me reports the allowance actually enforced, plus the admin flag the
  //    dashboard uses to decide whether to offer a Control Room link.
  const me = await (await get("/api/me", a)).json();
  const status = (await (await get("/api/credits/status", a)).json()).data;
  assert.strictEqual(me.credits.dailyQuota, status.unlimited ? -1 : status.limit, "the dashboard's quota is the enforced one");
  assert.strictEqual(me.isAdmin, false, "a normal account is not flagged admin");
  assert.ok(!("password_hash" in me) && !("totp_secret" in me), "no secrets in the profile payload");
  console.log("ok - /api/me matches the enforced allowance and carries no secrets");

  // 5) The daily rollup the chart draws lines up with the raw rows.
  const usage = await (await get("/api/usage", b)).json();
  const spentRaw = usage.recent.filter((r) => r.delta < 0).reduce((n, r) => n + -r.delta, 0);
  const spentRolled = usage.daily.reduce((n, d) => n + d.used, 0);
  assert.strictEqual(spentRolled, spentRaw, "the chart's daily totals match the ledger rows");
  console.log("ok - the usage chart's rollup agrees with the underlying ledger");

  // 6) The consume endpoint stores a reason from a known set, not from the
  //    caller. Free text there put arbitrary client strings into the user's
  //    own history and into the admin's view of it.
  await fetch(base + "/api/credits/consume", {
    method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, asUser(b)),
    body: JSON.stringify({ amount: 1, note: "<script>alert(1)</script> free text" }),
  });
  const spent = await (await get("/api/usage", b)).json();
  const reasons = new Set(spent.recent.map((r) => r.reason));
  assert.ok(!Array.from(reasons).some((r) => /script|free text/.test(r)), "the caller cannot name its own ledger reason");
  console.log("ok - ledger reasons come from a fixed set");

  // 7) The activity list folds same-day, same-reason rows. Run the real
  //    function out of the browser file rather than a copy of it, so renaming
  //    or rewriting it here fails loudly instead of silently diverging.
  const src = require("fs").readFileSync(require("path").join(__dirname, "../public/dashboard.js"), "utf8");
  const m = src.match(/function fold\(rows\) \{[\s\S]*?\n  \}/);
  assert.ok(m, "public/dashboard.js still defines fold(rows)");
  const fold = new Function(m[0] + "; return fold;")();
  const folded = fold([
    { reason: "image", created_at: "2026-09-09T14:00:00Z", delta: -1 },
    { reason: "image", created_at: "2026-09-09T09:00:00Z", delta: -1 },
    { reason: "image", created_at: "2026-09-08T09:00:00Z", delta: -1 },
    { reason: "daily_free", created_at: "2026-09-08T00:00:00Z", delta: 15 },
  ]);
  assert.deepStrictEqual(folded.map((r) => [r.reason, r.n, r.delta]),
    [["image", 2, -2], ["image", 1, -1], ["daily_free", 1, 15]],
    "one line per reason per day, carrying the count and the total");
  console.log("ok - the activity list folds a day's rows into one");

  server.close();
  console.log("\nALL DASHBOARD TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
