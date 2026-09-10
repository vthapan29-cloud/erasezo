/* The marketing home page. Two of these guard failures that are invisible in
 * a browser you are not looking closely at, and one guards the page telling
 * a visitor a price the checkout does not charge. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const srv = require("../server");
const db = srv.db;

const pub = path.join(__dirname, "../public");
const html = fs.readFileSync(path.join(pub, "home.html"), "utf8");
const css = fs.readFileSync(path.join(pub, "home.css"), "utf8");
const js = fs.readFileSync(path.join(pub, "home.js"), "utf8");

(async () => {
  await db.init();
  const server = require("http").createServer(srv.app).listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  const get = (p) => fetch(base + p, { redirect: "manual" });

  /* 1) The front door. "/" used to be the sign-in form, so the first thing a
        visitor met was a password field for an account they did not have. */
  const home = await get("/");
  const homeBody = await home.text();
  // Keyed on the page's furniture, not its headline — copy is meant to change.
  assert.ok(/home\.css/.test(homeBody) && /id="pricing"/.test(homeBody), "/ serves the home page");
  const login = await get("/login");
  assert.ok(/Sign in to Erasezo/.test(await login.text()), "/login still serves the form");
  for (const p of ["/register", "/signup"]) {
    const r = await get(p);
    assert.strictEqual(r.headers.get("location"), "/login", p + " points at the form, not the home page");
  }
  console.log("ok - / is the home page and the sign-in paths still reach the form");

  /* 2) The CSP has no 'unsafe-inline' in style-src, so a style attribute is
        dropped without a word. That already bit: the hero's readout bars each
        carried an inline width, every one was discarded, and because the fill
        is a block element they all rendered full — four bars claiming 100%
        next to the numbers 0.34, 0.62, 0.50 and 0.30. */
  const csp = home.headers.get("content-security-policy") || "";
  assert.ok(/style-src[^;]*/.test(csp) && !/style-src[^;]*unsafe-inline/.test(csp),
    "style-src still forbids inline styles");
  assert.ok(!/\sstyle="/.test(html), "home.html carries no style attribute for the CSP to drop");

  // The hero's wipe is driven by a custom property written from JS. CSP allows
  // that (it governs markup, not CSSOM), but the page must not depend on the
  // script having run: the stage declares a starting --wipe so the frame shows
  // both halves even if home.js never loads.
  assert.ok(/--wipe:\s*\d+%/.test(css), "the stage ships a default wipe position");
  assert.ok(/setProperty\("--wipe"/.test(js), "and JS moves it by custom property, not by a style attribute");
  assert.ok(/clip-path: inset\([^)]*var\(--wipe\)/.test(css), "the clean copy is clipped by that property");

  console.log("ok - nothing on the page depends on an inline style the CSP will drop");

  /* 2b) Every control in the header and hero does something. A language
         dropdown was in the reference design and is deliberately absent —
         the site has one language, and a select that switches nothing is
         worse than no select. */
  assert.ok(/id="themeBtn"/.test(html), "the theme button exists");
  assert.ok(/setAttribute\("data-theme"/.test(js) && /removeAttribute\("data-theme"\)/.test(js),
    "it sets and clears data-theme, which is what tokens.css answers to");
  assert.ok(/localStorage\.setItem\(THEME_KEY/.test(js), "and the choice survives a reload");
  assert.ok(/aria-label/.test(html.slice(html.indexOf('id="themeBtn"') - 200, html.indexOf('id="themeBtn"') + 200)),
    "and it is labelled for a screen reader");
  assert.ok(!/<select/.test(html), "no dropdown that switches nothing");

  const modes = [...html.matchAll(/data-mode="(\w+)"/g)].map((m) => m[1]);
  assert.ok(modes.includes("image") && modes.includes("video"), "the preview has both modes");
  for (const m of ["image", "video"]) {
    assert.ok(new RegExp(m + ":\\s*\\{ url:").test(js), m + " mode changes what the frame shows");
  }
  assert.ok(/aria-pressed/.test(html), "the segmented control reports its state");
  console.log("ok - the header and hero controls all drive something real");

  /* 3) Prices come from the table that bills. A number typed into the markup
        is a number that drifts away from what a customer is charged. */
  assert.ok(!/₹\s*\d/.test(html), "no price is hardcoded in the markup");
  assert.ok(/fetch\("\/api\/plans"\)/.test(js), "the page reads its prices from /api/plans");
  const plans = await (await fetch(base + "/api/plans")).json();
  assert.ok(plans.plans.length, "and that endpoint has something to give it");
  assert.ok(plans.plans.every((p) => !("razorpayPlanId" in p)), "still no billing ids in the public payload");
  console.log("ok - pricing is read from the same table the server bills against");

  /* 4) Every outbound link opens away from the page and cannot reach back
        into it through window.opener. */
  assert.ok(/rel = "noopener"/.test(js) || /rel="noopener"/.test(js),
    "the store links are opened with noopener");
  console.log("ok - outbound links carry noopener");

  /* 5) One heading per level, in order, and a skip link first in the tab
        order — the two structural things a screen reader user notices. */
  assert.strictEqual((html.match(/<h1[ >]/g) || []).length, 1, "exactly one h1");
  assert.ok(html.indexOf('class="skip"') < html.indexOf("<header"), "the skip link comes first");
  assert.ok(/<main id="main">/.test(html) && /href="#main"/.test(html), "and it points at main");
  const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
  assert.ok(imgs.every((i) => /alt=/.test(i)), "every image declares alt text");
  console.log("ok - landmark structure and image alts are in place");

  server.close();
  console.log("\nALL HOME TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", (e && e.stack) || e); process.exit(1); });
