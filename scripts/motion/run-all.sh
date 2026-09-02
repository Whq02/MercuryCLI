#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/ink/hooks/** src/ink/components/MotionParkContext.ts src/components/FullscreenLayout.tsx src/components/mercury-ui/components.tsx src/utils/cockpit/presenceLive.ts src/hooks/useArrowKeyHistory.tsx src/components/PromptInput/** assets/splash/**
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── motion proofs ──"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$f" || fail=1; prover_mark "$f" "$__t"
done
if [[ "$fail" == "0" ]]; then echo "✅ MOTION SUITE GREEN"; exit 0; else
  echo "❌ MOTION SUITE RED"; exit 1; fi
