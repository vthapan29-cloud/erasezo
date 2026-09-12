/* The Control Room's view of real users: listing, credits, subscriptions,
 * disabling accounts, and the Razorpay webhook that drives paid status. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "whsec-test";

const assert = require("assert");
const crypto = require("crypto");
const srv = require("../server");
const db = srv.db;

let base, server;
const jars = { admin: "", user: "" };
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
// Sign a webhook body exactly the way Razorpay does: HMAC over the raw bytes.
function rzpPost(payload, { secret = "whsec-test", eventId = null } = {}) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const headers = { "Content-Type": "application/json", "x-razorpay-signature": sig };
  if (eventId) headers["x-razorpay-event-id"] = eventId;
  return fetch(base + "/api/webhooks/razorpay", { method: "POST", headers, body: raw });
}

(async () => {
  await db.init();
  server = require("http").createServer(srv.app).listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const ADMIN = { email: "owner@erasezo.com", password: "OwnerPass123!x" };
  process.env.ADMIN_EMAIL = ADMIN.email; process.env.ADMIN_PASSWORD = ADMIN.password;
  await srv.ensureAdminFromEnv();
  await req("admin", "/api/admin/login", { method: "POST", body: ADMIN });

  // A password signup and a Google signup — the Google one is the case the
  // panel used to be blind to entirely.
  await req(null, "/api/auth/register", { method: "POST", body: { email: "pw@user.com", password: "UserPass123!", username: "pwuser" } });
  const gUid = await srv.mergeOrCreateGoogleUser({ email: "goog@user.com", sub: "google-oauth-123", name: "Goog User" });

  // 1) Everything is behind the admin gate.
  assert.strictEqual((await req(null, "/api/admin/users")).status, 401, "user list needs an admin session");
  assert.strictEqual((await req(null, "/api/admin/stats")).status, 401, "stats need an admin session");
  console.log("ok - user data is not readable without an admin session");

  // 2) The list shows real accounts, including the Google one, with how they
  //    signed up — the actual complaint that started this.
  const list = await (await req("admin", "/api/admin/users")).json();
  const byEmail = Object.fromEntries(list.users.map((u) => [u.email, u]));
  assert.ok(byEmail["pw@user.com"], "password signup is listed");
  assert.ok(byEmail["goog@user.com"], "Google signup is listed");
  assert.strictEqual(byEmail["goog@user.com"].authProvider, "google", "Google accounts are identified as such");
  assert.strictEqual(list.total, 3, "total counts every account");
  console.log("ok - the panel lists real users, Google sign-ups included");

  // 3) Credits: a fresh account got its daily grant, and the figures separate
  //    granted from used rather than only reporting a net number.
  const pw = byEmail["pw@user.com"];
  assert.strictEqual(pw.credits.grantedToday, 15, "daily free credits were granted at signup");
  assert.strictEqual(pw.credits.usedToday, 0, "nothing used yet");
  assert.strictEqual(pw.credits.dailyQuota, 15, "quota falls back to the global default");
  await req("admin", `/api/admin/users/${pw.userId}/credits`, { method: "POST", body: { delta: -4, reason: "image_clean" } });
  const afterUse = await (await req("admin", `/api/admin/users/${pw.userId}`)).json();
  assert.strictEqual(afterUse.credits.usedToday, 4, "usage is counted");
  assert.strictEqual(afterUse.credits.balance, 11, "balance nets grants against usage");
  assert.ok(afterUse.ledger.length >= 2, "the detail view shows the ledger behind those numbers");
  console.log("ok - credit quota, credits used and balance are each reported");

  // 4) Adjusting credits appends to the ledger rather than overwriting a total,
  //    so the adjustment stays visible afterwards.
  const bumped = await (await req("admin", `/api/admin/users/${pw.userId}/credits`, { method: "POST", body: { delta: 50, reason: "goodwill" } })).json();
  assert.strictEqual(bumped.credits.balance, 61, "admin top-up lands on the balance");
  const detail = await (await req("admin", `/api/admin/users/${pw.userId}`)).json();
  assert.ok(detail.ledger.some((l) => l.reason === "goodwill"), "the adjustment is attributable in the ledger");
  console.log("ok - credit adjustments are appended to the ledger, not overwritten");

  // 5) A per-user quota overrides the global default for future daily grants.
  await req("admin", `/api/admin/users/${pw.userId}`, { method: "PATCH", body: { dailyQuota: 100 } });
  const q = await (await req("admin", `/api/admin/users/${pw.userId}`)).json();
  assert.strictEqual(q.credits.dailyQuota, 100, "override is stored");
  assert.strictEqual(q.credits.quotaIsOverride, true, "and is distinguishable from the default");
  assert.strictEqual((await req("admin", `/api/admin/users/${pw.userId}`, { method: "PATCH", body: { dailyQuota: -5 } })).status, 400, "a negative quota is refused");
  console.log("ok - per-user daily quota overrides the global default");

  // 6) Subscription set by hand shows up on the user.
  await req("admin", `/api/admin/users/${pw.userId}`, { method: "PATCH", body: { subscription: { status: "active", plan: "pro" } } });
  const sub = await (await req("admin", `/api/admin/users/${pw.userId}`)).json();
  assert.strictEqual(sub.subscription.status, "active");
  assert.strictEqual(sub.subscription.plan, "pro");
  assert.strictEqual((await req("admin", `/api/admin/users/${pw.userId}`, { method: "PATCH", body: { subscription: { status: "nonsense" } } })).status, 400, "an unknown status is refused");
  console.log("ok - subscriptions are visible and settable per user");

  // 7) Disabling an account has to shut every door, not just the one that was
  //    tested — password login, the extension's login, and Google sign-in.
  await req("admin", `/api/admin/users/${pw.userId}`, { method: "PATCH", body: { disabled: true } });
  assert.strictEqual((await req(null, "/api/auth/login", { method: "POST", body: { email: "pw@user.com", password: "UserPass123!" } })).status, 403, "site login refuses a disabled account");
  assert.strictEqual((await req(null, "/api/ext/login", { method: "POST", body: { email: "pw@user.com", password: "UserPass123!" } })).status, 403, "extension login refuses it too");
  const jwt = require("jsonwebtoken");
  const deadTok = jwt.sign({ uid: pw.userId }, "test-secret", { expiresIn: "1h" });
  const deadHdr = { Authorization: "Bearer " + deadTok, "Content-Type": "application/json" };
  assert.strictEqual((await fetch(base + "/api/me", { headers: deadHdr })).status, 403, "an already-issued Bearer token cannot read /api/me");
  assert.strictEqual((await fetch(base + "/api/credits/consume", { method: "POST", headers: deadHdr, body: "{}" })).status, 403, "nor spend credits");
  assert.strictEqual((await fetch(base + "/api/credits/status", { headers: deadHdr })).status, 403, "nor poll the meter");
  assert.strictEqual((await fetch(base + "/api/ext/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: deadTok }) })).status, 403, "nor mint a fresh token");
  await db.query("update users set disabled=true where id=$1", [gUid]);
  await assert.rejects(() => srv.mergeOrCreateGoogleUser({ email: "goog@user.com", sub: "google-oauth-123" }), /account_disabled/, "Google sign-in is not a way around being disabled");
  console.log("ok - a disabled account is refused at every sign-in path");

  // 8) An admin cannot disable or demote themselves — that would be
  //    unrecoverable from inside the panel.
  const me = await (await req("admin", "/api/admin/me")).json();
  assert.strictEqual((await req("admin", `/api/admin/users/${me.userId}`, { method: "PATCH", body: { disabled: true } })).status, 400, "self-disable refused");
  assert.strictEqual((await req("admin", `/api/admin/users/${me.userId}`, { method: "PATCH", body: { isAdmin: false } })).status, 400, "self-demote refused");
  console.log("ok - the panel refuses to lock its own admin out");

  // 9) Razorpay: an unsigned or wrongly-signed body must change nothing. This
  //    endpoint is public, so its body is otherwise a request to grant a plan.
  const goodBody = {
    event: "subscription.activated",
    payload: { subscription: { entity: { id: "sub_test1", plan_id: "plan_x", current_end: 1893456000, notes: { user_id: String(gUid), plan: "pro" } } } },
  };
  const unsigned = await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(goodBody) });
  assert.strictEqual(unsigned.status, 401, "unsigned webhook rejected");
  assert.strictEqual((await rzpPost(goodBody, { secret: "wrong-secret" })).status, 401, "wrongly-signed webhook rejected");
  const stillNone = (await db.query("select status from subscriptions where user_id=$1", [gUid])).rows[0];
  assert.ok(!stillNone, "no subscription was created by the rejected calls");
  console.log("ok - the webhook grants nothing without a valid signature");

  // 10) A correctly signed event activates the subscription; a replay of the
  //     same delivery must not double-apply.
  assert.strictEqual((await rzpPost(goodBody, { eventId: "evt_1" })).status, 200, "signed webhook accepted");
  const active = (await db.query("select status, plan, provider, provider_subscription_id from subscriptions where user_id=$1", [gUid])).rows[0];
  assert.strictEqual(active.status, "active");
  assert.strictEqual(active.plan, "pro");
  assert.strictEqual(active.provider, "razorpay");
  assert.strictEqual(active.provider_subscription_id, "sub_test1");
  const replay = await (await rzpPost(goodBody, { eventId: "evt_1" })).json();
  assert.strictEqual(replay.duplicate, true, "a retried delivery is recognised and ignored");
  console.log("ok - a signed event activates the plan, and a retry is not applied twice");

  // 11) Cancellation flows through, and an event this app doesn't model leaves
  //     the status alone rather than guessing.
  await rzpPost({ event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_test1", notes: { user_id: String(gUid) } } } } }, { eventId: "evt_2" });
  assert.strictEqual((await db.query("select status from subscriptions where user_id=$1", [gUid])).rows[0].status, "cancelled", "cancellation is applied");
  const ignored = await (await rzpPost({ event: "subscription.updated", payload: { subscription: { entity: { id: "sub_test1", notes: { user_id: String(gUid) } } } } }, { eventId: "evt_3" })).json();
  assert.strictEqual(ignored.ignored, "subscription.updated", "an unmodelled event is acknowledged, not guessed at");
  assert.strictEqual((await db.query("select status from subscriptions where user_id=$1", [gUid])).rows[0].status, "cancelled", "and it left the status untouched");
  console.log("ok - cancellation applies; unmodelled events change nothing");

  // 12) Stats back the dashboard tiles.
  const stats = await (await req("admin", "/api/admin/stats")).json();
  assert.strictEqual(stats.users.total, 3);
  assert.strictEqual(stats.users.google, 1, "Google sign-ups are counted");
  assert.ok(stats.credits.usedToday >= 4, "credit usage is aggregated");
  console.log("ok - dashboard stats aggregate users, subscriptions and credit usage");

  server.close();
  console.log("\nALL USER/BILLING TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
