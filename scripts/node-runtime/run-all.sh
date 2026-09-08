#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/utils/runtime/** src/entrypoints/cli*
# gate-watch: scripts/release/** .github/workflows/** package.json .node-version build.ts
# gate-watch: src/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

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
  __t=$SECONDS; __rc=0; "$BUN" run "$here/$prover.ts" || { __rc=$?; fail=1; }; prover_mark "$here/$prover.ts" "$__t" "$__rc"
done

if [[ -f "$root/dist/mercury.mjs" ]]; then
  echo ""
  echo "▶ qualify-artifact (expect-supported, ambient node)"
  bash "$here/qualify-artifact.sh" "$root/dist/mercury.mjs" expect-supported || { __rc=$?; fail=1; }
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
