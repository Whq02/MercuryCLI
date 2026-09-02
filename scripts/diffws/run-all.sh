#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: scripts/ui/vshot.py src/components/mercuryPalette* src/utils/sessionStoragePortable*
# ============================================================================
#  scripts/diffws/run-all.sh — split from the ui suite (interaction-finish
# the /diff review workspace + cockpit pointer PTY proofs
#  outgrew ui's per-suite watchdog inside one suite (ui hit the 900s
#  tree-kill) — the POOLED gate prefers more, smaller suites: gate
#  wall-clock is max(suite), not sum. Globs prove-*.ts so future proofs
#  auto-join.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in scripts/diffws/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ DIFFWS SUITE GREEN"; else echo "❌ DIFFWS SUITE RED"; fi
exit "$fail"
