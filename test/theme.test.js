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
/* The Control Room used to live in the extension package and be copied here,
   which meant editing the copy and running the sync silently reverted the
   edit — it ate a contrast fix once. It is served only from public/ now, so
   there is one copy and nothing to keep in step. This asserts the removal
   rather than the sync: a stray admin.* back in the package is the old trap
   returning, and it would ship the admin API map to every installed user. */
for (const f of ["admin.html", "admin.css", "admin.js", "admin"]) {
  ok(!fs.existsSync(path.join(root, "Erasezo-extension", f)),
     "the extension package does not carry " + f);
}
for (const f of ["admin.html", "admin.css", "admin.js", "admin/auth.js"]) {
  ok(fs.existsSync(path.join(web, "public", f)), "the site still serves " + f);
}

const theme = fs.readFileSync(path.join(web, "public/theme.css"), "utf8");
for (const dir of ["Erasezo-extension", "1.1.2_0"]) {
  const p = path.join(root, dir, "assets/theme.css");
  if (!fs.existsSync(p)) { console.log("skip (missing): " + dir); continue; }
  ok(fs.readFileSync(p, "utf8") === theme, dir + "/assets/theme.css is in sync (run sync-design.sh)");
}

/* text-white is baked into the bundle's markup for this button, so whatever
   fill it gets has to stay dark enough to carry white — the accent wash is
   #E0F2FE in light mode, which made the label disappear. */
{
  const rule = theme.match(/\.bg-\\\[\\#153642\\\][^{]*\{[^}]*\}/);
  ok(rule && !/accent-wash/.test(rule[0]),
     "the solid-dark button is not filled with the accent wash");
}

/* The brand mark. The extension shipped the old teal Erasio icon at every
   size, the login card drew the letter "L", and the dashboard drew "E" — a
   placeholder outlives the day it was written unless something checks. */
const png = (file) => {
  const b = fs.readFileSync(file);
  // IHDR is the first chunk, so width and height sit at a fixed offset.
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
};

const extRoot = path.join(root, "Erasezo-extension");
if (!fs.existsSync(extRoot)) { console.log("skip: extension folder not present"); }
else {
  const man = JSON.parse(fs.readFileSync(path.join(extRoot, "manifest.json"), "utf8"));
  for (const size of [16, 32, 48, 128]) {
    const rel = "icons/icon" + size + ".png";
    ok(man.icons[size] === rel, "manifest declares the " + size + "px icon");
    ok(man.action.default_icon && man.action.default_icon[size] === rel,
       "the toolbar button has its own " + size + "px icon, not a rescale");
    const d = png(path.join(extRoot, rel));
    ok(d.w === size && d.h === size, rel + " really is " + size + "x" + size);
  }
  // Every size is cut from the one 128 master, so they are the same artwork.
  const master = png(path.join(extRoot, "icons/icon128.png"));
  const siteMark = png(path.join(web, "public/mark.png"));
  ok(master.bytes === siteMark.bytes, "the site's mark and the extension's icon are the same file");

  for (const dir of ["Erasezo-extension", "1.1.2_0"]) {
    const p2 = path.join(root, dir, "mark.png");
    if (!fs.existsSync(p2)) { console.log("skip (missing): " + dir + "/mark.png"); continue; }
    // admin.html and user.html are served from the extension root and from the
    // site root, and both ask for /mark.png.
    ok(fs.readFileSync(p2).equals(fs.readFileSync(path.join(web, "public/mark.png"))),
       dir + "/mark.png is in sync (run sync-design.sh)");
  }
}

for (const [file, dir] of [["index.html", "public"], ["dashboard.html", "public"],
                           ["admin.html", "public"], ["user.html", null]]) {
  const p2 = dir ? path.join(web, dir, file) : path.join(root, "Erasezo-extension", file);
  if (!fs.existsSync(p2)) { console.log("skip (missing): " + file); continue; }
  const html = fs.readFileSync(p2, "utf8");
  ok(/<link rel="icon"/.test(html), file + " has a favicon");
  ok(!/<div class="logo">[A-Z]<\/div>/.test(html), file + " does not draw a letter where the mark goes");
}

console.log("\nALL THEME TESTS PASSED");
