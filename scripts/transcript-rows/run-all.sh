#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/ink/** src/utils/cockpit/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── transcript-rows proofs ──"
claimed=$(cat scripts/transcript-rows-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for f in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$f")"; then continue; fi
  [ -e "$f" ] || continue
  __t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$f" || fail=1; prover_mark "$f" "$__t"
done
if [[ "$fail" == "0" ]]; then echo "✅ TRANSCRIPT-ROWS SUITE GREEN"; exit 0; else
  echo "❌ TRANSCRIPT-ROWS SUITE RED"; exit 1; fi
