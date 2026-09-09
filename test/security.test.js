/* Verifies the hardening added in this pass actually works — not just present
 * in the code. Runs against an in-memory Postgres + a real HTTP server. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";

const assert = require("assert");
const srv = require("../server");
const db = srv.db;

let base, server;
async function req(path, opts) { return fetch(base + path, opts); }

(async () => {
  await db.init();
  server = require("http").createServer(srv.app).listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  // 1) Security headers present on every response.
  const r1 = await req("/healthz");
  assert.strictEqual(r1.headers.get("x-content-type-options"), "nosniff", "X-Content-Type-Options set");
  assert.strictEqual(r1.headers.get("x-frame-options"), "DENY", "X-Frame-Options set");
  assert.ok(r1.headers.get("content-security-policy").includes("default-src 'self'"), "CSP set");
  console.log("ok - security headers present on every response");

  // 2) Body size limit rejects an oversized JSON payload.
  const bigPassword = "x".repeat(200 * 1024); // 200KB, over the 64KB cap
  const r2 = await req("/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "big@x.com", password: bigPassword }),
  });
  assert.strictEqual(r2.status, 413, "oversized body rejected with 413");
  console.log("ok - body size limit enforced (413 on oversized payload)");

  // 3) Rate limiting kicks in on repeated login attempts from the same IP.
  let sawLimited = false;
  for (let i = 0; i < 25; i++) {
    const r = await req("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@x.com", password: "wrongpassword" }),
    });
    if (r.status === 429) { sawLimited = true; assert.ok(r.headers.get("retry-after"), "Retry-After header present"); break; }
  }
  assert.ok(sawLimited, "rate limiter triggers after repeated attempts");
  console.log("ok - rate limiter blocks repeated login attempts (429 + Retry-After)");

  // 4) /api/me and static assets are NOT rate-limited by the auth bucket
  //    (sanity: a burst of /healthz calls should never 429).
  let allOk = true;
  for (let i = 0; i < 25; i++) { const r = await req("/healthz"); if (r.status !== 200) allOk = false; }
  assert.ok(allOk, "non-auth routes are unaffected by the auth rate limiter");
  console.log("ok - non-auth routes unaffected by the auth-only rate limiter");

  // 5) The Control Room is served, and its relative asset refs resolve to real
  //    files. That layout is load-bearing (see sync-admin.sh) — a bad copy
  //    would 404 the panel's scripts and render a silently blank shell.
  const rAdmin = await req("/admin");
  assert.strictEqual(rAdmin.status, 200, "/admin serves the Control Room");
  const html = await rAdmin.text();
  assert.ok(/admin\.css/.test(html) && !/<style>/.test(html), "styles are an external file (strict CSP has no 'unsafe-inline')");
  for (const asset of ["/admin.css", "/admin.js", "/admin/auth.js"]) {
    assert.strictEqual((await req(asset)).status, 200, `${asset} resolves`);
  }
  console.log("ok - /admin serves the Control Room and every relative asset resolves");

  // 6) The panel talks only to this origin now, so connect-src stays closed.
  //    No 'unsafe-inline' either — which is exactly why the auth modal's styles
  //    live in admin.css rather than being injected from script.
  const csp = rAdmin.headers.get("content-security-policy");
  assert.ok(/connect-src 'self';/.test(csp), "connect-src is limited to this origin");
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), "CSP grants no unsafe-inline/eval");
  const css = await (await req("/admin.css")).text();
  assert.ok(css.includes(".sbm-ov"), "auth modal styles ship in the stylesheet, not injected at runtime");
  console.log("ok - CSP stays locked down and the modal styles are CSP-safe");

  // 7) The extension's session-token keys must never be reachable through the
  //    settings bridge, in either direction — that allowlist is the whole
  //    trust boundary between page script and the extension's auth.
  const bridgeSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "Erasezo-extension", "page", "webBridge.js"), "utf8");
  const keyList = bridgeSrc.match(/var SETTINGS_KEYS = \[([\s\S]*?)\]/);
  assert.ok(keyList, "SETTINGS_KEYS allowlist present in webBridge.js");
  for (const secret of ["erasioAccessToken", "erasioRefreshToken", "erasioUser"]) {
    assert.ok(!keyList[1].includes(secret), `${secret} is NOT bridgeable to page script`);
  }
  const actions = bridgeSrc.match(/var ALLOWED_ACTIONS = \[([\s\S]*?)\]/);
  assert.ok(actions && !actions[1].includes("erasioAuthSync"), "erasioAuthSync is not page-invokable (would accept a forged token)");
  console.log("ok - settings bridge cannot read or forge extension auth tokens");

  server.close();
  console.log("\nALL SECURITY TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
