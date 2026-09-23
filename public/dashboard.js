/* Erasezo account dashboard.
 *
 * Everything shown here is served by /api/me, /api/usage and /api/plans — the
 * same resolvers the extension is metered by, so the allowance on screen is
 * always the one actually being enforced.
 *
 * No inline handlers or styles anywhere: the site's CSP has no 'unsafe-inline',
 * so markup-level onclick or style="" would simply not run.
 */
(function () {
  "use strict";

  var me = null, usage = null, plans = null;
  var view = "overview";

  var $ = function (id) { return document.getElementById(id); };
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "include";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var b = null; try { b = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) { var err = new Error((b && (b.message || b.error)) || ("HTTP " + r.status)); err.code = b && b.error; err.status = r.status; throw err; }
        return b;
      });
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  var ICONS = {
    overview: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    usage: '<path d="M3 3v18h18"/><path d="m7 14 3-4 3 3 5-7"/>',
    plans: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    security: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    referral: '<path d="M20 12v9H4v-9"/><rect x="2" y="7" width="20" height="5" rx="1"/><path d="M12 21V7"/><path d="M12 7 8.5 3.5a2.5 2.5 0 1 1 3.5 0"/><path d="M12 7l3.5-3.5a2.5 2.5 0 1 0-3.5 0"/>'
  };
  function icon(name, cls) {
    var d = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="' + (cls || "ic") + '" aria-hidden="true">' + (ICONS[name] || "") + "</svg>", "image/svg+xml");
    return document.importNode(d.documentElement, true);
  }

  var VIEWS = [
    { id: "overview", title: "Overview", render: renderOverview },
    { id: "usage", title: "Usage", render: renderUsage },
    { id: "plans", title: "Plans & billing", render: renderPlans },
    { id: "profile", title: "Profile", render: renderProfile },
    { id: "security", title: "Security", render: renderSecurity },
    { id: "referral", title: "Refer & earn", render: renderReferral }
  ];

  /* ---- shell ---- */
  function buildNav() {
    var nav = $("nav"); nav.innerHTML = "";
    VIEWS.forEach(function (v) {
      var b = el("button", v.id === view ? "on" : "");
      b.appendChild(icon(v.id, "ic"));
      b.appendChild(document.createTextNode(v.title));
      b.addEventListener("click", function () { go(v.id); });
      nav.appendChild(b);
    });
  }
  function go(id) {
    view = id;
    // A real URL per view, so browser back works and a view can be linked to.
    try { history.replaceState(null, "", "#" + id); } catch (e) {}
    closeSidebar();
    render();
  }
  function render() {
    var v = VIEWS.filter(function (x) { return x.id === view; })[0] || VIEWS[0];
    buildNav();
    $("viewTitle").textContent = v.title;
    var host = $("view"); host.innerHTML = "";
    v.render(host);
    window.scrollTo(0, 0);
  }

  function card(host, title, sub) {
    var c = el("section", "card2");
    if (title) {
      var h = el("div", "card2-head");
      h.appendChild(el("h2", null, title));
      if (sub) h.appendChild(el("p", "muted", sub));
      c.appendChild(h);
    }
    host.appendChild(c);
    return c;
  }
  function row(parent, k, v) {
    var d = el("div", "kv"); d.appendChild(el("span", null, k));
    d.appendChild(el("b", null, v == null ? "—" : String(v))); parent.appendChild(d); return d;
  }
  function btn(label, cls, fn) { var b = el("button", "btn-sm " + (cls || ""), label); b.addEventListener("click", fn); return b; }
  function fmtDate(s) { if (!s) return "—"; try { return new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return "—"; } }
  function fmtTime(s) { try { return new Date(s).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) { return "—"; } }

  /* ---- Overview ---- */
  function renderOverview(host) {
    var c = me.credits;
    var grid = el("div", "grid2"); host.appendChild(grid);

    // Credit meter. Unlimited gets no bar — a progress bar with no ceiling is
    // a lie, and drawing one full would read as "you're out".
    var cc = el("section", "card2 hero");
    cc.appendChild(el("div", "eyebrow", "Credits"));
    if (c.unlimited) {
      cc.appendChild(el("div", "big", "Unlimited"));
      cc.appendChild(el("p", "muted", "Your plan has no daily cap."));
    } else {
      var used = Math.max(0, c.dailyQuota - c.balance);
      var pct = c.dailyQuota > 0 ? Math.min(100, Math.round((c.balance / c.dailyQuota) * 100)) : 0;
      var big = el("div", "big"); big.appendChild(el("span", null, String(c.balance)));
      big.appendChild(el("small", null, " / " + c.dailyQuota));
      cc.appendChild(big);
      var bar = el("div", "meter");
      var fill = el("div", "meter-fill " + (pct <= 15 ? "low" : ""));
      fill.style.width = pct + "%";
      bar.appendChild(fill); cc.appendChild(bar);
      cc.appendChild(el("p", "muted", used + " used today · resets at midnight UTC"));
    }
    grid.appendChild(cc);

    // Plan
    var pc = el("section", "card2 hero");
    pc.appendChild(el("div", "eyebrow", "Current plan"));
    pc.appendChild(el("div", "big", me.planName || me.plan));
    var note = me.subscriptionStatus === "active"
      ? (me.currentPeriodEnd ? "Renews " + fmtDate(me.currentPeriodEnd) : "Active subscription")
      : "Upgrade for a higher daily allowance.";
    pc.appendChild(el("p", "muted", note));
    var pr = el("div", "row");
    pr.appendChild(btn(me.subscriptionStatus === "active" ? "Manage plan" : "View plans", "", function () { go("plans"); }));
    pc.appendChild(pr);
    grid.appendChild(pc);

    // Quick actions. Two of these used to point at /tool and /guide, which are
    // placeholder routes that redirect straight back here — a card that looks
    // like an action and does nothing when you click it. Every one of them now
    // goes somewhere that exists.
    var qa = card(host, "Quick actions");
    var acts = el("div", "actions");
    [
      ["Get the extension", "Removal happens in the browser side panel.", function () {
        location.assign("/#get-extension");
      }],
      ["Plans & billing", "Daily allowance, invoices and upgrades.", function () { go("plans"); }],
      ["Account settings", "Name, password and connected accounts.", function () { go("profile"); }]
    ].forEach(function (a) {
      var b = el("button", "action");
      b.appendChild(el("b", null, a[0]));
      b.appendChild(el("span", null, a[1]));
      b.addEventListener("click", a[2]);
      acts.appendChild(b);
    });
    qa.appendChild(acts);

    // Recent activity preview
    var ra = card(host, "Recent activity");
    if (!usage) { ra.appendChild(el("p", "muted", "Loading…")); loadUsage(); }
    else if (!usage.recent.length) ra.appendChild(el("p", "muted", "Nothing yet. Credits you spend will show up here."));
    else {
      ra.appendChild(ledgerList(usage.recent, 5));
      var rr = el("div", "row");
      rr.appendChild(btn("See all usage", "ghost", function () { go("usage"); }));
      ra.appendChild(rr);
    }
  }

  var REASONS = {
    daily_free: "Daily free credits", quota_sync: "Plan allowance adjusted", admin_grant: "Added by support", admin_deduct: "Adjusted by support",
    admin_adjust: "Adjusted by support", usage: "Watermark removed", image_clean: "Watermark removed",
    usage_unlimited: "Watermark removed", image: "Watermark removed", video: "Video cleaned",
    batch: "Batch cleaned", goodwill: "Bonus credits", referral: "Referral bonus"
  };

  /* Twenty rows reading "Watermark removed · -1" for the same afternoon is a
   * receipt, not a history. Same reason on the same day folds into one line
   * carrying the count and the total, which is the question someone opening
   * this actually has. Rows are already newest-first from the server, so a
   * single pass over neighbours is enough — no sorting, no grouping map. */
  function fold(rows) {
    var out = [];
    rows.forEach(function (r) {
      var day = String(r.created_at).slice(0, 10);
      var last = out[out.length - 1];
      if (last && last.reason === r.reason && last.day === day && (last.delta < 0) === (r.delta < 0)) {
        last.delta += r.delta; last.n += 1;
        return;
      }
      out.push({ reason: r.reason, day: day, created_at: r.created_at, delta: r.delta, n: 1 });
    });
    return out;
  }

  function ledgerList(rows, limit) {
    var list = el("ul", "ledger");
    /* Fold first, then trim: five raw rows can be one afternoon's work, and
       trimming first would have shown five lines saying the same thing. */
    var folded = fold(rows);
    (limit ? folded.slice(0, limit) : folded).forEach(function (r) {
      var li = el("li");
      var left = el("div");
      left.appendChild(el("b", null, REASONS[r.reason] || r.reason));
      left.appendChild(el("span", "muted",
        fmtTime(r.created_at) + (r.n > 1 ? " · " + r.n + " times" : "")));
      li.appendChild(left);
      var amt = el("span", "delta " + (r.delta > 0 ? "up" : r.delta < 0 ? "down" : ""),
        (r.delta > 0 ? "+" : "") + r.delta);
      li.appendChild(amt);
      list.appendChild(li);
    });
    return list;
  }

  /* ---- Usage ---- */
  function renderUsage(host) {
    if (!usage) { card(host, "Usage").appendChild(el("p", "muted", "Loading…")); loadUsage(); return; }

    var c = card(host, "Last 30 days", "Credits you've spent each day.");
    if (!usage.daily.length) c.appendChild(el("p", "muted", "No activity yet."));
    else c.appendChild(usageChart(usage.daily));

    var h = card(host, "Activity", "Every credit added to or taken from your balance.");
    if (!usage.recent.length) h.appendChild(el("p", "muted", "Nothing yet."));
    else h.appendChild(ledgerList(usage.recent));
  }

  /* Inline SVG rather than a charting library: it is one series of bars, and
   * the CSP forbids third-party scripts anyway. Bars are labelled for screen
   * readers because the axis alone doesn't convey the values. */
  function usageChart(daily) {
    var days = [];
    for (var i = 29; i >= 0; i--) {
      var d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      var hit = daily.filter(function (x) { return x.date === d; })[0];
      days.push({ date: d, used: hit ? hit.used : 0 });
    }
    var max = Math.max(1, Math.max.apply(null, days.map(function (d) { return d.used; })));
    var W = 720, H = 160, gap = 3, bw = (W - gap * (days.length - 1)) / days.length;

    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + (H + 22));
    svg.setAttribute("class", "chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Credits spent per day over the last 30 days. Peak " + max + ".");

    days.forEach(function (d, i) {
      var h = d.used ? Math.max(3, (d.used / max) * H) : 2;
      var r = document.createElementNS(ns, "rect");
      r.setAttribute("x", (i * (bw + gap)).toFixed(2));
      r.setAttribute("y", (H - h).toFixed(2));
      r.setAttribute("width", bw.toFixed(2));
      r.setAttribute("height", h.toFixed(2));
      r.setAttribute("rx", "2");
      r.setAttribute("class", d.used ? "bar" : "bar zero");
      var title = document.createElementNS(ns, "title");
      title.textContent = d.date + ": " + d.used + (d.used === 1 ? " credit" : " credits");
      r.appendChild(title);
      svg.appendChild(r);
    });
    // Only the ends are labelled; thirty tick labels would be unreadable.
    [[0, days[0].date], [W, days[days.length - 1].date]].forEach(function (t, idx) {
      var lbl = document.createElementNS(ns, "text");
      lbl.setAttribute("x", t[0]); lbl.setAttribute("y", H + 16);
      lbl.setAttribute("class", "axis");
      if (idx) lbl.setAttribute("text-anchor", "end");
      lbl.textContent = fmtDate(t[1]);
      svg.appendChild(lbl);
    });

    var wrap = el("div", "chart-wrap");
    wrap.appendChild(svg);
    wrap.appendChild(el("p", "muted", "Peak day: " + max + (max === 1 ? " credit" : " credits")));
    return wrap;
  }

  /* Payments are set up in the Razorpay dashboard, not here, so the two ways
     that can be half-finished get their own words. Anything else is a real
     failure and says so without repeating the server's error text. */
  var CHECKOUT_ERRORS = {
    not_configured: "Payments aren't switched on yet. This plan will be purchasable shortly.",
    plan_not_linked: "This plan isn't connected to billing yet.",
    no_such_plan: "That plan is no longer available.",
  };

  /* ---- Plans ---- */
  function renderPlans(host) {
    if (!plans) { card(host, "Plans").appendChild(el("p", "muted", "Loading…")); loadPlans(); return; }

    var c = card(host, "Plans", "Your plan sets how many images you can clean each day.");
    var grid = el("div", "plans");
    plans.forEach(function (p) {
      var mine = p.id === me.plan;
      var pc = el("div", "plan" + (mine ? " current" : ""));
      if (mine) pc.appendChild(el("span", "tag", "Current"));
      pc.appendChild(el("h3", null, p.name));
      var price = el("div", "price");
      price.appendChild(el("span", null, p.priceInr ? "₹" + p.priceInr : "Free"));
      if (p.priceInr) price.appendChild(el("small", null, "/month"));
      pc.appendChild(price);
      pc.appendChild(el("p", "muted", p.unlimited ? "Unlimited images per day" : p.dailyQuota + " images per day"));
      if (!mine) {
        var go2 = btn(p.priceInr ? "Upgrade" : "Switch", "", function () {
          if (!p.priceInr) { toast("Contact support to move down a plan."); return; }
          go2.disabled = true; go2.textContent = "Opening…";
          api("/api/billing/checkout", { method: "POST", body: { planId: p.id } })
            .then(function (r) {
              // A named window, not a redirect: the dashboard stays put so the
              // account is still there when they come back from paying.
              window.open(r.url, "_blank", "noopener");
              toast("Checkout opened in a new tab.");
            })
            .catch(function (e) {
              toast(CHECKOUT_ERRORS[e.code] || "Could not start checkout. Try again in a moment.");
            })
            .then(function () { go2.disabled = false; go2.textContent = p.priceInr ? "Upgrade" : "Switch"; });
        });
        pc.appendChild(go2);
      }
      grid.appendChild(pc);
    });
    c.appendChild(grid);

    var b = card(host, "Billing");
    row(b, "Status", me.subscriptionStatus === "none" ? "No active subscription" : me.subscriptionStatus);
    row(b, "Plan", me.planName || me.plan);
    if (me.currentPeriodEnd) row(b, "Renews", fmtDate(me.currentPeriodEnd));
    if (me.credits.quotaSource === "user_override") {
      b.appendChild(el("div", "note", "Your daily allowance has been set individually for this account, so it overrides the plan's."));
    }
  }

  /* ---- Profile ---- */
  function renderProfile(host) {
    var c = card(host, "Profile", "How you appear on Erasezo.");
    var id = el("div", "identity");
    var av = el("div", "avatar", (me.username || me.email).slice(0, 1).toUpperCase());
    id.appendChild(av);
    var who = el("div");
    who.appendChild(el("b", null, me.username || "—"));
    who.appendChild(el("span", "muted", me.email));
    id.appendChild(who);
    c.appendChild(id);

    c.appendChild(el("label", null, "Username"));
    var name = el("input"); name.type = "text"; name.value = me.username || ""; name.maxLength = 60;
    c.appendChild(name);
    c.appendChild(el("p", "hint", "This is how others see you."));

    c.appendChild(el("label", null, "Email"));
    var mail = el("input"); mail.type = "email"; mail.value = me.email; mail.disabled = true;
    c.appendChild(mail);
    c.appendChild(el("p", "hint", "Email can't be changed. Contact support if you need to."));

    var msg = el("div", "msg"); c.appendChild(msg);
    var save = btn("Save changes", "", function () {
      var v = name.value.trim();
      if (!v) { msg.textContent = "Enter a username."; msg.className = "msg err"; return; }
      save.disabled = true;
      api("/api/user/profile", { method: "PATCH", body: { username: v } })
        .then(function (u) { me = u; msg.textContent = "Saved."; msg.className = "msg ok"; save.disabled = false; paintShell(); })
        .catch(function (e) { msg.textContent = e.message || "Couldn't save."; msg.className = "msg err"; save.disabled = false; });
    });
    var r = el("div", "row"); r.appendChild(save); c.appendChild(r);

    var ca = card(host, "Connected accounts", "Third-party services linked to this account.");
    var g = el("div", "conn");
    var gl = el("div");
    gl.appendChild(el("b", null, "Google"));
    gl.appendChild(el("span", "muted", me.googleId ? "Connected" : "Not connected"));
    g.appendChild(gl);
    g.appendChild(el("span", "tag " + (me.googleId ? "on" : ""), me.googleId ? "Connected" : "Not connected"));
    ca.appendChild(g);
    if (!me.googleId) {
      ca.appendChild(el("p", "hint", "To link Google, sign out and use “Continue with Google”. Accounts sharing an email are merged automatically."));
    }
  }

  /* ---- Security ----
   * Two real credentials, read from the account rather than assumed:
   *   googleId     — Google sign-in is linked
   *   hasPassword  — email + password sign-in works (/api/auth/login checks the hash)
   * A Google account with no hash can add a password. An account that already
   * has one must change it by proving the current password. There is no session
   * list and no second factor on this page. */
  function renderSecurity(host) {
    var state = securityState(me);

    var methods = card(host, "Sign-in methods", "Ways this account can sign in.");
    var list = el("div", "method-list");
    list.appendChild(methodRow(
      "Google",
      state.googleConnected ? "Linked to this account." : "Not linked.",
      state.googleConnected ? "Connected" : "Not connected",
      state.googleConnected
    ));
    list.appendChild(methodRow(
      "Email and password",
      state.hasPassword ? ("Sign in with " + (me.email || "your email") + ".") : "No password on this account.",
      state.hasPassword ? "On" : "Not set",
      state.hasPassword
    ));
    methods.appendChild(list);
    if (!state.googleConnected) {
      methods.appendChild(el("p", "hint", "To link Google, sign out and use “Continue with Google”. Accounts sharing an email are merged automatically."));
    }

    if (state.hasPassword) renderChangePassword(host, state);
    else renderSetPassword(host, state);

    var s = card(host, "This browser", "Signing out ends the session in this browser.");
    var sr = el("div", "row");
    sr.appendChild(btn("Sign out", "ghost", signOut));
    s.appendChild(sr);
  }

  function renderChangePassword(host, state) {
    var sub = state.googleConnected
      ? "Email sign-in uses this password. Google sign-in stays linked."
      : "Enter your current password, then choose a new one.";
    var c = card(host, "Change password", sub);
    var cur, n1, n2, msg, save;
    var form = el("form");
    cur = passField(form, "Current password", "sec-current", "current-password");
    n1 = passField(form, "New password", "sec-new", "new-password");
    n2 = passField(form, "Confirm new password", "sec-confirm", "new-password");
    form.appendChild(el("p", "hint", "At least 8 characters."));
    msg = el("div", "msg"); msg.setAttribute("role", "status"); form.appendChild(msg);
    save = el("button", "btn-sm", "Update password"); save.type = "submit";
    var rowEl = el("div", "row"); rowEl.appendChild(save); form.appendChild(rowEl);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (save.disabled) return;
      var err = passwordFormError("change", cur.value, n1.value, n2.value);
      if (err) { msg.textContent = err; msg.className = "msg err"; return; }
      save.disabled = true;
      api("/api/user/password", { method: "PATCH", body: { currentPassword: cur.value, newPassword: n1.value } })
        .then(function () {
          msg.textContent = "Password updated."; msg.className = "msg ok";
          cur.value = n1.value = n2.value = "";
          save.disabled = false;
        })
        .catch(function (err2) {
          msg.textContent = passwordErrorText(err2); msg.className = "msg err"; save.disabled = false;
        });
    });
    c.appendChild(form);
  }

  function renderSetPassword(host, state) {
    var sub = state.googleConnected
      ? "Google sign-in stays as it is. A password also lets you sign in with your email."
      : "This account has no password yet. Set one to sign in with your email.";
    var c = card(host, "Add a password", sub);
    var n1, n2, msg, save;
    var form = el("form");
    n1 = passField(form, "New password", "sec-new", "new-password");
    n2 = passField(form, "Confirm new password", "sec-confirm", "new-password");
    form.appendChild(el("p", "hint", "At least 8 characters."));
    msg = el("div", "msg"); msg.setAttribute("role", "status"); form.appendChild(msg);
    save = el("button", "btn-sm", "Add password"); save.type = "submit";
    var rowEl = el("div", "row"); rowEl.appendChild(save); form.appendChild(rowEl);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (save.disabled) return;
      var err = passwordFormError("set", "", n1.value, n2.value);
      if (err) { msg.textContent = err; msg.className = "msg err"; return; }
      save.disabled = true;
      api("/api/user/password", { method: "POST", body: { newPassword: n1.value } })
        .then(function () {
          me.hasPassword = true;
          toast("Password added. You can sign in with your email as well.");
          render();
        })
        .catch(function (err2) {
          msg.textContent = passwordErrorText(err2); msg.className = "msg err"; save.disabled = false;
        });
    });
    c.appendChild(form);
  }

  function methodRow(title, detail, tagText, on) {
    var g = el("div", "conn");
    var gl = el("div");
    gl.appendChild(el("b", null, title));
    gl.appendChild(el("span", "muted", detail));
    g.appendChild(gl);
    g.appendChild(el("span", "tag" + (on ? " on" : ""), tagText));
    return g;
  }

  function securityState(user) {
    return {
      googleConnected: !!(user && user.googleId),
      hasPassword: !!(user && user.hasPassword),
    };
  }

  function passwordFormError(mode, current, next, confirmNext) {
    if (mode === "change" && !String(current || "")) return "Enter your current password.";
    if (String(next || "").length < 8) return "New password must be at least 8 characters.";
    if (next !== confirmNext) return "The two new passwords don't match.";
    return "";
  }

  function passwordErrorText(e) {
    var known = {
      wrong_current_password: "Current password is incorrect.",
      weak_password: "Password must be at least 8 characters.",
      oauth_only: "This account has no password to change.",
      password_exists: "This account already has a password.",
      rate_limited: "Too many attempts — try again shortly."
    };
    if (e && known[e.code]) return known[e.code];
    return (e && e.message) || "Couldn't update the password.";
  }

  function passField(parent, label, id, autocomplete) {
    var lab = el("label", null, label);
    lab.htmlFor = id;
    parent.appendChild(lab);
    var i = el("input");
    i.type = "password";
    i.id = id;
    i.autocomplete = autocomplete;
    parent.appendChild(i);
    return i;
  }

  /* ---- Referrals ----
   * A code exists only after an application is approved. The empty state
   * links to the application; it does not pretend the program is closed. */
  var referralGen = 0;
  function renderReferral(host) {
    var c = card(host, "Refer & earn", "Invite people to Erasezo. A link is issued after your application is approved.");
    var gen = ++referralGen;
    var slot = el("div");
    c.appendChild(slot);
    slot.appendChild(el("p", "muted", "Loading…"));
    api("/api/referral/me").then(function (d) {
      if (gen !== referralGen) return;
      slot.innerHTML = "";
      paintReferral(slot, d);
    }).catch(function () {
      if (gen !== referralGen) return;
      slot.innerHTML = "";
      slot.appendChild(el("p", "muted", "Couldn't load your referral status."));
      var a = el("a", "btn-sm", "Open the referral program");
      a.href = "/referral";
      var r = el("div", "row"); r.appendChild(a); slot.appendChild(r);
    });
  }
  function paintReferral(slot, d) {
    if (d && d.status === "approved" && d.referralCode) {
      var link = location.origin + "/?ref=" + d.referralCode;
      row(slot, "Your link", link);
      row(slot, "Signups", d.signups);
      row(slot, "Credits earned", d.creditsEarned);
      var r = el("div", "row");
      r.appendChild(btn("Copy link", "", function () {
        navigator.clipboard.writeText(link).then(function () { toast("Link copied"); }, function () { toast("Couldn't copy — select the link instead"); });
      }));
      slot.appendChild(r);
      return;
    }
    if (d && d.status === "pending") {
      slot.appendChild(el("p", "muted", "Your application is in review. The link appears here once it's approved."));
    } else if (d && d.status === "rejected") {
      slot.appendChild(el("p", "muted", "This application wasn't approved. You can submit a new one."));
      if (d.rejectReason) slot.appendChild(el("p", "note", d.rejectReason));
    } else {
      slot.appendChild(el("p", "muted", "You don't have a referral link yet. Apply, and a person reviews it. If it's approved, the link and the credits it earns show up here."));
    }
    var a = el("a", "btn-sm", d && d.status === "rejected" ? "Apply again" : "Apply for referral access");
    a.href = "/referral";
    var rowEl = el("div", "row"); rowEl.appendChild(a); slot.appendChild(rowEl);
  }

  /* ---- data ---- */
  function loadUsage() {
    api("/api/usage").then(function (d) { usage = d; if (view === "usage" || view === "overview") render(); })
      .catch(function () { usage = { recent: [], daily: [] }; if (view === "usage" || view === "overview") render(); });
  }
  function loadPlans() {
    api("/api/plans").then(function (d) { plans = d.plans; if (view === "plans") render(); })
      .catch(function () { plans = []; if (view === "plans") render(); });
  }

  function paintShell() {
    $("planPill").textContent = (me.planName || me.plan || "free").toUpperCase();
    var w = $("sideWho"); w.innerHTML = "";
    w.appendChild(el("b", null, me.username || me.email.split("@")[0]));
    w.appendChild(el("span", null, me.email));
  }

  function signOut() {
    api("/api/auth/logout", { method: "POST" }).catch(function () {}).then(function () { location.href = "/"; });
  }

  /* ---- mobile sidebar ---- */
  function openSidebar() { document.body.classList.add("side-open"); $("scrim").hidden = false; $("menuBtn").setAttribute("aria-expanded", "true"); }
  function closeSidebar() { document.body.classList.remove("side-open"); $("scrim").hidden = true; $("menuBtn").setAttribute("aria-expanded", "false"); }

  /* ---- boot ---- */
  $("signout").addEventListener("click", signOut);
  $("menuBtn").addEventListener("click", function () {
    if (document.body.classList.contains("side-open")) closeSidebar(); else openSidebar();
  });
  $("scrim").addEventListener("click", closeSidebar);
  window.addEventListener("hashchange", function () {
    var id = location.hash.replace("#", "");
    if (VIEWS.some(function (v) { return v.id === id; }) && id !== view) { view = id; render(); }
  });

  api("/api/me").then(function (u) {
    me = u;
    var hashed = location.hash.replace("#", "");
    if (VIEWS.some(function (v) { return v.id === hashed; })) view = hashed;
    paintShell();
    // Shown from the user's own record rather than by probing an admin
    // endpoint that would 401 on every page load for everyone else. The panel
    // itself is gated server-side; this only decides whether to offer a link.
    $("adminLink").hidden = !me.isAdmin;
    render();
  }).catch(function () { location.href = "/"; });
})();
