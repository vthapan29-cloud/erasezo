/* Control Room auth — talks to the Erasezo backend's /api/admin/* endpoints.
 *
 * This used to run on a separate Supabase project: a second account, a second
 * password, and a mandatory confirmation email standing between the owner and
 * their own dashboard — on a free-tier project that auto-paused once and took
 * the panel down with it. It is now the same database and the same login as the
 * rest of erasezo.com, with `is_admin` as the gate.
 *
 * Every decision is the server's. This file renders what it is told: the panel
 * asks /api/admin/me, and a 401/403 means no admin UI, full stop. There is no
 * client-side email allowlist left to fall out of sync, and nothing gated can
 * be reached by editing state in the browser — the data behind those views is
 * simply not served without the admin cookie.
 *
 * All styling lives in admin.css. Injecting a <style> element from script would
 * be blocked outright by the site's Content-Security-Policy, which carries no
 * 'unsafe-inline' — the modal would render as unstyled plain text.
 */
(function () {
  "use strict";

  // Same-origin on erasezo.com; absolute when the panel is opened from the
  // extension, which has no http(s) origin to resolve a relative path against.
  var API = (location.protocol === "http:" || location.protocol === "https:") ? "" : "https://erasezo.com";

  var listeners = [];
  // Restrictive defaults — nothing gated renders until the server confirms.
  var state = { ready: false, verifying: true, user: null, userId: null, role: "anonymous", plan: null, isAdmin: false, totpEnabled: false };

  function setState(patch) { Object.assign(state, patch); listeners.forEach(function (cb) { try { cb(state); } catch (e) {} }); }

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "include";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
    return fetch(API + path, opts).then(function (r) {
      return r.text().then(function (t) {
        var body = null; try { body = t ? JSON.parse(t) : null; } catch (e) { body = { raw: t }; }
        if (!r.ok) {
          var err = new Error((body && (body.message || body.error)) || ("HTTP " + r.status));
          err.status = r.status; err.code = body && body.error; throw err;
        }
        return body;
      });
    });
  }

  /* ---- DOM helpers ---- */
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function svg(paths, cls) {
    var d = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="' + (cls || "sbm-ic") + '">' + paths + "</svg>", "image/svg+xml");
    return document.importNode(d.documentElement, true);
  }
  var IC = {
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>',
    lock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
    shield: '<path d="M12 2 3 6v6c0 5 3.5 8.5 9 10 5.5-1.5 9-5 9-10V6l-9-4Z"/><path d="m9 12 2 2 4-4"/>'
  };

  var overlay = null, escHandler = null;
  function closeModal() {
    if (overlay) { overlay.remove(); overlay = null; }
    if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
  }

  function shell(title, subtitle) {
    closeModal();
    overlay = el("div", "sbm-ov");
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeModal(); });
    escHandler = function (e) { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", escHandler);
    var card = el("div", "sbm-card"); overlay.appendChild(card);
    var head = el("div", "sbm-head");
    head.appendChild(el("h3", null, title));
    var x = el("button", "sbm-x", "✕"); x.setAttribute("aria-label", "Close");
    x.addEventListener("click", closeModal);
    head.appendChild(x); card.appendChild(head);
    var body = el("div", "sbm-body"); card.appendChild(body);
    if (subtitle) body.appendChild(el("p", "sbm-sub", subtitle));
    document.body.appendChild(overlay);
    return body;
  }

  function field(body, label, type, placeholder) {
    body.appendChild(el("label", "sbm-lab", label));
    var wrap = el("div", "sbm-inwrap");
    wrap.appendChild(svg(type === "password" ? IC.lock : IC.mail));
    var i = el("input", "sbm-in");
    i.type = type; i.placeholder = placeholder;
    i.autocomplete = type === "password" ? "current-password" : "email";
    wrap.appendChild(i);
    if (type === "password") {
      var eye = el("button", "sbm-eye"); eye.type = "button"; eye.setAttribute("aria-label", "Show password");
      eye.appendChild(svg(IC.eye));
      eye.addEventListener("click", function () { i.type = i.type === "password" ? "text" : "password"; });
      wrap.appendChild(eye);
    }
    body.appendChild(wrap);
    return i;
  }

  function codeField(parent) {
    var wrap = el("div", "sbm-inwrap");
    wrap.appendChild(svg(IC.shield));
    var i = el("input", "sbm-in sbm-code");
    i.type = "text"; i.placeholder = "000000"; i.maxLength = 6;
    i.inputMode = "numeric"; i.autocomplete = "one-time-code";
    wrap.appendChild(i); parent.appendChild(wrap);
    return i;
  }

  function notices(body) {
    var err = el("div", "sbm-err"), ok = el("div", "sbm-ok");
    body.appendChild(err); body.appendChild(ok);
    return {
      err: function (m) { err.textContent = m; err.classList.add("show"); ok.classList.remove("show"); },
      ok: function (m) { ok.textContent = m; ok.classList.add("show"); err.classList.remove("show"); },
      clear: function () { err.classList.remove("show"); ok.classList.remove("show"); }
    };
  }

  var MSG = {
    invalid_credentials: "That email and password isn't an admin account.",
    totp_invalid: "That code didn't match. Codes change every 30 seconds — try the current one.",
    rate_limited: "Too many attempts. Wait a minute, then try again."
  };
  function humanize(e) {
    if (e && e.status === 0) return "Can't reach the server. Check your connection.";
    return (e && MSG[e.code]) || (e && e.message) || "Something went wrong.";
  }

  /* ---- sign in: password, then a code only if this account has 2FA on ---- */
  function openModal() {
    var body = shell("Sign in to the Control Room", "Owner access to the extension's settings, users and subscriptions.");
    var email = field(body, "Email", "email", "you@example.com");
    var pw = field(body, "Password", "password", "••••••••");

    var codeWrap = el("div", "sbm-hidden");
    codeWrap.appendChild(el("label", "sbm-lab", "Two-factor code"));
    var code = codeField(codeWrap);
    body.appendChild(codeWrap);
    var needCode = false;

    var note = notices(body);
    var btn = el("button", "sbm-btn");
    btn.appendChild(svg(IC.login)); btn.appendChild(document.createTextNode("Sign in"));
    body.appendChild(btn);

    function submit() {
      var e = email.value.trim(), p = pw.value, c = code.value.trim();
      if (!e || !p) { note.err("Enter your email and password."); return; }
      if (needCode && !/^\d{6}$/.test(c)) { note.err("Enter the 6-digit code from your authenticator app."); return; }
      note.clear(); btn.disabled = true;
      api("/api/admin/login", { method: "POST", body: { email: e, password: p, code: c } })
        .then(refresh).then(closeModal)
        .catch(function (err) {
          btn.disabled = false;
          if (err.code === "totp_required") {
            needCode = true;
            codeWrap.className = "";
            note.ok("Password accepted — now the code from your authenticator app.");
            setTimeout(function () { code.focus(); }, 30);
            return;
          }
          note.err(humanize(err));
        });
    }
    btn.addEventListener("click", submit);
    [email, pw, code].forEach(function (i) { i.addEventListener("keydown", function (ev) { if (ev.key === "Enter") submit(); }); });
    setTimeout(function () { email.focus(); }, 30);
  }

  /* ---- 2FA, driven from the panel's Security card ---- */
  function openTwoFactorSetup() {
    var body = shell("Turn on two-factor authentication",
      "Add the key below to your authenticator app, then confirm one code. 2FA only switches on once a code checks out, so a mistyped setup can't lock you out.");
    var loading = el("p", "sbm-hint", "Preparing your setup key…");
    body.appendChild(loading);

    api("/api/admin/2fa/setup", { method: "POST" }).then(function (d) {
      loading.remove();
      body.appendChild(el("label", "sbm-lab", "Setup key"));
      body.appendChild(el("div", "sbm-secret", d.secret.replace(/(.{4})/g, "$1 ").trim()));
      var copy = el("button", "sbm-link", "Copy key");
      copy.addEventListener("click", function () {
        navigator.clipboard.writeText(d.secret).then(
          function () { copy.textContent = "Copied"; },
          function () { copy.textContent = "Select the key above to copy it"; }
        );
      });
      body.appendChild(copy);
      body.appendChild(el("p", "sbm-hint", "In Google Authenticator, Authy or 1Password pick “add account → enter a setup key”, then paste this."));

      body.appendChild(el("label", "sbm-lab", "Code from the app"));
      var code = codeField(body);
      var note = notices(body);
      var btn = el("button", "sbm-btn");
      btn.appendChild(svg(IC.shield)); btn.appendChild(document.createTextNode("Verify & turn on"));
      body.appendChild(btn);

      function submit() {
        if (!/^\d{6}$/.test(code.value.trim())) { note.err("Enter the 6-digit code."); return; }
        btn.disabled = true;
        api("/api/admin/2fa/enable", { method: "POST", body: { code: code.value.trim() } })
          .then(refresh).then(closeModal)
          .catch(function (e) {
            btn.disabled = false; code.value = ""; code.focus();
            note.err(e.code === "totp_invalid"
              ? "That code didn't match. Check your phone's clock is set automatically, then enter the current code."
              : humanize(e));
          });
      }
      btn.addEventListener("click", submit);
      code.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
      setTimeout(function () { code.focus(); }, 30);
    }).catch(function (e) {
      loading.textContent = e.code === "already_enabled"
        ? "Two-factor is already on for this account."
        : "Couldn't start setup: " + humanize(e);
    });
  }

  function openTwoFactorDisable() {
    var body = shell("Turn off two-factor authentication",
      "Both factors are needed to remove one — an open session on its own isn't enough.");
    var pw = field(body, "Password", "password", "••••••••");
    body.appendChild(el("label", "sbm-lab", "Current code"));
    var code = codeField(body);
    var note = notices(body);
    var btn = el("button", "sbm-btn sbm-danger", "Turn off 2FA");
    body.appendChild(btn);
    function submit() {
      btn.disabled = true;
      api("/api/admin/2fa/disable", { method: "POST", body: { password: pw.value, code: code.value.trim() } })
        .then(refresh).then(closeModal)
        .catch(function (e) { btn.disabled = false; note.err(humanize(e)); });
    }
    btn.addEventListener("click", submit);
    code.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  }

  /* ---- state ---- */
  function applyMe(me) {
    if (!me) {
      setState({ ready: true, verifying: false, user: null, userId: null, role: "anonymous", plan: null, isAdmin: false, totpEnabled: false });
      return state;
    }
    setState({
      ready: true, verifying: false,
      user: { email: me.email, username: me.username },
      userId: me.userId, role: "admin", plan: "admin",
      isAdmin: true, totpEnabled: !!me.totpEnabled
    });
    return state;
  }

  function refresh() {
    setState({ verifying: true });
    return api("/api/admin/me").then(applyMe).catch(function () { return applyMe(null); });
  }

  var cloud = {
    available: function () { return state.isAdmin; },
    pullSettings: function () {
      if (!cloud.available()) return Promise.resolve(null);
      return api("/api/admin/settings").then(function (s) { return (s && Object.keys(s).length) ? s : null; });
    },
    pushSettings: function (buckets) {
      if (!cloud.available()) return Promise.resolve(false);
      return api("/api/admin/settings", { method: "PUT", body: buckets }).then(function () { return true; });
    },
    // Usage events were a Supabase-only table and nothing reads them today, so
    // this stays a no-op rather than shipping a write path with no reader.
    logEvent: function () { return Promise.resolve(false); }
  };

  window.Auth = {
    state: state,
    cloud: cloud,
    onChange: function (cb) { listeners.push(cb); if (state.ready) cb(state); },
    openModal: openModal,
    closeModal: closeModal,
    openTwoFactorSetup: openTwoFactorSetup,
    openTwoFactorDisable: openTwoFactorDisable,
    refreshMe: refresh,
    signOut: function () {
      return api("/api/admin/logout", { method: "POST" })
        .catch(function () {})
        .then(function () { applyMe(null); });
    },
    init: refresh
  };
})();
