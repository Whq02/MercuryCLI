#!/usr/bin/env bash
# gate-class: pty
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"

prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

BUN="${BUN:-$HOME/.bun/bin/bun}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail=0
for proof in "$DIR"/prove-*.ts; do
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$proof"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    fail=1
  fi
  prover_mark "$proof" "$__t" "$__rc"
done

if [ "$fail" -eq 0 ]; then
  echo "✅ longrun-invariants suite green"
else
  echo "❌ longrun-invariants suite RED"
fi
exit "$fail"
