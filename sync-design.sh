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
done
# theme.css is the sidepanel's own; keep the two extension folders identical.
if [ -f "$EXT/assets/theme.css" ] && [ -d "$EXT2/assets" ]; then
  cp "$EXT/assets/theme.css" "$EXT2/assets/theme.css"
  echo "theme  -> $EXT2/assets/theme.css"
fi
