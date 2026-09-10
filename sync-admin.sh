#!/bin/sh
# Copies the Control Room out of the extension folder into public/, so the same
# panel is served from erasezo.com. The extension folder is the single source of
# truth — never edit public/admin* by hand, edit there and re-run this.
#
# The layout below is deliberate: served at the URL "/admin", the page's own
# relative refs resolve to /admin.css, /admin.js and /admin/<file>.js, which is
# exactly where these land. Same file works unmodified in both contexts.
set -e
WEB="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$WEB/../Erasezo-extension}"
EXT2="${2:-$WEB/../1.1.2_0}"
DEST="$WEB/public"

cp "$SRC/admin.html" "$DEST/admin.html"
cp "$SRC/admin.css"  "$DEST/admin.css"
cp "$SRC/admin.js"   "$DEST/admin.js"
# Mirror rather than copy-over: files deleted upstream (the old Supabase client
# and its config) must not linger here and keep getting served.
rm -rf "$DEST/admin"
mkdir -p "$DEST/admin"
cp "$SRC/admin/auth.js" "$DEST/admin/"
echo "Control Room -> $DEST"

# The unpacked copy is the same extension at the same version, so it needs the
# same panel. It was only being fanned out to by sync-design.sh, which is why
# its admin.css sat two contrast fixes behind the one being served.
if [ -d "$EXT2" ]; then
  cp "$SRC/admin.html" "$EXT2/admin.html"
  cp "$SRC/admin.css"  "$EXT2/admin.css"
  cp "$SRC/admin.js"   "$EXT2/admin.js"
  rm -rf "$EXT2/admin"
  mkdir -p "$EXT2/admin"
  cp "$SRC/admin/auth.js" "$EXT2/admin/"
  echo "Control Room -> $EXT2"
fi
