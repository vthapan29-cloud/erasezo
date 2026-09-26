/* Control Room read of uninstall_feedback. Same admin gate as the other
 * admin lists; newest first; the row is the six stored fields and nothing
 * else. No write route. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const srv = require("../server");
const db = srv.db;

let base, server;
function jar() { return {}; }
function cookieHeader(j) {
  return Object.keys(j).map((k) => k + "=" + j[k]).join("; ");
}
function take(res, j) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const kv = c.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) j[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return res;
}
async function req(j, p, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  const c = cookieHeader(j);
  if (c) opts.headers.Cookie = c;
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  const r = await fetch(base + p, opts);
  return take(r, j);
}

const FIELDS = ["reason", "reasonOther", "feedback", "email", "createdAt", "ip"];

(async () => {
  await db.init();
  server = require("http").createServer(srv.app).listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const admin = jar();
  const user = jar();
  process.env.ADMIN_EMAIL = "owner@erasezo.com";
  process.env.ADMIN_PASSWORD = "OwnerPass123!x";
  await srv.ensureAdminFromEnv();

  const anon = await req(jar(), "/api/admin/uninstall-feedback");
  assert.strictEqual(anon.status, 401);
  assert.strictEqual((await anon.json()).error, "not_authenticated");
  console.log("ok - anonymous caller gets 401");

  assert.strictEqual((await req(user, "/api/auth/register", {
    method: "POST",
    body: { email: "reader@example.com", password: "NormalPass123!" },
  })).status, 200);
  assert.ok(cookieHeader(user).includes("erasezo_token"), "ordinary login set the user cookie");
  const asUser = await req(user, "/api/admin/uninstall-feedback");
  assert.strictEqual(asUser.status, 401);
  assert.strictEqual((await asUser.json()).error, "not_authenticated");
  console.log("ok - an ordinary session cannot read uninstall feedback");

  assert.strictEqual((await req(admin, "/api/admin/login", {
    method: "POST",
    body: { email: "owner@erasezo.com", password: "OwnerPass123!x" },
  })).status, 200);

  const empty = await (await req(admin, "/api/admin/uninstall-feedback")).json();
  assert.deepStrictEqual(empty.entries, []);
  assert.strictEqual(empty.total, 0);
  assert.strictEqual(empty.limit, 50);
  assert.strictEqual(empty.offset, 0);
  console.log("ok - an admin sees an empty list");

  await db.query(
    `insert into uninstall_feedback(reason, reason_other, feedback, email, ip, user_agent, created_at)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    ["quality", null, "edges looked soft", null, "203.0.113.0", "ua-secret-old", "2026-01-02T00:00:00Z"]
  );
  await db.query(
    `insert into uninstall_feedback(reason, reason_other, feedback, email, ip, user_agent, created_at)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    ["bug", null, "panel stopped", "ada@example.com", "198.51.100.0", "ua-secret-mid", "2026-06-01T12:00:00Z"]
  );
  await db.query(
    `insert into uninstall_feedback(reason, reason_other, feedback, email, ip, user_agent, created_at)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    ["other", "shortcut vanished", null, "bea@example.com", "192.0.2.0", "ua-secret-new", "2026-06-01T12:00:00Z"]
  );

  const page = await (await req(admin, "/api/admin/uninstall-feedback?limit=1&offset=0")).json();
  assert.strictEqual(page.total, 3);
  assert.strictEqual(page.limit, 1);
  assert.strictEqual(page.offset, 0);
  assert.strictEqual(page.entries.length, 1);
  assert.deepStrictEqual(Object.keys(page.entries[0]), FIELDS);
  assert.strictEqual(page.entries[0].reason, "other");
  assert.strictEqual(page.entries[0].reasonOther, "shortcut vanished");
  assert.strictEqual(page.entries[0].feedback, null);
  assert.strictEqual(page.entries[0].email, "bea@example.com");
  assert.strictEqual(page.entries[0].ip, "192.0.2.0");
  assert.strictEqual(new Date(page.entries[0].createdAt).toISOString(), "2026-06-01T12:00:00.000Z");
  assert.ok(!JSON.stringify(page).includes("ua-secret"), "user agent is not in the response");
  assert.ok(!JSON.stringify(page).includes("user_agent") && !JSON.stringify(page).includes("userAgent"));

  const mid = await (await req(admin, "/api/admin/uninstall-feedback?limit=1&offset=1")).json();
  assert.strictEqual(mid.entries[0].reason, "bug");
  assert.strictEqual(mid.entries[0].reasonOther, null);
  assert.strictEqual(mid.entries[0].feedback, "panel stopped");
  assert.strictEqual(mid.entries[0].email, "ada@example.com");
  assert.strictEqual(mid.entries[0].ip, "198.51.100.0");

  const old = await (await req(admin, "/api/admin/uninstall-feedback?limit=1&offset=2")).json();
  assert.strictEqual(old.entries[0].reason, "quality");
  assert.strictEqual(old.entries[0].email, null);
  assert.strictEqual(old.entries[0].ip, "203.0.113.0");

  const past = await (await req(admin, "/api/admin/uninstall-feedback?limit=1&offset=3")).json();
  assert.deepStrictEqual(past.entries, []);
  assert.strictEqual(past.total, 3);
  console.log("ok - newest first, six fields, limit and offset");

  const clamped = await (await req(admin, "/api/admin/uninstall-feedback?limit=9999&offset=-4")).json();
  assert.strictEqual(clamped.limit, 200);
  assert.strictEqual(clamped.offset, 0);
  assert.strictEqual(clamped.entries.length, 3);
  const def = await (await req(admin, "/api/admin/uninstall-feedback?limit=nope")).json();
  assert.strictEqual(def.limit, 50);
  assert.strictEqual(def.offset, 0);
  console.log("ok - limit and offset are clamped like the other admin lists");

  assert.strictEqual((await req(admin, "/api/admin/uninstall-feedback", { method: "POST", body: {} })).status, 404);
  assert.strictEqual((await req(admin, "/api/admin/uninstall-feedback", { method: "DELETE" })).status, 404);
  console.log("ok - there is no write route");

  await db.query("update users set is_admin=false where email=$1", ["owner@erasezo.com"]);
  const revoked = await req(admin, "/api/admin/uninstall-feedback");
  assert.strictEqual(revoked.status, 403);
  assert.strictEqual((await revoked.json()).error, "not_admin");
  console.log("ok - a revoked admin is 403 on the next request");

  const adminJs = fs.readFileSync(path.join(__dirname, "../public/admin.js"), "utf8");
  const start = adminJs.indexOf("function loadUninstall()");
  const end = adminJs.indexOf("/* ---- boot ---- */");
  assert.ok(start > 0 && end > start, "the panel section is present");
  const section = adminJs.slice(start, end);
  assert.ok(section.includes('"/api/admin/uninstall-feedback?limit="'));
  assert.ok(section.includes("Couldn't load uninstall feedback:"));
  assert.ok(section.includes("No uninstall feedback yet."));
  assert.ok(section.includes("No feedback on this page."));
  assert.ok(section.includes("renderSkeleton(panel)"));
  assert.ok(/Reason", "Other", "Feedback", "Email", "Created", "IP"/.test(section));
  assert.ok(!/method:\s*"(POST|PATCH|PUT|DELETE)"/.test(section), "the panel does not write");
  for (const n of ["era" + "sio", "chrome" + "webstore"]) {
    assert.ok(!section.toLowerCase().includes(n), "the new panel copy does not contain " + n);
  }
  assert.ok(/ids: \["dashboard", "users", "plans", "referrals", "uninstall"\]/.test(adminJs));
  console.log("ok - the Control Room section is read-only and states load, empty, and error");

  const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.ok(/app\.get\("\/api\/admin\/uninstall-feedback", adminAuth/.test(serverSrc));
  assert.strictEqual(
    (serverSrc.match(/app\.(post|patch|put|delete)\("\/api\/admin\/uninstall-feedback"/g) || []).length,
    0
  );

  server.close();
  console.log("\nALL ADMIN UNINSTALL FEEDBACK TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", (e && e.stack) || e); try { server && server.close(); } catch (_) {} process.exit(1); });
