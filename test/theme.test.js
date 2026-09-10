/* The design layer has no server to test, but it has two invariants that have
   already broken once each, silently, in a way no page load complains about. */
const fs = require("fs");
const path = require("path");

const web = path.join(__dirname, "..");
const root = path.join(web, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL - " + m); process.exit(1); } console.log("ok - " + m); };

const tokens = fs.readFileSync(path.join(web, "public/tokens.css"), "utf8");

/* The sidepanel and the Control Room both drive their theme button by writing
   data-theme. tokens.css originally answered only to data-ez-theme, so both
   buttons flipped the surrounding bundle and left the tokens on the other
   mode — a half-dark panel, and a Control Room toggle that did nothing. */
ok(/:root:not\(\[data-ez-theme="light"\]\):not\(\[data-theme="light"\]\)/.test(tokens),
   "OS dark defers to an explicit light choice under either attribute");
ok(/:root\[data-theme="dark"\]/.test(tokens) && /:root\[data-ez-theme="dark"\]/.test(tokens),
   "an explicit dark choice is honoured under either attribute");

/* The dark palette is written twice - once under prefers-color-scheme for the
   OS default, once under the attribute for an explicit choice - because a
   media query and a plain selector cannot share one rule. Two hand-kept
   copies drift, and the drift is invisible until someone happens to open the
   surface in the mode that was missed. */
const darkBlocks = (tokens.match(/--ez-bg:[\s\S]*?\n\s*\}/g) || []).filter((b) => /#080E18/.test(b));
const norm = (b) => b.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
ok(darkBlocks.length === 2 && norm(darkBlocks[0]) === norm(darkBlocks[1]),
   "both dark palettes declare the same values");

/* One source of truth only stays true if the copies keep up. Editing
   public/tokens.css and forgetting sync-design.sh leaves the extension on the
   old palette, which looks like a CSS bug and is not one. */
for (const dir of ["Erasezo-extension", "1.1.2_0"]) {
  const p = path.join(root, dir, "tokens.css");
  if (!fs.existsSync(p)) { console.log("skip (missing): " + dir); continue; }
  ok(fs.readFileSync(p, "utf8") === tokens, dir + "/tokens.css is in sync (run sync-design.sh)");
}
/* Same trap, other direction: the Control Room's source of truth is the
   extension folder and sync-admin.sh copies it into public/. Editing the
   public copy and then running the sync silently reverts the edit - which is
   exactly how a contrast fix committed here once vanished on the next sync. */
for (const f of ["admin.css", "admin.js", "admin.html"]) {
  const a = path.join(root, "Erasezo-extension", f), b = path.join(web, "public", f);
  if (!fs.existsSync(a) || !fs.existsSync(b)) { console.log("skip (missing): " + f); continue; }
  ok(fs.readFileSync(a, "utf8") === fs.readFileSync(b, "utf8"),
     "public/" + f + " matches the extension copy (edit there, run sync-admin.sh)");
}

const themeA = path.join(root, "Erasezo-extension/assets/theme.css");
const themeB = path.join(root, "1.1.2_0/assets/theme.css");
if (fs.existsSync(themeA) && fs.existsSync(themeB)) {
  ok(fs.readFileSync(themeA, "utf8") === fs.readFileSync(themeB, "utf8"),
     "both extension folders carry the same theme.css");
}

/* text-white is baked into the bundle's markup for this button, so whatever
   fill it gets has to stay dark enough to carry white — the accent wash is
   #E0F2FE in light mode, which made the label disappear. */
if (fs.existsSync(themeA)) {
  const theme = fs.readFileSync(themeA, "utf8");
  const rule = theme.match(/\.bg-\\\[\\#153642\\\][^{]*\{[^}]*\}/);
  ok(rule && !/accent-wash/.test(rule[0]),
     "the solid-dark button is not filled with the accent wash");
}

console.log("\nALL THEME TESTS PASSED");
