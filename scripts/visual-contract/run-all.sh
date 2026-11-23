#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: assets/splash/** src/screen/composer/usePasteHandler.ts
# gate-watch: src/screen/widgets/**
# gate-watch: README.md scripts/lib/captureDriver.ts
# gate-watch: scripts/ui/render-tui.ts scripts/ui/vshot.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/visual-contract"
fail=0

echo "############################################################"
echo "# visual-contract — the frontier presentation & interaction lane"
echo "############################################################"

drive_members visual-contract 'scripts/visual-contract/$name' "$here/members.txt" || fail=1

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ visual-contract PASS"; else echo "# ❌ visual-contract FAILED"; fi
echo "############################################################"
exit "$fail"
