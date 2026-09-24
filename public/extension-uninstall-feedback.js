/* Uninstall feedback. The reason list is the radios in the page; this file
 * only sends what the person picked and keeps every failure on screen. */
(function () {
  "use strict";

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

  var need = document.getElementById("needJs");
  if (need) need.hidden = true;

  var form = document.getElementById("feedbackForm");
  var formPane = document.getElementById("formPane");
  var thanks = document.getElementById("thanks");
  var err = document.getElementById("formError");
  var submitBtn = document.getElementById("submitBtn");
  if (!form || !err || !submitBtn) return;

  var pending = false;

  function showError(msg) {
    err.hidden = false;
    err.textContent = msg || "Something went wrong. Try again.";
  }

  function selectedReason() {
    var picked = form.querySelector('input[name="reason"]:checked');
    return picked ? picked.value : "";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (pending) return;
    err.hidden = true;
    err.textContent = "";

    var reason = selectedReason();
    var otherEl = document.getElementById("reasonOther");
    var feedbackEl = document.getElementById("feedback");
    var emailEl = document.getElementById("email");
    var other = otherEl ? otherEl.value : "";
    var feedback = feedbackEl ? feedbackEl.value : "";
    var email = emailEl ? emailEl.value.trim() : "";

    if (!reason) return showError("Choose one of the reasons listed.");
    if (reason === "other") {
      if (!other.trim()) return showError("Add a short reason.");
      if (other.trim().length > 500) return showError("Keep the short reason to 500 characters.");
    }
    if (feedback.trim().length > 5000) return showError("Keep feedback to 5000 characters.");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return showError("Enter a valid email, or leave it blank.");
    }

    var payload = { reason: reason };
    if (reason === "other") payload.reasonOther = other.trim();
    if (feedback.trim()) payload.feedback = feedback.trim();
    if (email) payload.email = email;

    pending = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";
    fetch("/api/uninstall-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.text().then(function (t) {
        var b = null;
        try { b = t ? JSON.parse(t) : null; } catch (e2) {}
        if (!r.ok) {
          var msg = (b && b.message) ||
            (b && b.error === "rate_limited" ? "Too many attempts — try again shortly." : "") ||
            ("Could not send your note (" + r.status + ").");
          throw new Error(msg);
        }
        return b;
      });
    }).then(function () {
      if (formPane) formPane.hidden = true;
      if (thanks) {
        thanks.hidden = false;
        var h = thanks.querySelector("h2");
        if (h) { h.tabIndex = -1; h.focus(); }
      }
    }).catch(function (e2) {
      var msg = e2 && e2.name === "TypeError"
        ? "Could not reach Erasezo. Check your connection and try again."
        : (e2 && e2.message);
      showError(msg);
    }).then(function () {
      pending = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Send feedback";
    });
  });
})();
