#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: scripts/streaming/ptydrive.py scripts/streaming/screengrab.py
# gate-watch: src/components/LiveStreamingTail* src/components/Markdown* src/ink/**
# gate-watch: src/state/AppState* src/utils/**
# gate-watch: scripts/lib/* scripts/ui/vshot.py src/components/Message.tsx src/components/Messages.tsx
# gate-watch: src/daemon/concourseWorkers.ts src/daemon/sessionSeat.ts src/ink.ts src/screens/Chat.tsx
# gate-watch: src/services/engine-connector/* src/services/providers/streamIdleBudget.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/services/tools/chantGuard.ts
# gate-watch: src/services/engine-connector/daemon/tail.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── FLUX terminal-fluidity proofs ──"
claimed=$(cd "$here/../.." && cat scripts/streaming-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
for f in "$here"/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$f")" && continue
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
if [[ "$fail" == "0" ]]; then echo "✅ FLUX SUITE GREEN"; exit 0; else
  echo "❌ FLUX SUITE RED"; exit 1; fi
