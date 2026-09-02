#!/usr/bin/env bash
# deploy-launcher.sh — deploy the canonical launcher to the config home.
# scripts/ops/launcher-mercury.sh (repo) → <config-home>/bin/mercury
# (artifact), which ~/.local/bin/mercury symlinks. bash-syntax-checked
# before copy. R-1: the ~/.local/bin symlink is repointed by the operator in
# one deliberate command after `<home>/bin/mercury --version` verifies,
# never by this script (a script-side repoint would dangle the live
# `mercury` command mid-deploy).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib/mercury-home.sh"
src="$here/launcher-mercury.sh"
MERCURY_HOME="$(mercury_resolve_home)"
dst="$MERCURY_HOME/bin/mercury"
bash -n "$src"
mkdir -p "$MERCURY_HOME/bin"
cp "$src" "$dst"
chmod +x "$dst"
echo "deployed → $dst"
echo "repoint when verified:  ln -sf '$dst' ~/.local/bin/mercury"
