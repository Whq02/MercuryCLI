#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/changeTransaction/receipts* src/services/dap/dapClient*
# gate-watch: src/services/dap/debugpyResolver* src/services/ide/** src/services/lsp/**
# gate-watch: src/services/resources/adapters/ide* src/services/resources/adapters/test*
# gate-watch: src/services/resources/registry* src/services/run/**
# gate-watch: src/services/vulcan/vulcanClient* src/services/workshop/pythonRuntime*
# gate-watch: src/tools/DebugTool/DebugTool* src/tools/LSPTool/mercuryOps*
# gate-watch: src/tools/LaunchTool/LaunchTool* src/tools/TestTool/TestTool* src/utils/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
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
