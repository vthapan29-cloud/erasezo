/* Erasezo Control Room — admin panel.
 * Framework-free. Drives the extension entirely through chrome.storage.local,
 * which bootstrap.js relays live to the page engines. No bundle edits.
 * Falls back to localStorage when opened as a plain file (for preview). */
(function () {
  "use strict";

  var HAS_CHROME = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  var BUCKETS = { settings: "erasioSettings", image: "erasioToolImageSettings", video: "erasioToolVideoSettings" };

  var DEF = {
    settings: {
      defaultModel: "v2", defaultMode: "auto", autoDownload: true, showNotifications: true,
      darkMode: false, historyDays: 30, imageQuality: "high", performanceMode: "quality",
      batchProcessing: false, enableAutoRemoval: true, saveImagesToHistory: true,
      skipPreview: false, enableFlow: true
    },
    image: {
      logoVersion: "old", maskScale: 1, gainDrift: 0.62, nccGood: 0.5, nccAccept: 0.3,
      scanStride: 8, refineRadius: 8, alphaThreshold: 0.002, maxAlpha: 0.99, logoValue: 255,
      maskPosition: { mode: "auto", dx: 0, dy: 0 },
      maskLocks: [{ w: 1376, h: 768, x: 1255, y: 647 }],
      fullGainOnLock: true
    },
    video: {
      logoVersion: "old", maskScale: 1, baseStrength: 1, opacityMode: "auto", opacityCustom: 0.5,
      ceiling: 0.99, overlayValue: 255, edgeMode: "auto", edgeStrength: 1, edgeRadius: 2,
      edgePasses: 1, bitrateMult: 1, corrThreshold: 0.3, maskPosition: { mode: "auto", dx: 0, dy: 0 }
    }
  };

  var LOCALES = { en: "English", es: "Español", fr: "Français", de: "Deutsch", it: "Italiano",
    pt: "Português", ru: "Русский", ja: "日本語", ko: "한국어", zh_CN: "中文 (简)",
    ar: "العربية", hi: "हिन्दी", tr: "Türkçe", ur: "اردو" };

  /* ---- storage abstraction ----
   * Inside the extension this is chrome.storage.local directly. The same page
   * is also served from erasezo.com, where chrome.* does not exist — there each
   * operation is handed to page/webBridge.js (a content script on that origin)
   * which performs it against the extension's REAL storage, so settings edited
   * on the website reach the installed extension. If nothing answers (extension
   * not installed) it falls back to localStorage so the panel still works. */
  var BRIDGE_TIMEOUT_MS = 800;
  function bridge(op, payload) {
    return new Promise(function (res) {
      var id = "ez" + Math.random().toString(36).slice(2);
      var settled = false;
      function onMsg(e) {
        if (e.source !== window || e.origin !== location.origin) return;
        var d = e.data;
        if (!d || d.__erasezoAdmin !== "res" || d.id !== id) return;
        settled = true; window.removeEventListener("message", onMsg);
        res(d.ok ? (d.data || true) : null);
      }
      window.addEventListener("message", onMsg);
      window.postMessage({ __erasezoAdmin: "req", id: id, op: op, payload: payload }, location.origin);
      setTimeout(function () {
        if (settled) return;
        window.removeEventListener("message", onMsg); res(null);
      }, BRIDGE_TIMEOUT_MS);
    });
  }
  function mockGet() { try { return JSON.parse(localStorage.getItem("__erasioMock") || "{}"); } catch (e) { return {}; } }
  function mockPut(c) { try { localStorage.setItem("__erasioMock", JSON.stringify(c)); } catch (e) {} }

  var store = {
    getAll: function () {
      if (HAS_CHROME) return new Promise(function (res) { chrome.storage.local.get(null, res); });
      return bridge("getAll").then(function (d) { return (d && d !== true) ? d : mockGet(); });
    },
    set: function (obj) {
      if (HAS_CHROME) return new Promise(function (res) { chrome.storage.local.set(obj, res); });
      return bridge("set", obj).then(function (ok) {
        if (ok) return;
        var c = mockGet(); Object.assign(c, obj); mockPut(c);
      });
    },
    remove: function (key) {
      if (HAS_CHROME) return new Promise(function (res) { chrome.storage.local.remove(key, res); });
      return bridge("remove", key).then(function (ok) {
        if (ok) return;
        var c = mockGet(); delete c[key]; mockPut(c);
      });
    }
  };
  function sendMsg(msg) {
    try {
      if (HAS_CHROME && chrome.runtime) { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); return; }
      bridge("msg", msg);
    } catch (e) {}
  }
  // True once the bridge has answered at least once — drives the banner that
  // tells you whether edits here are reaching a real extension.
  var bridgeLive = null;
  function probeBridge() {
    if (HAS_CHROME) { bridgeLive = true; return Promise.resolve(true); }
    return bridge("ping").then(function (ok) { bridgeLive = !!ok; return bridgeLive; });
  }

  var state = { settings: {}, image: {}, video: {}, raw: {} };

  /* ---- schema ----
   * Every field here is wired to something that reads it. Controls that only
   * persisted a value nothing consumed have been removed rather than left
   * looking operational. */

  var SCHEMA = [
    { id: "dashboard", title: "Dashboard", icon: "📊", custom: renderDashboard },
    { id: "users", title: "Users", icon: "👤", custom: renderUsers },
    { id: "plans", title: "Plans", icon: "💳", custom: renderPlans },
    { id: "detection", title: "Detection", icon: "🎯",
      desc: "How the sparkle is located. Lower nccAccept catches fainter marks; the scan finds it when it drifts off the auto position.",
      groups: [{ title: "Image detection · erasioToolImageSettings", fields: [
        { b: "image", k: "nccAccept", t: "range", min: 0.1, max: 0.6, step: 0.01, live: 1, label: "Accept threshold", help: "Minimum score to declare a watermark." },
        { b: "image", k: "nccGood", t: "range", min: 0.3, max: 0.9, step: 0.01, live: 1, label: "Trust threshold", help: "Skip the scan when the auto position scores at least this." },
        { b: "image", k: "scanStride", t: "number", min: 2, max: 16, step: 1, live: 1, label: "Scan stride", help: "Coarse-pass step in px. Smaller = thorough, slower." },
        { b: "image", k: "refineRadius", t: "number", min: 0, max: 16, step: 1, live: 1, label: "Refine radius", help: "±px stride-1 refine around the coarse peak." },
        { b: "image", k: "logoVersion", t: "select", options: [["old", "Legacy sparkle"], ["new", "2026 sparkle"]], live: 1, label: "Logo version", help: "Which calibrated map to match against." }
      ]}]
    },
    { id: "removal", title: "Removal", icon: "🧽",
      desc: "The reverse alpha-blend that erases the mark, pixel by pixel.",
      groups: [{ title: "Reverse-blend · erasioToolImageSettings", fields: [
        { b: "image", k: "gainDrift", t: "range", min: 0.3, max: 1, step: 0.01, live: 1, label: "Drift gain", help: "Blend strength when the mark sits off the auto position." },
        { b: "image", k: "maskScale", t: "range", min: 0.5, max: 3, step: 0.1, live: 1, label: "Mask scale", help: "Enlarge the cleanup mask to eat fringe glow." },
        { b: "image", k: "alphaThreshold", t: "number", min: 0, max: 0.05, step: 0.001, live: 1, label: "Alpha threshold", help: "α below this is skipped during blend." },
        { b: "image", k: "maxAlpha", t: "number", min: 0.8, max: 0.999, step: 0.001, live: 1, label: "Max alpha", help: "α cap before ÷(1−α) to avoid blow-ups." },
        { b: "image", k: "logoValue", t: "number", min: 0, max: 255, step: 1, live: 1, label: "Logo value", help: "Assumed RGB value of the watermark color." },
        { b: "image", k: "fullGainOnLock", t: "toggle", live: 1, label: "Full strength on a locked mask", help: "A pinned position is a statement of fact, so blend at 100% rather than the drift gain. Turn off if a lock is slightly imprecise." }
      ]}]
    },
    { id: "masklocks", title: "Mask Locks", icon: "📌", custom: renderMaskLocks },
    { id: "sites", title: "Sites & Behavior", icon: "🌐",
      desc: "Where the extension runs and how downloads behave.",
      groups: [
        { title: "Master · erasioSettings", fields: [
          { b: "settings", k: "enableAutoRemoval", t: "toggle", live: 1, label: "Auto-removal", help: "Clean images automatically at display time." },
          { b: "settings", k: "enableFlow", t: "toggle", live: 1, label: "Flow support", help: "Inject buttons + intercept downloads on Flow." },
          { b: "settings", k: "skipPreview", t: "toggle", live: 1, label: "Skip preview", help: "Download immediately instead of the Before/After modal." }
        ]}
      ]
    },
    { id: "video", title: "Video", icon: "🎬",
      desc: "The video engine — frame-by-frame strength, edge feathering, and re-mux settings.",
      groups: [
        { title: "Strength · erasioToolVideoSettings", fields: [
          { b: "video", k: "baseStrength", t: "range", min: 0.2, max: 1.5, step: 0.05, live: 1, label: "Base strength", help: "Core reverse-blend intensity." },
          { b: "video", k: "opacityMode", t: "select", options: [["auto", "Auto"], ["custom", "Custom"]], live: 1, label: "Opacity mode" },
          { b: "video", k: "opacityCustom", t: "range", min: 0, max: 1, step: 0.01, live: 1, label: "Custom opacity" },
          { b: "video", k: "ceiling", t: "number", min: 0.5, max: 0.999, step: 0.001, live: 1, label: "Ceiling" },
          { b: "video", k: "overlayValue", t: "number", min: 0, max: 255, step: 1, live: 1, label: "Overlay value" }
        ]},
        { title: "Feather & encode", fields: [
          { b: "video", k: "edgeMode", t: "select", options: [["auto", "Auto"], ["off", "Off"], ["custom", "Custom"]], live: 1, label: "Edge mode" },
          { b: "video", k: "edgeStrength", t: "range", min: 0, max: 3, step: 0.1, live: 1, label: "Edge strength" },
          { b: "video", k: "edgeRadius", t: "number", min: 0, max: 8, step: 1, live: 1, label: "Edge radius" },
          { b: "video", k: "edgePasses", t: "number", min: 0, max: 5, step: 1, live: 1, label: "Edge passes" },
          { b: "video", k: "bitrateMult", t: "range", min: 0.5, max: 3, step: 0.1, live: 1, label: "Bitrate ×" },
          { b: "video", k: "corrThreshold", t: "range", min: 0.1, max: 0.6, step: 0.01, live: 1, label: "Correlation gate" }
        ]}
      ]
    },
    { id: "sync", title: "Sync & Cache", icon: "⚙️",
      desc: "Background refresh cadence and the in-page caches.",
      custom: renderSync
    },
    { id: "localization", title: "Localization", icon: "🌍",
      desc: "Language and appearance.",
      groups: [{ title: "Appearance · erasioSettings", fields: [
        { b: "settings", k: "darkMode", t: "toggle", live: 1, label: "Dark mode", help: "Relayed to the on-page overlays." }
      ]}]
    },
    { id: "audit", title: "Audit log", icon: "📜", custom: renderAudit },
    { id: "maintenance", title: "Maintenance", icon: "🧰", custom: renderMaintenance }
  ];

  /* ---- generic helpers ---- */
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function get(b, k, dflt) { var v = state[b][k]; return v === undefined ? (dflt !== undefined ? dflt : (DEF[b] ? DEF[b][k] : undefined)) : v; }

  /* ---- inline icon set (Lucide-style strokes; keyed by tab id + dashboard heads) ---- */
  var ICONS = {
    audit: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    plans: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    detection: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
    removal: '<path d="m7 21-4.3-4.3a1.7 1.7 0 0 1 0-2.4l9.6-9.6a1.7 1.7 0 0 1 2.4 0l5 5a1.7 1.7 0 0 1 0 2.4L13 21"/><path d="M22 21H8"/><path d="m5 12 7 7"/>',
    masklocks: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    sites: '<circle cx="12" cy="12" r="9"/><path d="M12 3a13 13 0 0 0 0 18 13 13 0 0 0 0-18"/><path d="M3 12h18"/>',
    video: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M3 12h18"/><path d="M3 7.5h4"/><path d="M3 16.5h4"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
    sync: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    localization: '<path d="m4 14 6-6 2-3"/><path d="m5 8 6 6"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
    maintenance: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    subscription: '<path d="M6 3h12l4 6-10 12L2 9Z"/><path d="M11 3 8 9l4 12 4-12-3-6"/><path d="M2 9h20"/>',
    credit: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
    analytics: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'
  };
  function icon(name, cls) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="icon' + (cls ? " " + cls : "") + '" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
    var doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    return document.importNode(doc.documentElement, true);
  }
  function h3ic(name, text) { var h = el("h3", "h3ic"); h.appendChild(icon(name)); h.appendChild(document.createTextNode(text)); return h; }

  var saveTimers = {};
  function scheduleSave(b) {
    markDirty(true);
    clearTimeout(saveTimers[b]);
    saveTimers[b] = setTimeout(function () {
      var o = {}; o[BUCKETS[b]] = state[b];
      store.set(o).then(function () { markDirty(false); cloudPush(); });
    }, 350);
  }
  function markDirty(d) {
    var ind = document.getElementById("saveInd"), txt = document.getElementById("saveTxt");
    if (!ind) return;
    ind.classList.toggle("dirty", !!d);
    txt.textContent = d ? "Saving…" : "All changes saved";
  }
  function toast(msg) {
    var t = document.getElementById("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  /* ---- field renderer ---- */
  function fieldRow(f) {
    var row = el("div", "field");
    var left = el("div");
    var lab = el("div", "lab"); lab.appendChild(document.createTextNode(f.label + " "));
    var codeEl = el("code", null, f.k); lab.appendChild(codeEl);
    left.appendChild(lab);
    if (f.help) left.appendChild(el("div", "help", f.help));
    row.appendChild(left);

    var ctl = el("div", "ctl");
    var cur = get(f.b, f.k, f.def);

    if (f.t === "toggle") {
      var sw = el("label", "sw");
      var inp = el("input"); inp.type = "checkbox"; inp.checked = !!cur;
      inp.addEventListener("change", function () { state[f.b][f.k] = inp.checked; scheduleSave(f.b); });
      sw.appendChild(inp); sw.appendChild(el("span", "track")); sw.appendChild(el("span", "knob"));
      ctl.appendChild(sw);
    } else if (f.t === "range") {
      var tag = el("span", "val-tag", fmt(cur, f.step));
      var r = el("input"); r.type = "range"; r.min = f.min; r.max = f.max; r.step = f.step; r.value = cur;
      r.addEventListener("input", function () { var v = parseFloat(r.value); state[f.b][f.k] = v; tag.textContent = fmt(v, f.step); scheduleSave(f.b); });
      ctl.appendChild(r); ctl.appendChild(tag);
    } else if (f.t === "number") {
      var n = el("input"); n.type = "number"; if (f.min != null) n.min = f.min; if (f.max != null) n.max = f.max; if (f.step != null) n.step = f.step; n.value = cur;
      n.addEventListener("change", function () { var v = parseFloat(n.value); if (isNaN(v)) v = f.def != null ? f.def : 0; state[f.b][f.k] = v; scheduleSave(f.b); });
      ctl.appendChild(n);
    } else if (f.t === "select") {
      var s = el("select");
      f.options.forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; if (String(cur) === String(o[0])) op.selected = true; s.appendChild(op); });
      s.addEventListener("change", function () { state[f.b][f.k] = s.value; scheduleSave(f.b); });
      ctl.appendChild(s);
    } else if (f.t === "text") {
      var tx = el("input"); tx.type = "text"; tx.value = cur == null ? "" : cur;
      tx.addEventListener("change", function () { state[f.b][f.k] = tx.value; scheduleSave(f.b); });
      ctl.appendChild(tx);
    }
    row.appendChild(ctl);
    return row;
  }
  function fmt(v, step) { var d = (String(step).split(".")[1] || "").length; return Number(v).toFixed(Math.min(d, 3)); }

  /* ---- tab renderers ---- */
  function renderGroups(tab, panel) {
    if (tab.desc) { var ph = el("div", "panel-head"); ph.appendChild(el("h2", null, tab.title)); ph.appendChild(el("p", null, tab.desc)); panel.appendChild(ph); }
    tab.groups.forEach(function (g) {
      panel.appendChild(el("div", "group-title", g.title));
      var card = el("div", "card");
      g.fields.forEach(function (f) { card.appendChild(fieldRow(f)); });
      panel.appendChild(card);
    });
  }

  function renderDashboard(tab, panel) {
    var ph = el("div", "panel-head"); ph.appendChild(el("h2", null, "Dashboard")); ph.appendChild(el("p", null, "Mission control — account, subscription, credits, and usage at a glance."));
    panel.appendChild(ph);

    var cs = state.raw.erasioCreditStatus || {};
    var user = state.raw.erasioUser || null;
    var enabled = state.raw.enabled !== false;
    var processed = Number(state.raw.processedCount || 0);
    var plan = cs.kind === "paid" ? "Pro" : cs.kind === "free" ? "Free" : cs.kind === "guest" ? "Guest" : (cs.kind || "—");
    var unlimited = (cs.limit === 0 || cs.remaining >= 999999);

    // Tiles. The first two describe THIS browser's extension; the rest are the
    // whole service, fetched from the server — a panel whose headline numbers
    // only ever describe one machine isn't mission control.
    var tiles = el("div", "tiles");
    function tile(label, value) {
      var d = el("div", "tile"); d.appendChild(el("div", "v", value)); d.appendChild(el("div", "l", label));
      tiles.appendChild(d); return d;
    }
    var tUsers = tile("Users", "…"), tSubs = tile("Active plans", "…"), tCredits = tile("Credits used today", "…");
    panel.appendChild(tiles);

    if (adminStats) applyStats(); else {
      adminApi("/api/admin/stats")
        .then(function (d) { adminStats = d; applyStats(); })
        .catch(function () { [tUsers, tSubs, tCredits].forEach(function (t) { t.querySelector(".v").textContent = "—"; }); });
    }
    function applyStats() {
      tUsers.querySelector(".v").textContent = String(adminStats.users.total);
      tUsers.querySelector(".l").textContent = "Users · +" + adminStats.users.newToday + " today";
      tSubs.querySelector(".v").textContent = String(adminStats.subscriptions.active);
      tCredits.querySelector(".v").textContent = String(adminStats.credits.usedToday);
    }

    var sep = el("div", "group-title", "This browser's extension");
    sep.style.marginTop = "22px";
    panel.appendChild(sep);
    panel.appendChild(el("p", "sec-sub", "The tiles above cover the whole service. Everything below is the Erasezo extension installed in THIS browser — useful for testing, but not what your customers see."));

    var localTiles = el("div", "tiles"); localTiles.style.marginTop = "12px";
    [["Images cleaned here", processed.toLocaleString()], ["Extension", enabled ? "On" : "Off"]].forEach(function (t) {
      var d = el("div", "tile"); d.appendChild(el("div", "v", t[1])); d.appendChild(el("div", "l", t[0]));
      localTiles.appendChild(d);
    });
    panel.appendChild(localTiles);

    var grid = el("div", "subgrid two"); grid.style.marginTop = "16px";

    // The extension's own session on this machine — not a customer account.
    var uc = el("div", "card pad"); uc.appendChild(h3ic("user", "Extension session here"));
    var ukv = el("div"); ukv.style.margin = "12px 0";
    kvRow(ukv, "Username", user && user.username ? user.username : "Guest");
    kvRow(ukv, "Email", user && user.email ? user.email : "—");
    kvRow(ukv, "Verified", user && (user.emailVerified || user.is_email_verified) ? "Yes" : "No");
    uc.appendChild(ukv);
    var urow = el("div", "row");
    urow.appendChild(btn("Sign out / clear auth", "ghost sm", function () {
      store.remove(["erasioUser", "erasioAccessToken", "erasioRefreshToken"]).then(function () { toast("Auth cleared — reload target tabs"); reload(); });
    }));
    urow.appendChild(btn("Force token refresh", "ghost sm", function () { sendMsg({ action: "erasioRefreshAuth" }); toast("Refresh requested"); }));
    urow.appendChild(btn("Replay onboarding", "ghost sm", function () { state.raw.erasioOnboarded = false; store.set({ erasioOnboarded: false }); toast("Onboarding reset"); }));
    uc.appendChild(urow);
    grid.appendChild(uc);

    // Subscription
    var sc = el("div", "card pad"); sc.appendChild(h3ic("subscription", "Subscription"));
    var skv = el("div"); skv.style.margin = "12px 0";
    kvRow(skv, "Current plan", cs.planName || plan);
    kvRow(skv, "Resets", cs.resetAt ? new Date(cs.resetAt).toLocaleString() : "—");
    kvRow(skv, "Allowance", unlimited ? "Unlimited" : ((cs.remaining != null ? cs.remaining : "—") + " of " + (cs.limit != null ? cs.limit : "—")));
    sc.appendChild(skv);
    var srow = el("div", "row");
    srow.appendChild(btn("Sync from server", "sm", function () { sendMsg({ action: "erasioCreditStatus", force: true }); toast("Sync requested"); setTimeout(reload, 900); }));
    sc.appendChild(srow);
    // This card describes the account signed in on THIS machine. Entitlements
    // are server-side now, so anything set locally is overwritten by the next
    // sync — Users (one account) and Plans (a whole tier) are where it sticks.
    var note = el("div", "callout");
    note.textContent = "Shows the account signed in on this machine. To change an allowance use the Users tab for one account, or Plans for a whole tier — those are stored on the server.";
    sc.appendChild(note);
    grid.appendChild(sc);
    panel.appendChild(grid);

    // Credit control. Read-only on purpose: credits are decided by the server
    // now, so a number typed into this browser's cache would be overwritten by
    // the next sync — an editable field here would just be a way to confuse
    // yourself. Real changes live in Users (one account) and Plans (a tier).
    var cc = el("div", "card pad"); cc.appendChild(h3ic("credit", "Credits on this machine"));
    var ckv = el("div"); ckv.style.margin = "12px 0";
    kvRow(ckv, "Remaining", cs.remaining != null ? String(cs.remaining) : "—");
    kvRow(ckv, "Daily limit", cs.limit ? String(cs.limit) : (cs.limit === 0 ? "Unlimited" : "—"));
    kvRow(ckv, "Images cleaned here", processed.toLocaleString());
    cc.appendChild(ckv);
    var crow2 = el("div", "row");
    crow2.appendChild(btn("Grant credits to a user", "sm", function () { active = "users"; render(); }));
    crow2.appendChild(btn("Reset processed count", "ghost sm", function () { state.raw.processedCount = 0; store.set({ processedCount: 0 }); toast("Processed count reset"); reload(); }));
    cc.appendChild(crow2);
    panel.appendChild(cc);

    // Analytics
    var ac = el("div", "card pad"); ac.appendChild(h3ic("analytics", "Advanced analytics"));
    var t2 = el("div", "tiles"); t2.style.margin = "12px 0";
    [["Total cleaned", processed.toLocaleString()], ["This session", "—"], ["Hit rate", "—"], ["Credits saved", (processed).toLocaleString()]]
      .forEach(function (t) { var d = el("div", "tile"); d.appendChild(el("div", "v", t[1])); d.appendChild(el("div", "l", t[0])); t2.appendChild(d); });
    ac.appendChild(t2);
    var an = el("div", "callout"); an.textContent = "Per-surface breakdown, hit rate, and detection scores stream from AIP_DETECT_TELEMETRY (Phase 3). Total cleaned reads processedCount now.";
    ac.appendChild(an);
    panel.appendChild(ac);

    // Account & security — the owner account itself, and its second factor.
    var ast = (window.Auth && Auth.state) || {};
    var clc = el("div", "card pad"); clc.appendChild(h3ic("user", "Account & security"));
    var cl = el("div"); cl.style.margin = "12px 0";
    kvRow(cl, "Signed in as", (ast.user && ast.user.email) || "—");
    kvRow(cl, "Two-factor", ast.totpEnabled ? "On" : "Off");
    clc.appendChild(cl);

    var clr = el("div", "row");
    if (ast.totpEnabled) {
      clr.appendChild(btn("Turn off 2FA", "ghost sm", function () { Auth.openTwoFactorDisable(); }));
    } else {
      clr.appendChild(btn("Turn on 2FA", "sm", function () { Auth.openTwoFactorSetup(); }));
    }
    clr.appendChild(btn("Sign out", "ghost sm", function () { Auth.signOut().then(function () { toast("Signed out"); }); }));
    clc.appendChild(clr);
    if (!ast.totpEnabled) {
      clc.appendChild(el("div", "callout", "This account opens every setting, user and subscription. Two-factor means a leaked password alone isn't enough to get in."));
    }
    panel.appendChild(clc);

    // Settings backup — the panel's settings, saved server-side against this
    // account so a reinstall or a second machine starts from where you left off.
    var syc = el("div", "card pad"); syc.appendChild(h3ic("subscription", "Settings backup"));
    syc.appendChild(el("p", "sec-sub", "Saves this panel's Detection, Removal and Video settings to your account. Autosaves as you edit; these are for restoring by hand."));
    var syr = el("div", "row"); syr.style.marginTop = "12px";
    syr.appendChild(btn("Back up now", "sm", cloudPushNow));
    syr.appendChild(btn("Restore", "ghost sm", pullNow));
    syc.appendChild(syr);
    panel.appendChild(syc);
  }

  /* ---- Users ----
   * Reads the backend's real users table, so everyone who signed up counts —
   * password or Google. This is deliberately server-only data: the extension's
   * own chrome.storage knows about exactly one account (whoever is signed in on
   * this machine), which is why the Dashboard's User control card can only ever
   * say "Guest". */
  var usersState = { q: "", offset: 0, limit: 25, loading: false, data: null, error: null, openId: null };
  var adminStats = null; // cached so flipping between tabs doesn't refetch each render

  function adminApi(path, opts) {
    opts = opts || {};
    opts.credentials = "include";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
    var base = (location.protocol === "http:" || location.protocol === "https:") ? "" : "https://erasezo.com";
    return fetch(base + path, opts).then(function (r) {
      return r.text().then(function (t) {
        var b = null; try { b = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) { var e2 = new Error((b && (b.message || b.error)) || ("HTTP " + r.status)); e2.code = b && b.error; throw e2; }
        return b;
      });
    });
  }

  function fmtDate(s) { if (!s) return "—"; try { return new Date(s).toLocaleDateString(); } catch (e) { return "—"; } }

  function loadUsers(panel) {
    usersState.loading = true;
    adminApi("/api/admin/users?limit=" + usersState.limit + "&offset=" + usersState.offset +
             (usersState.q ? "&q=" + encodeURIComponent(usersState.q) : ""))
      .then(function (d) { usersState.data = d; usersState.error = null; })
      .catch(function (e) { usersState.error = e.message; usersState.data = null; })
      .then(function () { usersState.loading = false; render(); });
  }

  function renderUsers(tab, panel) {
    var ph = el("div", "panel-head"); ph.appendChild(el("h2", null, "Users"));
    ph.appendChild(el("p", null, "Everyone registered on erasezo.com — password and Google sign-ups alike — with their credits and subscription."));
    panel.appendChild(ph);

    // Search
    var sc = el("div", "card pad");
    var srow = el("div", "row");
    var search = el("input"); search.type = "text";
    search.placeholder = "Search by email or username"; search.value = usersState.q;
    search.style.minWidth = "280px";
    search.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { usersState.q = search.value.trim(); usersState.offset = 0; loadUsers(panel); }
    });
    srow.appendChild(search);
    srow.appendChild(btn("Search", "sm", function () { usersState.q = search.value.trim(); usersState.offset = 0; loadUsers(panel); }));
    if (usersState.q) srow.appendChild(btn("Clear", "ghost sm", function () { usersState.q = ""; usersState.offset = 0; loadUsers(panel); }));
    sc.appendChild(srow);
    panel.appendChild(sc);

    if (usersState.loading && !usersState.data) { renderSkeleton(panel); return; }
    if (usersState.error) {
      var ec = el("div", "card pad");
      ec.appendChild(el("div", "callout", "Couldn't load users: " + usersState.error));
      panel.appendChild(ec); return;
    }
    if (!plansState.data && !plansState.loading) loadPlans(); // needed for the plan dropdown
    if (!usersState.data) { loadUsers(panel); renderSkeleton(panel); return; }

    var d = usersState.data;
    var lc = el("div", "card pad");
    lc.appendChild(h3ic("user", d.total + (d.total === 1 ? " account" : " accounts")));
    if (!d.users.length) {
      lc.appendChild(el("div", "callout", usersState.q ? "No account matches that search." : "No one has signed up yet."));
      panel.appendChild(lc); return;
    }

    d.users.forEach(function (u) { lc.appendChild(userRow(u, panel)); });

    // Paging
    if (d.total > d.limit) {
      var pr = el("div", "row"); pr.style.marginTop = "14px";
      if (d.offset > 0) pr.appendChild(btn("← Previous", "ghost sm", function () {
        usersState.offset = Math.max(0, d.offset - d.limit); loadUsers(panel);
      }));
      if (d.offset + d.limit < d.total) pr.appendChild(btn("Next →", "ghost sm", function () {
        usersState.offset = d.offset + d.limit; loadUsers(panel);
      }));
      pr.appendChild(el("span", "sec-sub", "Showing " + (d.offset + 1) + "–" + Math.min(d.offset + d.limit, d.total) + " of " + d.total));
      lc.appendChild(pr);
    }
    panel.appendChild(lc);
  }

  function userRow(u, panel) {
    var head = el("button", "userrow-head");
    head.addEventListener("click", function () { openUserDrawer(u.userId); });

    var who = el("div", "userrow-who");
    who.appendChild(el("b", null, u.email));
    var meta = el("span", "userrow-meta");
    meta.textContent = (u.authProvider === "google" ? "Google" : "Password") + " · joined " + fmtDate(u.createdAt);
    who.appendChild(meta);
    head.appendChild(who);

    var tags = el("div", "userrow-tags");
    if (u.isAdmin) tags.appendChild(el("span", "utag utag-admin", "admin"));
    if (u.disabled) tags.appendChild(el("span", "utag utag-off", "disabled"));
    else if (u.suspension) tags.appendChild(el("span", "utag utag-warn", "suspended"));
    tags.appendChild(el("span", "utag utag-" + (u.subscription.status === "active" ? "on" : "muted"),
      u.subscription.status === "active" ? (u.subscription.plan || "pro") : u.subscription.status));
    tags.appendChild(el("span", "utag utag-muted", u.credits.balance + " cr"));
    head.appendChild(tags);

    var wrap = el("div", "userrow");
    wrap.appendChild(head);
    return wrap;
  }

  /* ---- user drawer ----
   * A slide-over instead of an inline accordion, with the account pinned in the
   * header. The old version expanded under the row, so as soon as the controls
   * were taller than the viewport the email scrolled away and you were changing
   * someone's plan with no idea whose. */
  var drawer = { el: null, user: null, section: "overview", busy: false };

  function closeUserDrawer() {
    if (drawer.el) { drawer.el.remove(); drawer.el = null; }
    document.removeEventListener("keydown", drawerEsc);
    drawer.user = null;
  }
  function drawerEsc(e) { if (e.key === "Escape") closeUserDrawer(); }

  function openUserDrawer(id) {
    drawer.section = "overview";
    document.addEventListener("keydown", drawerEsc);
    paintDrawer(null, id);
    adminApi("/api/admin/users/" + id)
      .then(function (u) { drawer.user = u; paintDrawer(u, id); })
      .catch(function (e) { toast("Couldn't load that account: " + e.message); closeUserDrawer(); });
  }
  function refreshDrawer() {
    if (!drawer.user) return Promise.resolve();
    return adminApi("/api/admin/users/" + drawer.user.userId).then(function (u) {
      drawer.user = u; paintDrawer(u, u.userId); loadUsers();
    });
  }

  function paintDrawer(u, id) {
    if (!drawer.el) {
      drawer.el = el("div", "drawer-ov");
      drawer.el.addEventListener("mousedown", function (e) { if (e.target === drawer.el) closeUserDrawer(); });
      var panelEl = el("aside", "drawer");
      panelEl.addEventListener("mousedown", function (e) { e.stopPropagation(); });
      drawer.el.appendChild(panelEl);
      document.body.appendChild(drawer.el);
    }
    var d = drawer.el.querySelector(".drawer");
    d.innerHTML = "";

    if (!u) { d.appendChild(el("div", "drawer-head")).appendChild(el("h3", null, "Loading…")); return; }

    /* Sticky identity header — this is the whole point of the drawer. */
    var head = el("div", "drawer-head");
    var idb = el("div", "drawer-id");
    idb.appendChild(el("div", "avatar-sm", (u.username || u.email).slice(0, 1).toUpperCase()));
    var idt = el("div", "drawer-idt");
    idt.appendChild(el("b", null, u.email));
    var sub = el("span");
    sub.textContent = (u.username || "—") + " · " + (u.authProvider === "google" ? "Google" : "Password") + " · id " + u.userId;
    idt.appendChild(sub);
    idb.appendChild(idt);
    head.appendChild(idb);
    var x = el("button", "sbm-x", "✕"); x.setAttribute("aria-label", "Close");
    x.addEventListener("click", closeUserDrawer);
    head.appendChild(x);

    var st = el("div", "drawer-tags");
    if (u.isAdmin) st.appendChild(el("span", "utag utag-admin", "admin"));
    if (u.disabled) st.appendChild(el("span", "utag utag-off", "disabled — cannot sign in"));
    if (u.suspension) st.appendChild(el("span", "utag utag-warn", "suspended"));
    st.appendChild(el("span", "utag utag-" + (u.subscription.status === "active" ? "on" : "muted"),
      u.subscription.status === "active" ? "on " + (u.subscription.plan || "pro") : u.subscription.status));
    head.appendChild(st);

    var tabs = el("div", "drawer-tabs");
    [["overview", "Overview"], ["billing", "Billing"], ["credits", "Credits"], ["access", "Access"]].forEach(function (t) {
      var b = el("button", drawer.section === t[0] ? "on" : "", t[1]);
      b.addEventListener("click", function () { drawer.section = t[0]; paintDrawer(drawer.user, id); });
      tabs.appendChild(b);
    });
    head.appendChild(tabs);
    d.appendChild(head);

    var body = el("div", "drawer-body");
    d.appendChild(body);
    if (u.suspension) {
      var warn = el("div", "callout callout-warn");
      warn.textContent = "Suspended: " + u.suspension.reason +
        (u.suspension.until ? " — lifts " + fmtDate(u.suspension.until) : " — no end date");
      body.appendChild(warn);
    }
    ({ overview: drawerOverview, billing: drawerBilling, credits: drawerCredits, access: drawerAccess }[drawer.section])(body, u);
  }

  function apply(u, patch, okMsg) {
    if (drawer.busy) return;
    drawer.busy = true;
    return adminApi("/api/admin/users/" + u.userId, { method: "PATCH", body: patch })
      .then(function () { toast(okMsg || "Saved"); return refreshDrawer(); })
      .catch(function (e) {
        toast(e.code === "cannot_lock_self_out" ? "You can't disable or demote your own admin account" : "Failed: " + e.message);
      })
      .then(function () { drawer.busy = false; });
  }

  function drawerOverview(body, u) {
    var a = u.analytics || { daily: [], spent30: 0, activeDays: 0, avgPerActiveDay: 0, accountAgeDays: 0 };
    var tiles = el("div", "tiles");
    [["Credits left", String(u.credits.balance)],
     ["Used in 30d", String(a.spent30)],
     ["Active days", String(a.activeDays)],
     ["Avg / active day", String(a.avgPerActiveDay)]].forEach(function (t) {
      var c = el("div", "tile"); c.appendChild(el("div", "v", t[1])); c.appendChild(el("div", "l", t[0]));
      tiles.appendChild(c);
    });
    body.appendChild(tiles);

    var ch = el("div", "card pad"); ch.appendChild(h3ic("analytics", "Last 30 days"));
    if (!a.daily.length) ch.appendChild(el("p", "sec-sub", "No activity recorded yet."));
    else ch.appendChild(miniChart(a.daily));
    body.appendChild(ch);

    var kvc = el("div", "card pad"); kvc.appendChild(h3ic("user", "Account"));
    var kv = el("div"); kv.style.marginTop = "10px";
    kvRow(kv, "Joined", fmtDate(u.createdAt) + " (" + a.accountAgeDays + " days ago)");
    kvRow(kv, "Last used", a.lastActive ? fmtDate(a.lastActive) : "never");
    kvRow(kv, "Sign-in", u.authProvider === "google" ? "Google" : "Email + password");
    kvRow(kv, "Daily quota", u.credits.dailyQuota + (u.credits.quotaIsOverride ? " (override)" : " (from plan)"));
    kvc.appendChild(kv);
    body.appendChild(kvc);
  }

  /* Inline SVG: one series of bars, and the site's CSP blocks third-party
   * scripts anyway. */
  function miniChart(daily) {
    var days = [];
    for (var i = 29; i >= 0; i--) {
      var key = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      var hit = daily.filter(function (x) { return x.date === key; })[0];
      days.push({ date: key, used: hit ? hit.used : 0 });
    }
    var max = Math.max(1, Math.max.apply(null, days.map(function (d) { return d.used; })));
    var W = 640, H = 120, gap = 3, bw = (W - gap * (days.length - 1)) / days.length;
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("class", "chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Credits spent per day over the last 30 days, peak " + max + ".");
    days.forEach(function (d, i) {
      var h = d.used ? Math.max(3, (d.used / max) * H) : 2;
      var r = document.createElementNS(ns, "rect");
      r.setAttribute("x", (i * (bw + gap)).toFixed(2)); r.setAttribute("y", (H - h).toFixed(2));
      r.setAttribute("width", bw.toFixed(2)); r.setAttribute("height", h.toFixed(2));
      r.setAttribute("rx", "2"); r.setAttribute("class", d.used ? "bar" : "bar zero");
      var t = document.createElementNS(ns, "title");
      t.textContent = d.date + ": " + d.used + (d.used === 1 ? " credit" : " credits");
      r.appendChild(t); svg.appendChild(r);
    });
    var wrap = el("div", "chart-wrap"); wrap.appendChild(svg);
    wrap.appendChild(el("p", "sec-sub", "Peak " + max + " on a single day."));
    return wrap;
  }

  function drawerBilling(body, u) {
    var c = el("div", "card pad"); c.appendChild(h3ic("subscription", "Subscription"));
    var kv = el("div"); kv.style.marginTop = "10px";
    kvRow(kv, "Status", u.subscription.status);
    kvRow(kv, "Plan", u.subscription.plan || "—");
    if (u.subscription.provider) kvRow(kv, "Billed via", u.subscription.provider);
    if (u.subscription.currentPeriodEnd) kvRow(kv, "Period ends", fmtDate(u.subscription.currentPeriodEnd));
    if (u.subscription.providerSubscriptionId) kvRow(kv, "Provider ref", u.subscription.providerSubscriptionId);
    c.appendChild(kv);
    body.appendChild(c);

    var e = el("div", "card pad"); e.appendChild(h3ic("credit", "Change subscription"));
    var r1 = el("div", "row"); r1.style.marginTop = "10px";
    var sel = el("select");
    [["none", "No subscription"], ["active", "Active"], ["past_due", "Past due"], ["cancelled", "Cancelled"]].forEach(function (o) {
      var op = el("option", null, o[1]); op.value = o[0];
      if (u.subscription.status === o[0]) op.selected = true;
      sel.appendChild(op);
    });
    var planIn = el("select");
    var none = el("option", null, "— no plan —"); none.value = ""; planIn.appendChild(none);
    (plansState.data || []).forEach(function (pl) {
      var op = el("option", null, pl.name + " (" + (pl.unlimited ? "unlimited" : pl.dailyQuota + "/day") + ")");
      op.value = pl.id; if (u.subscription.plan === pl.id) op.selected = true;
      planIn.appendChild(op);
    });
    if (u.subscription.plan && !(plansState.data || []).some(function (pl) { return pl.id === u.subscription.plan; })) {
      var orphan = el("option", null, u.subscription.plan + " (missing plan)");
      orphan.value = u.subscription.plan; orphan.selected = true; planIn.appendChild(orphan);
    }
    r1.appendChild(sel); r1.appendChild(planIn);
    r1.appendChild(btn("Apply", "sm", function () {
      apply(u, { subscription: { status: sel.value, plan: planIn.value || null } }, "Subscription updated");
    }));
    e.appendChild(r1);
    e.appendChild(el("p", "sec-sub", "Set by hand this counts as manually managed. A Razorpay webhook overwrites it on the next billing event."));
    body.appendChild(e);
  }

  function drawerCredits(body, u) {
    var c = el("div", "card pad"); c.appendChild(h3ic("credit", "Balance"));
    var kv = el("div"); kv.style.marginTop = "10px";
    kvRow(kv, "Credits left", String(u.credits.balance));
    kvRow(kv, "Used today", String(u.credits.usedToday));
    kvRow(kv, "Used all time", String(u.credits.usedTotal));
    kvRow(kv, "Daily quota", u.credits.dailyQuota + (u.credits.quotaIsOverride ? " (override)" : " (from plan)"));
    c.appendChild(kv);

    var r = el("div", "row"); r.style.marginTop = "12px";
    var amt = el("input"); amt.type = "number"; amt.value = "50";
    r.appendChild(amt);
    r.appendChild(btn("Add", "sm", function () { moveUserCredits(u, Math.abs(parseInt(amt.value, 10) || 0), "admin_grant"); }));
    r.appendChild(btn("Deduct", "ghost sm", function () { moveUserCredits(u, -Math.abs(parseInt(amt.value, 10) || 0), "admin_deduct"); }));
    c.appendChild(r);

    var q = el("div", "row");
    var quota = el("input"); quota.type = "number"; quota.value = String(u.credits.dailyQuota);
    q.appendChild(el("span", "sec-sub", "Daily quota"));
    q.appendChild(quota);
    q.appendChild(btn("Set", "sm", function () { apply(u, { dailyQuota: parseInt(quota.value, 10) }, "Quota updated"); }));
    if (u.credits.quotaIsOverride) q.appendChild(btn("Follow the plan", "ghost sm", function () { apply(u, { dailyQuota: null }, "Now follows the plan"); }));
    c.appendChild(q);
    body.appendChild(c);

    var l = el("div", "card pad"); l.appendChild(h3ic("history", "Recent ledger"));
    if (!(u.ledger || []).length) l.appendChild(el("p", "sec-sub", "Nothing yet."));
    else {
      var list = el("div"); list.style.marginTop = "8px";
      u.ledger.forEach(function (row) {
        var d2 = el("div", "kv");
        var left = el("span"); left.textContent = row.reason + " · " + fmtDate(row.created_at);
        d2.appendChild(left);
        d2.appendChild(el("b", null, (row.delta > 0 ? "+" : "") + row.delta));
        list.appendChild(d2);
      });
      l.appendChild(list);
    }
    body.appendChild(l);
  }
  function moveUserCredits(u, delta, reason) {
    if (!delta) { toast("Enter a non-zero amount"); return; }
    adminApi("/api/admin/users/" + u.userId + "/credits", { method: "POST", body: { delta: delta, reason: reason } })
      .then(function () { toast(delta > 0 ? "Credits added" : "Credits deducted"); return refreshDrawer(); })
      .catch(function (e) { toast("Failed: " + e.message); });
  }

  /* Access. The three states are deliberately different things, or there would
   * be no reason for three controls:
   *   suspend — can still sign in and manage billing, cannot spend credits
   *   disable — cannot sign in at all
   *   delete  — the account and its history are gone */
  function drawerAccess(body, u) {
    var s = el("div", "card pad"); s.appendChild(h3ic("user", "Suspend"));
    s.appendChild(el("p", "sec-sub", "Blocks credit use while leaving sign-in and billing alone. Use it to pause an account without locking someone out of their own subscription."));
    if (u.suspension) {
      var cur = el("div"); cur.style.marginTop = "10px";
      kvRow(cur, "Reason", u.suspension.reason);
      kvRow(cur, "Lifts", u.suspension.until ? fmtDate(u.suspension.until) : "no end date — stays until lifted");
      s.appendChild(cur);
      var lr = el("div", "row");
      lr.appendChild(btn("Lift suspension", "sm", function () {
        adminApi("/api/admin/users/" + u.userId + "/suspend", { method: "POST", body: { lift: true } })
          .then(function () { toast("Suspension lifted"); return refreshDrawer(); })
          .catch(function (e) { toast("Failed: " + e.message); });
      }));
      s.appendChild(lr);
    } else {
      var reason = el("input"); reason.type = "text"; reason.placeholder = "Reason (the account is shown this)";
      reason.style.minWidth = "260px";
      var days = el("input"); days.type = "number"; days.placeholder = "days"; days.value = "7";
      var sr = el("div", "row"); sr.style.marginTop = "10px";
      sr.appendChild(reason); sr.appendChild(days);
      sr.appendChild(btn("Suspend", "sm", function () {
        var v = reason.value.trim();
        if (!v) { toast("Give a reason — the account is shown it"); return; }
        var n = parseInt(days.value, 10);
        adminApi("/api/admin/users/" + u.userId + "/suspend", { method: "POST", body: { reason: v, days: n > 0 ? n : null } })
          .then(function () { toast("Account suspended"); return refreshDrawer(); })
          .catch(function (e) { toast(e.code === "cannot_suspend_self" ? "You can't suspend your own account" : "Failed: " + e.message); });
      }));
      s.appendChild(sr);
      s.appendChild(el("p", "sec-sub", "Leave days empty for an open-ended hold. A dated suspension lifts itself."));
    }
    body.appendChild(s);

    var d = el("div", "card pad"); d.appendChild(h3ic("maintenance", "Disable"));
    d.appendChild(el("p", "sec-sub", "Blocks sign-in everywhere — the site, the extension and Google. Billing is untouched."));
    var dr = el("div", "row"); dr.style.marginTop = "10px";
    dr.appendChild(btn(u.disabled ? "Re-enable sign-in" : "Disable sign-in", u.disabled ? "sm" : "ghost sm", function () {
      apply(u, { disabled: !u.disabled }, u.disabled ? "Sign-in re-enabled" : "Sign-in disabled");
    }));
    dr.appendChild(btn(u.isAdmin ? "Revoke admin" : "Make admin", "ghost sm", function () {
      apply(u, { isAdmin: !u.isAdmin }, u.isAdmin ? "Admin revoked" : "Admin granted");
    }));
    d.appendChild(dr);
    body.appendChild(d);

    var del = el("div", "card pad danger-card"); del.appendChild(h3ic("maintenance", "Delete account"));
    del.appendChild(el("p", "sec-sub", "Removes the account, its credit history and its subscription. This cannot be undone — suspend or disable instead if you might want it back."));
    var confirm = el("input"); confirm.type = "text"; confirm.placeholder = "Type " + u.email + " to confirm";
    confirm.style.minWidth = "280px";
    var delr = el("div", "row"); delr.style.marginTop = "10px";
    delr.appendChild(confirm);
    delr.appendChild(btn("Delete permanently", "danger sm", function () {
      adminApi("/api/admin/users/" + u.userId, { method: "DELETE", body: { confirmEmail: confirm.value.trim() } })
        .then(function () { toast("Account deleted"); closeUserDrawer(); loadUsers(); })
        .catch(function (e) {
          toast({
            confirm_mismatch: "Type the account's email exactly to confirm.",
            admin_account: "Revoke admin on this account before deleting it.",
            cannot_delete_self: "You can't delete your own account."
          }[e.code] || ("Failed: " + e.message));
        });
    }));
    del.appendChild(delr);
    body.appendChild(del);
  }

  /* ---- Plans ----
   * What each tier actually grants. Until now "pro" was a bare label on a
   * subscription with nothing behind it, so changing someone's plan changed
   * nothing they could do. A quota of -1 means unlimited. */
  var plansState = { loading: false, data: null, error: null, editing: null };

  function loadPlans() {
    plansState.loading = true;
    adminApi("/api/admin/plans")
      .then(function (d) { plansState.data = d.plans; plansState.error = null; })
      .catch(function (e) { plansState.error = e.message; })
      .then(function () { plansState.loading = false; render(); });
  }

  function renderPlans(tab, panel) {
    var ph = el("div", "panel-head"); ph.appendChild(el("h2", null, "Plans"));
    ph.appendChild(el("p", null, "What each tier grants. The daily quota here is what the extension enforces — set it to -1 for unlimited. Live for every account on the plan."));
    panel.appendChild(ph);

    if (plansState.error) {
      var ec = el("div", "card pad"); ec.appendChild(el("div", "callout", "Couldn't load plans: " + plansState.error));
      panel.appendChild(ec); return;
    }
    if (!plansState.data) { if (!plansState.loading) loadPlans(); renderSkeleton(panel); return; }

    plansState.data.forEach(function (p) { panel.appendChild(planCard(p)); });

    // New plan
    var nc = el("div", "card pad");
    nc.appendChild(h3ic("subscription", "Add a plan"));
    var f = planForm({ id: "", name: "", dailyQuota: 100, priceInr: 0, razorpayPlanId: "", active: true, sortOrder: (plansState.data.length || 0) }, true);
    nc.appendChild(f.node);
    var nr = el("div", "row"); nr.style.marginTop = "12px";
    nr.appendChild(btn("Create plan", "sm", function () {
      adminApi("/api/admin/plans", { method: "POST", body: f.read() })
        .then(function () { toast("Plan created"); loadPlans(); })
        .catch(function (e) { toast(planError(e)); });
    }));
    nc.appendChild(nr);
    panel.appendChild(nc);
  }

  function planError(e) {
    return ({
      bad_id: "Use a short lowercase id — letters, numbers, dash or underscore.",
      bad_quota: "Daily quota must be a whole number, or -1 for unlimited.",
      bad_price: "Price must be a whole number of rupees.",
      bad_name: "Give the plan a name.",
      already_exists: "A plan with that id already exists.",
      cannot_delete_free: "The free plan is the fallback for every unsubscribed account and can't be deleted.",
      plan_in_use: e.message,
    })[e.code] || ("Failed: " + e.message);
  }

  function planForm(p, isNew) {
    var wrap = el("div");
    function row(label, input, hint) {
      var r = el("div", "field");
      var l = el("div"); l.appendChild(el("div", "lab", label));
      if (hint) l.appendChild(el("div", "help", hint));
      var c = el("div", "ctl"); c.appendChild(input);
      r.appendChild(l); r.appendChild(c); wrap.appendChild(r);
      return input;
    }
    var idIn = el("input"); idIn.type = "text"; idIn.value = p.id; idIn.placeholder = "pro";
    if (!isNew) { idIn.disabled = true; idIn.title = "A plan's id is referenced by existing subscriptions and can't be renamed."; }
    row("Plan id", idIn, isNew ? "Lowercase, no spaces. Referenced by subscriptions, so it can't be changed later." : "Referenced by existing subscriptions.");

    var nameIn = el("input"); nameIn.type = "text"; nameIn.value = p.name; nameIn.placeholder = "Pro";
    row("Display name", nameIn);

    var quotaIn = el("input"); quotaIn.type = "number"; quotaIn.value = String(p.dailyQuota);
    row("Daily quota", quotaIn, "Images per day. -1 means unlimited.");

    var priceIn = el("input"); priceIn.type = "number"; priceIn.value = String(p.priceInr);
    row("Price (₹/month)", priceIn, "Display only — Razorpay holds the real amount.");

    var rzpIn = el("input"); rzpIn.type = "text"; rzpIn.value = p.razorpayPlanId || ""; rzpIn.placeholder = "plan_XXXXXXXX";
    row("Razorpay plan id", rzpIn, "From the Razorpay dashboard. Links a webhook event to this tier.");

    var activeIn = el("input"); activeIn.type = "checkbox"; activeIn.checked = p.active !== false;
    row("Offered to new customers", activeIn, "Turning this off hides the plan without affecting anyone already on it.");

    return {
      node: wrap,
      read: function () {
        return {
          id: idIn.value.trim().toLowerCase(), name: nameIn.value.trim(),
          dailyQuota: parseInt(quotaIn.value, 10), priceInr: parseInt(priceIn.value, 10),
          razorpayPlanId: rzpIn.value.trim() || null, active: activeIn.checked,
          sortOrder: p.sortOrder || 0,
        };
      },
    };
  }

  function planCard(p) {
    var c = el("div", "card pad");
    var head = el("div", "row");
    head.appendChild(h3ic("subscription", p.name));
    var tags = el("div", "userrow-tags"); tags.style.marginLeft = "auto";
    tags.appendChild(el("span", "utag utag-muted", p.id));
    tags.appendChild(el("span", "utag " + (p.unlimited ? "utag-on" : "utag-muted"), p.unlimited ? "unlimited" : p.dailyQuota + "/day"));
    tags.appendChild(el("span", "utag utag-muted", "₹" + p.priceInr));
    if (!p.active) tags.appendChild(el("span", "utag utag-off", "hidden"));
    tags.appendChild(el("span", "utag " + (p.activeSubscribers ? "utag-admin" : "utag-muted"),
      p.activeSubscribers + (p.activeSubscribers === 1 ? " subscriber" : " subscribers")));
    head.appendChild(tags);
    c.appendChild(head);

    var open = plansState.editing === p.id;
    var r = el("div", "row"); r.style.marginTop = "10px";
    r.appendChild(btn(open ? "Close" : "Edit", open ? "ghost sm" : "sm", function () {
      plansState.editing = open ? null : p.id; render();
    }));
    if (p.id !== "free") {
      r.appendChild(btn("Delete", "ghost sm", function () {
        adminApi("/api/admin/plans/" + encodeURIComponent(p.id), { method: "DELETE" })
          .then(function () { toast("Plan deleted"); loadPlans(); })
          .catch(function (e) { toast(planError(e)); });
      }));
    }
    c.appendChild(r);

    if (open) {
      var f = planForm(p, false);
      c.appendChild(f.node);
      var sr = el("div", "row"); sr.style.marginTop = "12px";
      sr.appendChild(btn("Save changes", "sm", function () {
        adminApi("/api/admin/plans/" + encodeURIComponent(p.id), { method: "PATCH", body: f.read() })
          .then(function () { toast("Plan saved"); plansState.editing = null; loadPlans(); })
          .catch(function (e) { toast(planError(e)); });
      }));
      c.appendChild(sr);
    }
    return c;
  }

  function renderMaskLocks(tab, panel) {
    var ph = el("div", "panel-head"); ph.appendChild(el("h2", null, "Mask Locks"));
    ph.appendChild(el("p", null, "Pin the mask to an absolute position for an exact resolution — every image of that size skips detection and cleans at the fixed spot. This is live."));
    panel.appendChild(ph);

    // maskPosition mode
    panel.appendChild(el("div", "group-title", "Global mask mode · erasioToolImageSettings.maskPosition"));
    var mp = get("image", "maskPosition", { mode: "auto", dx: 0, dy: 0 });
    var mcard = el("div", "card");
    var frow = el("div", "field");
    var fl = el("div"); fl.appendChild(el("div", "lab", "Mode")); fl.appendChild(el("div", "help", "Auto-detect, or a fixed corner-offset (dx, dy from bottom-right) applied to every image."));
    frow.appendChild(fl);
    var fctl = el("div", "ctl");
    var sel = el("select"); [["auto", "Auto-detect"], ["pinned", "Pinned offset"]].forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; if (mp.mode === o[0]) op.selected = true; sel.appendChild(op); });
    var dx = numInput(mp.dx || 0, function (v) { mp.dx = v; state.image.maskPosition = mp; scheduleSave("image"); });
    var dy = numInput(mp.dy || 0, function (v) { mp.dy = v; state.image.maskPosition = mp; scheduleSave("image"); });
    dx.style.width = dy.style.width = "70px";
    sel.addEventListener("change", function () { mp.mode = sel.value; state.image.maskPosition = mp; scheduleSave("image"); });
    fctl.appendChild(sel); fctl.appendChild(labelWrap("dx", dx)); fctl.appendChild(labelWrap("dy", dy));
    frow.appendChild(fctl); mcard.appendChild(frow);
    panel.appendChild(mcard);

    // locks table
    panel.appendChild(el("div", "group-title", "Absolute resolution locks · erasioToolImageSettings.maskLocks"));
    var card = el("div", "card pad");
    var locks = (get("image", "maskLocks", []) || []).slice();
    var tbl = el("table");
    var thead = el("tr"); ["Width", "Height", "Mask X", "Mask Y", "Size", ""].forEach(function (h) { thead.appendChild(el("th", null, h)); });
    var thd = el("thead"); thd.appendChild(thead); tbl.appendChild(thd);
    var tb = el("tbody");
    function commit() { state.image.maskLocks = locks.slice(); scheduleSave("image"); }
    function drawRows() {
      tb.innerHTML = "";
      locks.forEach(function (L, i) {
        var tr = el("tr");
        [["w"], ["h"], ["x"], ["y"], ["size"]].forEach(function (col) {
          var td = el("td");
          var inp = el("input"); inp.type = "number"; inp.value = L[col[0]] != null ? L[col[0]] : "";
          if (col[0] === "size") inp.placeholder = "auto";
          inp.addEventListener("change", function () { var v = inp.value === "" ? undefined : parseInt(inp.value, 10); if (col[0] === "size" && (v === undefined || isNaN(v))) delete L.size; else L[col[0]] = v; commit(); });
          td.appendChild(inp); tr.appendChild(td);
        });
        var tdd = el("td");
        tdd.appendChild(btn("✕", "danger sm", function () { locks.splice(i, 1); commit(); drawRows(); }));
        tr.appendChild(tdd); tb.appendChild(tr);
      });
    }
    tbl.appendChild(tb); card.appendChild(tbl); drawRows();
    var add = btn("+ Add lock", "ghost sm", function () { locks.push({ w: 1376, h: 768, x: 1255, y: 647 }); commit(); drawRows(); });
    add.style.marginTop = "12px"; card.appendChild(add);
    var hint = el("div", "callout"); hint.innerHTML = "X / Y are the mask's <b>top-left</b> in source pixels. Leave Size blank to infer (48 small · 96 large). Example that ships: 1376×768 → (1255, 647).";
    card.appendChild(hint);
    panel.appendChild(card);
  }

  function renderSync(tab, panel) {
    var ph = el("div", "panel-head"); ph.appendChild(el("h2", null, "Sync & Cache")); ph.appendChild(el("p", null, tab.desc));
    panel.appendChild(ph);
    panel.appendChild(el("div", "group-title", "Intervals · erasioSettings (engine phase)"));
    var c1 = el("div", "card");
    []
      .forEach(function (f) { f.t = "number"; c1.appendChild(fieldRow(f)); });
    panel.appendChild(c1);

    panel.appendChild(el("div", "group-title", "Actions"));
    var c2 = el("div", "card pad");
    var r = el("div", "row");
    r.appendChild(btn("Clear processed cache", "ghost", function () { toast("Signal sent to open tabs"); postToTabs({ channel: "AIP_ADMIN_CLEAR_CACHE" }); }));
    r.appendChild(btn("Sync credits now", "ghost", function () { sendMsg({ action: "erasioCreditStatus" }); toast("Credit sync requested"); }));
    r.appendChild(btn("Sync announcements", "ghost", function () { sendMsg({ action: "erasioAnnouncementSync" }); toast("Announcement sync requested"); }));
    c2.appendChild(r);
    c2.appendChild(el("div", "callout", "Cache clears are honored by open Gemini/Flow tabs via the config relay; if nothing changes, reload the target tab."));
    panel.appendChild(c2);
  }


  /* ---- Audit log ----
   * Append-only: this view can read and filter, and there is no control here
   * that edits or clears it, because a log its own admins can rewrite is not
   * evidence of anything. */
  var auditState = { loading: false, data: null, error: null, action: "", offset: 0, limit: 50 };

  function loadAudit() {
    auditState.loading = true;
    adminApi("/api/admin/audit?limit=" + auditState.limit + "&offset=" + auditState.offset +
             (auditState.action ? "&action=" + encodeURIComponent(auditState.action) : ""))
      .then(function (d) { auditState.data = d; auditState.error = null; })
      .catch(function (e) { auditState.error = e.message; })
      .then(function () { auditState.loading = false; render(); });
  }

  var ACTION_LABEL = {
    "admin.login": "Signed in", "admin.login_failed": "Sign-in refused",
    "admin.2fa_enabled": "Turned on 2FA", "admin.2fa_disabled": "Turned off 2FA",
    "user.disable": "Disabled an account", "user.enable": "Re-enabled an account",
    "user.grant_admin": "Granted admin", "user.revoke_admin": "Revoked admin",
    "user.quota": "Changed a daily quota", "user.subscription": "Changed a subscription",
    "user.credits": "Adjusted credits",
    "plan.create": "Created a plan", "plan.update": "Edited a plan", "plan.delete": "Deleted a plan"
  };

  function renderAudit(tab, panel) {
    var ph = el("div", "panel-head"); ph.appendChild(el("h2", null, "Audit log"));
    ph.appendChild(el("p", null, "Every change an admin made, and every sign-in that was refused. Read-only — nothing here can edit or clear it."));
    panel.appendChild(ph);

    if (auditState.error) {
      var ec = el("div", "card pad"); ec.appendChild(el("div", "callout", "Couldn't load the log: " + auditState.error));
      panel.appendChild(ec); return;
    }
    if (!auditState.data) { if (!auditState.loading) loadAudit(); renderSkeleton(panel); return; }
    var d = auditState.data;

    var fc = el("div", "card pad");
    var frow = el("div", "row");
    var sel = el("select");
    var all = el("option", null, "All activity"); all.value = ""; sel.appendChild(all);
    (d.actions || []).forEach(function (a) {
      var o = el("option", null, ACTION_LABEL[a] || a); o.value = a;
      if (a === auditState.action) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () { auditState.action = sel.value; auditState.offset = 0; loadAudit(); });
    frow.appendChild(sel);
    frow.appendChild(el("span", "sec-sub", d.total + (d.total === 1 ? " entry" : " entries")));
    fc.appendChild(frow);
    panel.appendChild(fc);

    var lc = el("div", "card pad");
    if (!d.entries.length) {
      lc.appendChild(el("div", "callout", auditState.action ? "Nothing recorded for that action yet." : "Nothing recorded yet."));
      panel.appendChild(lc); return;
    }
    d.entries.forEach(function (e) { lc.appendChild(auditRow(e)); });

    if (d.total > d.limit) {
      var pr = el("div", "row"); pr.style.marginTop = "14px";
      if (d.offset > 0) pr.appendChild(btn("← Newer", "ghost sm", function () { auditState.offset = Math.max(0, d.offset - d.limit); loadAudit(); }));
      if (d.offset + d.limit < d.total) pr.appendChild(btn("Older →", "ghost sm", function () { auditState.offset = d.offset + d.limit; loadAudit(); }));
      lc.appendChild(pr);
    }
    panel.appendChild(lc);
  }

  function auditRow(e) {
    var wrap = el("div", "userrow");
    var head = el("div", "userrow-head"); head.style.cursor = "default";
    var who = el("div", "userrow-who");
    who.appendChild(el("b", null, ACTION_LABEL[e.action] || e.action));
    var meta = el("span", "userrow-meta");
    meta.textContent = (e.actor_email || "unknown") + " · " + fmtWhen(e.created_at) + (e.ip ? " · " + e.ip : "");
    who.appendChild(meta);
    head.appendChild(who);

    var tags = el("div", "userrow-tags");
    if (e.action.indexOf("failed") !== -1) tags.appendChild(el("span", "utag utag-off", "refused"));
    if (e.target_type) tags.appendChild(el("span", "utag utag-muted", e.target_type + " " + (e.target_id || "")));
    head.appendChild(tags);
    wrap.appendChild(head);

    var detail = e.detail && Object.keys(e.detail).length ? e.detail : null;
    if (detail) {
      var body = el("div", "userrow-body");
      Object.keys(detail).forEach(function (k) {
        var v = detail[k];
        kvRow(body, k, (v && typeof v === "object") ? JSON.stringify(v) : String(v));
      });
      wrap.appendChild(body);
    }
    return wrap;
  }
  function fmtWhen(s) { try { return new Date(s).toLocaleString(); } catch (e) { return "—"; } }

  function renderMaintenance(tab, panel) {
    var ph = el("div", "panel-head"); ph.appendChild(el("h2", null, "Maintenance")); ph.appendChild(el("p", null, "Import / export the whole config, reset to defaults, and edit any storage key directly."));
    panel.appendChild(ph);

    panel.appendChild(el("div", "group-title", "Snapshot"));
    var c = el("div", "card pad"); var r = el("div", "row");
    r.appendChild(btn("Export all settings", "", function () { exportAll(); }));
    var imp = btn("Import…", "ghost", function () { fileInput.click(); }); r.appendChild(imp);
    r.appendChild(btn("Reset to defaults", "danger", function () { if (confirm("Reset all engine + settings to calibrated defaults?")) resetAll(); }));
    c.appendChild(r); panel.appendChild(c);
    var fileInput = el("input"); fileInput.type = "file"; fileInput.accept = "application/json"; fileInput.style.display = "none";
    fileInput.addEventListener("change", function () { var f = fileInput.files[0]; if (!f) return; var fr = new FileReader(); fr.onload = function () { try { importAll(JSON.parse(fr.result)); } catch (e) { toast("Invalid JSON"); } }; fr.readAsText(f); });
    c.appendChild(fileInput);

    panel.appendChild(el("div", "group-title", "Raw storage editor · every erasio* key"));
    var rc = el("div", "card pad");
    var tbl = el("table"); var thd = el("thead"); var htr = el("tr"); ["Key", "Value (JSON)", ""].forEach(function (h) { htr.appendChild(el("th", null, h)); }); thd.appendChild(htr); tbl.appendChild(thd);
    var tb = el("tbody");
    Object.keys(state.raw).sort().forEach(function (key) {
      var tr = el("tr");
      tr.appendChild(el("td", null, key));
      var vtd = el("td");
      var inp = el("input", "wide"); inp.type = "text"; inp.value = JSON.stringify(state.raw[key]);
      vtd.appendChild(inp); tr.appendChild(vtd);
      var atd = el("td"); var save = btn("Save", "sm", function () {
        try { var v = JSON.parse(inp.value); var o = {}; o[key] = v; store.set(o).then(function () { state.raw[key] = v; toast("Saved " + key); }); }
        catch (e) { toast("Invalid JSON for " + key); }
      });
      var del = btn("✕", "danger sm", function () { store.remove(key).then(function () { delete state.raw[key]; tr.remove(); toast("Removed " + key); }); });
      del.style.marginLeft = "6px"; atd.appendChild(save); atd.appendChild(del); tr.appendChild(atd);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    var wrap = el("div"); wrap.style.overflowX = "auto"; wrap.appendChild(tbl); rc.appendChild(wrap);
    panel.appendChild(rc);
  }

  /* ---- small UI helpers ---- */
  function kvRow(parent, k, v) { var d = el("div", "kv"); d.appendChild(el("span", null, k)); d.appendChild(el("b", null, v)); parent.appendChild(d); }
  function btn(txt, cls, fn) { var b = el("button", "btn " + (cls || ""), txt); b.addEventListener("click", fn); return b; }
  function numInput(val, fn) { var n = el("input"); n.type = "number"; n.value = val; n.addEventListener("change", function () { fn(parseInt(n.value, 10) || 0); }); return n; }
  function labelWrap(lab, inp) { var w = el("label"); w.style.display = "inline-flex"; w.style.alignItems = "center"; w.style.gap = "6px"; w.style.fontFamily = '"IBM Plex Mono",monospace'; w.style.fontSize = "12px"; w.style.color = "var(--ink-faint)"; w.appendChild(document.createTextNode(lab)); w.appendChild(inp); return w; }

  function postToTabs(msg) { /* best-effort: relayed via storage flag some engines watch */ store.set({ __erasioAdminSignal: { msg: msg, at: Date.now() } }); }

  function exportAll() {
    var out = {}; Object.keys(state.raw).forEach(function (k) { if (k.indexOf("erasio") === 0 || k === "enabled" || k === "processedCount") out[k] = state.raw[k]; });
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    var a = el("a"); a.href = URL.createObjectURL(blob); a.download = "erasio-config-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    toast("Exported");
  }
  function importAll(obj) { store.set(obj).then(function () { toast("Imported — reloading"); reload(); }); }
  function resetAll() {
    var o = {}; o[BUCKETS.settings] = Object.assign({}, DEF.settings); o[BUCKETS.image] = Object.assign({}, DEF.image); o[BUCKETS.video] = Object.assign({}, DEF.video);
    store.set(o).then(function () { toast("Reset to defaults"); reload(); });
  }

  /* ---- boot ---- */
  var active = "dashboard";
  /* Two kinds of setting live in this panel and conflating them is what made it
   * confusing: SERVICE settings are server-side and affect every customer,
   * EXTENSION settings are this browser's chrome.storage and affect the engine.
   * Grouping the nav makes the blast radius of a change obvious before it's
   * made. */
  var NAV_GROUPS = [
    { label: "Service", ids: ["dashboard", "users", "plans"] },
    { label: "Engine", ids: ["detection", "removal", "masklocks", "video", "sites"] },
    { label: "System", ids: ["audit", "sync", "localization", "maintenance"] }
  ];

  function buildNav() {
    var nav = document.getElementById("nav"); nav.innerHTML = "";
    var placed = {};
    NAV_GROUPS.forEach(function (g) {
      var tabs = g.ids.map(function (id) {
        return SCHEMA.filter(function (t) { return t.id === id; })[0];
      }).filter(Boolean);
      if (!tabs.length) return;
      nav.appendChild(el("div", "navlabel", g.label));
      tabs.forEach(function (tab) { placed[tab.id] = true; nav.appendChild(navBtn(tab)); });
    });
    // Anything added to SCHEMA without being placed in a group still shows up,
    // rather than silently disappearing from the panel.
    var rest = SCHEMA.filter(function (t) { return !placed[t.id]; });
    if (rest.length) {
      nav.appendChild(el("div", "navlabel", "Other"));
      rest.forEach(function (tab) { nav.appendChild(navBtn(tab)); });
    }
  }
  function navBtn(tab) {
    var b = el("button"); if (tab.id === active) b.className = "on";
    b.appendChild(icon(tab.id, "nav-ic")); b.appendChild(document.createTextNode(tab.title));
    b.addEventListener("click", function () { active = tab.id; render(); });
    return b;
  }
  function render() {
    buildNav();
    var tab = SCHEMA.filter(function (t) { return t.id === active; })[0];
    document.getElementById("tab-title").textContent = tab.title;
    var panel = document.getElementById("panel"); panel.innerHTML = "";
    if (tab.custom) tab.custom(tab, panel); else renderGroups(tab, panel);
    window.scrollTo(0, 0);
  }
  // ---- Access-control gate: the control surface renders ONLY for a
  // server-confirmed admin. Default is most-restrictive; admin UI is never in
  // the DOM for non-admins (not merely hidden).
  function renderBadge(st) {
    var bar = document.querySelector(".topbar"); if (!bar) return;
    var b = document.getElementById("roleBadge");
    if (!b) { b = el("span"); b.id = "roleBadge"; b.className = "role-badge"; bar.insertBefore(b, document.getElementById("saveInd")); }
    var role = st.verifying || !st.ready ? "verifying" : (st.isAdmin ? "admin" : "signed out");
    b.textContent = role;
    b.className = "role-badge r-" + role.replace(/\s+/g, "-");
  }
  function renderSkeleton(panel) {
    panel.innerHTML = "";
    var w = el("div"); w.style.padding = "10px 0";
    w.appendChild(el("div", "skel", "")).style.cssText = "height:36px;width:260px;margin-bottom:18px";
    for (var i = 0; i < 3; i++) { var s = el("div", "skel"); s.style.cssText = "height:84px;margin-bottom:14px"; w.appendChild(s); }
    panel.appendChild(w);
  }
  var CONTROL_ROOM_URL = "https://erasezo.com/admin";
  function renderLoggedOut(panel) {
    panel.innerHTML = "";
    var c = el("div", "card pad gate-card");

    // Opened as the extension's own options page, this copy can't sign in: the
    // session cookie is SameSite=Lax, so the browser won't attach it to a
    // request from a chrome-extension:// origin. Rather than present a login
    // box that silently never works, send the owner to the hosted panel — which
    // writes back to this very extension through page/webBridge.js anyway.
    if (HAS_CHROME) {
      c.appendChild(h3ic("user", "Open the Control Room"));
      c.appendChild(el("p", "sec-sub", "The panel runs on erasezo.com, signed in with your owner account. Settings you change there apply to this extension straight away."));
      var wr = el("div", "row"); wr.style.marginTop = "12px";
      wr.appendChild(btn("Open erasezo.com/admin", "", function () {
        try { chrome.tabs.create({ url: CONTROL_ROOM_URL }); }
        catch (e) { window.open(CONTROL_ROOM_URL, "_blank", "noopener"); }
      }));
      c.appendChild(wr);
      panel.appendChild(c);
      return;
    }

    c.appendChild(h3ic("user", "Sign in required"));
    c.appendChild(el("p", "sec-sub", "This control panel is for the owner account only. Your role is verified on the server before anything is shown."));
    var r = el("div", "row"); r.style.marginTop = "12px";
    r.appendChild(btn("Sign in", "", function () { if (window.Auth) Auth.openModal(); }));
    c.appendChild(r);
    panel.appendChild(c);
  }
  // Top-level render — decides the whole view from the (server-verified) role.
  // On the website build, say plainly whether edits are reaching a real
  // installed extension or just this browser's localStorage — otherwise you
  // can tune settings all day and wonder why nothing changed.
  function renderExtLink() {
    if (HAS_CHROME || bridgeLive === null) return;
    var bar = document.querySelector(".topbar"); if (!bar) return;
    var p = document.getElementById("extLink");
    if (!p) { p = el("span"); p.id = "extLink"; p.className = "cloud-badge"; bar.insertBefore(p, document.getElementById("saveInd")); }
    p.className = "cloud-badge " + (bridgeLive ? "on" : "off");
    p.textContent = bridgeLive ? "extension connected" : "extension not detected";
    p.title = bridgeLive
      ? "Changes here are written straight to the installed Erasezo extension."
      : "No Erasezo extension answered on this page. Changes are saved in this browser only. Install/enable the extension, then reload.";
  }

  function renderApp() {
    var st = (window.Auth && Auth.state) || { verifying: true, ready: false, isAdmin: false, role: "anonymous" };
    renderBadge(st); renderAcct(st); renderExtLink();
    var nav = document.getElementById("nav");
    var title = document.getElementById("tab-title");
    var panel = document.getElementById("panel");
    if (st.verifying || !st.ready) { nav.innerHTML = ""; title.textContent = "Verifying…"; renderSkeleton(panel); return; }
    // /api/admin/me answers only for a confirmed admin, so a signed-in state
    // and an admin state are now the same thing — there is no in-between view.
    if (!st.isAdmin) { nav.innerHTML = ""; title.textContent = "Sign in"; renderLoggedOut(panel); return; }
    render(); // server-confirmed admin → full control surface
  }
  function reload() { boot(); }
  function boot() {
    probeBridge().then(store.getAll).then(function (all) {
      state.raw = all || {};
      state.settings = Object.assign({}, DEF.settings, all[BUCKETS.settings] || {});
      state.image = Object.assign({}, DEF.image, all[BUCKETS.image] || {});
      state.video = Object.assign({}, DEF.video, all[BUCKETS.video] || {});
      renderApp();
    });
  }

  /* ---- Supabase cloud sync + account UI (separate from erasio.io) ---- */
  var cloudTimer = null;
  function cloudPush() {
    if (!(window.Auth && Auth.cloud && Auth.cloud.available())) return;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(function () {
      Auth.cloud.pushSettings({ settings: state.settings, image: state.image, video: state.video })
        .catch(function () { /* surfaced on manual push */ });
    }, 900);
  }
  function cloudPushNow() {
    if (!(window.Auth && Auth.cloud.available())) { toast("Sign in as admin first"); return; }
    Auth.cloud.pushSettings({ settings: state.settings, image: state.image, video: state.video })
      .then(function () { toast("Pushed to cloud"); }).catch(function (e) { toast("Push failed: " + (e.message || "")); });
  }
  function pullNow() {
    if (!(window.Auth && Auth.cloud.available())) { toast("Sign in as admin first"); return; }
    Auth.cloud.pullSettings().then(function (c) { if (c) applyCloudSettings(c); else toast("No cloud settings yet"); })
      .catch(function (e) { toast("Pull failed: " + (e.message || "")); });
  }
  function applyCloudSettings(cloudBuckets) {
    if (!cloudBuckets) return;
    ["settings", "image", "video"].forEach(function (b) {
      if (cloudBuckets[b] && typeof cloudBuckets[b] === "object") {
        state[b] = Object.assign({}, DEF[b], cloudBuckets[b]);
        var o = {}; o[BUCKETS[b]] = state[b]; store.set(o);
      }
    });
    renderApp(); toast("Pulled settings from cloud");
  }

  var acctMenu = null;
  function closeAcctMenu() { if (acctMenu) { acctMenu.remove(); acctMenu = null; document.removeEventListener("mousedown", onDocDown); } }
  function onDocDown(e) { if (acctMenu && !acctMenu.contains(e.target) && e.target.id !== "acctBtn") closeAcctMenu(); }
  function renderAcct(st) {
    var b = document.getElementById("acctBtn"); if (!b) return;
    if (st && st.user) {
      b.classList.add("in"); b.textContent = "";
      b.appendChild(el("span", "acct-dot"));
      b.appendChild(document.createTextNode(st.isAdmin ? (st.user.email || "admin") : "signed in"));
    } else {
      b.classList.remove("in");
      // Same reason as renderLoggedOut: signing in from the extension's own
      // origin can't work, so offer the hosted panel instead of a dead login.
      b.textContent = HAS_CHROME ? "Open Control Room" : "Sign in";
    }
  }
  function toggleAcctMenu() {
    if (acctMenu) { closeAcctMenu(); return; }
    var st = (window.Auth && Auth.state) || {};
    if (!st.user) {
      if (HAS_CHROME) {
        try { chrome.tabs.create({ url: CONTROL_ROOM_URL }); } catch (e) { window.open(CONTROL_ROOM_URL, "_blank", "noopener"); }
      } else if (window.Auth) { Auth.openModal(); }
      return;
    }
    var m = el("div", "acct-menu");
    var who = el("div", "who");
    who.appendChild(document.createTextNode(st.isAdmin ? "Admin · " : "Signed in · "));
    who.appendChild(el("b", null, st.user.email || ""));
    m.appendChild(who);
    if (st.isAdmin) {
      m.appendChild(menuLine("Push settings to cloud", function () { cloudPushNow(); closeAcctMenu(); }));
      m.appendChild(menuLine("Pull settings from cloud", function () { pullNow(); closeAcctMenu(); }));
    }
    m.appendChild(menuLine("Sign out", function () { Auth.signOut().then(function () { toast("Signed out"); }); closeAcctMenu(); }));
    document.body.appendChild(m); acctMenu = m;
    setTimeout(function () { document.addEventListener("mousedown", onDocDown); }, 0);
  }
  function menuLine(txt, fn) { var b = el("button", null, txt); b.addEventListener("click", fn); return b; }
  function initAuthUI() {
    var b = document.getElementById("acctBtn");
    if (b) b.addEventListener("click", toggleAcctMenu);
    if (!window.Auth) { renderApp(); return; }
    Auth.onChange(function () { renderApp(); });
    Auth.init().then(function (st) {
      renderApp();
      try { if (new URLSearchParams(location.search).get("signin") && !(st && st.user)) Auth.openModal(); } catch (e) {}
      if (st && st.isAdmin) { Auth.cloud.pullSettings().then(function (c) { if (c) applyCloudSettings(c); }).catch(function () {}); }
    });
  }

  // theme toggle
  document.getElementById("themeBtn").addEventListener("click", function () {
    var root = document.documentElement;
    var cur = root.getAttribute("data-theme") || (window.matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light");
    root.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
  });

  boot();
  initAuthUI();
})();
