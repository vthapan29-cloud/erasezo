(function () {
  var mode = "signin";
  var $ = function (id) { return document.getElementById(id); };
  var next = "";
  try { next = new URLSearchParams(location.search).get("next") || ""; } catch (e) {}
  function dest() {
    if (next.charAt(0) === "/" && next.charAt(1) !== "/" && next.indexOf("\\") === -1 && next.indexOf("://") === -1) return next;
    return "/dashboard";
  }
  var google = document.querySelector("a.google");
  if (google && dest() !== "/dashboard") google.href = "/api/auth/google?next=" + encodeURIComponent(dest());
  function setMode(m) {
    mode = m;
    $("title").textContent = m === "signup" ? "Create your account" : "Sign in to Erasezo";
    $("submit").textContent = m === "signup" ? "Create account" : "Sign in";
    $("ftext").textContent = m === "signup" ? "Already have an account? " : "New to Erasezo? ";
    $("toggle").textContent = m === "signup" ? "Sign in" : "Create an account";
    $("password").autocomplete = m === "signup" ? "new-password" : "current-password";
  }
  function msg(t, ok) { var e = $("msg"); e.textContent = t; e.className = "msg " + (ok ? "ok" : "err"); }
  $("toggle").onclick = function () { setMode(mode === "signup" ? "signin" : "signup"); $("msg").className = "msg"; };
  $("submit").onclick = function () {
    var email = $("email").value.trim(), password = $("password").value;
    if (!email || !password) { msg("Enter email and password."); return; }
    $("submit").disabled = true;
    fetch("/api/auth/" + (mode === "signup" ? "register" : "login"), {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ email: email, password: password })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (x) {
        if (x.ok) { location.href = dest(); return; }
        var m = { invalid_credentials: "Wrong email or password.", email_taken: "An account with this email already exists.", weak_password: "Password must be at least 8 characters.", rate_limited: "Too many attempts — try again shortly." }[x.b.error] || x.b.message || "Failed.";
        msg(m); $("submit").disabled = false;
      }).catch(function () { msg("Network error."); $("submit").disabled = false; });
  };
  // already signed in? go to dashboard
  fetch("/api/me", { credentials: "include" }).then(function (r) { if (r.ok) location.href = dest(); });
})();
