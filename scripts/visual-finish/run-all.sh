#!/usr/bin/env bash
# gate-class: pty
# gate-watch: assets/splash/**
# gate-watch: src/screen/renderer/frame-writer.ts
# gate-watch: src/screen/widgets/assets.tsx src/screen/widgets/focalRamp.ts src/screen/theme/glyphs.ts src/screen/widgets/splashRuns.ts
# gate-watch: src/screen/theme/mercuryPalette.ts src/screen/renderer/colorize.ts src/screen/theme/mercuryTokens.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/visual-finish"
fail=0

echo "############################################################"
echo "# visual-finish — the visual-finish lane"
echo "############################################################"

drive_members visual-finish 'scripts/visual-finish/$name' "$here/members.txt" || fail=1

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ visual-finish PASS"; else echo "# ❌ visual-finish FAILED"; fi
echo "############################################################"
exit "$fail"
