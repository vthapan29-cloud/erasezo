#!/bin/sh
# Mirrors the whole extension into the unpacked copy next to it.
#
# There are two identical copies of this extension on disk: Erasezo-extension,
# which is the one under version control and the one to edit, and 1.1.2_0,
# which is what gets loaded unpacked. Nothing kept them in step, so a change
# to one silently left the other behind — which is how 1.1.2_0 ended up
# serving a Control Room two contrast fixes old, and how a manifest fix could
# ship to the tracked copy while the loaded copy still had the old one.
#
# sync-design.sh and sync-admin.sh each copy their own few files; this copies
# everything, so it is the one to run after touching the manifest, the page
# scripts or the bundle. test/extension.test.js fails if the two drift.
set -e
WEB="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$WEB/../Erasezo-extension}"
DEST="${2:-$WEB/../1.1.2_0}"

[ -d "$SRC" ]  || { echo "no source: $SRC";  exit 1; }
[ -d "$DEST" ] || { echo "no destination: $DEST"; exit 1; }

# --delete so a file removed upstream does not linger in the loaded copy.
# .git and the review-graph cache belong to their own folder, not to the build.
rsync -a --delete \
  --exclude '.git/' --exclude '.DS_Store' --exclude '.code-review-graph/' \
  "$SRC"/ "$DEST"/

echo "extension -> $DEST"
