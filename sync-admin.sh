#!/bin/sh
# Copies the Control Room out of the extension folder into public/, so the same
# panel is served from erasezo.com. The extension folder is the single source of
# truth — never edit public/admin* by hand, edit there and re-run this.
#
# The layout below is deliberate: served at the URL "/admin", the page's own
# relative refs resolve to /admin.css, /admin.js and /admin/<file>.js, which is
# exactly where these land. Same file works unmodified in both contexts.
set -e
SRC="${1:-../Erasezo-extension}"
DEST="$(dirname "$0")/public"

cp "$SRC/admin.html" "$DEST/admin.html"
cp "$SRC/admin.css"  "$DEST/admin.css"
cp "$SRC/admin.js"   "$DEST/admin.js"
# Mirror rather than copy-over: files deleted upstream (the old Supabase client
# and its config) must not linger here and keep getting served.
rm -rf "$DEST/admin"
mkdir -p "$DEST/admin"
cp "$SRC/admin/auth.js" "$DEST/admin/"

echo "Control Room synced from $SRC"
