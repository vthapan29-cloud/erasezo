/* Referral program: apply, review, attribute, pay once.
 *
 * Re-apply policy: a rejected application can be submitted again and returns
 * to pending. Pending and approved applications cannot be replaced.
 * Rejecting an approved partner clears the code. Past attributions stay.
 *
 * Password accounts are paid at signup — there is no verification email.
 * Google accounts are paid only when the account is created, which is after
 * Google has verified the email. A later sign-in does not pay again.
 *
 * Phase 2 (paid-plan bonus) is not granted. */
"use strict";
process.env.USE_PGMEM = "1";
process.env.JWT_SECRET = "test-secret";
process.env.REFERRAL_SIGNUP_CREDITS = "15";

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
const WHY = "I publish a weekly newsletter about image tools and would share Erasezo with those readers.";

async function credits(uid) {
  const r = (await db.query("select credit_balance, referral_credits, referred_by, referral_code from users where id=$1", [uid])).rows[0];
  const ledger = Number((await db.query("select coalesce(sum(delta),0)::int s from credit_ledger where user_id=$1 and reason='referral'", [uid])).rows[0].s);
  const n = Number((await db.query("select count(*)::int c from credit_ledger where user_id=$1 and reason='referral'", [uid])).rows[0].c);
  return {
    balance: Number(r.credit_balance),
    bonus: Number(r.referral_credits),
    referredBy: r.referred_by,
    code: r.referral_code,
    referralSum: ledger,
    referralRows: n,
  };
}

