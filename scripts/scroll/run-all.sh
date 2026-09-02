#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/hooks/useVirtualScroll* src/ink/components/ScrollBox*
# gate-watch: src/components/ScrollKeybindingHandler* src/components/VirtualMessageList*
# ============================================================================
#  scripts/scroll/run-all.sh — the transcript scroll-model travel suite.
#  Real-binary PageUp journeys over a resumed synthetic session: settled
#  travel is row-exact in real content rows (the content-coordinate paging
#  law). Globs prove-*.ts so future scroll proofs auto-join.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in scripts/scroll/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ SCROLL SUITE GREEN"; else echo "❌ SCROLL SUITE RED"; fi
exit "$fail"
