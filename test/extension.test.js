/* Google gave Flow its own domain. The extension only ever knew
 * labs.google/fx/tools/flow, so on flow.google.com nothing ran at all: no
 * content script, no site adapter, no native-toggle notice, no in-page
 * button. Four separate host gates had to agree, and this checks all four -
 * plus the download interception, whose URL shape changes with the move.
 *
 * The site router is executed for real rather than pattern-matched, because
 * it matches with hostname.includes(domain) and "does labs.google appear
 * inside flow.google.com" is exactly the kind of question a regex over the
 * source answers wrongly. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ext = path.join(__dirname, "../../Erasezo-extension");
const ok = (c, m) => { if (!c) { console.error("FAIL - " + m); process.exit(1); } console.log("ok - " + m); };
if (!fs.existsSync(ext)) { console.log("skip: extension folder not present"); process.exit(0); }

const FLOW_HOSTS = ["labs.google", "flow.google.com"];

/* 1. The content script has to be injected there before anything else can
      matter, and its page scripts have to be loadable from that origin. */
const man = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
const cs = man.content_scripts.find((c) => c.matches.some((m) => /gemini\.google\.com/.test(m)));
ok(cs.matches.some((m) => m.startsWith("https://flow.google.com/")), "content script runs on flow.google.com");
ok(cs.matches.some((m) => m.startsWith("https://labs.google/")), "and still on labs.google");
const war = man.web_accessible_resources.find((w) => w.resources.some((r) => r === "page/flowInjector.js"));
ok(war.matches.some((m) => m.startsWith("https://flow.google.com/")),
   "the injected page scripts are reachable from flow.google.com");

/* 2. The router picks the adapter, and the adapter is what turns on the video
      pipeline that injects the in-page button. Run the real thing. */
function activeSiteFor(hostname) {
  const sandbox = { location: { hostname }, console: { debug() {}, error() {} } };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of ["assets/siteRouter.js-BdjvtTZG.js", "assets/flow.js-DrrgvGoY.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ext, f), "utf8"), ctx);
  }
  return sandbox.Erasezo.getActiveSite();
}
for (const host of FLOW_HOSTS) {
  const site = activeSiteFor(host);
  ok(site && site.name === "Flow", host + " resolves to the Flow adapter");
  ok(site.videoMode === "inject-button", host + " gets the in-page button pipeline");
}
ok(activeSiteFor("example.com") === null, "an unrelated host still matches nothing");

/* 3. The native-toggle notice on the page itself - screenshot 1 - is behind
      its own hostname check, which was a strict equality on labs.google. */
const boot = fs.readFileSync(path.join(ext, "assets/bootstrap.js-Dctxozx3.js"), "utf8");
const gate = boot.match(/function pt\(\)\{if\((.*?)\)try\{/);
ok(gate, "the notice's host gate is still where it was");
for (const host of FLOW_HOSTS) {
  ok(gate[1].includes('"' + host + '"'), "the in-page notice is gated on " + host);
}

/* 4. Downloads are intercepted by URL, and the move changes that URL: under
      labs.google the app lives at /fx, on its own domain it is at the root. */
const inj = fs.readFileSync(path.join(ext, "page/flowInjector.js"), "utf8");
const reSrc = inj.match(/const REDIRECT_URL_RE = (\/.*\/i);/);
ok(reSrc, "flowInjector still defines REDIRECT_URL_RE");
const RE = eval(reSrc[1]);
ok(RE.test("/fx/api/trpc/media.getMediaUrlRedirect?name=abc"), "labs.google download URL still intercepted");
ok(RE.test("/api/trpc/media.getMediaUrlRedirect?name=abc"), "flow.google.com download URL intercepted");
ok(!RE.test("/api/trpc/media.list"), "an unrelated tRPC call is left alone");

/* 5. The tour laid a dim layer over the notice, so on a fresh install the
      notice rendered, looked actionable, and swallowed every click. */
const theme = fs.readFileSync(path.join(__dirname, "../public/theme.css"), "utf8");
ok(/body:has\(\.erasio-tour-bubble\)[\s\S]{0,120}\.flow-google-banner/.test(theme),
   "the notice stands down while the tour is running");

/* 6. Two identical copies of the extension live side by side: the tracked one
      and the unpacked one that actually gets loaded. Nothing kept them in
      step, so a fix could land in the copy under review while the copy being
      run stayed broken - which is not a bug you find by reading the diff. */
const loaded = path.join(__dirname, "../../1.1.2_0");
if (!fs.existsSync(loaded)) {
  console.log("skip: no unpacked copy alongside");
} else {
  const IGNORE = new Set([".git", ".DS_Store", ".code-review-graph"]);
  const walk = (dir, base = "") => fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !IGNORE.has(e.name))
    .flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name), base + e.name + "/")
                                    : [base + e.name]);
  const a = walk(ext).sort(), b = walk(loaded).sort();
  assert.deepStrictEqual(a, b, "the two extension copies hold the same files (run sync-ext.sh)");
  const differing = a.filter((f) =>
    !fs.readFileSync(path.join(ext, f)).equals(fs.readFileSync(path.join(loaded, f))));
  ok(differing.length === 0,
     "the unpacked copy matches the tracked one (run sync-ext.sh)" +
     (differing.length ? " - stale: " + differing.slice(0, 5).join(", ") : ""));
}

console.log("\nALL EXTENSION TESTS PASSED");
