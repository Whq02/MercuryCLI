#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/attachments/**
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── context-assembly proofs ──"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-attachments-parity.ts" || fail=1; prover_mark "$here/prove-attachments-parity.ts" "$__t"
if [[ "$fail" == "0" ]]; then echo "✅ ATTACHMENTS SUITE GREEN"; exit 0; else
  echo "❌ ATTACHMENTS SUITE RED"; exit 1; fi
