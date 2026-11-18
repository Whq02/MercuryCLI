#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/ink/hooks/** src/ink/components/MotionParkContext.ts src/components/FullscreenLayout.tsx src/components/mercury-ui/components.tsx src/hooks/useArrowKeyHistory.tsx src/components/PromptInput/** assets/splash/**
# gate-watch: scripts/lib/captureDriver.ts scripts/streaming/artifactArena.ts
# gate-watch: src/utils/cockpit/greetingShimmer.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── motion proofs ──"
claimed=$(cd "$here/../.." && members_cat scripts/motion-*/members.txt)
for f in "$here"/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$f")" && continue
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
if [[ "$fail" == "0" ]]; then echo "✅ MOTION SUITE GREEN"; exit 0; else
  echo "❌ MOTION SUITE RED"; exit 1; fi
