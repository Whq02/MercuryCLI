#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/model/computedDefault* src/utils/accounts/signInLedger*
# ============================================================================
#  scripts/default-model/run-all.sh — the computed-default suite: the
#  provider-neutral default (the newest usable row of the provider of the
#  most recent sign-in) and the sign-in ledger it orders by. Globs
#  prove-*.ts so new legs auto-join; the suite auto-joins the green gate
#  (scripts/run-all-suites.sh globs scripts/*/run-all.sh).
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in scripts/default-model/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ DEFAULT-MODEL SUITE GREEN"; else echo "❌ DEFAULT-MODEL SUITE RED"; fi
exit "$fail"
