#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/session-graph/**
# gate-watch: src/services/attention/** src/services/attention/relations.ts
# gate-watch: src/services/workbench/** src/services/acp/** src/input-core/composer-document.ts
# gate-watch: src/utils/artifacts/** src/utils/sideQuestion.ts src/utils/tabula/minerva.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# session-graph — the living-crew lane"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$proof") || fail=1; prover_mark "$proof" "$__t"
done

for repro in "$here"/repro-*.ts; do
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$repro") || fail=1; prover_mark "$repro" "$__t"
done

if [ "${CONSTELLATION_CLOSE_ARC:-0}" = "1" ]; then
  for runner in "$here"/run-journeys.ts "$here"/run-sensitivity.ts; do
    echo
    echo "── $(basename "$runner") (close-arc lane) ──"
    (cd "$repo" && "$bun" run "$runner") || fail=1
  done
fi

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ session-graph PASS"; else echo "# ❌ session-graph FAILED"; fi
echo "############################################################"
exit "$fail"
