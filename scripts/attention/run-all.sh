#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/attention/**
# gate-watch: src/services/attention/** src/services/workbench/** src/input-core/**
# gate-watch: src/utils/sideQuestion.ts src/services/acp/** src/components/tasks/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# attention — the operator command surface"
echo "############################################################"

claimed=$(cat scripts/attention-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$proof") || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done

for journey in "$here"/journey-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$journey")"; then continue; fi
  [ -e "$journey" ] || continue
  echo
  echo "── $(basename "$journey") (machine-gated) ──"
  __t=$SECONDS
  (cd "$repo" && "$bun" run "$journey")
  got=$?; __rc=$got
  prover_mark "$journey" "$__t" "$__rc"
  if [ "$got" != "0" ]; then
    echo "❌ $(basename "$journey") exited $got"
    fail=1
  fi
done

for repro in "$here"/repro-journey-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$repro")"; then continue; fi
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$repro") || { __rc=$?; fail=1; }; prover_mark "$repro" "$__t" "$__rc"
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ attention PASS"; else echo "# ❌ attention FAILED"; fi
echo "############################################################"
exit "$fail"
