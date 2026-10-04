#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: sdk/** src/rows/** src/cli/run.ts src/cli/sessionArgs.ts src/cli/structuredIO.ts src/cli/headless/refusalEnvelope.ts
# gate-watch: src/main.tsx src/types/permissions.ts src/utils/effortLadder.ts
# gate-watch: scripts/lib/fixtureApi.ts scripts/lib/firstRunSeed.ts scripts/lib/generated-assets-map.mjs scripts/gate/generated-assets.tsv
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# sdk — the parked package: build, drift, the run door through it"
echo "############################################################"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  echo
  echo "── $(basename "$f") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit $fail
