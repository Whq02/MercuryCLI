#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/formal-models/**
# gate-watch: src/services/interview/** scripts/interview/prove-resume-bounds.ts
# gate-watch: src/substrate/flagRegistry.ts scripts/orphans/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# formal-models — production reachability + state-integrity closure"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$proof") || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done

for repro in "$here"/repro-*.ts; do
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$repro") || { __rc=$?; fail=1; }; prover_mark "$repro" "$__t" "$__rc"
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ formal-models PASS"; else echo "# ❌ formal-models FAILED"; fi
echo "############################################################"
exit "$fail"
