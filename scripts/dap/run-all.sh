#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/dap/dapClient* src/services/run/ownerKey*
# gate-watch: scripts/dap/prove-dap-dart-flutter.ts scripts/dap/prove-dap-codelldb.ts scripts/dap/prove-dap-php.ts scripts/dap/prove-dap-bash.ts
# gate-watch: src/services/dap/optionalAdapters.ts src/services/dap/adapterInstallConsent.ts vendor/dap-adapters.lock.json
# gate-watch: src/extensions/installConsent.ts src/extensions/bundled/shared/install.mjs
# gate-watch: src/services/run/ownerLifecycle* src/tools/DebugTool/DebugTool*
# gate-watch: src/services/lsp/clangdLane* src/services/lsp/mercuryLsp*
# gate-watch: src/services/dap/debugpyResolver.ts src/services/dap/unityAdapter.ts
# gate-watch: src/services/lsp/builtinServers.ts src/services/resources/adapters/execution.ts
# gate-watch: src/services/run/resolveOwner.ts src/tools/DebugTool/UI.tsx src/utils/* src/services/providers/toolCallGate.ts src/tools/DebugTool/prompt.ts
# gate-watch: src/Tool.ts src/guards/guards.ts src/tools/BashTool/BashTool.tsx src/bootstrap/state.ts src/utils/config/globalConfig.ts src/utils/config/trust.ts src/utils/permissions/filesystem.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# dap — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL DAP PROOFS PASS"; else echo "# ❌ SOME DAP PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
