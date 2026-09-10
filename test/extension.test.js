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
const epSrc = inj.match(/const MEDIA_ENDPOINT = String\.raw`([^`]*)`;/);
ok(epSrc, "flowInjector defines the media endpoint once");
const RE = new RegExp(epSrc[1], "i");
ok(RE.test("/fx/api/trpc/media.getMediaUrlRedirect?name=abc"), "labs.google media URL matches");
ok(RE.test("/api/trpc/media.getMediaUrlRedirect?name=abc"), "flow.google.com media URL matches");
ok(!RE.test("/api/trpc/media.list"), "an unrelated tRPC call is left alone");

/* The same endpoint drives three patterns: the download interception, and the
   two src checks that decide whether a tile gets a button at all. It was
   spelled out separately in each, which is how the download path got fixed
   for the new domain while the two src checks stayed on /fx and the button
   went on not appearing. */
for (const name of ["FLOW_VIDEO_SRC_PATTERN", "FLOW_IMAGE_SRC_PATTERN", "REDIRECT_URL_RE"]) {
  const decl = inj.match(new RegExp("const " + name + "\\s*=\\s*([^;]+);"));
  ok(decl && decl[1].includes("MEDIA_ENDPOINT"), name + " is built from the one endpoint, not its own copy");
}
ok(!/\/fx\\\/api/.test(inj.replace(/\/\/.*$/gm, "")),
   "no code path still hardcodes the /fx prefix");

/* 4b. A tile only gets its button if the image looks like generated media.
      That decision used to rest entirely on alt text matching /image/i —
      Flow's own label, which is localised, so a Hindi or Spanish UI failed it.
      Size is the second signal: chrome inside a tile is small, a generated
      image is not. Run the real function. */
const sizeSrc = inj.match(/function isTileSized\(img\) \{[\s\S]*?\n    \}/);
ok(sizeSrc, "flowInjector defines isTileSized");
const minPx = Number(inj.match(/const MIN_TILE_IMAGE_PX = (\d+);/)[1]);
const isTileSized = new Function("MIN_TILE_IMAGE_PX", sizeSrc[0] + "; return isTileSized;")(minPx);
const fakeImg = (nw, nh, rect) => ({ naturalWidth: nw, naturalHeight: nh, getBoundingClientRect: () => rect || { width: 0, height: 0 } });
ok(isTileSized(fakeImg(1280, 720)), "a generated image passes on its natural size");
ok(!isTileSized(fakeImg(24, 24)), "an icon does not");
ok(isTileSized(fakeImg(0, 0, { width: 320, height: 200 })), "an unloaded image falls back to its laid-out box");
ok(!isTileSized(fakeImg(400, 20)), "a wide thin strip is not a tile image");
ok(/img\.addEventListener\("load"/.test(inj),
   "an image that has not loaded yet is retried, not rejected");

/* 4c. The image path used to hard-require [data-tile-id] on the container —
      a Google-internal attribute, so a rename takes the button with it. It is
      preferred now, not required: anything that frames one piece of media
      qualifies, and a grid of them does not. */
const tileLikeSrc = inj.match(/function isTileLike\(host, media\) \{[\s\S]*?\n    \}/);
ok(tileLikeSrc, "flowInjector defines isTileLike");
const isTileLike = new Function("MIN_TILE_IMAGE_PX", "TILE_SELECTOR", "window",
  tileLikeSrc[0] + "; return isTileLike;")(minPx, "[data-tile-id]", { innerWidth: 1440, innerHeight: 900 });
const box = (w, h, opts = {}) => ({
  matches: (sel) => !!opts.isFlowTile && sel === "[data-tile-id]",
  getBoundingClientRect: () => ({ width: w, height: h }),
  querySelectorAll: () => ({ length: opts.mediaCount === undefined ? 1 : opts.mediaCount }),
});
ok(isTileLike(box(10, 10, { isFlowTile: true })), "Flow's own tile qualifies on its name alone");
ok(isTileLike(box(320, 200)), "a container framing one image qualifies without the attribute");
ok(!isTileLike(box(40, 40)), "something too small to hold a generated image does not");
ok(!isTileLike(box(1440, 900)), "the whole viewport is not a tile");
ok(!isTileLike(box(660, 300, { mediaCount: 3 })), "a grid of images is not one tile");
ok(!isTileLike(null), "no container at all is not a tile");
ok(/document\.querySelectorAll\("img"\)\.forEach\(tryAttachImage\)/.test(inj),
   "the initial scan is not scoped to the tile attribute either");

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
