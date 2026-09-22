/* Referral page. The reward figure is read from /api/referral/program so the
 * page cannot advertise a number the server does not pay. */
(function () {
  "use strict";

  function el(t, c, x) {
    var e = document.createElement(t);
    if (c) e.className = c;
    if (x != null) e.textContent = x;
    return e;
  }
  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "include";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var b = null;
        try { b = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) {
          var err = new Error((b && (b.message || b.error)) || ("HTTP " + r.status));
          err.status = r.status;
          err.code = b && b.error;
          throw err;
        }
        return b;
      });
    });
  }

  var credits = null;
  api("/api/referral/program").then(function (p) {
    credits = p.signupCredits;
    var n = document.getElementById("signupCredits");
    if (n) n.textContent = String(p.signupCredits);
  }).catch(function () {});

  var body = document.getElementById("applyBody");

  api("/api/me").then(function () {
    var sign = document.getElementById("signinLink");
    var dash = document.getElementById("dashLink");
    if (sign) sign.hidden = true;
    if (dash) dash.hidden = false;
    return api("/api/referral/me");
  }).then(function (me) {
    if (!me) return;
    paint(me);
  }).catch(function (e) {
    if (e && e.status === 401) return;
  });

  function paint(me) {
    body.innerHTML = "";
    if (me.status === "approved" && me.referralCode) return paintApproved(me);
    if (me.status === "pending") return paintPending();
    if (me.status === "rejected") paintRejected(me);
    paintForm(me);
  }

  function paintPending() {
    body.appendChild(el("p", "ref-status pending", "Pending"));
    body.appendChild(el("p", "lead", "Your application is waiting for a person to review it. The link shows up on your dashboard if it's approved."));
    var a = el("a", "btn", "Go to dashboard");
    a.href = "/dashboard#referral";
    body.appendChild(a);
  }

  function paintRejected(me) {
    body.appendChild(el("p", "ref-status rejected", "Not approved"));
    body.appendChild(el("p", "lead", "You can apply again. A new application replaces this one."));
    if (me.rejectReason) body.appendChild(el("p", "ref-warn", me.rejectReason));
  }

  function paintApproved(me) {
    body.appendChild(el("p", "ref-status approved", "Approved"));
    body.appendChild(el("p", "lead", "Your link is ready. Credits are added when someone new creates an account with it."));
    var link = location.origin + "/?ref=" + me.referralCode;
    var input = el("input");
    input.type = "text";
    input.readOnly = true;
    input.value = link;
    input.className = "ref-link";
    input.setAttribute("aria-label", "Your referral link");
    body.appendChild(input);
    var b = el("button", "btn", "Copy link");
    b.type = "button";
    b.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(function () { b.textContent = "Copied"; }, function () { input.focus(); input.select(); });
      } else { input.focus(); input.select(); }
    });
    body.appendChild(b);
    var dash = el("a", "btn ghost", "Open dashboard");
    dash.href = "/dashboard#referral";
    body.appendChild(dash);
  }

  function paintForm(prefill) {
    prefill = prefill || {};
    if (prefill.status !== "rejected") {
      body.appendChild(el("p", "lead", "Every application is read by a person. Approved partners get a link and earn credits when a new account is created with it."));
    }
    var form = el("form");
    form.addEventListener("submit", function (e) { e.preventDefault(); });

    form.appendChild(el("label", "fld", "Where will you promote Erasezo?"));
    var channel = el("input");
    channel.type = "text";
    channel.maxLength = 200;
    channel.required = true;
    channel.value = prefill.channel || "";
    channel.setAttribute("aria-label", "Where will you promote Erasezo?");
    form.appendChild(channel);

    var audLab = el("label", "fld", "Roughly how big is your audience? ");
    audLab.appendChild(el("span", "opt", "(optional)"));
    form.appendChild(audLab);
    var audience = el("input");
    audience.type = "text";
    audience.maxLength = 80;
    audience.value = prefill.audience || "";
    audience.setAttribute("aria-label", "Audience size, optional");
    form.appendChild(audience);

    form.appendChild(el("label", "fld", "Why do you want referral access?"));
    var why = el("textarea");
    why.maxLength = 2000;
    why.required = true;
    why.value = prefill.status === "rejected" ? (prefill.why || "") : "";
    why.setAttribute("aria-label", "Why do you want referral access?");
    form.appendChild(why);
    var count = el("p", "ref-count", "");
    form.appendChild(count);
    function tick() {
      var n = why.value.trim().length;
      count.textContent = n + "/40 characters minimum";
    }
    why.addEventListener("input", tick);
    tick();

    var check = el("label", "ref-check");
    var box = el("input");
    box.type = "checkbox";
    check.appendChild(box);
    var span = el("span");
    span.appendChild(document.createTextNode("I've read and agree to the "));
    var rules = el("a", null, "referral program rules");
    rules.href = "#rules";
    span.appendChild(rules);
    span.appendChild(document.createTextNode(", including the fair-use note."));
    check.appendChild(span);
    form.appendChild(check);

    var msg = el("p", "ref-msg");
    var submit = el("button", "btn", prefill.status === "rejected" ? "Submit again" : "Submit application");
    submit.type = "submit";
    form.appendChild(submit);
    form.appendChild(msg);
    var help = el("p", "ref-help", "Say where you'll share Erasezo, write at least 40 characters, and accept the rules.");
    form.appendChild(help);

    submit.addEventListener("click", function () {
      msg.className = "ref-msg";
      msg.textContent = "";
      if (channel.value.trim().length < 2 || why.value.trim().length < 40 || !box.checked) {
        msg.className = "ref-msg err";
        msg.textContent = "Fill in where you'll promote Erasezo, write at least 40 characters, and accept the rules.";
        return;
      }
      submit.disabled = true;
      api("/api/referral/apply", {
        method: "POST",
        body: {
          channel: channel.value,
          audience: audience.value,
          why: why.value,
          acceptTerms: true
        }
      }).then(function (next) {
        paint(next);
      }).catch(function (e) {
        submit.disabled = false;
        msg.className = "ref-msg err";
        msg.textContent = e.code === "rate_limited" ? "Too many attempts — try again shortly."
          : (e.message || "Couldn't submit.");
      });
    });

    body.appendChild(form);
    if (credits != null) {
      var line = document.getElementById("signupCredits");
      if (line) line.textContent = String(credits);
    }
  }
})();
