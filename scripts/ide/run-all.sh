#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/changeTransaction/receipts* src/services/dap/dapClient*
# gate-watch: src/services/dap/debugpyResolver* src/services/ide/** src/services/lsp/**
# gate-watch: src/services/resources/adapters/ide* src/services/resources/adapters/test*
# gate-watch: src/services/resources/registry* src/services/run/**
# gate-watch: src/services/vulcan/vulcanClient* src/services/workshop/pythonRuntime*
# gate-watch: src/tools/DebugTool/DebugTool* src/tools/LSPTool/mercuryOps*
# gate-watch: src/tools/LaunchTool/LaunchTool* src/tools/TestTool/TestTool* src/utils/**
# IDE plane — proof harness.
# The IDE-plane provers live HERE. Runs every scripts/ide/prove-*.ts via bun run;
# non-zero exit on any failure. Machine-dependent legs (a healthy Python
# interpreter for the debugpy journey) skip LOUDLY with the exact missing
# prerequisite — never silently. run-all-suites.sh auto-joins this suite via
# its scripts/*/run-all.sh glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# ide — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL IDE PROOFS PASS"; else echo "# ❌ SOME IDE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
