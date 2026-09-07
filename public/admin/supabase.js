/* Minimal Supabase client for the Erasezo admin panel — auth + REST over fetch.
 *
 * Why not @supabase/supabase-js: for an extension we need sign-up / sign-in /
 * Google-OAuth / token-refresh / a few table reads-writes. That is a thin layer
 * over GoTrue (/auth/v1) and PostgREST (/rest/v1). Hand-rolling it keeps the
 * bundle tiny, auditable, and free of any supply-chain surface — which is the
 * point when the brief is "no vulnerabilities".
 *
 * Session (access + refresh tokens) lives in chrome.storage.local, isolated to
 * this extension. Never in localStorage, never logged.
 */
(function () {
  "use strict";

  var CFG = window.ERASIO_ADMIN_CONFIG || {};
  var URL_BASE = (CFG.SUPABASE_URL || "").replace(/\/+$/, "");
  var ANON = CFG.SUPABASE_ANON_KEY || "";
  var SESSION_KEY = "sb.admin.session";
  var HAS_CHROME = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  function configured() {
    return /^https:\/\/.+\.supabase\.co$/i.test(URL_BASE) && ANON && ANON.indexOf("YOUR-") !== 0;
  }

  /* ---- session storage (chrome.storage.local, with localStorage fallback for preview) ---- */
  function loadSession() {
    return new Promise(function (res) {
      if (HAS_CHROME) chrome.storage.local.get([SESSION_KEY], function (o) { res((o && o[SESSION_KEY]) || null); });
      else { try { res(JSON.parse(localStorage.getItem(SESSION_KEY) || "null")); } catch (e) { res(null); } }
    });
  }
  function saveSession(s) {
    return new Promise(function (res) {
      if (HAS_CHROME) { var o = {}; o[SESSION_KEY] = s; chrome.storage.local.set(o, res); }
      else { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); res(); }
    });
  }
  function clearSession() {
    return new Promise(function (res) {
      if (HAS_CHROME) chrome.storage.local.remove([SESSION_KEY], res);
      else { localStorage.removeItem(SESSION_KEY); res(); }
    });
  }

  var _session = null; // in-memory mirror
  var _meCache = null, _meAt = 0; // /api/me cache (max ~60s)

  function normalizeSession(data) {
    if (!data || !data.access_token) return null;
    // GoTrue may send expires_at (unix seconds) or only expires_in. Store an
    // absolute ms timestamp either way.
    var expMs = data.expires_at
      ? Number(data.expires_at) * 1000
      : Date.now() + Number(data.expires_in || 3600) * 1000;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at_ms: expMs,
      user: data.user || (_session && _session.user) || null
    };
  }

  /* ---- low-level fetch helpers ---- */
  function authHeaders(token) {
    return {
      "apikey": ANON,
      "Authorization": "Bearer " + (token || ANON),
      "Content-Type": "application/json"
    };
  }
  function jsonOrThrow(r) {
    return r.text().then(function (t) {
      var body = null; try { body = t ? JSON.parse(t) : null; } catch (e) { body = { raw: t }; }
      if (!r.ok) {
        var msg = (body && (body.error_description || body.msg || body.message || body.error)) || ("HTTP " + r.status);
        var err = new Error(msg); err.status = r.status; err.body = body; throw err;
      }
      return body;
    });
  }

  /* ---- PKCE helpers for the Google flow ---- */
  function b64url(bytes) {
    var s = ""; var b = new Uint8Array(bytes);
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomVerifier() {
    var a = new Uint8Array(32); crypto.getRandomValues(a); return b64url(a);
  }
  function challengeOf(verifier) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(b64url);
  }

  /* ---- public API ---- */
  var SB = {
    configured: configured,
    urlBase: function () { return URL_BASE; },

    init: function () {
      return loadSession().then(function (s) { _session = s; return s; });
    },
    currentUser: function () { return _session && _session.user; },
    currentSession: function () { return _session; },

    signUp: function (email, password) {
      return fetch(URL_BASE + "/auth/v1/signup", {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ email: email, password: password })
      }).then(jsonOrThrow).then(function (d) {
        // With email confirmation ON, d has no session yet — caller shows "check your email".
        if (d && d.access_token) { _session = normalizeSession(d); return saveSession(_session).then(function () { return d; }); }
        return d;
      });
    },

    signIn: function (email, password) {
      return fetch(URL_BASE + "/auth/v1/token?grant_type=password", {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ email: email, password: password })
      }).then(jsonOrThrow).then(function (d) {
        _session = normalizeSession(d); return saveSession(_session).then(function () { return _session; });
      });
    },

    // Google OAuth via PKCE + chrome.identity.launchWebAuthFlow. No client secret
    // in the extension; the secret lives in the Supabase dashboard.
    signInWithGoogle: function () {
      if (!(typeof chrome !== "undefined" && chrome.identity && chrome.identity.launchWebAuthFlow)) {
        return Promise.reject(new Error("Google sign-in needs the extension context (chrome.identity)."));
      }
      var redirectTo = chrome.identity.getRedirectURL();
      var verifier = randomVerifier();
      return challengeOf(verifier).then(function (challenge) {
        var authUrl = URL_BASE + "/auth/v1/authorize?provider=google"
          + "&code_challenge=" + encodeURIComponent(challenge)
          + "&code_challenge_method=s256"
          + "&redirect_to=" + encodeURIComponent(redirectTo);
        return new Promise(function (resolve, reject) {
          chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, function (redirect) {
            if (chrome.runtime.lastError || !redirect) {
              return reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "Sign-in cancelled"));
            }
            var u; try { u = new URL(redirect); } catch (e) { return reject(new Error("Bad redirect")); }
            var code = u.searchParams.get("code");
            var err = u.searchParams.get("error_description") || u.searchParams.get("error");
            if (err) return reject(new Error(err));
            if (!code) return reject(new Error("No authorization code returned"));
            fetch(URL_BASE + "/auth/v1/token?grant_type=pkce", {
              method: "POST", headers: authHeaders(),
              body: JSON.stringify({ auth_code: code, code_verifier: verifier })
            }).then(jsonOrThrow).then(function (d) {
              _session = normalizeSession(d); return saveSession(_session);
            }).then(function () { resolve(_session); }).catch(reject);
          });
        });
      });
    },

    refresh: function () {
      if (!_session || !_session.refresh_token) return Promise.reject(new Error("No session"));
      return fetch(URL_BASE + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ refresh_token: _session.refresh_token })
      }).then(jsonOrThrow).then(function (d) {
        _session = normalizeSession(d); return saveSession(_session).then(function () { return _session; });
      });
    },

    // Return a valid access token, refreshing if it is within 60s of expiry.
    ensureToken: function () {
      if (!_session) return Promise.resolve(null);
      if (Date.now() < (_session.expires_at_ms - 60000)) return Promise.resolve(_session.access_token);
      return SB.refresh().then(function (s) { return s.access_token; }).catch(function () { return null; });
    },

    signOut: function () {
      var token = _session && _session.access_token;
      var done = function () { _session = null; _meCache = null; _meAt = 0; return clearSession(); };
      if (!token) return done();
      return fetch(URL_BASE + "/auth/v1/logout", { method: "POST", headers: authHeaders(token) })
        .catch(function () {}).then(done);
    },

    /* ---- REST (PostgREST). RLS enforces access; these just carry the token. ---- */
    db: function (method, path, body, prefer) {
      return SB.ensureToken().then(function (token) {
        var h = authHeaders(token);
        if (prefer) h["Prefer"] = prefer;
        var opts = { method: method, headers: h };
        if (body !== undefined) opts.body = JSON.stringify(body);
        return fetch(URL_BASE + "/rest/v1/" + path, opts).then(jsonOrThrow);
      });
    },
    select: function (table, query) { return SB.db("GET", table + (query ? "?" + query : "")); },
    upsert: function (table, row) { return SB.db("POST", table, row, "resolution=merge-duplicates,return=representation"); },
    insert: function (table, row) { return SB.db("POST", table, row, "return=minimal"); },
    rpc: function (fn, args) { return SB.db("POST", "rpc/" + fn, args || {}); },

    // The /api/me equivalent for our stack: VERIFIED identity from GoTrue
    // (/auth/v1/user validates the token server-side) + role computed
    // server-side by the is_admin() SQL function via RPC. Never derived from a
    // client-decoded token. Cached ~60s; force=true bypasses the cache.
    me: function (force) {
      if (!force && _meCache && Date.now() - _meAt < 60000) return Promise.resolve(_meCache);
      if (!_session) { _meCache = null; return Promise.resolve(null); }
      return SB.ensureToken().then(function (tok) {
        if (!tok) { _meCache = null; return null; }
        return fetch(URL_BASE + "/auth/v1/user", { headers: authHeaders(tok) }).then(jsonOrThrow).then(function (u) {
          return SB.rpc("is_admin").then(function (r) {
            var admin = r === true || (Array.isArray(r) && r[0] === true) || r === "true";
            _meCache = { userId: u.id, email: u.email, role: admin ? "admin" : "free", plan: admin ? "admin" : "free", isAdmin: admin };
            _meAt = Date.now();
            return _meCache;
          }).catch(function () {
            // RPC failed (e.g. table not migrated) → most-restrictive: treat as free.
            _meCache = { userId: u.id, email: u.email, role: "free", plan: "free", isAdmin: false };
            _meAt = Date.now();
            return _meCache;
          });
        });
      });
    },
    clearMe: function () { _meCache = null; _meAt = 0; },

    // Decode (not verify — GoTrue already signed it; this is a client UI
    // read, never a security boundary by itself) the session JWT's assurance
    // level. "aal2" means an MFA challenge was satisfied THIS session; "aal1"
    // means password/Google only. Used to gate the admin UI so a stored
    // password-only session from before MFA was required can never silently
    // count as admin after a reload — it must re-clear the MFA step.
    sessionAal: function () {
      if (!_session || !_session.access_token) return null;
      try {
        var part = _session.access_token.split(".")[1];
        var b64 = part.replace(/-/g, "+").replace(/_/g, "/");
        while (b64.length % 4) b64 += "=";
        var payload = JSON.parse(atob(b64));
        return payload && payload.aal || null;
      } catch (e) { return null; }
    },

    /* ---- MFA (TOTP) — makes password-only compromise insufficient ----
     * Standard GoTrue MFA REST surface. enroll() returns a ready-made QR
     * (totp.qr_code) to scan with any authenticator app (Google Authenticator,
     * Authy, 1Password, …). Both enrollment confirmation and login step-up use
     * the same challenge → verify pair; verify() replaces the session with an
     * aal2 (MFA-satisfied) one. */
    mfaFactors: function () {
      return SB.ensureToken().then(function (tok) {
        return fetch(URL_BASE + "/auth/v1/user", { headers: authHeaders(tok) }).then(jsonOrThrow);
      }).then(function (u) { return (u && u.factors) || []; });
    },
    mfaVerifiedTotp: function () {
      return SB.mfaFactors().then(function (fs) {
        return fs.filter(function (f) { return f.factor_type === "totp" && f.status === "verified"; });
      });
    },
    mfaEnroll: function () {
      return SB.ensureToken().then(function (tok) {
        return fetch(URL_BASE + "/auth/v1/factors", {
          method: "POST", headers: authHeaders(tok), body: JSON.stringify({ factor_type: "totp" })
        }).then(jsonOrThrow);
      });
    },
    mfaUnenroll: function (factorId) {
      return SB.ensureToken().then(function (tok) {
        return fetch(URL_BASE + "/auth/v1/factors/" + factorId, { method: "DELETE", headers: authHeaders(tok) }).then(jsonOrThrow);
      });
    },
    // One call: challenge the factor, then verify the user's 6-digit code
    // against it. On success this REPLACES the session with an aal2 one.
    mfaChallengeAndVerify: function (factorId, code) {
      return SB.ensureToken().then(function (tok) {
        return fetch(URL_BASE + "/auth/v1/factors/" + factorId + "/challenge", {
          method: "POST", headers: authHeaders(tok)
        }).then(jsonOrThrow).then(function (ch) {
          return fetch(URL_BASE + "/auth/v1/factors/" + factorId + "/verify", {
            method: "POST", headers: authHeaders(tok),
            body: JSON.stringify({ challenge_id: ch.id, code: String(code).trim() })
          }).then(jsonOrThrow);
        });
      }).then(function (d) {
        // verify() returns a fresh session at aal2 — adopt it.
        if (d && d.access_token) { _session = normalizeSession(d); return saveSession(_session).then(function () { return _session; }); }
        return _session;
      });
    }
  };

  window.SB = SB;
})();
