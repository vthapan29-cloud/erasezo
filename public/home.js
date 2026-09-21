/* Home page behaviour. Small jobs, no framework.
 *
 * The pricing section is the reason this file exists: hardcoding prices on a
 * marketing page is how a site ends up advertising a number the checkout does
 * not charge. It reads /api/plans — the same endpoint the dashboard renders
 * from and the same table the server bills against — so the page cannot drift
 * from what a customer actually pays. */
(function () {
  "use strict";

  // Honest in-page destination. There is no Erasezo CWS listing yet; sending
  // people to Erasio's was a lie. Same-page hash, not a new tab.
  var STORE_URL = "#get-extension";
  ["installTop", "installHero", "installEnd", "installDock"].forEach(function (id) {
    var a = document.getElementById(id);
    if (!a) return;
    a.href = STORE_URL;
    a.removeAttribute("target");
    a.removeAttribute("rel");
  });

  /* ---- menu ---- */
  var toggle = document.getElementById("navToggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var open = document.body.classList.toggle("nav-open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    var nav = document.getElementById("siteNav");
    if (nav) nav.addEventListener("click", function (e) {
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

  /* ---- announcement ---- */
  var announce = document.getElementById("announce");
  var ANNOUNCE_KEY = "erasezo.announce.v1";
  if (announce) {
    var dismissed = false;
    try { dismissed = localStorage.getItem(ANNOUNCE_KEY) === "1"; } catch (e) { dismissed = false; }
    if (!dismissed) {
      announce.hidden = false;
      document.body.classList.add("has-announce");
    }
    var x = document.getElementById("announceDismiss");
    if (x) x.addEventListener("click", function () {
      announce.hidden = true;
      document.body.classList.remove("has-announce");
      try { localStorage.setItem(ANNOUNCE_KEY, "1"); } catch (e) { /* private window */ }
    });
  }

  /* ---- the live-demo frame ----
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

  // Images / Video. The buttons are real, so they change something real —
  // the URL chip, the caption, and a CSS art variant. There is no recorded
  // clip attached to Video; the note next to the control says so.
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

  /* ---- sticky header + floating dock ---- */
  var dock = document.getElementById("dock");
  var foot = document.querySelector(".site-foot");
  var pastHero = false;
  var footHit = false;
  function syncDock() {
    if (!dock) return;
    var show = pastHero && !footHit;
    dock.hidden = !show;
    dock.classList.toggle("on", show);
    document.body.classList.toggle("dock-pad", show);
  }
  function onScroll() {
    var y = window.scrollY || 0;
    root.classList.toggle("scrolled", y > 8);
    pastHero = y > 480;
    syncDock();
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  if (dock && foot && "IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      footHit = !!(entries[0] && entries[0].isIntersecting);
      syncDock();
    }, { threshold: 0.08 }).observe(foot);
  }

  /* ---- scroll reveal ---- */
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add("in");
        io.unobserve(en.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    Array.prototype.forEach.call(document.querySelectorAll(".reveal"), function (el) { io.observe(el); });
  } else {
    Array.prototype.forEach.call(document.querySelectorAll(".reveal"), function (el) { el.classList.add("in"); });
  }

  /* ---- already signed in? ---- */
  // Cheap courtesy: someone with a session should be offered their dashboard
  // rather than a sign-in form they don't need.
  fetch("/api/me", { credentials: "include" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (me) {
      if (!me || !me.email) return;
      ["signinLink", "dockSignin", "signinEnd"].forEach(function (id) {
        var a = document.getElementById(id);
        if (a) { a.href = "/dashboard"; a.textContent = "Dashboard"; }
      });
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

  if (host) fetch("/api/plans")
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (data) {
      var plans = data && data.plans;
      var paymentsOn = !!(data && data.paymentsConfigured);
      if (!plans || !plans.length) {
        // Say nothing rather than something wrong. An invented price is worse
        // than an absent one.
        host.innerHTML = "";
        host.appendChild(el("p", "plan-skel", "Plans are on the dashboard — sign in to see current pricing."));
        return;
      }
      host.innerHTML = "";
      plans.forEach(function (p) {
        var paid = !!p.priceInr;
        var featured = p.id === "pro";
        var card = el("div", "plan" + (featured ? " featured" : ""));
        if (featured) card.appendChild(el("span", "tag", "Paid plan"));
        card.appendChild(el("h3", null, p.name));

        var price = el("div", "price");
        price.appendChild(document.createTextNode(paid ? "₹" + p.priceInr : "Free"));
        if (paid) price.appendChild(el("small", null, " /month"));
        card.appendChild(price);

        card.appendChild(el("p", "quota",
          p.unlimited ? "Unlimited files per day" : p.dailyQuota + " files per day"));

        var bits = el("ul");
        bits.appendChild(el("li", null, "Local processing — files stay on your device"));
        bits.appendChild(el("li", null, "Detector controls in the side panel"));
        bits.appendChild(el("li", null, paid
          ? "Billed monthly in INR, cancel from the dashboard"
          : "Account required · no card"));
        card.appendChild(bits);

        // Paid "Choose …" buttons only when checkout can actually run. Free
        // stays offered regardless — it never goes through Razorpay.
        if (!paid || paymentsOn) {
          var cta = el("a", "btn" + (paid ? "" : " ghost"), paid ? "Choose " + p.name : "Start free");
          cta.href = paid ? "/dashboard" : "/login";
          card.appendChild(cta);
        }
        host.appendChild(card);
      });
      if (note) {
        note.textContent = paymentsOn
          ? "Prices in INR, billed monthly. Cancel any time from your dashboard."
          : "Prices in INR. Paid checkout is not switched on yet — the free plan is available now.";
      }
    });
})();
