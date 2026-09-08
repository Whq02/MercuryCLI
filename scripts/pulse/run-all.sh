#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/Spinner/** src/ink/** src/utils/pulse/**
# gate-watch: src/utils/router/providers/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "── MERCURY PULSE proofs ──"

bash "$here/spinner/run-all.sh" || { __rc=$?; fail=1; }

for f in "$here"/matrix/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "$BUN" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done

if [[ "$fail" == "0" ]]; then echo "✅ PULSE SUITE GREEN"; exit 0; else
  echo "❌ PULSE SUITE RED"; exit 1; fi
