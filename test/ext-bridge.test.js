/* Verifies /api/ext/session — the endpoint that mints a bearer session for
 * the extension's sidepanel bridge, given a valid cookie login. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";

const assert = require("assert");
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

  // 1) No session → 401, nothing leaked.
  const r0 = await req("/api/ext/session");
  assert.strictEqual(r0.status, 401, "unauthenticated request rejected");
  console.log("ok - /api/ext/session rejects without a session");

  // 2) Register (sets the real cookie), then mint a bearer session from it.
  await req("/api/auth/register", { method: "POST", body: JSON.stringify({ email: "bridge@x.com", password: "password123", username: "bridgeuser" }) });
  const r1 = await req("/api/ext/session");
  assert.strictEqual(r1.status, 200, "session mint succeeds when logged in");
  const body = await r1.json();
  assert.ok(body.accessToken, "accessToken present");
  assert.ok(body.refreshToken, "refreshToken present");
  assert.strictEqual(body.user.email, "bridge@x.com", "user.email correct");
  assert.strictEqual(body.user.username, "bridgeuser", "user.username correct");
  assert.strictEqual(body.user.name, "bridgeuser", "user.name mirrors username (sidepanel reads either)");
  assert.strictEqual(body.user.emailVerified, true, "emailVerified true");
  assert.strictEqual(body.user.is_email_verified, true, "is_email_verified true (snake_case variant)");
  console.log("ok - /api/ext/session returns accessToken/refreshToken/user matching sidepanel's expected shape");

  // 3) The minted accessToken is a real JWT for this user (defense: not a
  //    dummy/shared value) — verify it independently decodes to the same uid
  //    /api/me resolves to.
  const jwt = require("jsonwebtoken");
  const decoded = jwt.verify(body.accessToken, "test-secret");
  const me = await (await req("/api/me")).json();
  assert.strictEqual(decoded.uid, me.userId, "minted token's uid matches the logged-in user");
  console.log("ok - minted accessToken is a real, correctly-scoped JWT for this user");

  // 4) After logout, minting fails again (no stale bearer session issuable).
  await req("/api/auth/logout", { method: "POST" });
  const r2 = await req("/api/ext/session");
  assert.strictEqual(r2.status, 401, "cannot mint a session after logout");
  console.log("ok - session minting rejected after logout");

  // 5) /api/ext/login — the sidepanel's OWN form, now against OUR backend
  //    (previously leaked credentials to erasio.io). Wrong password rejected,
  //    correct password returns the exact {data:{accessToken,user,
  //    refreshToken}} shape the sidepanel's compiled code destructures.
  const EXT_ORIGIN = "chrome-extension://obmfaiblgoplljdpiembdcdjeohllfcd";
  const rBad = await fetch(base + "/api/ext/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: EXT_ORIGIN },
    body: JSON.stringify({ email: "bridge@x.com", password: "WRONG" }),
  });
  assert.strictEqual(rBad.status, 401, "wrong password rejected on /api/ext/login");
  assert.strictEqual(rBad.headers.get("access-control-allow-origin"), EXT_ORIGIN, "CORS allows the extension origin");
  console.log("ok - /api/ext/login rejects wrong password, CORS scoped to the extension origin");

  const rGood = await fetch(base + "/api/ext/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: EXT_ORIGIN },
    body: JSON.stringify({ email: "bridge@x.com", password: "password123" }),
  });
  assert.strictEqual(rGood.status, 200, "correct password accepted");
  const loginBody = await rGood.json();
  assert.ok(loginBody.data && loginBody.data.accessToken, "data.accessToken present (sidepanel destructures r?.data?.accessToken)");
  assert.ok(loginBody.data.user && loginBody.data.user.email === "bridge@x.com", "data.user.email present");
  console.log("ok - /api/ext/login returns the exact shape the sidepanel's login handler expects");

  // 6) A request from a DIFFERENT / no origin does not get the CORS header —
  //    confirms this isn't accidentally a wildcard-allow-any-origin endpoint.
  const rOther = await fetch(base + "/api/ext/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ email: "bridge@x.com", password: "password123" }),
  });
  assert.strictEqual(rOther.headers.get("access-control-allow-origin"), null, "no CORS header for a non-extension origin");
  console.log("ok - /api/ext/login does NOT allow an arbitrary origin (no CORS wildcard)");

  // 7) /api/ext/refresh — accepts a token minted by /api/ext/session and
  //    returns a fresh one in the same shape; a garbage token is rejected.
  const rRefresh = await fetch(base + "/api/ext/refresh", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: EXT_ORIGIN },
    body: JSON.stringify({ refreshToken: loginBody.data.refreshToken }),
  });
  assert.strictEqual(rRefresh.status, 200, "valid refresh token accepted");
  const refreshBody = await rRefresh.json();
  assert.ok(refreshBody.data.accessToken, "refresh returns a fresh accessToken");
  console.log("ok - /api/ext/refresh reissues a session for a valid token");

  const rRefreshBad = await fetch(base + "/api/ext/refresh", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: EXT_ORIGIN },
    body: JSON.stringify({ refreshToken: "garbage.not.a.jwt" }),
  });
  assert.strictEqual(rRefreshBad.status, 401, "garbage refresh token rejected");
  console.log("ok - /api/ext/refresh rejects an invalid token");

  server.close();
  console.log("\nALL EXT-BRIDGE TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
