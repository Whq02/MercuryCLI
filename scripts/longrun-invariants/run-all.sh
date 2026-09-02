#!/usr/bin/env bash
# gate-class: pty
set -uo pipefail

prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

BUN="${BUN:-$HOME/.bun/bin/bun}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail=0
for proof in "$DIR"/prove-*.ts; do
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; if ! "$BUN" run "$proof"; then
    fail=1
  fi
  prover_mark "$proof" "$__t"
done

if [ "$fail" -eq 0 ]; then
  echo "✅ longrun-invariants suite green"
else
  echo "❌ longrun-invariants suite RED"
fi
exit "$fail"
