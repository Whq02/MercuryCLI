#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_PROOF_DIST
# gate-watch: src/bootstrap/state* src/services/mcp/** src/state/AppState* src/utils/Shell*
# gate-watch: src/utils/config/** src/utils/mcp/elicitationValidation*
# gate-watch: src/cli/handlers/mcp.tsx src/commands/mcp/* src/components/mcp/* src/utils/redactHeaders.ts
# gate-watch: scripts/lib/hermetic.ts src/services/vulcan/engine/leases.ts src/tools/AgentTool/runAgent.ts
# gate-watch: src/components/MCPServerApprovalDialog.tsx src/components/MCPServerMultiselectDialog.tsx src/services/mcpServerApproval.tsx src/utils/projectConfig.ts src/commands/mcp/route.ts
# gate-watch: src/utils/env.ts src/utils/staticRender.tsx src/ink/components/TerminalSizeContext.tsx
# gate-watch: assets/splash/splash-core.mjs package.json scripts/daemon/dupline-world.ts
# gate-watch: scripts/lib/firstRunSeed.ts scripts/lib/scriptedTurn.ts scripts/lib/rows.ts src/utils/readiness.ts src/utils/cockpit/mcpGauge.ts
# gate-watch: src/rows/* src/runner/wire/* sdk/src/** src/cli/mcpServer.ts src/cli/headless/projectQuery.ts src/main.tsx scripts/sdk/compatRoadFixture.ts scripts/sdk/runtime.ts scripts/provider-compat/fixtures/engineRules.mjs
# gate-watch: scripts/lib/seatDoor.ts scripts/lib/mcpInProcess.ts scripts/lib/settingsPopupHarness.ts
# gate-watch: scripts/providers/lib/llmhostFixture.ts scripts/ui/gridToPng.ts
# gate-watch: src/cli/run.ts scripts/lib/fixtureApi.ts src/utils/settings/settings.ts
# gate-watch: src/utils/messages/outsideReport.ts src/utils/sessionStorage/paths.ts src/daemon/concourseDispatch.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# MCP hardening — proof harness"
echo "############################################################"
shopt -s nullglob
claimed=$(cat scripts/mcp-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MCP PROOFS PASS"; else echo "# ❌ SOME MCP PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
