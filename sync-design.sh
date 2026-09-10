#!/bin/sh
# Copies the design tokens and the sidepanel theme between the site and the
# extension. public/tokens.css is the single source of truth — edit it there.
#
# The two live in different deployment contexts (a website and a packed
# extension), so neither can link the other's file at runtime; the only way
# they stay one system is by being copied from one place.
set -e
WEB="$(cd "$(dirname "$0")" && pwd)"
EXT="${1:-$WEB/../Erasezo-extension}"
EXT2="${2:-$WEB/../1.1.2_0}"

for dir in "$EXT" "$EXT2"; do
  [ -d "$dir" ] || { echo "skip (missing): $dir"; continue; }
  # Root, not assets/: the extension serves its folder root at "/" and the
  # site serves public/ at "/", so "/tokens.css" is the one path that
  # resolves in both contexts.
  cp "$WEB/public/tokens.css" "$dir/tokens.css"
  echo "tokens -> $dir/tokens.css"
  # The Control Room is served from both roots and asks for /mark.png, so the
  # brand mark has to sit at the same path in each.
  cp "$WEB/public/mark.png" "$dir/mark.png"
  echo "mark   -> $dir/mark.png"
done
# theme.css re-skins the sidepanel, so it lives in the extension at runtime --
# but the extension folders are not under version control, and design work that
# exists in exactly one unbacked copy is design work waiting to be lost. The
# tracked original is public/theme.css and it fans out the same way tokens do.
for dir in "$EXT" "$EXT2"; do
  [ -d "$dir/assets" ] || continue
  cp "$WEB/public/theme.css" "$dir/assets/theme.css"
  echo "theme  -> $dir/assets/theme.css"
done
