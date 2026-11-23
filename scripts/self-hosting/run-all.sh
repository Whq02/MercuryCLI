#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/engine/system-prompt/apolloMode.ts src/engine/system-prompt/behaviourContract.ts src/engine/system-prompt/composer.ts src/engine/system-prompt/mercuryContract.ts src/engine/system-prompt/recordedComposition.ts
# gate-watch: src/screen/cockpit/repoSurfaceMap.ts src/platform/config/trust.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/self-hosting"
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="bun"
fail=0
drive_members self-hosting 'scripts/self-hosting/$name' "$here/members.txt" '' run || fail=1
BOM_HOME="$(mktemp -d "${TMPDIR:-/tmp}/native-bom-home.XXXXXX")"
for model in claude-fable-5 claude-opus-5 claude-sonnet-5; do
  MERCURY_CONFIG_DIR="$BOM_HOME" "$BUN" run scripts/self-hosting/bom.ts --model "$model" --mode interactive >/dev/null 2>&1 || { echo "BOM smoke FAILED for $model"; fail=1; }
done
MERCURY_CONFIG_DIR="$BOM_HOME" "$BUN" run scripts/self-hosting/bom.ts --model claude-fable-5 --mode subagent >/dev/null 2>&1 || { echo "BOM smoke FAILED for subagent mode"; fail=1; }
rm -rf "$BOM_HOME"
exit "$fail"
