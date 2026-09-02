#!/usr/bin/env bash
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
