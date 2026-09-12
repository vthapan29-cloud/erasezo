/* Plans, entitlements, and actually spending credits — the part that decides
 * what a paying customer gets that a free one doesn't. */
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
// The extension authenticates with a bearer token, not the cookie.
const asUser = (uid) => ({ Authorization: "Bearer " + jwt.sign({ uid }, "test-secret", { expiresIn: "1h" }) });
const bearer = (uid, path, opts) => req(null, path, Object.assign({}, opts, { headers: asUser(uid) }));

(async () => {
  await db.init();
  server = require("http").createServer(srv.app).listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const ADMIN = { email: "owner@erasezo.com", password: "OwnerPass123!x" };
  process.env.ADMIN_EMAIL = ADMIN.email; process.env.ADMIN_PASSWORD = ADMIN.password;
  await srv.ensureAdminFromEnv();
  await req("admin", "/api/admin/login", { method: "POST", body: ADMIN });

  // 1) The seeded tiers exist and carry real quotas.
  const seeded = await (await req("admin", "/api/admin/plans")).json();
  const byId = Object.fromEntries(seeded.plans.map((p) => [p.id, p]));
  assert.strictEqual(byId.free.dailyQuota, 15);
  assert.strictEqual(byId.pro.dailyQuota, 500);
  assert.strictEqual(byId.unlimited.unlimited, true, "-1 reads as unlimited");
  console.log("ok - free / pro / unlimited ship with real quotas behind them");

  // 2) A free user gets the free quota and can spend it — the whole point of
  //    removing the forced-unlimited bypass.
  await req(null, "/api/auth/register", { method: "POST", body: { email: "free@u.com", password: "UserPass123!" } });
  const freeUid = (await db.query("select id from users where email='free@u.com'")).rows[0].id;
  let st = (await (await bearer(freeUid, "/api/credits/status")).json()).data;
  assert.strictEqual(st.limit, 15, "free plan reports its limit");
  assert.strictEqual(st.remaining, 15, "and a full allowance");
  assert.strictEqual(st.unlimited, false, "credits are actually metered now");

  const spend = await (await bearer(freeUid, "/api/credits/consume", { method: "POST", body: JSON.stringify({ amount: 1 }) })).json();
  assert.strictEqual(spend.data.ok, true);
  assert.strictEqual(spend.data.remaining, 14, "spending one credit leaves fourteen");
  console.log("ok - a free account is metered and spending a credit deducts it");

  // 3) Running out returns 402 with the reason the extension already reads.
  await req("admin", `/api/admin/users/${freeUid}/credits`, { method: "POST", body: { delta: -14, reason: "drain" } });
  const broke = await bearer(freeUid, "/api/credits/consume", { method: "POST", body: JSON.stringify({ amount: 1 }) });
  assert.strictEqual(broke.status, 402, "402 is what the sidepanel maps to insufficient_credits");
  assert.strictEqual((await broke.json()).data.reason, "insufficient_credits");
  assert.strictEqual(await balance(freeUid), 0, "and nothing was deducted on the refusal");
  console.log("ok - an exhausted account is refused with 402 and is not overdrawn");

  // 4) THE RACE: with one credit left, two simultaneous requests must not both
  //    succeed. This is the bug that lets someone double-spend by clicking
  //    twice, and it only shows up under concurrency.
  await req("admin", `/api/admin/users/${freeUid}/credits`, { method: "POST", body: { delta: 1, reason: "topup" } });
  const both = await Promise.all([
    bearer(freeUid, "/api/credits/consume", { method: "POST", body: JSON.stringify({ amount: 1 }) }),
    bearer(freeUid, "/api/credits/consume", { method: "POST", body: JSON.stringify({ amount: 1 }) }),
  ]);
  const okCount = both.filter((r) => r.status === 200).length;
  assert.strictEqual(okCount, 1, "exactly one of two concurrent spends succeeds");
  assert.strictEqual(await balance(freeUid), 0, "the balance never goes negative");
  console.log("ok - concurrent spends can't double-spend the last credit");

  // 5) An active subscription lifts the allowance, without touching the user.
  await req(null, "/api/auth/register", { method: "POST", body: { email: "pro@u.com", password: "UserPass123!" } });
  const proUid = (await db.query("select id from users where email='pro@u.com'")).rows[0].id;
  await req("admin", `/api/admin/users/${proUid}`, { method: "PATCH", body: { subscription: { status: "active", plan: "pro" } } });
  st = (await (await bearer(proUid, "/api/credits/status")).json()).data;
  assert.strictEqual(st.limit, 500, "the pro plan's quota is what gets enforced");
  assert.strictEqual(st.remaining, 500, "and the balance is topped up to that quota the same day");
  assert.strictEqual(st.kind, "paid");
  console.log("ok - an active subscription raises the allowance to its plan's quota");

  // 5b) Switching back to Free must claw the leftover Pro pile — this is the
  //     500/15 dashboard: quota followed the plan, the balance did not.
  await req("admin", `/api/admin/users/${proUid}`, { method: "PATCH", body: { subscription: { status: "cancelled", plan: "pro" } } });
  st = (await (await bearer(proUid, "/api/credits/status")).json()).data;
  assert.strictEqual(st.limit, 15, "cancelled Pro falls back to free");
  assert.strictEqual(st.remaining, 15, "and the leftover 500 is not kept");
  console.log("ok - a downgrade syncs the balance to the new quota");

  await req("admin", `/api/admin/users/${proUid}`, { method: "PATCH", body: { subscription: { status: "active", plan: "pro" } } });

  // 6) Unlimited never blocks, however much is spent.
  await req("admin", `/api/admin/users/${proUid}`, { method: "PATCH", body: { subscription: { status: "active", plan: "unlimited" } } });
  for (let i = 0; i < 5; i++) {
    const r = await bearer(proUid, "/api/credits/consume", { method: "POST", body: JSON.stringify({ amount: 100 }) });
    assert.strictEqual(r.status, 200, "unlimited never refuses");
  }
  st = (await (await bearer(proUid, "/api/credits/status")).json()).data;
  assert.strictEqual(st.unlimited, true);
  assert.strictEqual(st.limit, 0, "limit 0 is how the client already reads unlimited");
  console.log("ok - an unlimited plan is never refused");

  // 7) Cancelling drops the account back to free rather than stranding it on a
  //    tier it no longer pays for.
  await req("admin", `/api/admin/users/${proUid}`, { method: "PATCH", body: { subscription: { status: "cancelled", plan: "unlimited" } } });
  st = (await (await bearer(proUid, "/api/credits/status")).json()).data;
  assert.strictEqual(st.limit, 15, "a cancelled subscription falls back to free");
  assert.strictEqual(st.unlimited, false);
  console.log("ok - a lapsed subscription loses its paid allowance");

  // 8) A per-user override outranks the plan — that is the point of an override.
  await req("admin", `/api/admin/users/${proUid}`, { method: "PATCH", body: { dailyQuota: 42 } });
  st = (await (await bearer(proUid, "/api/credits/status")).json()).data;
  assert.strictEqual(st.limit, 42, "the admin's per-account decision wins");
  console.log("ok - a per-user quota override beats the plan's quota");

  // 9) Editing a plan changes what its subscribers get, immediately.
  await req("admin", "/api/admin/plans/pro", { method: "PATCH", body: { name: "Pro", dailyQuota: 1000, priceInr: 599, active: true } });
  await req(null, "/api/auth/register", { method: "POST", body: { email: "pro2@u.com", password: "UserPass123!" } });
  const pro2 = (await db.query("select id from users where email='pro2@u.com'")).rows[0].id;
  await req("admin", `/api/admin/users/${pro2}`, { method: "PATCH", body: { subscription: { status: "active", plan: "pro" } } });
  st = (await (await bearer(pro2, "/api/credits/status")).json()).data;
  assert.strictEqual(st.limit, 1000, "the edited quota applies to everyone on the plan");
  console.log("ok - editing a plan re-prices every subscriber on it at once");

  // 10) Guard rails on plan management.
  assert.strictEqual((await req("admin", "/api/admin/plans", { method: "POST", body: { id: "Bad Id!", name: "x", dailyQuota: 1, priceInr: 0 } })).status, 400, "malformed id refused");
  assert.strictEqual((await req("admin", "/api/admin/plans", { method: "POST", body: { id: "pro", name: "x", dailyQuota: 1, priceInr: 0 } })).status, 409, "duplicate id refused");
  assert.strictEqual((await req("admin", "/api/admin/plans/free", { method: "DELETE" })).status, 400, "the free fallback can't be deleted");
  assert.strictEqual((await req("admin", "/api/admin/plans/pro", { method: "DELETE" })).status, 409, "a plan with subscribers can't be deleted out from under them");
  assert.strictEqual((await req(null, "/api/admin/plans")).status, 401, "plans aren't readable without an admin session");
  console.log("ok - plan management refuses the changes that would break billing");

  // 11) The daily grant tops up TO the quota rather than stacking, which is why
  //     live accounts had accumulated 180 credits.
  const idle = (await db.query("insert into users(email, auth_provider) values ('idle@u.com','password') returning id")).rows[0].id;
  await srv.grantDailyIfNeeded(idle);
  assert.strictEqual(await balance(idle), 15, "first day: a full allowance");
  await db.query("update credit_ledger set created_at = created_at - interval '2 days' where user_id=$1", [idle]);
  await srv.grantDailyIfNeeded(idle);
  assert.strictEqual(await balance(idle), 15, "a day later it is topped up to 15, not to 30");
  console.log("ok - the daily grant tops up to the quota instead of stacking forever");

  // 11b) A leftover Pro pile that never went through applyPlanAllowance is
  //      still capped on the next daily grant / status poll — Visu's 500/15.
  const stuck = (await db.query("insert into users(email, auth_provider) values ('stuck@u.com','password') returning id")).rows[0].id;
  await srv.grantDailyIfNeeded(stuck);
  assert.strictEqual(await balance(stuck), 15);
  await db.query("update users set credit_balance = credit_balance + 485 where id=$1", [stuck]);
  await db.query("insert into credit_ledger(user_id, delta, reason) values ($1,485,'daily_free')", [stuck]);
  st = (await (await bearer(stuck, "/api/credits/status")).json()).data;
  assert.strictEqual(st.limit, 15);
  assert.strictEqual(st.remaining, 15, "status poll claws the leftover Pro pile");
  console.log("ok - a leftover higher-plan balance is capped on the next status poll");

  // 11c) An admin bonus above the quota is not cancelled out by that cap.
  const bonus = (await db.query("insert into users(email, auth_provider) values ('bonus@u.com','password') returning id")).rows[0].id;
  await srv.grantDailyIfNeeded(bonus);
  await req("admin", `/api/admin/users/${bonus}/credits`, { method: "POST", body: { delta: 100, reason: "admin_grant" } });
  await srv.grantDailyIfNeeded(bonus);
  assert.strictEqual(await balance(bonus), 115, "a support grant above the quota stays");
  console.log("ok - an admin bonus above the quota is left alone");

  // 12) The ledger and the enforced counter must agree. Two stores means drift
  //     is the failure mode that matters, and it would show up as users being
  //     charged for credits they still have (or spending ones they don't).
  const drift = (await db.query(`
    select u.id, u.credit_balance, coalesce(l.s,0)::int ledger
    from users u
    left join (select user_id, sum(delta)::int s from credit_ledger group by user_id) l on l.user_id = u.id
    where u.credit_balance <> coalesce(l.s,0)
  `)).rows;
  assert.deepStrictEqual(drift, [], "every account's balance matches its ledger");
  console.log("ok - the enforced balance never drifts from the ledger");

  // 13) And if it ever did, boot reconciliation puts it right rather than
  //     letting it compound.
  await db.query("update users set credit_balance = credit_balance + 999 where id=$1", [freeUid]);
  await db.reconcileBalances();
  const led = Number((await db.query("select coalesce(sum(delta),0) s from credit_ledger where user_id=$1", [freeUid])).rows[0].s);
  assert.strictEqual(await balance(freeUid), led, "reconciliation restores the balance from the ledger");
  console.log("ok - boot reconciliation repairs a drifted balance");

  // 14) The Control Room must report the SAME allowance the server enforces.
  //     These are computed in two different places — a SQL join for the list and
  //     entitlement() for the API — and when they drifted, the panel showed a
  //     Pro subscriber "15/day" while the extension happily gave them 500.
  for (const uid of [freeUid, proUid, pro2]) {
    const shown = (await (await req("admin", `/api/admin/users/${uid}`)).json()).credits.dailyQuota;
    const enforced = (await (await bearer(uid, "/api/credits/status")).json()).data;
    const enforcedQuota = enforced.unlimited ? -1 : enforced.limit;
    assert.strictEqual(shown, enforcedQuota,
      `user ${uid}: panel shows ${shown}/day but the server enforces ${enforcedQuota}`);
  }
  console.log("ok - the panel's quota always matches the one actually enforced");

  server.close();
  console.log("\nALL PLAN/CREDIT TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });

async function balance(uid) {
  return Number((await db.query("select credit_balance from users where id=$1", [uid])).rows[0].credit_balance);
}
