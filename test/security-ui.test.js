/* Security tab: what a Google-only account sees, and what a password account
 * can do with the change form. Runs the real dashboard script against a small
 * DOM stand-in — no browser, no extra dependency. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "../public/dashboard.js"), "utf8");

assert.ok(!SRC.includes("no password to change here"), "the dead-end Google copy is gone");
assert.ok(!/renderSecurity[\s\S]*style=/.test(SRC), "the security view adds no inline style attributes");

function classList() {
  const set = new Set();
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
  };
}

function makeEl(tag) {
  const el = {
    tag,
    children: [],
    className: "",
    textContent: "",
    id: "",
    type: "",
    value: "",
    autocomplete: "",
    htmlFor: "",
    disabled: false,
    hidden: false,
    listeners: {},
    attrs: {},
    classList: classList(),
    style: {},
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
  };
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return html; },
    set(v) { html = String(v); if (html === "") el.children = []; },
  });
  return el;
}

function textOf(node) {
  if (!node) return "";
  if (node.children && node.children.length) return node.children.map(textOf).join(" ");
  return node.textContent || "";
}

function walk(node, pred, out) {
  out = out || [];
  if (pred(node)) out.push(node);
  (node.children || []).forEach((c) => walk(c, pred, out));
  return out;
}

function mount(user, calls) {
  const ids = {};
  ["nav", "sideWho", "signout", "menuBtn", "scrim", "viewTitle", "planPill", "adminLink", "view", "toast"].forEach((id) => {
    ids[id] = makeEl(id === "nav" || id === "view" ? "div" : "div");
    ids[id].id = id;
  });
  const document = {
    body: makeEl("body"),
    getElementById(id) { return ids[id] || null; },
    createElement(tag) { return makeEl(tag); },
    createTextNode(t) { return { textContent: String(t), children: [] }; },
    importNode(n) { return n; },
  };
  const location = { hash: "#security", href: "http://127.0.0.1/dashboard#security", origin: "http://127.0.0.1" };
  function fetch(url, opts) {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method: (opts && opts.method) || "GET", body });
    if (url === "/api/me") return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(user) });
    const res = (calls.scripted && calls.scripted[String(url)]) || { ok: true, status: 200, body: { ok: true } };
    return Promise.resolve({
      ok: res.ok, status: res.status,
      text: async () => JSON.stringify(res.body == null ? {} : res.body),
    });
  }
  const sandbox = {
    console, setTimeout, clearTimeout,
    document, location, fetch,
    history: { replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    DOMParser: class { parseFromString() { return { documentElement: makeEl("svg") }; } },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (ev, fn) => { sandbox.listeners = sandbox.listeners || {}; sandbox.listeners[ev] = fn; };
  sandbox.scrollTo = () => {};
  vm.runInNewContext(SRC, sandbox, { filename: "dashboard.js" });
  return { ids, document };
}

async function settle() {
  await new Promise((r) => setTimeout(r, 30));
}

function viewText(ids) { return textOf(ids.view); }

async function screen(user) {
  const calls = [];
  const mounted = mount(user, calls);
  await settle();
  return { calls, text: viewText(mounted.ids), view: mounted.ids.view, toast: mounted.ids.toast };
}

function submit(view) {
  const form = walk(view, (n) => n.tag === "form")[0];
  assert.ok(form, "security renders a password form");
  form.listeners.submit({ preventDefault() {} });
  return form;
}

(async () => {
  const google = {
    email: "g@x.com", username: "g", plan: "pro", planName: "Pro",
    authProvider: "google", googleId: "gid-1", hasPassword: false, isAdmin: false,
    credits: { unlimited: true, balance: 0, dailyQuota: 0 },
  };
  const password = {
    email: "a@x.com", username: "alpha", plan: "free", planName: "Free",
    authProvider: "password", googleId: null, hasPassword: true, isAdmin: false,
    credits: { unlimited: false, balance: 15, dailyQuota: 15 },
  };
  const both = Object.assign({}, password, { authProvider: "password", googleId: "gid-merged", hasPassword: true, email: "both@x.com" });

  const g = await screen(google);
  assert.ok(g.text.includes("Sign-in methods"), "google: sign-in methods heading");
  assert.ok(g.text.includes("Google") && g.text.includes("Connected"), "google: Google is connected");
  assert.ok(g.text.includes("Email and password") && g.text.includes("Not set"), "google: password is not set");
  assert.ok(g.text.includes("Add a password"), "google: add-password action");
  assert.ok(g.text.includes("Google sign-in stays as it is"), "google: adding a password does not drop Google");
  assert.ok(!g.text.includes("Current password"), "google: no current-password field");
  assert.ok(!g.text.includes("Update password"), "google: no change-password action");
  assert.ok(g.text.includes("This browser") && g.text.includes("Sign out"), "google: sign-out is available");
  assert.ok(!g.text.includes("To link Google"), "google: no prompt to link a provider that is already linked");
  const gInputs = walk(g.view, (n) => n.tag === "input");
  assert.strictEqual(gInputs.length, 2, "google: new password and confirmation only");
  assert.deepStrictEqual(gInputs.map((i) => i.autocomplete), ["new-password", "new-password"]);
  assert.strictEqual(walk(g.view, (n) => n.tag === "label")[0].htmlFor, gInputs[0].id, "label points at the field");
  console.log("ok - Google-only security view offers sign-in methods and add-password, not change-password");

  const mismatch = await screen(google);
  const gForm = submit(mismatch.view);
  const badInputs = walk(gForm, (n) => n.tag === "input");
  badInputs[0].value = "short";
  badInputs[1].value = "short";
  gForm.listeners.submit({ preventDefault() {} });
  assert.ok(textOf(mismatch.view).includes("at least 8 characters"), "short password is refused in the form");
  badInputs[0].value = "long-enough-password";
  badInputs[1].value = "different-password";
  gForm.listeners.submit({ preventDefault() {} });
  assert.ok(textOf(mismatch.view).includes("don't match"), "mismatched confirmation is refused in the form");
  assert.strictEqual(mismatch.calls.filter((c) => c.url === "/api/user/password").length, 0, "invalid add-password does not call the API");
  console.log("ok - add-password form checks length and confirmation before calling the API");

  const adding = await screen(google);
  const addForm = walk(adding.view, (n) => n.tag === "form")[0];
  const addInputs = walk(addForm, (n) => n.tag === "input");
  addInputs[0].value = "google-pass-123";
  addInputs[1].value = "google-pass-123";
  addForm.listeners.submit({ preventDefault() {} });
  await settle();
  const post = adding.calls.filter((c) => c.url === "/api/user/password");
  assert.strictEqual(post.length, 1, "one set request");
  assert.strictEqual(post[0].method, "POST");
  assert.deepStrictEqual(post[0].body, { newPassword: "google-pass-123" }, "set sends the new password only");
  assert.ok(textOf(adding.view).includes("Current password"), "after adding, the view becomes change-password");
  assert.ok(textOf(adding.view).includes("On"), "password method flips to on");
  assert.strictEqual(adding.toast.textContent, "Password added. You can sign in with your email as well.");
  console.log("ok - adding a password posts once and then shows the change form");

  const p = await screen(password);
  assert.ok(p.text.includes("Not connected"), "password account: Google is not linked");
  assert.ok(p.text.includes("To link Google"), "password account: explains how Google linking actually works");
  assert.ok(p.text.includes("On") && p.text.includes("Sign in with a@x.com."), "password account: email sign-in is on");
  assert.ok(p.text.includes("Change password") && p.text.includes("Current password"), "password account: change form");
  assert.ok(p.text.includes("Update password"), "password account: update action");
  assert.ok(!p.text.includes("Add a password"), "password account: no set-password action");
  const pInputs = walk(p.view, (n) => n.tag === "input");
  assert.strictEqual(pInputs.length, 3, "current, new, confirm");
  assert.strictEqual(pInputs[0].autocomplete, "current-password");
  assert.strictEqual(pInputs[1].autocomplete, "new-password");
  assert.strictEqual(pInputs[2].autocomplete, "new-password");
  console.log("ok - password account sees a change form and an unlinked Google method");

  const pForm = walk(p.view, (n) => n.tag === "form")[0];
  pForm.listeners.submit({ preventDefault() {} });
  assert.ok(textOf(p.view).includes("Enter your current password."), "empty change asks for the current password");
  pInputs[0].value = "password123";
  pInputs[1].value = "newpassword123";
  pInputs[2].value = "newpassword123";
  pForm.listeners.submit({ preventDefault() {} });
  await settle();
  const patch = p.calls.filter((c) => c.url === "/api/user/password");
  assert.strictEqual(patch.length, 1);
  assert.strictEqual(patch[0].method, "PATCH");
  assert.deepStrictEqual(patch[0].body, { currentPassword: "password123", newPassword: "newpassword123" });
  assert.ok(textOf(p.view).includes("Password updated."));
  assert.strictEqual(pInputs[0].value, "", "fields clear after a successful change");
  console.log("ok - change form patches current + new password and confirms");

  const failCalls = [];
  failCalls.scripted = { "/api/user/password": { ok: false, status: 400, body: { error: "wrong_current_password" } } };
  const fail = mount(password, failCalls);
  await settle();
  const failForm = walk(fail.ids.view, (n) => n.tag === "form")[0];
  const failInputs = walk(failForm, (n) => n.tag === "input");
  failInputs[0].value = "wrong";
  failInputs[1].value = "newpassword123";
  failInputs[2].value = "newpassword123";
  failForm.listeners.submit({ preventDefault() {} });
  await settle();
  assert.ok(textOf(fail.ids.view).includes("Current password is incorrect."), "server refusal is shown in the form");
  console.log("ok - a wrong current password is reported in the form");

  const linked = await screen(both);
  assert.ok(linked.text.includes("Connected") && linked.text.includes("On"), "linked account shows both methods");
  assert.ok(linked.text.includes("Google sign-in stays linked."), "change copy keeps Google linked");
  assert.ok(linked.text.includes("Current password") && !linked.text.includes("Add a password"), "linked password account still changes, not sets");
  console.log("ok - an account with both Google and a password can change the password");

  console.log("\nALL SECURITY UI TESTS PASSED");
})().catch((e) => { console.error("TEST FAIL:", e && e.stack || e); process.exit(1); });
