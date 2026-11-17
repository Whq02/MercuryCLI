#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_BROWSER_CACHE_DIR
# gate-watch: src/services/browser/** src/tools/BrowserTool/** src/commands/browser/**
# gate-watch: scripts/browser/**
# gate-watch: scripts/lib/executionProfile.ts scripts/lib/provisionManagedBrowser.ts src/Tool.ts
# gate-watch: scripts/lib/removeScratch.ts scripts/lib/nodeBin.ts
# gate-watch: src/components/permissions/BrowserPermissionRequest/BrowserPermissionRequest.tsx
# gate-watch: src/components/permissions/PermissionRequest.tsx src/services/run/ownerLifecycle.ts
# gate-watch: src/services/run/resolveOwner.ts src/tools/AgentTool/runAgent.ts
# gate-watch: src/utils/permissions/decision/engine.ts src/utils/subprocessEnv.ts
# gate-watch: src/services/run/ownerKey.ts src/utils/model/modelTransition.ts
# gate-watch: src/components/CustomSelect/select.tsx src/keybindings/useKeybinding.ts src/utils/staticRender.tsx
# gate-watch: src/state/AppState.tsx src/state/AppStateStore.ts src/state/store.ts
# gate-watch: docs/BROWSER.md
# gate-watch: scripts/lib/firstRunSeed.ts scripts/lib/fixtureApi.ts src/services/providers/toolCallGate.ts
# gate-watch: src/utils/permissions/filesystem.ts src/utils/platform.ts
# gate-watch: scripts/vendor/patches/puppeteer-core@25.9.0.patch
# gate-watch: src/daemon/roster.ts scripts/lib/runnerHost.ts scripts/lib/scratchSeat.ts scripts/lib/seatLauncher.ts
# gate-watch: src/substrate/flagRegistry.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# browser — the driving surface suite"
echo "############################################################"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  echo ""
  echo "== $name =="
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "RED: $name"
    fail=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done
exit "$fail"
