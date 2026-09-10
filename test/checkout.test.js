/* Starting a subscription. Razorpay itself is stubbed with a local server the
 * app is pointed at via RAZORPAY_API, because the real thing needs live keys -
 * but everything on our side of the call is exercised for real: the auth gate,
 * the plan lookup, the two not-configured-yet states, and above all that
 * notes.user_id goes out on the wire, since the webhook identifies the
 * account from it and a subscription without one is money we cannot match. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

let calls = [];
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
    if (stub.failNext) {
      stub.failNext = false;
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { description: "plan_id is invalid" } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "sub_TEST1", short_url: "https://rzp.io/i/test1" }));
  });
});

(async () => {
  await new Promise((r) => stub.listen(0, r));
  process.env.RAZORPAY_API = "http://127.0.0.1:" + stub.address().port;

  const srv = require("../server");
  const db = srv.db;
  await db.init();
  const server = http.createServer(srv.app).listen(0);
  const base = "http://127.0.0.1:" + server.address().port;

  const asUser = (uid) => ({
    "Content-Type": "application/json",
    Authorization: "Bearer " + jwt.sign({ uid }, "test-secret", { expiresIn: "1h" }),
  });
  const post = (path, uid, body) =>
    fetch(base + path, { method: "POST", headers: uid ? asUser(uid) : { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

  await db.query("insert into users(email,username,auth_provider,password_hash) values ('buyer@example.com','Buyer','password','x')");
  const uid = (await db.query("select id from users where email='buyer@example.com'")).rows[0].id;

  // 1) Anonymous callers cannot open a checkout at all.
  assert.strictEqual((await post("/api/billing/checkout", null, { planId: "pro" })).status, 401);
  console.log("ok - checkout needs a signed-in account");

  // 2) No keys yet is "not configured", not a crash, and not a 500 - the
  //    dashboard shows a different sentence for it.
  delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
  assert.strictEqual((await post("/api/billing/checkout", uid, { planId: "pro" })).status, 503);
  console.log("ok - missing keys report not_configured");

  process.env.RAZORPAY_KEY_ID = "rzp_test_key";
  process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";

  // 3) A plan with no Razorpay id is the other half-finished state, and it is
  //    distinguishable from the first so the operator knows which to fix.
  await db.query("update plans set razorpay_plan_id=null where id='pro'");
  let r = await post("/api/billing/checkout", uid, { planId: "pro" });
  assert.strictEqual(r.status, 503);
  assert.strictEqual((await r.json()).error, "plan_not_linked");
  console.log("ok - an unlinked plan is reported apart from missing keys");

  // 4) An id that isn't a live plan cannot be talked into a subscription.
  assert.strictEqual((await post("/api/billing/checkout", uid, { planId: "no_such" })).status, 404);
  await db.query("update plans set active=false where id='pro'");
  await db.query("update plans set razorpay_plan_id='plan_RZP_PRO' where id='pro'");
  assert.strictEqual((await post("/api/billing/checkout", uid, { planId: "pro" })).status, 404,
    "an inactive plan is not purchasable");
  await db.query("update plans set active=true where id='pro'");
  console.log("ok - only a live, linked plan can be bought");

  // 5) The happy path, and the thing that matters in it.
  calls = [];
  r = await post("/api/billing/checkout", uid, { planId: "pro" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).url, "https://rzp.io/i/test1");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].path, "/subscriptions");
  assert.strictEqual(calls[0].body.plan_id, "plan_RZP_PRO");
  assert.strictEqual(calls[0].body.notes.user_id, String(uid),
    "the webhook identifies the account from notes.user_id - without it the payment cannot be matched");
  assert.strictEqual(calls[0].body.notes.email, "buyer@example.com");
  assert.ok(/^Basic /.test(calls[0].auth), "keys go in the Authorization header, not the body");
  console.log("ok - checkout sends notes.user_id and returns the hosted link");

  // 6) One account cannot open a checkout that bills into another's notes.
  await db.query("insert into users(email,username,auth_provider,password_hash) values ('other@example.com','Other','password','x')");
  const other = (await db.query("select id from users where email='other@example.com'")).rows[0].id;
  calls = [];
  await post("/api/billing/checkout", other, { planId: "pro", userId: uid, user_id: uid });
  assert.strictEqual(calls[0].body.notes.user_id, String(other),
    "the account comes from the session, never from the body");
  console.log("ok - the buyer is the caller, whatever the body claims");

  // 7) Razorpay's own error text stays on the server.
  stub.failNext = true;
  r = await post("/api/billing/checkout", uid, { planId: "pro" });
  assert.strictEqual(r.status, 502);
  const body = await r.text();
  assert.ok(!/plan_id is invalid/.test(body), "the provider's error is not forwarded to the browser");
  console.log("ok - a provider failure is a 502 with nothing leaked");

  server.close(); stub.close();
  console.log("\nALL CHECKOUT TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", (e && e.stack) || e); process.exit(1); });
