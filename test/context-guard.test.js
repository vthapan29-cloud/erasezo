/* What happens to a content script when its extension is reloaded underneath
 * it. The whole trap is that chrome.storage and chrome.runtime are still
 * present as objects, so a presence check passes and the call then throws
 * "Extension context invalidated" — which is exactly how a four-second poll
 * ended up filling the extension's error page.
 *
 * The guard runs for real here against a fake chrome whose context can be
 * killed mid-test, because "does it stop throwing" is not a question the
 * source answers by inspection. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ext = path.join(__dirname, "../../Erasezo-extension");
const ok = (c, m) => { if (!c) { console.error("FAIL - " + m); process.exit(1); } console.log("ok - " + m); };
if (!fs.existsSync(ext)) { console.log("skip: extension folder not present"); process.exit(0); }

const src = fs.readFileSync(path.join(ext, "contextGuard.js"), "utf8");

// A chrome that behaves the way Chrome's really does: the objects survive, the
// id disappears, and every call throws from then on.
function makeChrome() {
  const calls = [];
  const boom = () => { throw new Error("Extension context invalidated."); };
  const c = {
    _live: true,
    runtime: {
      get id() { return c._live ? "abcdef" : undefined; },
      sendMessage: (...a) => { if (!c._live) boom(); calls.push(["sendMessage", a[0]]); const cb = a[a.length - 1]; if (typeof cb === "function") cb({ ok: true }); },
      getURL: (p) => { if (!c._live) boom(); return "chrome-extension://x/" + p; },
      onMessage: { addListener: () => { if (!c._live) boom(); calls.push(["onMessage"]); } },
    },
    storage: {
      local: {
        get: (k, cb) => { if (!c._live) boom(); calls.push(["get", k]); if (cb) cb({ hit: 1 }); else return Promise.resolve({ hit: 1 }); },
        set: (o, cb) => { if (!c._live) boom(); calls.push(["set", o]); if (cb) cb(); },
        remove: (k, cb) => { if (!c._live) boom(); calls.push(["remove", k]); if (cb) cb(); },
        clear: (cb) => { if (!c._live) boom(); calls.push(["clear"]); if (cb) cb(); },
      },
      onChanged: { addListener: () => { if (!c._live) boom(); calls.push(["onChanged"]); } },
    },
    _calls: calls,
  };
  return c;
}

const chrome = makeChrome();
const sandbox = { chrome, Promise, console };
sandbox.globalThis = sandbox;
vm.runInContext(src, vm.createContext(sandbox));

/* Alive: the guard has to be invisible. */
let got = null;
chrome.storage.local.get(["a"], (r) => { got = r; });
assert.deepStrictEqual(got, { hit: 1 }, "callback still receives the real value");
ok(chrome.runtime.getURL("icons/x.png") === "chrome-extension://x/icons/x.png",
   "a live context is passed through untouched");
ok(chrome._calls.length === 1, "exactly one real call reached chrome");

/* A real error, raised while the context is alive, must not be swallowed —
   hiding those would turn every genuine bug into a silent no-op. Its own
   chrome and its own guard, so the wrapping stays single. */
{
  const c2 = makeChrome();
  c2.storage.local.set = () => { throw new Error("quota exceeded"); };
  const s2 = { chrome: c2, Promise, console };
  s2.globalThis = s2;
  vm.runInContext(src, vm.createContext(s2));
  assert.throws(() => c2.storage.local.set({ a: 1 }), /quota exceeded/,
    "an error from a live context is re-thrown");
  ok(true, "a genuine error is not absorbed");
}

/* Now pull the extension out from under it. */
chrome._live = false;
const before = chrome._calls.length;

let cbRan = false, cbArg = "untouched";
assert.doesNotThrow(() => chrome.storage.local.remove(["k"], (r) => { cbRan = true; cbArg = r; }),
  "the call that started this — storage.remove on a dead context — no longer throws");
ok(cbRan && cbArg === undefined, "its callback still runs, with undefined, so nothing waits forever");

assert.doesNotThrow(() => chrome.runtime.sendMessage({ a: 1 }, () => {}), "sendMessage is safe too");
assert.doesNotThrow(() => chrome.storage.onChanged.addListener(() => {}), "so is registering a listener");
assert.doesNotThrow(() => chrome.runtime.getURL("x.png"), "and getURL");
ok(chrome._calls.length === before, "nothing reached the dead extension");

(async () => {
  const p = chrome.storage.local.get(["a"]);
  ok(p && typeof p.then === "function", "the promise form still returns a promise");
  ok((await p) === undefined, "which resolves undefined rather than rejecting");

  /* The bug was a repeating timer, so surviving one call is not enough. */
  for (let i = 0; i < 50; i++) chrome.storage.local.remove(["k"], () => {});
  ok(chrome._calls.length === before, "fifty more polls are still silent");

  console.log("\nALL CONTEXT-GUARD TESTS PASSED");
})();