(async () => {
  await db.init();
  server = require("http").createServer(srv.app).listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const admin = jar();
  process.env.ADMIN_EMAIL = "owner@erasezo.com";
  process.env.ADMIN_PASSWORD = "OwnerPass123!x";
  await srv.ensureAdminFromEnv();
  assert.strictEqual((await req(admin, "/api/admin/login", { method: "POST", body: { email: "owner@erasezo.com", password: "OwnerPass123!x" } })).status, 200);

  const pub = path.join(__dirname, "../public");
  const page = fs.readFileSync(path.join(pub, "referral.html"), "utf8");
  const pageJs = fs.readFileSync(path.join(pub, "referral.js"), "utf8");
  const dash = fs.readFileSync(path.join(pub, "dashboard.js"), "utf8");
  assert.ok(!/erasio/i.test(page + pageJs), "the referral page does not use the other product's name");
  assert.ok(/Earn credits with Erasezo/.test(page), "the page is Erasezo's");
  assert.ok(!/\sstyle=/.test(page), "no inline style for the CSP to drop");
  assert.ok(!/300\s*credits/i.test(page), "the paid-plan bonus is not advertised as live");
  assert.ok(!/aren't open yet/.test(dash), "the dashboard no longer stops at a closed message");
  assert.ok(/\/referral/.test(dash), "the dashboard links to the application");
  console.log("ok - public copy is Erasezo's and does not invent a paid bonus");

  const home = await req(jar(), "/referral");
  assert.strictEqual(home.status, 200);
  assert.ok(/referral\.js/.test(await home.text()));
  const alias = await req(jar(), "/referral-program", { redirect: "manual" });
  assert.strictEqual(alias.status, 302);
  assert.strictEqual(alias.headers.get("location"), "/referral");
  console.log("ok - /referral is a page and /referral-program redirects to it");

  const program = await (await req(jar(), "/api/referral/program")).json();
  assert.strictEqual(program.signupCredits, 15);
  assert.strictEqual(program.paidBonus, null);
  assert.ok(!("email" in program) && !JSON.stringify(program).includes("@"), "the public program payload has no account data");
  console.log("ok - the public program endpoint exposes the reward and nothing about people");

  assert.strictEqual((await req(jar(), "/api/referral/apply", { method: "POST", body: {} })).status, 401, "apply needs a session");
  assert.strictEqual((await req(jar(), "/api/admin/referrals")).status, 401, "the queue is not public");

  const ada = jar();
  assert.strictEqual((await req(ada, "/api/auth/register", { method: "POST", body: { email: "ada@u.com", password: "UserPass123!", username: "ada" } })).status, 200);
  assert.strictEqual((await req(ada, "/api/admin/referrals")).status, 401, "a normal session cannot review applications");
  assert.strictEqual((await req(ada, "/api/admin/referrals/1/approve", { method: "POST", body: {} })).status, 401);

  const me0 = await (await req(ada, "/api/referral/me")).json();
  assert.strictEqual(me0.status, "none");
  assert.strictEqual(me0.referralCode, null);
  assert.ok(!("email" in me0), "the caller's own view does not grow an email field");

  assert.strictEqual((await req(ada, "/api/referral/apply", { method: "POST", body: { channel: "newsletter", why: "too short", acceptTerms: true } })).status, 400);
  assert.strictEqual((await req(ada, "/api/referral/apply", { method: "POST", body: { channel: "newsletter", why: WHY, acceptTerms: false } })).status, 400);
  assert.strictEqual((await req(ada, "/api/referral/apply", { method: "POST", body: { channel: "x", why: WHY, acceptTerms: true } })).status, 400);
  assert.strictEqual((await req(ada, "/api/referral/apply", { method: "POST", body: { channel: "newsletter", why: "y".repeat(2001), acceptTerms: true } })).status, 400);
  const applied = await (await req(ada, "/api/referral/apply", {
    method: "POST", body: { channel: "A weekly newsletter", audience: "about 2,000 readers", why: WHY, acceptTerms: true },
  })).json();
  assert.strictEqual(applied.status, "pending");
  assert.strictEqual(applied.referralCode, null, "applying does not mint a code");
  assert.strictEqual((await req(ada, "/api/referral/apply", { method: "POST", body: { channel: "A weekly newsletter", why: WHY, acceptTerms: true } })).status, 409);
  console.log("ok - apply validates, stays pending, and does not hand out a code");

  const queue = await (await req(admin, "/api/admin/referrals?status=pending")).json();
  const adaRow = queue.applications.find((a) => a.email === "ada@u.com");
  assert.ok(adaRow, "the pending queue shows the applicant to an admin");
  assert.strictEqual(adaRow.why, WHY);
  assert.ok(!("password_hash" in adaRow));

  const approved = await (await req(admin, "/api/admin/referrals/" + adaRow.userId + "/approve", { method: "POST", body: {} })).json();
  assert.strictEqual(approved.status, "approved");
  assert.ok(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(approved.referralCode));
  const again = await (await req(admin, "/api/admin/referrals/" + adaRow.userId + "/approve", { method: "POST", body: {} })).json();
  assert.strictEqual(again.referralCode, approved.referralCode, "approving twice keeps the same code");
  const adaMe = await (await req(ada, "/api/referral/me")).json();
  assert.strictEqual(adaMe.status, "approved");
  assert.strictEqual(adaMe.referralCode, approved.referralCode);
  assert.strictEqual(adaMe.signups, 0);
  assert.strictEqual(adaMe.creditsEarned, 0);
  assert.strictEqual((await req(ada, "/api/referral/apply", { method: "POST", body: { channel: "A weekly newsletter", why: WHY, acceptTerms: true } })).status, 409);
  console.log("ok - approval mints one code and the partner can see it");

  // A ref in the JSON body is not attribution. The cookie is.
  const sneaky = jar();
  const sneakyRes = await req(sneaky, "/api/auth/register", {
    method: "POST", body: { email: "sneaky@u.com", password: "UserPass123!", ref: approved.referralCode },
  });
  assert.strictEqual(sneakyRes.status, 200);
  const sneakyId = (await db.query("select id, referred_by from users where email='sneaky@u.com'")).rows[0];
  assert.strictEqual(sneakyId.referred_by, null, "a ref field in the body does not attribute");
  console.log("ok - attribution ignores a ref sent in the request body");

  const visit = jar();
  const landed = await req(visit, "/?ref=" + approved.referralCode);
  assert.ok(/HttpOnly/i.test((typeof landed.headers.getSetCookie === "function" ? landed.headers.getSetCookie() : []).join(";")), "the ref cookie is httpOnly");
  assert.strictEqual(visit.erasezo_ref, approved.referralCode);
  const newbie = await req(visit, "/api/auth/register", { method: "POST", body: { email: "new@u.com", password: "UserPass123!", username: "new" } });
  assert.strictEqual(newbie.status, 200);
  const newId = (await db.query("select id from users where email='new@u.com'")).rows[0].id;
  const adaId = adaRow.userId;
  let adaC = await credits(adaId);
  let newC = await credits(newId);
  assert.strictEqual(newC.referredBy, adaId, "referred_by is the partner");
  assert.strictEqual(adaC.referralRows, 1);
  assert.strictEqual(adaC.referralSum, 15);
  assert.strictEqual(adaC.bonus, 15);
  assert.strictEqual(adaC.balance, 30, "the signup reward sits on top of the daily allowance");

  await srv.grantDailyIfNeeded(adaId);
  adaC = await credits(adaId);
  assert.strictEqual(adaC.balance, 30, "the daily cap does not delete the referral reward");
  assert.strictEqual(adaC.bonus, 15);

  await srv.attributeReferral(newId, approved.referralCode);
  adaC = await credits(adaId);
  assert.strictEqual(adaC.referralRows, 1, "attributing the same signup again does not pay twice");
  assert.strictEqual(newC.referredBy, adaId);

  await srv.attributeReferral(adaId, approved.referralCode);
  const self = await credits(adaId);
  assert.strictEqual(self.referredBy, null, "a partner cannot be referred by their own code");
  assert.strictEqual(self.referralRows, 1, "self-referral does not pay");
  console.log("ok - a real signup pays 15 once, survives the daily cap, and self-referral pays nothing");

  const spent = await req(visit, "/api/credits/consume", { method: "POST", body: { amount: 1, note: "image" } });
  // That spent the NEW user's credits, not Ada's. Spend Ada's via a bearer-less cookie jar — visit's cookie was replaced by new@'s session.
  // Use Ada's jar.
  assert.strictEqual(spent.status, 200);
  await req(ada, "/api/credits/consume", { method: "POST", body: { amount: 4, note: "image" } });
  adaC = await credits(adaId);
  assert.strictEqual(adaC.bonus, 11, "spending draws down the protected referral credits");
  assert.strictEqual(adaC.balance, 26);
  await db.query("update users set credit_balance=500 where id=$1", [adaId]);
  await srv.grantDailyIfNeeded(adaId);
  adaC = await credits(adaId);
  assert.strictEqual(adaC.balance, 26, "a quota cap keeps unspent referral credits and drops the rest");
  assert.strictEqual(adaC.bonus, 11);
  // Put Ada back to a consistent balance so later ledger checks are about the reward, not this claw.
  console.log("ok - spending and a later quota cap both leave the unspent reward in place");

  const view = await (await req(ada, "/api/referral/me?userId=" + newId)).json();
  assert.strictEqual(view.signups, 1);
  assert.strictEqual(view.creditsEarned, 15);
  assert.ok(!JSON.stringify(view).includes("new@u.com"), "the partner's stats do not include the referred person's email");
  console.log("ok - the dashboard payload is counts, not the referred person's identity");

  // A second new account from the same cookie pays again. A different code cannot overwrite the first.
  const second = jar();
  second.erasezo_ref = approved.referralCode;
  await req(second, "/api/auth/register", { method: "POST", body: { email: "second@u.com", password: "UserPass123!" } });
  adaC = await credits(adaId);
  assert.strictEqual(adaC.referralRows, 2);
  assert.strictEqual(adaC.referralSum, 30);

  const bob = jar();
  await req(bob, "/api/auth/register", { method: "POST", body: { email: "bob@u.com", password: "UserPass123!" } });
  await req(bob, "/api/referral/apply", { method: "POST", body: { channel: "A podcast", why: WHY, acceptTerms: true } });
  const bobId = (await db.query("select id from users where email='bob@u.com'")).rows[0].id;
  const bobCode = (await (await req(admin, "/api/admin/referrals/" + bobId + "/approve", { method: "POST", body: {} })).json()).referralCode;
  assert.notStrictEqual(bobCode, approved.referralCode);
  const secondId = (await db.query("select id from users where email='second@u.com'")).rows[0].id;
  await srv.attributeReferral(secondId, bobCode);
  const still = (await db.query("select referred_by from users where id=$1", [secondId])).rows[0];
  assert.strictEqual(still.referred_by, adaId, "referred_by is set once");
  const bobC = await credits(bobId);
  assert.strictEqual(bobC.referralRows, 0, "the second partner was not paid for an account already attributed");
  console.log("ok - a second partner cannot take over an account that was already referred");

  // Google: a brand-new account is paid; merging into an existing one is not.
  const g = await srv.mergeOrCreateGoogleUser(
    { email: "g@u.com", sub: "gid-ref", name: "Gee", email_verified: true },
    approved.referralCode
  );
  const gRow = (await db.query("select referred_by from users where id=$1", [g])).rows[0];
  assert.strictEqual(gRow.referred_by, adaId);
  await srv.mergeOrCreateGoogleUser({ email: "g@u.com", sub: "gid-ref", email_verified: true }, approved.referralCode);
  adaC = await credits(adaId);
  assert.strictEqual(adaC.referralRows, 3, "the Google account paid once, including the two password signups");
  const beforeMerge = adaC.referralRows;
  await srv.mergeOrCreateGoogleUser({ email: "sneaky@u.com", sub: "gid-sneaky", email_verified: true }, approved.referralCode);
  adaC = await credits(adaId);
  assert.strictEqual(adaC.referralRows, beforeMerge, "linking Google onto an existing account is not a new referral");
  console.log("ok - a new Google account pays once; a merge into an existing account does not");

  process.env.REFERRAL_SIGNUP_CREDITS = "7";
  const seven = jar();
  seven.erasezo_ref = approved.referralCode;
  await req(seven, "/api/auth/register", { method: "POST", body: { email: "seven@u.com", password: "UserPass123!" } });
  adaC = await credits(adaId);
  assert.strictEqual(adaC.referralSum, 30 + 15 + 7, "the reward amount follows REFERRAL_SIGNUP_CREDITS");
  process.env.REFERRAL_SIGNUP_CREDITS = "15";
  console.log("ok - the signup reward is the configured amount");

  // Reject, re-apply, approve again with a new code.
  const rej = await req(admin, "/api/admin/referrals/" + bobId + "/reject", { method: "POST", body: { reason: "No public page yet" } });
  assert.strictEqual(rej.status, 200);
  const bobAfter = await (await req(bob, "/api/referral/me")).json();
  assert.strictEqual(bobAfter.status, "rejected");
  assert.strictEqual(bobAfter.rejectReason, "No public page yet");
  assert.strictEqual(bobAfter.referralCode, null);
  assert.strictEqual((await db.query("select referral_code from users where id=$1", [bobId])).rows[0].referral_code, null);
  const re = await (await req(bob, "/api/referral/apply", { method: "POST", body: { channel: "A podcast", why: WHY, acceptTerms: true } })).json();
  assert.strictEqual(re.status, "pending", "a rejected applicant can apply again");
  const reCode = (await (await req(admin, "/api/admin/referrals/" + bobId + "/approve", { method: "POST", body: {} })).json()).referralCode;
  assert.ok(reCode && reCode !== bobCode, "re-approval mints a new code");
  console.log("ok - reject stores a reason, clears the code, and allows a new application");

  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  const evil = await req(jar(), "/api/auth/google?next=https://evil.example/phish", { redirect: "manual" });
  const evilCookies = decodeURIComponent((typeof evil.headers.getSetCookie === "function" ? evil.headers.getSetCookie() : []).join(";"));
  assert.ok(!/erasezo_next=https/.test(evilCookies), "an off-site next= is not stored");
  const okNext = await req(jar(), "/api/auth/google?next=/referral", { redirect: "manual" });
  const okCookies = decodeURIComponent((typeof okNext.headers.getSetCookie === "function" ? okNext.headers.getSetCookie() : []).join(";"));
  assert.ok(/erasezo_next=\/referral/.test(okCookies), "a same-site next= is kept for the Google return");
  console.log("ok - the post-login return path cannot be an open redirect");

  let limited = false;
  for (let i = 0; i < 20; i++) {
    const r = await req(ada, "/api/referral/apply", { method: "POST", body: { channel: "x", why: "no", acceptTerms: true } });
    if (r.status === 429) { limited = true; assert.ok(r.headers.get("retry-after")); break; }
  }
  assert.ok(limited, "apply is rate limited");
  console.log("ok - apply is rate limited");

  server.close();
  console.log("\nALL REFERRAL TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST FAIL:", (e && e.stack) || e); try { server && server.close(); } catch (_) {} process.exit(1); });
