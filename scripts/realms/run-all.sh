#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/realmRegistry*
# ============================================================================
#  scripts/realms/run-all.sh — the realms launcher/system suite.
#  Pins the registry contracts (home-rooted trust, revocation-only removal,
#  closed-set per-realm accounts) and the END-TO-END launch/auth proof on the
#  real binary. Globs prove-*.ts; auto-joins the green gate.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in scripts/realms/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ REALMS SUITE GREEN"; else echo "❌ REALMS SUITE RED"; fi
exit "$fail"
