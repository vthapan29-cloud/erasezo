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

  server.close();
  console.log("\nALL SECURITY TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
