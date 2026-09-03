#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/utils/runtime/** src/entrypoints/cli*
# gate-watch: scripts/release/** .github/workflows/** package.json .node-version build.ts
# gate-watch: src/**
# scripts/node-runtime/run-all.sh — the Node 24 LTS runtime contract.
# One policy owner, one calibration pin, the entry gate on every route, every
# launcher checking the FULL range, every projection mechanical
#
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
root="$(cd "$root/.." && pwd)"
cd "$root" || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "── Node 24 LTS runtime-contract proofs ──"
for prover in prove-node-policy prove-entry-gate prove-compile-cache prove-win32-console prove-windows-seams prove-spawn-window-discipline prove-copy-truth prove-workflow-toolchain prove-field-findings-exit-writes prove-broken-pipe-uniform; do
  echo ""
  echo "▶ $prover"
  __t=$SECONDS; "$BUN" run "$here/$prover.ts" || fail=1; prover_mark "$here/$prover.ts" "$__t"
done

# The compact artifact qualification on THIS (supported) runtime — the same
# harness gate.yml drives with the calibration Node + the real Node-22 leg.
if [[ -f "$root/dist/mercury.mjs" ]]; then
  echo ""
  echo "▶ qualify-artifact (expect-supported, ambient node)"
  bash "$here/qualify-artifact.sh" "$root/dist/mercury.mjs" expect-supported || fail=1
else
  echo "  [SKIP] dist/mercury.mjs absent — the pooled gate prebuilds it"
fi

if [[ "$fail" == "0" ]]; then
  echo ""
  echo "✅ node-runtime suite pass"
  exit 0
fi
echo ""
echo "❌ node-runtime suite FAILED"
exit 1
