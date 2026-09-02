#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/remember/index* src/commands/remember/remember*
# gate-watch: src/memdir/**
# gate-watch: src/tools/RememberLessonTool/RememberLessonTool*
# gate-watch: src/utils/evolution/evolutionLedger* src/utils/evolution/ledgerScan*
# gate-watch: src/utils/frontmatterParser* src/utils/sanitization*
# gate-watch: src/utils/cockpit/traceSnapshot*
# Experience-card memory extension — proof harness. Globs prove-*.ts so EVERY
# memory proof (and any new one) joins the gate automatically — the explicit list
# had drifted to 3 of 8 (remember-command/tool, card-dedup, cards-browser, memory-
# flock were unregistered). Non-zero exit on any fail.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Experience-card memory extension — proof harness"
echo "############################################################"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "$bun" run "$f" || fail=1; prover_mark "$f" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MEMORY PROOFS PASS"; else echo "# ❌ SOME MEMORY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
