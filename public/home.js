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
