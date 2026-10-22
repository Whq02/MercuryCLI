#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: package.json scripts/release/launcherTemplates.mjs src/services/privateChannel/installLayout.ts tsconfig.json
# gate-watch: sdk/** sdk-py/** src/rows/** src/cli/run.ts src/cli/sessionArgs.ts src/cli/structuredIO.ts src/cli/headless/refusalEnvelope.ts
# gate-watch: src/runner/wire/** src/utils/permissions/PermissionMode.ts src/utils/permissions/PermissionUpdateSchema.ts src/utils/lazySchema.ts
# gate-watch: src/main.tsx src/types/permissions.ts src/utils/effortLadder.ts
# gate-watch: src/types/message.ts src/utils/deadline.ts src/utils/lazySchema.ts src/components/mercury-ui/glyphs.ts src/ink/stringWidth.ts src/ink/wrap-text.ts src/ink/wrapAnsi.ts src/utils/intl.ts src/utils/sliceAnsi.ts src/utils/truncate.ts
# gate-watch: scripts/lib/fixtureApi.ts scripts/lib/firstRunSeed.ts scripts/lib/generated-assets-map.mjs scripts/gate/generated-assets.tsv scripts/provider-compat/fixtures/engineRules.mjs scripts/providers/lib/llmhostFixture.ts src/services/providers/providerSecrets.ts src/utils/settings/settingsCache.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# sdk — TypeScript and Python: build, drift, run, runner and testing"
echo "############################################################"
[ -d "$here/../../sdk/src" ] || { echo "the SDK is parked and not on this tree (the published lineage carries no sdk/): nothing to prove here"; exit 0; }
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  echo
  echo "── $(basename "$f") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit $fail
