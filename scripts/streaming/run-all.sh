#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: scripts/streaming/ptydrive.py scripts/streaming/screengrab.py
# gate-watch: src/components/LiveStreamingTail* src/components/Markdown* src/ink/**
# gate-watch: src/state/AppState* src/utils/**
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── FLUX terminal-fluidity proofs ──"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$f" || fail=1; prover_mark "$f" "$__t"
done
if [[ "$fail" == "0" ]]; then echo "✅ FLUX SUITE GREEN"; exit 0; else
  echo "❌ FLUX SUITE RED"; exit 1; fi
