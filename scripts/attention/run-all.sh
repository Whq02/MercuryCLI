#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/attention/**
# gate-watch: src/services/attention/** src/services/workbench/** src/input-core/**
# gate-watch: src/utils/sideQuestion.ts src/services/acp/** src/components/tasks/**
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# attention — the operator command surface"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$proof") || fail=1; prover_mark "$proof" "$__t"
done

for journey in "$here"/journey-*.ts; do
  [ -e "$journey" ] || continue
  echo
  echo "── $(basename "$journey") (machine-gated) ──"
  (cd "$repo" && "$bun" run "$journey")
  got=$?
  if [ "$got" = "3" ]; then
    echo "⏭  $(basename "$journey") SKIP — machine gate honoured"
  elif [ "$got" != "0" ]; then
    echo "❌ $(basename "$journey") exited $got (0 = pass, 3 = machine-gate SKIP)"
    fail=1
  fi
done

for repro in "$here"/repro-journey-*.ts; do
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$repro") || fail=1; prover_mark "$repro" "$__t"
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ attention PASS"; else echo "# ❌ attention FAILED"; fi
echo "############################################################"
exit "$fail"
