/* Erasezo Admin auth — login/signup modal, session state, admin gate, cloud sync.
 * Sits on top of window.SB (admin/supabase.js). Separate from erasio.io auth.
 *
 * Admin gate: the client checks ADMIN_EMAILS purely to decide what UI to show.
 * The DATABASE is the real gate — the is_admin() RLS policy in schema.sql means
 * a non-admin session simply gets zero rows / permission denied on every table,
 * so nothing sensitive leaks even if the UI were bypassed.
 *
 * Hardening in this file (on top of that DB gate):
 *   - Mandatory TOTP 2FA for admin accounts — a password (or Google) sign-in
 *     alone is never enough; the UI stays locked until an "aal2" session is
 *     reached, checked on EVERY path that could grant admin (fresh login,
 *     page reload, MFA verify) — not just the login button's own handler.
 *   - Strong password policy enforced client-side on signup.
 *   - Client-side lockout with exponential backoff on repeated failed
 *     sign-in / MFA-code attempts, persisted so a page reload doesn't reset it.
 */
(function () {
  "use strict";

  var CFG = window.ERASIO_ADMIN_CONFIG || {};
  var ADMIN_EMAILS = (CFG.ADMIN_EMAILS || []).map(function (e) { return String(e).toLowerCase().trim(); });

  var listeners = [];
  // Restrictive defaults: nothing gated is visible until the server confirms a
  // role AND (for admins) an aal2 session. needsMfa distinguishes "not an
  // admin at all" from "is an admin, but must still complete 2FA".
  var state = { ready: false, verifying: true, user: null, userId: null, role: "anonymous", plan: null, isAdmin: false, needsMfa: false };

  function isAdminEmail(email) { return !!email && ADMIN_EMAILS.indexOf(String(email).toLowerCase().trim()) !== -1; }
  function setState(patch) { Object.assign(state, patch); listeners.forEach(function (cb) { try { cb(state); } catch (e) {} }); }

  /* ---- storage (chrome.storage.local, localStorage fallback for preview) ---- */
  var HAS_CHROME = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  /* ---- lockout (chrome.storage-backed, exponential backoff) ---- */
  var LOCK_KEY = "sb.admin.lockout";
  function sget(keys) { return new Promise(function (res) { if (HAS_CHROME) chrome.storage.local.get(keys, res); else { var o = {}; (keys || []).forEach(function (k) { try { o[k] = JSON.parse(localStorage.getItem(k)); } catch (e) {} }); res(o); } }); }
  function sset(obj) { return new Promise(function (res) { if (HAS_CHROME) chrome.storage.local.set(obj, res); else { Object.keys(obj).forEach(function (k) { localStorage.setItem(k, JSON.stringify(obj[k])); }); res(); } }); }
  function sremove(keys) { return new Promise(function (res) { if (HAS_CHROME) chrome.storage.local.remove(keys, res); else { keys.forEach(function (k) { localStorage.removeItem(k); }); res(); } }); }
  function mk(k, v) { var o = {}; o[k] = v; return o; }

  function lockoutState(bucket) {
    return sget([LOCK_KEY]).then(function (o) { return (o[LOCK_KEY] && o[LOCK_KEY][bucket]) || { fails: 0, until: 0 }; });
  }
  function lockoutCheck(bucket) {
    return lockoutState(bucket).then(function (l) {
      var remaining = l.until - Date.now();
      return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    });
  }
  function lockoutFail(bucket) {
    return sget([LOCK_KEY]).then(function (o) {
      var all = o[LOCK_KEY] || {};
      var l = all[bucket] || { fails: 0, until: 0 };
      l.fails += 1;
      // 5 free tries, then exponential backoff: 5s, 10s, 20s, 40s ... capped at 5 min.
      var delaySec = l.fails > 5 ? Math.min(300, 5 * Math.pow(2, l.fails - 6)) : 0;
      l.until = delaySec ? Date.now() + delaySec * 1000 : 0;
      all[bucket] = l;
      return sset(mk(LOCK_KEY, all)).then(function () { return l; });
    });
  }
  function lockoutReset(bucket) {
    return sget([LOCK_KEY]).then(function (o) {
      var all = o[LOCK_KEY] || {}; delete all[bucket];
      return sset(mk(LOCK_KEY, all));
    });
  }

  /* ---- password policy ---- */
  function passwordIssue(pw) {
    if (pw.length < 12) return "Password must be at least 12 characters.";
    if (!/[a-z]/.test(pw)) return "Include at least one lowercase letter.";
    if (!/[A-Z]/.test(pw)) return "Include at least one uppercase letter.";
    if (!/[0-9]/.test(pw)) return "Include at least one number.";
    if (!/[^A-Za-z0-9]/.test(pw)) return "Include at least one symbol.";
    return null;
  }

  /* ---- modal styles (injected once) ---- */
  function ensureStyles() {
    if (document.getElementById("sbm-style")) return;
    var s = document.createElement("style"); s.id = "sbm-style";
    s.textContent = [
      ".sbm-ov{position:fixed;inset:0;z-index:100;display:flex;align-items:flex-start;justify-content:center;padding:60px 16px;background:rgba(10,18,17,.5);backdrop-filter:blur(3px)}",
      ".sbm-card{width:100%;max-width:420px;background:var(--surface,#fff);color:var(--ink,#10201e);border:1px solid var(--border,#d3dedc);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;font-family:'IBM Plex Sans',system-ui,sans-serif}",
      ".sbm-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border,#d3dedc)}",
      ".sbm-head h3{font-family:'Chivo',sans-serif;font-weight:700;font-size:1.15rem;margin:0}",
      ".sbm-x{background:none;border:0;color:var(--ink-faint,#7b8b89);font-size:20px;cursor:pointer;line-height:1}",
      ".sbm-body{padding:22px}",
      ".sbm-sub{color:var(--ink-soft,#4a5a58);font-size:.9rem;margin:0 0 18px}",
      ".sbm-lab{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-faint,#7b8b89);margin:14px 0 6px;display:block}",
      ".sbm-inwrap{position:relative;display:flex;align-items:center}",
      ".sbm-inwrap svg{position:absolute;left:12px;width:16px;height:16px;stroke:var(--ink-faint,#7b8b89);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
      ".sbm-in{width:100%;padding:12px 12px 12px 38px;background:var(--surface-2,#f6f9f8);border:1px solid var(--border,#d3dedc);border-radius:10px;color:var(--ink,#10201e);font:400 .95rem 'IBM Plex Sans',sans-serif}",
      ".sbm-in.sbm-in-plain{padding-left:12px}",
      ".sbm-in:focus{outline:2px solid var(--accent,#38bdf8);outline-offset:0;border-color:var(--accent,#38bdf8)}",
      ".sbm-eye{position:absolute;right:10px;background:none;border:0;cursor:pointer;color:var(--ink-faint,#7b8b89);padding:6px}",
      ".sbm-eye svg{position:static;stroke:currentColor}",
      ".sbm-btn{width:100%;margin-top:20px;padding:13px;border:0;border-radius:11px;background:var(--accent,#38bdf8);color:#04302e;font:700 1rem 'IBM Plex Sans',sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}",
      ".sbm-btn:disabled{opacity:.6;cursor:default}",
      ".sbm-btn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
      ".sbm-foot{text-align:center;margin-top:18px;color:var(--ink-soft,#4a5a58);font-size:.88rem}",
      ".sbm-link{color:var(--accent-ink,#06736f);background:none;border:0;cursor:pointer;font:600 .88rem 'IBM Plex Sans',sans-serif}",
      ".sbm-err{margin-top:14px;padding:10px 12px;border-radius:9px;background:rgba(192,69,58,.1);border:1px solid rgba(192,69,58,.4);color:#c0453a;font-size:.85rem;display:none}",
      ".sbm-err.show{display:block}",
      ".sbm-ok{margin-top:14px;padding:10px 12px;border-radius:9px;background:rgba(31,157,107,.1);border:1px solid rgba(31,157,107,.4);color:#1f9d6b;font-size:.85rem;display:none}",
      ".sbm-ok.show{display:block}",
      ".sbm-hint{color:var(--ink-faint,#7b8b89);font-size:.78rem;margin-top:6px;line-height:1.4}",
      ".sbm-qr{display:flex;justify-content:center;margin:6px 0 12px;background:#fff;border-radius:12px;padding:14px}",
      ".sbm-qr img{width:180px;height:180px;display:block}",
      ".sbm-secret{font-family:'IBM Plex Mono',monospace;font-size:.78rem;word-break:break-all;background:var(--surface-2,#f6f9f8);border:1px solid var(--border,#d3dedc);border-radius:8px;padding:8px 10px;user-select:all}",
      ".sbm-code-in{letter-spacing:.4em;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:1.1rem}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function svg(paths) {
    var d = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' + paths + "</svg>", "image/svg+xml");
    return document.importNode(d.documentElement, true);
  }
  var IC = {
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>',
    lock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
    shield: '<path d="M12 2 3 6v6c0 5 3.5 8.5 9 10 5.5-1.5 9-5 9-10V6l-9-4Z"/><path d="m9 12 2 2 4-4"/>'
  };

  var overlay = null, mode = "signin";
  // Two-factor context carried between the credentials step and the MFA step
  // for the SAME login attempt (not persisted — cleared on modal close).
  var pendingFactorId = null, pendingIsEnroll = false;

  function closeModal() { if (overlay) { overlay.remove(); overlay = null; } pendingFactorId = null; pendingIsEnroll = false; }

  function shell(title) {
    ensureStyles();
    closeModal();
    overlay = document.createElement("div"); overlay.className = "sbm-ov";
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeModal(); });
    var card = document.createElement("div"); card.className = "sbm-card"; overlay.appendChild(card);
    var head = document.createElement("div"); head.className = "sbm-head";
    var h3 = document.createElement("h3"); h3.textContent = title;
    var x = document.createElement("button"); x.className = "sbm-x"; x.textContent = "✕"; x.addEventListener("click", closeModal);
    head.appendChild(h3); head.appendChild(x); card.appendChild(head);
    var body = document.createElement("div"); body.className = "sbm-body"; card.appendChild(body);
    document.body.appendChild(overlay);
    return body;
  }

  /* ---- step 1: credentials (email/password or Google) ---- */
  function openModal() {
    mode = mode === "signup" ? "signup" : "signin";
    var body = shell(mode === "signup" ? "Create admin account" : "Sign in to Erasezo Admin");

    var sub = document.createElement("p"); sub.className = "sbm-sub";
    sub.textContent = "Owner account, protected by mandatory two-factor authentication.";
    body.appendChild(sub);

    body.appendChild(labeled("Email"));
    var emailWrap = inWrap(IC.mail);
    var email = input("email", "you@example.com"); emailWrap.appendChild(email); body.appendChild(emailWrap);

    body.appendChild(labeled("Password"));
    var pwWrap = inWrap(IC.lock);
    var pw = input("password", "••••••••"); pwWrap.appendChild(pw);
    var eye = document.createElement("button"); eye.type = "button"; eye.className = "sbm-eye"; eye.appendChild(svg(IC.eye));
    eye.addEventListener("click", function () { pw.type = pw.type === "password" ? "text" : "password"; });
    pwWrap.appendChild(eye); body.appendChild(pwWrap);
    if (mode === "signup") {
      var hint = document.createElement("p"); hint.className = "sbm-hint";
      hint.textContent = "At least 12 characters, with upper & lower case, a number, and a symbol.";
      body.appendChild(hint);
    }

    var err = document.createElement("div"); err.className = "sbm-err"; body.appendChild(err);
    var ok = document.createElement("div"); ok.className = "sbm-ok"; body.appendChild(ok);
    function showErr(m) { err.textContent = m; err.classList.add("show"); ok.classList.remove("show"); }
    function showOk(m) { ok.textContent = m; ok.classList.add("show"); err.classList.remove("show"); }

    var btn = document.createElement("button"); btn.className = "sbm-btn";
    btn.appendChild(svg(IC.login));
    btn.appendChild(document.createTextNode(mode === "signup" ? "Create account" : "Sign in"));
    body.appendChild(btn);

    function guardConfigured() {
      if (!window.SB || !SB.configured()) { showErr("Supabase is not configured yet. Fill admin/config.js — see admin/SETUP.md."); return false; }
      return true;
    }

    btn.addEventListener("click", function () {
      if (!guardConfigured()) return;
      var e = email.value.trim(), p = pw.value;
      if (!e || !p) { showErr("Enter email and password."); return; }
      var bucket = "cred:" + e.toLowerCase();

      lockoutCheck(bucket).then(function (waitSec) {
        if (waitSec > 0) { showErr("Too many attempts. Try again in " + waitSec + "s."); return; }

        if (mode === "signup") {
          var issue = passwordIssue(p);
          if (issue) { showErr(issue); return; }
        }

        btn.disabled = true;
        var op = mode === "signup" ? SB.signUp(e, p) : SB.signIn(e, p);
        op.then(function (r) {
          if (mode === "signup" && (!r || !r.access_token)) {
            showOk("Account created. Check your email to confirm, then sign in."); mode = "signin"; btn.disabled = false; return;
          }
          lockoutReset(bucket);
          return proceedPastCredentials();
        }).catch(function (er) {
          lockoutFail(bucket);
          showErr(er.message || "Sign-in failed."); btn.disabled = false;
        });
      });
    });

    // No Google sign-in for the super admin panel on purpose — a single,
    // fully-owned credential (password + mandatory TOTP) is the smaller
    // attack surface for an account this sensitive.

    var foot = document.createElement("div"); foot.className = "sbm-foot";
    foot.appendChild(document.createTextNode(mode === "signup" ? "Already have an account? " : "Need an owner account? "));
    var toggle = document.createElement("button"); toggle.className = "sbm-link";
    toggle.textContent = mode === "signup" ? "Sign in" : "Create account";
    toggle.addEventListener("click", function () { mode = mode === "signup" ? "signin" : "signup"; openModal(); });
    foot.appendChild(toggle); body.appendChild(foot);

    setTimeout(function () { email.focus(); }, 30);
  }

  // After ANY successful credential step (password or Google) — figure out
  // whether MFA is still owed before granting anything.
  function proceedPastCredentials() {
    return checkMfaGate(/* fromCredentialsStep */ true);
  }

  /* ---- step 2a: MFA code challenge (an existing verified factor) ---- */
  function openMfaChallenge(factorId) {
    pendingFactorId = factorId; pendingIsEnroll = false;
    var body = shell("Two-factor code");
    var sub = document.createElement("p"); sub.className = "sbm-sub";
    sub.textContent = "Enter the 6-digit code from your authenticator app.";
    body.appendChild(sub);

    var codeWrap = inWrap(IC.shield);
    var code = input("text", "000000"); code.className += " sbm-code-in"; code.maxLength = 6; code.inputMode = "numeric"; code.autocomplete = "one-time-code";
    codeWrap.appendChild(code); body.appendChild(codeWrap);

    var err = document.createElement("div"); err.className = "sbm-err"; body.appendChild(err);
    function showErr(m) { err.textContent = m; err.classList.add("show"); }

    var btn = document.createElement("button"); btn.className = "sbm-btn";
    btn.appendChild(svg(IC.shield)); btn.appendChild(document.createTextNode("Verify"));
    body.appendChild(btn);

    var bucket = "mfa:" + factorId;
    function submit() {
      var c = code.value.trim();
      if (!/^\d{6}$/.test(c)) { showErr("Enter the 6-digit code."); return; }
      lockoutCheck(bucket).then(function (waitSec) {
        if (waitSec > 0) { showErr("Too many attempts. Try again in " + waitSec + "s."); return; }
        btn.disabled = true;
        SB.mfaChallengeAndVerify(factorId, c).then(function () {
          lockoutReset(bucket);
          return afterAuth().then(closeModal);
        }).catch(function (er) {
          lockoutFail(bucket);
          showErr(er.message || "Invalid code."); btn.disabled = false; code.value = ""; code.focus();
        });
      });
    }
    btn.addEventListener("click", submit);
    code.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

    var foot = document.createElement("div"); foot.className = "sbm-foot";
    var back = document.createElement("button"); back.className = "sbm-link"; back.textContent = "Sign out and use a different account";
    back.addEventListener("click", function () { Auth.signOut().then(closeModal); });
    foot.appendChild(back); body.appendChild(foot);

    setTimeout(function () { code.focus(); }, 30);
  }

  /* ---- step 2b: MFA enrollment (admin has no verified factor yet — required) ---- */
  function openMfaEnroll() {
    var body = shell("Set up two-factor authentication");
    var sub = document.createElement("p"); sub.className = "sbm-sub";
    sub.textContent = "Required for admin accounts. Scan this with Google Authenticator, Authy, 1Password, or similar, then enter the code it shows.";
    body.appendChild(sub);

    var loading = document.createElement("p"); loading.className = "sbm-hint"; loading.textContent = "Generating your QR code…";
    body.appendChild(loading);

    SB.mfaEnroll().then(function (f) {
      loading.remove();
      pendingFactorId = f.id; pendingIsEnroll = true;

      var qrSrc = f && f.totp && f.totp.qr_code;
      if (qrSrc) {
        var qrBox = document.createElement("div"); qrBox.className = "sbm-qr";
        var img = document.createElement("img");
        // GoTrue returns either a data: URI or a raw <svg> string for qr_code.
        img.src = /^data:|^https?:/.test(qrSrc) ? qrSrc : "data:image/svg+xml;utf8," + encodeURIComponent(qrSrc);
        img.alt = "Two-factor QR code";
        qrBox.appendChild(img); body.appendChild(qrBox);
      }
      if (f && f.totp && f.totp.secret) {
        body.appendChild(labeled("Can't scan? Enter this key manually"));
        var sec = document.createElement("div"); sec.className = "sbm-secret"; sec.textContent = f.totp.secret;
        body.appendChild(sec);
      }

      body.appendChild(labeled("6-digit code"));
      var codeWrap = inWrap(IC.shield);
      var code = input("text", "000000"); code.className += " sbm-code-in"; code.maxLength = 6; code.inputMode = "numeric";
      codeWrap.appendChild(code); body.appendChild(codeWrap);

      var err = document.createElement("div"); err.className = "sbm-err"; body.appendChild(err);
      function showErr(m) { err.textContent = m; err.classList.add("show"); }

      var btn = document.createElement("button"); btn.className = "sbm-btn";
      btn.appendChild(svg(IC.shield)); btn.appendChild(document.createTextNode("Verify & enable"));
      body.appendChild(btn);

      function submit() {
        var c = code.value.trim();
        if (!/^\d{6}$/.test(c)) { showErr("Enter the 6-digit code."); return; }
        btn.disabled = true;
        SB.mfaChallengeAndVerify(f.id, c).then(function () {
          return afterAuth().then(closeModal);
        }).catch(function (er) {
          showErr(er.message || "Invalid code — check your app's time is correct and try again.");
          btn.disabled = false; code.value = ""; code.focus();
        });
      }
      btn.addEventListener("click", submit);
      code.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
      setTimeout(function () { code.focus(); }, 30);
    }).catch(function (er) {
      loading.textContent = "Couldn't start 2FA setup: " + (er.message || "unknown error");
    });
  }

  // The single choke point every auth path (fresh login, page reload) goes
  // through before anything admin-gated is shown. Never grants isAdmin
  // without a fresh, verified aal2 session.
  function checkMfaGate(fromCredentialsStep) {
    if (!window.SB || !SB.currentUser()) return afterAuth();
    var email = SB.currentUser().email;
    return SB.mfaVerifiedTotp().then(function (factors) {
      if (factors.length > 0) {
        if (SB.sessionAal() === "aal2") return afterAuth().then(function () { if (fromCredentialsStep) closeModal(); return state; });
        openMfaChallenge(factors[0].id);
        return afterAuth(); // sets needsMfa; UI stays gated until the modal above completes
      }
      if (isAdminEmail(email)) {
        openMfaEnroll();
        return afterAuth();
      }
      // Not an admin email and no factors — nothing to enforce; proceed as-is.
      return afterAuth().then(function () { if (fromCredentialsStep) closeModal(); return state; });
    });
  }

  var UID_KEY = "sb.admin.userId";
  function reconcileUser(newUserId) {
    return sget([UID_KEY]).then(function (o) {
      var prev = o && o[UID_KEY];
      if (prev && newUserId && prev !== newUserId) {
        if (window.SB) SB.clearMe();
        return sremove(["erasioSettings", "erasioToolImageSettings", "erasioToolVideoSettings"])
          .then(function () { return sset(mk(UID_KEY, newUserId)); });
      }
      return sset(mk(UID_KEY, newUserId));
    });
  }

  // Restrictive by default. Role/plan come from SB.me() (verified user +
  // server-side is_admin() RPC); an admin role is additionally gated on the
  // CURRENT session having reached aal2 (a completed MFA challenge). Without
  // that, isAdmin is forced false and needsMfa is set instead — closing the
  // "reload the page with an old password-only session" bypass.
  function applyMe(me) {
    if (!me) {
      setState({ ready: true, verifying: false, user: null, userId: null, role: "anonymous", plan: null, isAdmin: false, needsMfa: false });
      return Promise.resolve(state);
    }
    var wantsAdmin = me.role === "admin";
    var aal2 = window.SB && SB.sessionAal() === "aal2";
    var isAdmin = wantsAdmin && aal2;
    return reconcileUser(me.userId).then(function () {
      setState({
        ready: true, verifying: false, user: SB.currentUser(), userId: me.userId,
        role: isAdmin ? "admin" : me.role, plan: me.plan, isAdmin: isAdmin,
        needsMfa: wantsAdmin && !aal2,
      });
      return state;
    });
  }

  function afterAuth() {
    if (!window.SB) { setState({ ready: true, verifying: false, role: "anonymous", isAdmin: false, needsMfa: false }); return Promise.resolve(state); }
    setState({ verifying: true });
    return SB.me(true).then(applyMe).catch(function () {
      setState({ ready: true, verifying: false, user: SB.currentUser(), role: "free", plan: "free", isAdmin: false, needsMfa: false });
      return state;
    });
  }

  /* ---- cloud helpers (admin only; RLS also enforces) ---- */
  var cloud = {
    available: function () { return state.isAdmin && window.SB && SB.configured(); },
    pullSettings: function () {
      if (!cloud.available()) return Promise.resolve(null);
      return SB.select("admin_settings", "select=settings&limit=1").then(function (rows) {
        return (rows && rows[0] && rows[0].settings) || null;
      });
    },
    pushSettings: function (buckets) {
      if (!cloud.available()) return Promise.resolve(false);
      var u = SB.currentUser();
      return SB.upsert("admin_settings", { user_id: u.id, settings: buckets, updated_at: new Date().toISOString() })
        .then(function () { return true; });
    },
    logEvent: function (kind, meta) {
      if (!cloud.available()) return Promise.resolve(false);
      return SB.insert("usage_events", { kind: String(kind), meta: meta || {} }).then(function () { return true; }).catch(function () { return false; });
    }
  };

  window.Auth = {
    state: state,
    cloud: cloud,
    isAdminEmail: isAdminEmail,
    onChange: function (cb) { listeners.push(cb); if (state.ready) cb(state); },
    openModal: openModal,
    closeModal: closeModal,
    refreshMe: function () { return (window.SB ? checkMfaGate(false) : Promise.resolve(state)); },
    signOut: function () {
      return (window.SB ? SB.signOut() : Promise.resolve())
        .then(function () { return sremove([UID_KEY]); })
        .then(function () { setState({ ready: true, verifying: false, user: null, userId: null, role: "anonymous", plan: null, isAdmin: false, needsMfa: false }); });
    },
    init: function () {
      if (!window.SB) { setState({ ready: true, verifying: false, role: "anonymous", isAdmin: false, needsMfa: false }); return Promise.resolve(state); }
      setState({ verifying: true });
      return SB.init().then(function (sess) {
        if (!sess) { return applyMe(null); }
        return SB.ensureToken().then(function (tok) {
          if (!tok) { return SB.signOut().then(function () { return applyMe(null); }); }
          // Every reload re-checks the MFA gate too — an old aal1 session for
          // an admin email is routed straight into the MFA prompt again.
          return checkMfaGate(false);
        });
      }).catch(function () { setState({ ready: true, verifying: false, role: "anonymous", isAdmin: false, needsMfa: false }); return state; });
    }
  };

  function labeled(t) { var l = document.createElement("label"); l.className = "sbm-lab"; l.textContent = t; return l; }
  function inWrap(icon) { var w = document.createElement("div"); w.className = "sbm-inwrap"; w.appendChild(svg(icon)); return w; }
  function input(type, ph) { var i = document.createElement("input"); i.className = "sbm-in"; i.type = type; i.placeholder = ph; i.autocomplete = type === "password" ? "current-password" : "email"; return i; }
})();
