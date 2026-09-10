/* Home page behaviour. Three small jobs, no framework.
 *
 * The pricing section is the reason this file exists: hardcoding prices on a
 * marketing page is how a site ends up advertising a number the checkout does
 * not charge. It reads /api/plans — the same endpoint the dashboard renders
 * from and the same table the server bills against — so the page cannot drift
 * from what a customer actually pays. */
(function () {
  "use strict";

  var STORE_URL = "https://chromewebstore.google.com/detail/erasio-%E2%80%93-gemini-omni-wate/aedhekmakfgbcknofpiccffacdjcgdpp";
  ["installTop", "installHero", "installEnd"].forEach(function (id) {
    var a = document.getElementById(id);
    if (!a) return;
    a.href = STORE_URL;
    a.target = "_blank";
    a.rel = "noopener";
  });

  /* ---- menu ---- */
  var toggle = document.getElementById("navToggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var open = document.body.classList.toggle("nav-open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    // Any nav choice closes it, including one made with the keyboard.
    document.getElementById("siteNav").addEventListener("click", function (e) {
      if (e.target.tagName !== "A") return;
      document.body.classList.remove("nav-open");
      toggle.setAttribute("aria-expanded", "false");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !document.body.classList.contains("nav-open")) return;
      document.body.classList.remove("nav-open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus();
    });
  }

  /* ---- theme ----
   * tokens.css answers to data-theme in both directions: set it and the page
   * follows regardless of what the OS says, leave it off and the OS decides.
   * The choice is remembered per browser; nothing about it belongs on a
   * server. */
  var THEME_KEY = "erasezo.theme";
  var root = document.documentElement;
  var themeBtn = document.getElementById("themeBtn");

  function systemDark() {
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { return false; }
  }
  function applyTheme(t) {
    if (t) root.setAttribute("data-theme", t); else root.removeAttribute("data-theme");
    var dark = t ? t === "dark" : systemDark();
    if (themeBtn) themeBtn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  }
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (e) { applyTheme(null); }

  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var now = root.getAttribute("data-theme") || (systemDark() ? "dark" : "light");
      var next = now === "dark" ? "light" : "dark";
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private window */ }
    });
  }

  /* ---- the frame ----
   * Two copies of the same artwork, the top one clipped. --wipe is written
   * from here rather than from a style attribute: the page's CSP drops inline
   * styles in markup, and a wipe that silently does not move is worse than no
   * wipe at all. */
  var demo = document.getElementById("demo");
  var wipe = document.getElementById("wipe");
  var stage = wipe && wipe.parentElement;

  if (wipe && stage) {
    var paint = function () { stage.style.setProperty("--wipe", wipe.value + "%"); };
    wipe.addEventListener("input", paint);
    paint();
  }

  // Images / Video. The buttons are real, so they change something real.
  var MODES = {
    image: { url: "gemini.google.com", title: "Watermark removed", sub: "On your device · nothing uploaded" },
    video: { url: "flow.google.com", title: "Video cleaned, frame by frame", sub: "720p and 1080p · nothing uploaded" }
  };
  var fcTitle = document.getElementById("fcTitle");
  var fcSub = document.getElementById("fcSub");
  var demoUrl = document.getElementById("demoUrl");

  Array.prototype.forEach.call(document.querySelectorAll(".seg button"), function (b) {
    b.addEventListener("click", function () {
      var mode = b.getAttribute("data-mode");
      Array.prototype.forEach.call(document.querySelectorAll(".seg button"), function (o) {
        var on = o === b;
        o.classList.toggle("on", on);
        o.setAttribute("aria-pressed", String(on));
      });
      if (demo) demo.setAttribute("data-mode", mode);
      var m = MODES[mode];
      if (demoUrl) demoUrl.textContent = m.url;
      if (fcTitle) fcTitle.textContent = m.title;
      if (fcSub) fcSub.textContent = m.sub;
    });
  });

  /* ---- already signed in? ---- */
  // Cheap courtesy: someone with a session should be offered their dashboard
  // rather than a sign-in form they don't need.
  fetch("/api/me", { credentials: "include" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (me) {
      if (!me || !me.email) return;
      var a = document.getElementById("signinLink");
      if (a) { a.href = "/dashboard"; a.textContent = "Dashboard"; }
    });

  /* ---- pricing, from the table that bills ---- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var host = document.getElementById("plans");
  var note = document.getElementById("planNote");

  fetch("/api/plans")
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (data) {
      var plans = data && data.plans;
      if (!plans || !plans.length) {
        // Say nothing rather than something wrong. An invented price is worse
        // than an absent one.
        host.innerHTML = "";
        host.appendChild(el("p", "plan-skel", "Plans are on the dashboard — sign in to see current pricing."));
        return;
      }
      host.innerHTML = "";
      plans.forEach(function (p, i) {
        var paid = !!p.priceInr;
        var card = el("div", "plan" + (i === 1 ? " featured" : ""));
        if (i === 1) card.appendChild(el("span", "tag", "Most picked"));
        card.appendChild(el("h3", null, p.name));

        var price = el("div", "price");
        price.appendChild(document.createTextNode(paid ? "₹" + p.priceInr : "Free"));
        if (paid) price.appendChild(el("small", null, " /month"));
        card.appendChild(price);

        card.appendChild(el("p", "quota",
          p.unlimited ? "Unlimited files per day" : p.dailyQuota + " files per day"));

        var cta = el("a", "btn" + (paid ? "" : " ghost"), paid ? "Choose " + p.name : "Start free");
        cta.href = paid ? "/dashboard" : "/login";
        card.appendChild(cta);
        host.appendChild(card);
      });
      if (note) note.textContent = "Prices in INR, billed monthly. Cancel any time from your dashboard.";
    });
})();
