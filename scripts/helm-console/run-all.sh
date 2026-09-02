#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/ui/render-tui.ts scripts/ui/vshot.py src/components/mercury-ui/glyphs*
# gate-watch: src/constants/spinnerVerbs* src/utils/cockpit/**
# Helm console — proof harness (the cockpit mini-REPL: store state machine,
# text shaping, cockpit/command wiring, hip-vocab promotion, and the PTY
# render leg). Non-zero exit on any fail. Explicit list — wire NEW proofs in
# here (the autocompact-verbatim-tail lesson: suites are explicit lists).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Helm console — proof harness"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-console-store.ts" || fail=1; prover_mark "$here/prove-console-store.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-console-text.ts" || fail=1; prover_mark "$here/prove-console-text.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-console-wiring.ts" || fail=1; prover_mark "$here/prove-console-wiring.ts" "$__t"
# The ask engine's slot law: an unset console answers the /submodels hint at
# zero cost; a pinned console rides its question with the stamped identity
# and its role; the sandbox boundary is pinned at the fork.
__t=$SECONDS; "$bun" run "$here/prove-console-ask.ts" || fail=1; prover_mark "$here/prove-console-ask.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-hip-vocab.ts" || fail=1; prover_mark "$here/prove-hip-vocab.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-console-render.ts" || fail=1; prover_mark "$here/prove-console-render.ts" "$__t"
if [ "$fail" -ne 0 ]; then
  echo "❌ helm-console suite: FAILURES"
  exit 1
fi
echo "✅ helm-console suite: ALL GREEN"
