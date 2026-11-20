#!/bin/bash
# install-alef-live: point ~/.alef-loop/bin/alef-live at scripts/alef-live in the LIVE checkout.
#
# alef-live used to exist only as a hand-edited file on one Mac (the 2026-10-26 SIGKILL-escalation and
# fail-loudly-on-deploy patch had no copy anywhere else). It now lives in this repo, and the installed
# path is a symlink into ~/.alef-live, the same checkout alef-watchdog.sh already runs from. So the script
# reaches a Mac the way every other change does: merge, then `alef-live deploy`.
#
# Why ~/.alef-live and not the dev checkout: the watchdog calls alef-live from launchd, and a launchd job
# that touches ~/Documents can get EPERM from macOS privacy controls. A deploy that checks out a new
# commit replaces scripts/alef-live with a new file, so the copy bash is already running keeps its old inode.
#
# Order on a Mac: merge -> `alef-live deploy` (the old script moves ~/.alef-live to the merge) -> this.
# Refuses while the live checkout has no scripts/alef-live, so it can never install a dangling link.
# An existing regular file is kept as alef-live.pre-repo-<date> beside the link. Idempotent.
set -euo pipefail
LIVE="$HOME/.alef-live"
SRC="$LIVE/scripts/alef-live"
DEST="$HOME/.alef-loop/bin/alef-live"

if [ ! -f "$SRC" ]; then
  echo "install-alef-live: $SRC does not exist yet. Run 'alef-live deploy' first so ~/.alef-live has it." >&2
  exit 1
fi
mkdir -p "$(dirname "$DEST")"
if [ -L "$DEST" ] && [ "$(readlink "$DEST")" = "$SRC" ]; then
  echo "install-alef-live: already linked: $DEST -> $SRC"
  exit 0
fi
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  backup="$DEST.pre-repo-$(date +%Y%m%d-%H%M%S)"
  mv "$DEST" "$backup"
  echo "install-alef-live: kept the old one as $backup"
  if [ -f "$backup" ] && ! cmp -s "$backup" "$SRC"; then
    echo "install-alef-live: NOTE the old file differs from the repo copy: diff $backup $SRC" >&2
  fi
fi
ln -s "$SRC" "$DEST"
echo "install-alef-live: linked $DEST -> $SRC"
