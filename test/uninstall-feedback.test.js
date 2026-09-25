/* Public uninstall feedback: one page, one unauthenticated POST, one table.
 * No account, no mail, no store link. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const srv = require("../server");
const db = srv.db;

const REASONS = [
  "no_longer_needed", "didnt_work", "quality", "too_slow", "hard_to_use",
  "couldnt_remove", "download_process", "better_alternative", "privacy",
  "bug", "missing_feature", "other",
];

(async () => {
  await db.init();
  const server = require("http").createServer(srv.app).listen(0);
  const base = "http://127.0.0.1:" + server.address().port;

  async function post(body, headers) {
    const r = await fetch(base + "/api/uninstall-feedback", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { status: r.status, json, text, headers: r.headers };
  }
  function ip(addr) { return { "X-Forwarded-For": addr }; }

  const pub = path.join(__dirname, "../public");
  const html = fs.readFileSync(path.join(pub, "extension-uninstall-feedback.html"), "utf8");
  const css = fs.readFileSync(path.join(pub, "extension-uninstall-feedback.css"), "utf8");
  const js = fs.readFileSync(path.join(pub, "extension-uninstall-feedback.js"), "utf8");
  const pageSrc = html + "\n" + css + "\n" + js;
  for (const n of ["era" + "sio", "chrome" + "webstore", "you" + "tube"]) {
    assert.ok(!pageSrc.toLowerCase().includes(n), "page files must not contain " + n);
  }
  assert.ok(!/<iframe/i.test(html), "no video frame");
  assert.ok(!/\sstyle=/.test(html), "no inline style for the CSP to drop");
  assert.ok(/name="robots" content="noindex"/.test(html), "the page is noindex");
  assert.ok(/id="needJs"/.test(html) && /JavaScript is needed to send this form/.test(html),
    "without JS the page says the form cannot be sent");
  assert.ok(/extension-uninstall-feedback\.js/.test(html));
  assert.strictEqual((html.match(/<h1[ >]/g) || []).length, 1, "exactly one h1");
  assert.ok(html.indexOf('class="skip"') < html.indexOf("<header"));
  for (const id of REASONS) {
    assert.ok(new RegExp('value="' + id + '"').test(html), "reason " + id + " is on the page");
  }
  assert.strictEqual((html.match(/name="reason"/g) || []).length, REASONS.length, "twelve reasons");
  assert.ok(/I don’t need Erasezo right now/.test(html));
  assert.ok(/Watermark removal quality wasn’t good enough \(Gemini \/ Flow \/ Omni\)/.test(html));
  const ctas = html.match(/<a\b[^>]*>\s*Get the extension\s*<\/a>/g) || [];
  assert.ok(ctas.length >= 1, "there is a Get the extension link");
  assert.ok(ctas.every((a) => /href="\/#get-extension"/.test(a)), "every CTA href is /#get-extension");
  assert.ok(!/href="#get-extension"/.test(html), "a same-page hash would miss the home section");
  assert.ok(/:has\(input\[name="reason"\]\[value="other"\]:checked\)/.test(css), "Other reveals the short reason without JS");
  assert.ok(/role="alert"/.test(html), "errors have a live region");
  assert.ok(/showError\(/.test(js) && /rate_limited/.test(js) && /Could not reach Erasezo/.test(js),
    "validation, rate limit, and network failures are written on screen");
  assert.ok(/Sending…/.test(js) && /id="thanks"/.test(html), "submit has a loading label and a thank-you state");
  assert.ok(!/(?:color|background|border|fill|stroke)\s*:[^;{]*#[0-9a-fA-F]{3,8}/i.test(css),
    "the page css does not invent a colour");
  console.log("ok - the page is Erasezo's, has twelve reasons, and the CTA stays on /#get-extension");

  const page = await fetch(base + "/extension-uninstall-feedback");
  assert.strictEqual(page.status, 200);
  const body = await page.text();
  assert.ok(/id="feedbackForm"/.test(body));
  assert.ok(/extension-uninstall-feedback\.css/.test(body));
  const csp = page.headers.get("content-security-policy") || "";
  assert.ok(!/style-src[^;]*unsafe-inline/.test(csp));
  console.log("ok - GET /extension-uninstall-feedback serves the page");

  const anon = await post({ reason: "privacy" }, ip("203.0.113.8"));
  assert.strictEqual(anon.status, 200);
  assert.deepStrictEqual(anon.json, { ok: true });
  assert.ok(!JSON.stringify(anon.json).includes("@") && !("email" in anon.json));
  let row = (await db.query("select reason, reason_other, feedback, email, ip, user_agent from uninstall_feedback")).rows;
  assert.strictEqual(row.length, 1);
  assert.strictEqual(row[0].reason, "privacy");
  assert.strictEqual(row[0].reason_other, null);
  assert.strictEqual(row[0].email, null);
  assert.strictEqual(row[0].ip, "203.0.113.0", "the stored address drops the last octet");
  assert.notStrictEqual(row[0].ip, "203.0.113.8");
  console.log("ok - a public POST stores the reason and a truncated IP");

  const noted = await post({
    reason: "bug",
    reasonOther: "ignored when not other",
    feedback: " the panel stopped \u0000midway ",
    email: " Ada@Example.com ",
  }, Object.assign(ip("203.0.113.9"), { "User-Agent": "ErasezoTest/1.0" }));
  assert.strictEqual(noted.status, 200);
  row = (await db.query("select * from uninstall_feedback where reason='bug'")).rows[0];
  assert.strictEqual(row.reason_other, null, "a short reason is kept only for Other");
  assert.strictEqual(row.feedback, "the panel stopped midway");
  assert.strictEqual(row.email, "ada@example.com");
  assert.strictEqual(row.user_agent, "ErasezoTest/1.0");
  assert.strictEqual(row.ip, "203.0.113.0");
  const longUa = await post({ reason: "hard_to_use" }, Object.assign(ip("203.0.113.77"), { "User-Agent": "U".repeat(400) }));
  assert.strictEqual(longUa.status, 200);
  const uaRow = (await db.query("select user_agent from uninstall_feedback where reason='hard_to_use'")).rows[0];
  assert.strictEqual(uaRow.user_agent.length, 300, "the stored user-agent is truncated");

  const other = await post({ reason: "other", reasonOther: "  the shortcut vanished  " }, ip("198.51.100.4"));
  assert.strictEqual(other.status, 200);
  const otherRow = (await db.query("select reason_other, ip from uninstall_feedback where reason='other'")).rows[0];
  assert.strictEqual(otherRow.reason_other, "the shortcut vanished");
  assert.strictEqual(otherRow.ip, "198.51.100.0");
  console.log("ok - optional fields are trimmed, and Other keeps its short reason");

  assert.strictEqual((await post({}, ip("198.51.100.20"))).status, 400);
  assert.strictEqual((await post({ reason: "nope" }, ip("198.51.100.21"))).json.error, "bad_reason");
  assert.strictEqual((await post({ reason: "other" }, ip("198.51.100.22"))).json.error, "reason_other_required");
  assert.strictEqual((await post({ reason: "other", reasonOther: "   " }, ip("198.51.100.23"))).json.error, "reason_other_required");
  assert.strictEqual((await post({ reason: "other", reasonOther: "x".repeat(501) }, ip("198.51.100.24"))).json.error, "reason_other_too_long");
  assert.strictEqual((await post({ reason: "too_slow", feedback: "y".repeat(5001) }, ip("198.51.100.25"))).json.error, "feedback_too_long");
  const badMail = await post({ reason: "too_slow", email: "not-an-email" }, ip("198.51.100.26"));
  assert.strictEqual(badMail.status, 400);
  assert.strictEqual(badMail.json.error, "invalid_email");
  assert.ok(badMail.json.message, "a 400 carries a message the page can show");
  const exact = await post({ reason: "other", reasonOther: "z".repeat(500), feedback: "n".repeat(5000), email: "" }, ip("198.51.100.27"));
  assert.strictEqual(exact.status, 200, "500 and 5000 are the inclusive caps");
  const before = Number((await db.query("select count(*)::int c from uninstall_feedback")).rows[0].c);
  assert.strictEqual((await post({ reason: "nope" }, ip("198.51.100.28"))).status, 400);
  const after = Number((await db.query("select count(*)::int c from uninstall_feedback")).rows[0].c);
  assert.strictEqual(before, after, "a rejected body does not insert a row");
  console.log("ok - bad reason, missing Other text, long fields, and a bad email are 400");

  let last = null;
  for (let i = 0; i < 10; i++) {
    last = await post({ reason: "no_longer_needed" }, ip("192.0.2.40"));
    assert.strictEqual(last.status, 200, "request " + (i + 1) + " inside the hour cap");
  }
  const limited = await post({ reason: "no_longer_needed" }, ip("192.0.2.40"));
  assert.strictEqual(limited.status, 429);
  assert.strictEqual(limited.json.error, "rate_limited");
  assert.ok(limited.json.message);
  assert.ok(limited.headers.get("retry-after"));
  const otherIp = await post({ reason: "didnt_work" }, ip("192.0.2.41"));
  assert.strictEqual(otherIp.status, 200, "the cap is per IP");
  console.log("ok - ten posts an hour per IP, then rate_limited");

  const schema = fs.readFileSync(path.join(__dirname, "../db.js"), "utf8");
  assert.ok(
    /create index if not exists uninstall_feedback_created on uninstall_feedback \(created_at desc\)/.test(schema),
    "created_at desc is indexed"
  );
  const ordered = await db.query("select id from uninstall_feedback order by created_at desc limit 1");
  assert.ok(ordered.rows.length === 1);
  console.log("ok - uninstall_feedback is indexed on created_at desc");

  server.close();
  console.log("\nALL UNINSTALL FEEDBACK TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", (e && e.stack) || e); process.exit(1); });
