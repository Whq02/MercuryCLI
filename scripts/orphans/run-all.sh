#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/orphans/** build.ts src/entrypoints/**
# gate-watch: src/substrate/flagRegistry.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo "── orphans: $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$proof") || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
if [[ "$fail" == "0" ]]; then echo "✅ ORPHANS SUITE GREEN"; exit 0; else
  echo "❌ ORPHANS SUITE RED"; exit 1; fi
