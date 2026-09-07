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
      maskLocks: [{ w: 1376, h: 768, x: 1255, y: 647 }]
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

  /* ---- schema ---- */
  var LIVE = { badge: "live", cls: "badge-live" };   // relays to the running engine/gate now
  var SOON = { badge: "saved", cls: "badge-soon" };  // persists; runtime hook lands in a later phase

  var SCHEMA = [
    { id: "dashboard", title: "Dashboard", icon: "📊", custom: renderDashboard },
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
        { b: "settings", k: "fullGainOnLock", t: "toggle", live: 0, label: "Full strength on locked position", help: "Use 100% gain on a user-locked mask instead of the drift gain. (Engine phase)" }
      ]}]
    },
    { id: "masklocks", title: "Mask Locks", icon: "📌", custom: renderMaskLocks },
    { id: "sites", title: "Sites & Behavior", icon: "🌐",
      desc: "Where the extension runs and how downloads behave.",
      groups: [
        { title: "Master · erasioSettings", fields: [
          { b: "settings", k: "enableAutoRemoval", t: "toggle", live: 1, label: "Auto-removal", help: "Clean images automatically at display time." },
          { b: "settings", k: "enableFlow", t: "toggle", live: 1, label: "Flow support", help: "Inject buttons + intercept downloads on Flow." },
          { b: "settings", k: "skipPreview", t: "toggle", live: 1, label: "Skip preview", help: "Download immediately instead of the Before/After modal." },
          { b: "settings", k: "autoDownload", t: "toggle", live: 0, label: "Auto-download", help: "Save without prompting." }
        ]},
        { title: "Per-site (engine phase)", fields: [
          { b: "settings", k: "enableGemini", t: "toggle", live: 0, def: true, label: "Gemini", help: "gemini.google.com" },
          { b: "settings", k: "enableAiStudio", t: "toggle", live: 0, def: true, label: "AI Studio", help: "aistudio.google.com" },
          { b: "settings", k: "enableDocs", t: "toggle", live: 0, def: true, label: "Google Vids", help: "docs.google.com/videos" }
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
    { id: "output", title: "Output & Format", icon: "🖼️",
      desc: "Encoding, naming, and quality of the saved file.",
      groups: [{ title: "Format · erasioSettings", fields: [
        { b: "settings", k: "formatOverride", t: "select", live: 0, def: "auto", options: [["auto", "Preserve source"], ["png", "Force PNG"], ["jpeg", "Force JPEG"], ["webp", "Force WebP"]], label: "Format policy", help: "Default keeps JPEG→JPEG, WebP→WebP, else PNG." },
        { b: "settings", k: "encodeQuality", t: "range", live: 0, def: 0.95, min: 0.5, max: 1, step: 0.01, label: "Encode quality", help: "JPEG/WebP quality. (Engine phase)" },
        { b: "settings", k: "imageQuality", t: "select", live: 0, options: [["high", "High"], ["medium", "Medium"], ["low", "Low"]], label: "Image quality" },
        { b: "settings", k: "performanceMode", t: "select", live: 0, options: [["quality", "Quality"], ["speed", "Speed"]], label: "Performance mode" },
        { b: "settings", k: "filenameTemplate", t: "text", live: 0, def: "flow-{id}-erasio.{ext}", label: "Filename template", help: "Tokens: {id} {ext} {w} {h}. (Engine phase)" },
        { b: "settings", k: "defaultModel", t: "select", live: 0, options: [["v2", "v2"], ["v1", "v1"]], label: "Default model" }
      ]}]
    },
    { id: "batch", title: "Batch & Bulk", icon: "🗂️",
      desc: "Multi-select removal and ZIP export across Flow, Gemini and Vids.",
      groups: [{ title: "Batch · erasioSettings", fields: [
        { b: "settings", k: "batchProcessing", t: "toggle", live: 0, label: "Batch processing", help: "Enable the multi-select layer." },
        { b: "settings", k: "batchAllTiers", t: "toggle", live: 0, label: "Unlock for all tiers", help: "Bypass the paid gate on the batch checkbox. (Engine phase)" },
        { b: "settings", k: "zipEnabled", t: "toggle", live: 0, def: true, label: "ZIP export", help: "Bundle a batch into one archive." },
        { b: "settings", k: "batchCap", t: "number", live: 0, def: 40, min: 2, max: 200, step: 1, label: "Batch cap", help: "Max items per batch." }
      ]}]
    },
    { id: "notifications", title: "Notifications", icon: "🔔",
      desc: "Toasts and the prompts the extension shows.",
      groups: [{ title: "Prompts · erasioSettings", fields: [
        { b: "settings", k: "showNotifications", t: "toggle", live: 0, label: "Show notifications", help: "Success and status toasts." },
        { b: "settings", k: "disableRatePrompt", t: "toggle", live: 0, label: "Disable rate prompt", help: "Never ask for a store review." },
        { b: "settings", k: "disableUpsell", t: "toggle", live: 0, label: "Disable upsell", help: "Hide upgrade prompts." },
        { b: "settings", k: "disableAnnouncements", t: "toggle", live: 0, label: "Disable announcements", help: "Suppress server announcements." }
      ]}]
    },
    { id: "sync", title: "Sync & Cache", icon: "⚙️",
      desc: "Background refresh cadence and the in-page caches.",
      custom: renderSync
    },
    { id: "history", title: "History & Data", icon: "🕘",
      desc: "What the extension keeps.",
      groups: [{ title: "History · erasioSettings", fields: [
        { b: "settings", k: "saveImagesToHistory", t: "toggle", live: 0, label: "Save to history" },
        { b: "settings", k: "historyDays", t: "number", live: 0, min: 1, max: 365, step: 1, label: "Retention (days)" }
      ]}]
    },
    { id: "localization", title: "Localization", icon: "🌍",
      desc: "Language and appearance.",
      groups: [{ title: "Locale · erasioSettings / erasioLang", fields: [
        { b: "settings", k: "language", t: "select", live: 0, def: "en", options: Object.keys(LOCALES).map(function (k) { return [k, LOCALES[k]]; }), label: "Language" },
        { b: "settings", k: "darkMode", t: "toggle", live: 1, label: "Dark mode", help: "Relayed to the on-page overlays." }
      ]}]
    },
    { id: "experimental", title: "Experimental", icon: "🧪",
      desc: "New engine capabilities. These persist and switch on as each engine phase lands.",
      groups: [{ title: "Engine roadmap", fields: [
        { b: "settings", k: "inpaintFallback", t: "toggle", live: 0, label: "Inpaint fallback", help: "Pure-JS Telea fill on residue after reverse-blend." },
        { b: "settings", k: "multiCornerScan", t: "toggle", live: 0, label: "Multi-corner scan", help: "Search all four corners, not just bottom-right." },
        { b: "settings", k: "autoSparkleVersion", t: "toggle", live: 0, label: "Auto new-sparkle", help: "Pick old/2026 map by shape match automatically." }
      ]}]
    },
    { id: "maintenance", title: "Maintenance", icon: "🧰", custom: renderMaintenance }
  ];

  /* ---- generic helpers ---- */
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function get(b, k, dflt) { var v = state[b][k]; return v === undefined ? (dflt !== undefined ? dflt : (DEF[b] ? DEF[b][k] : undefined)) : v; }

  /* ---- inline icon set (Lucide-style strokes; keyed by tab id + dashboard heads) ---- */
  var ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    detection: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
    removal: '<path d="m7 21-4.3-4.3a1.7 1.7 0 0 1 0-2.4l9.6-9.6a1.7 1.7 0 0 1 2.4 0l5 5a1.7 1.7 0 0 1 0 2.4L13 21"/><path d="M22 21H8"/><path d="m5 12 7 7"/>',
    masklocks: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    sites: '<circle cx="12" cy="12" r="9"/><path d="M12 3a13 13 0 0 0 0 18 13 13 0 0 0 0-18"/><path d="M3 12h18"/>',
    video: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M3 12h18"/><path d="M3 7.5h4"/><path d="M3 16.5h4"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
    output: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="m21 15-4.5-4.5L6 21"/>',
    batch: '<path d="M12 2 2 7l10 5 10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    notifications: '<path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/><path d="M4 17h16c-1.5-1.5-2.5-3-2.5-7a5.5 5.5 0 0 0-11 0c0 4-1 5.5-2.5 7Z"/>',
    sync: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    localization: '<path d="m4 14 6-6 2-3"/><path d="m5 8 6 6"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
    experimental: '<path d="M10 2v7.5L4.8 20.5A1 1 0 0 0 5.7 22h12.6a1 1 0 0 0 .9-1.5L14 9.5V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
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
    ctl.appendChild(mkBadge(f.live));
    row.appendChild(ctl);
    return row;
  }
  function mkBadge(live) { return el("span", live ? LIVE.cls : SOON.cls, live ? LIVE.badge : SOON.badge); }
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

    // tiles
    var tiles = el("div", "tiles");
    [["Processed", processed.toLocaleString()], ["Power", enabled ? "On" : "Off"], ["Plan", plan], ["Credits", unlimited ? "∞" : ((cs.remaining != null ? cs.remaining : "—") + "/" + (cs.limit != null ? cs.limit : "—"))]]
      .forEach(function (t) { var d = el("div", "tile"); d.appendChild(el("div", "v", t[1])); d.appendChild(el("div", "l", t[0])); tiles.appendChild(d); });
    panel.appendChild(tiles);

    var grid = el("div", "subgrid two"); grid.style.marginTop = "16px";

    // User control
    var uc = el("div", "card pad"); uc.appendChild(h3ic("user", "User control"));
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
    kvRow(skv, "Current plan", plan);
    kvRow(skv, "Renews", cs.resetAt ? new Date(cs.resetAt).toLocaleDateString() : "—");
    kvRow(skv, "Bypass", unlimited ? "Active (worker forces ∞)" : "Off");
    sc.appendChild(skv);
    var srow = el("div", "row");
    srow.appendChild(btn("Force Pro / unlimited", "sm", function () { setCredit({ kind: "paid", remaining: 999999, limit: 0, emailVerified: true, isEmailVerified: true, resetAt: null, unavailable: false }); }));
    srow.appendChild(btn("Sync from server", "ghost sm", function () { sendMsg({ action: "erasioCreditStatus" }); toast("Sync requested"); setTimeout(reload, 600); }));
    sc.appendChild(srow);
    var note = el("div", "callout"); note.innerHTML = "The worker currently forces unlimited credits. A server sync is overridden back to ∞ by design.";
    sc.appendChild(note);
    grid.appendChild(sc);
    panel.appendChild(grid);

    // Credit control
    var cc = el("div", "card pad"); cc.appendChild(h3ic("credit", "Credit control"));
    var crow = el("div", "row"); crow.style.margin = "12px 0";
    crow.appendChild(labelWrap("Remaining", numInput(cs.remaining != null ? cs.remaining : 999999, function (v) { setCredit(Object.assign({}, cs, { remaining: v })); })));
    crow.appendChild(labelWrap("Limit", numInput(cs.limit != null ? cs.limit : 0, function (v) { setCredit(Object.assign({}, cs, { limit: v })); })));
    cc.appendChild(crow);
    var crow2 = el("div", "row");
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

    // Cloud sync (Supabase — separate from erasio.io)
    var clc = el("div", "card pad"); clc.appendChild(h3ic("subscription", "Cloud sync (Supabase)"));
    var ast = (window.Auth && Auth.state) || {};
    var cfgOk = window.SB && SB.configured();
    var cl = el("div"); cl.style.margin = "12px 0";
    kvRow(cl, "Config", cfgOk ? "Ready" : "Not set — see admin/SETUP.md");
    kvRow(cl, "Signed in", ast.user ? (ast.user.email || "yes") : "No");
    kvRow(cl, "Admin", ast.isAdmin ? "Yes" : "No");
    clc.appendChild(cl);
    var clr = el("div", "row");
    if (!ast.user) clr.appendChild(btn("Sign in", "sm", function () { if (window.Auth) Auth.openModal(); }));
    else {
      clr.appendChild(btn("Push to cloud", "sm", cloudPushNow));
      clr.appendChild(btn("Pull from cloud", "ghost sm", pullNow));
      clr.appendChild(btn("Sign out", "ghost sm", function () { Auth.signOut().then(function () { toast("Signed out"); }); }));
    }
    clc.appendChild(clr);
    if (ast.user && !ast.isAdmin) clc.appendChild(el("div", "callout", "This email is not on the admin allowlist — cloud sync is off. Add it to config.js + the admins table."));
    panel.appendChild(clc);
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
    fctl.appendChild(sel); fctl.appendChild(labelWrap("dx", dx)); fctl.appendChild(labelWrap("dy", dy)); fctl.appendChild(mkBadge(1));
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
    [{ b: "settings", k: "creditSyncSec", def: 30, min: 5, max: 600, step: 1, live: 0, label: "Credit sync (sec)", help: "How often the worker refreshes credit status." },
     { b: "settings", k: "announcementSyncMin", def: 30, min: 1, max: 240, step: 1, live: 0, label: "Announcement sync (min)" }]
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

  function setCredit(obj) { state.raw.erasioCreditStatus = obj; store.set({ erasioCreditStatus: obj, erasioCreditStatusUpdatedAt: Date.now() }).then(function () { toast("Credit status updated"); reload(); }); }
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
  function buildNav() {
    var nav = document.getElementById("nav"); nav.innerHTML = "";
    SCHEMA.forEach(function (tab) {
      var b = el("button"); if (tab.id === active) b.className = "on";
      b.appendChild(icon(tab.id, "nav-ic")); b.appendChild(document.createTextNode(tab.title));
      b.addEventListener("click", function () { active = tab.id; render(); });
      nav.appendChild(b);
    });
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
    var role = st.verifying || !st.ready ? "verifying" : (!st.user ? "signed out" : st.needsMfa ? "2fa required" : (st.role || (st.isAdmin ? "admin" : "free")));
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
  function renderLoggedOut(panel) {
    panel.innerHTML = "";
    var c = el("div", "card pad gate-card");
    c.appendChild(h3ic("user", "Sign in required"));
    c.appendChild(el("p", "sec-sub", "This control panel is for the owner account only. Your role is verified on the server before anything is shown."));
    var r = el("div", "row"); r.style.marginTop = "12px";
    r.appendChild(btn("Sign in", "", function () { if (window.Auth) Auth.openModal(); }));
    c.appendChild(r);
    panel.appendChild(c);
  }
  function renderFree(panel, st) {
    panel.innerHTML = "";
    var c = el("div", "card pad gate-card");
    var kv = el("div"); kv.style.margin = "12px 0";
    kvRow(kv, "Email", (st.user && st.user.email) || "—");
    kvRow(kv, "Role", st.role || "free");
    kvRow(kv, "Plan", st.plan || "free");
    var r = el("div", "row"); r.style.marginTop = "10px";
    if (st.needsMfa) {
      c.appendChild(h3ic("user", "Two-factor verification required"));
      c.appendChild(kv);
      c.appendChild(el("div", "callout", "This is an admin account, but this session hasn't completed two-factor verification yet. Finish the code prompt to continue — closed it by mistake? Use the button below to reopen it."));
      r.appendChild(btn("Continue 2FA", "", function () { if (window.Auth) Auth.refreshMe(); }));
    } else {
      c.appendChild(h3ic("user", "Signed in"));
      c.appendChild(kv);
      c.appendChild(el("div", "callout", "This account is not an admin, so the control panel is locked. If this is your owner account, add its email to the admins table (server-side)."));
    }
    r.appendChild(btn("Sign out", "ghost", function () { Auth.signOut().then(function () { toast("Signed out"); }); }));
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
    if (!st.user) { nav.innerHTML = ""; title.textContent = "Sign in"; renderLoggedOut(panel); return; }
    if (!st.isAdmin) { nav.innerHTML = ""; title.textContent = "Account"; renderFree(panel, st); return; }
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
    } else { b.classList.remove("in"); b.textContent = "Sign in"; }
  }
  function toggleAcctMenu() {
    if (acctMenu) { closeAcctMenu(); return; }
    var st = (window.Auth && Auth.state) || {};
    if (!st.user) { if (window.Auth) Auth.openModal(); return; }
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
