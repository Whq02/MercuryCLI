#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/utils/config.ts src/utils/worktree.ts
# gate-watch: src/daemon/** src/substrate/flagRegistry* src/types/permissions* src/components/SwitchboardTagBar.tsx
# gate-watch: src/utils/boxLock* src/services/resources/adapters/health*
# gate-watch: src/services/engine-connector/seatProjections* src/utils/spawnLedger* docs/DURABILITY.md
# gate-watch: src/tools/MonitorTool/** src/tools/ScheduleCronTool/** src/utils/cron.ts src/services/engine-connector/seatWire.ts
# gate-watch: src/cli/headless/turnDriver* src/cli/headless/runnerAsks.ts src/cli/run* src/services/saturn/** src/tools/ScheduleWakeupTool/**
# gate-watch: docs/SESSIONS.md scripts/dap/mock-dap-adapter.mjs scripts/journey/switch-fixture-server.ts
# gate-watch: scripts/lib/* scripts/staleness/prove-stale-registry.ts
# gate-watch: scripts/streaming/turn-end-fixture-server.ts
# gate-watch: scripts/ops/deploy-runtime.sh scripts/ops/launcher-mercury.sh scripts/ops/deploy-launcher.sh scripts/splash/deploy.sh docs/TERMINAL-RUNTIME.md
# gate-watch: src/utils/healthReport.ts src/cli/update.ts src/services/privateChannel/installLayout.ts src/services/privateChannel/vendoredRuntime.ts package.json
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: scripts/lib/seatDoor.ts
# gate-watch: src/services/engine-connector/daemonConnector.ts src/services/engine-connector/seatLive.ts src/components/Spinner/liveCounterWords.ts src/components/Spinner/spinnerHud.ts src/components/Spinner/SpinnerAnimationRow.tsx
# gate-watch: src/tasks/LocalAgentTask/* src/input-core/* src/state/AppState*
# gate-watch: src/services/providers/openaicompat/compatAccounts.ts src/services/providers/openaicompat/compatCatalogue.ts src/services/providers/openaicompat/compatAdapter.ts src/services/providers/providerDiscovery.ts src/services/concourse/workerModels.ts src/services/switchboard/bootBirthFacts.ts src/utils/auth.ts
# gate-watch: src/services/switchboard/sessionReceipts.ts src/utils/sessionStorage/paths.ts src/commands/restart/* src/tasks/LocalShellTask/*
# gate-watch: scripts/providers/lib/llmhostFixture.ts scripts/provider-compat/fixtures/engineRules.mjs
# gate-watch: src/services/providers/providerSecrets.ts src/utils/settings/settingsCache.ts
# gate-watch: src/components/BootSaturnScreen.tsx src/utils/staticRender.tsx
# gate-watch: src/services/providers/local/** src/services/providers/routeLaw.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury daemon — proof harness"
echo "############################################################"
claimed=$(cat scripts/daemon-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
dupes=$(printf '%s\n' "$claimed" | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "❌ daemon: prover(s) named by TWO sibling member lists (a double run across shards):"
  printf '%s\n' "$dupes" | sed 's/^/    /'
  fail=1
fi
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")" && continue
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL DAEMON PROOFS PASS"; else echo "# ❌ SOME DAEMON PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
