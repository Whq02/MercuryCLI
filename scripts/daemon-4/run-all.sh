#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/daemon/**
# gate-watch: src/types/permissions*
# gate-watch: src/utils/boxLock* src/services/resources/adapters/health*
# gate-watch: docs/DURABILITY.md
# gate-watch: src/tools/MonitorTool/** src/tools/ScheduleCronTool/** src/utils/cron.ts
# gate-watch: src/cli/headless/turnDriver* src/cli/headless/runnerAsks.ts src/cli/run* src/services/saturn/** src/tools/ScheduleWakeupTool/**
# gate-watch: scripts/dap/mock-dap-adapter.mjs
# gate-watch: scripts/lib/* scripts/staleness/prove-stale-registry.ts
# gate-watch: scripts/streaming/turn-end-fixture-server.ts
# gate-watch: scripts/ops/deploy-runtime.sh scripts/ops/launcher-mercury.sh scripts/ops/deploy-launcher.sh scripts/splash/deploy.sh docs/TERMINAL-RUNTIME.md
# gate-watch: src/utils/healthReport.ts src/cli/update.ts src/services/privateChannel/installLayout.ts src/services/privateChannel/vendoredRuntime.ts package.json
# gate-watch: src/rows/*
# gate-watch: src/components/Spinner/liveCounterWords.ts src/components/Spinner/spinnerHud.ts src/components/Spinner/SpinnerAnimationRow.tsx
# gate-watch: src/tasks/LocalAgentTask/* src/input-core/* src/state/AppState*
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/daemon-4"

fail=0
names=()
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  names+=("$name")
done < "$here/members.txt"
if [ "${#names[@]}" -eq 0 ]; then
  echo "❌ daemon-4: $here/members.txt names no prover — an empty slice is a red, never a vacuous green"
  fail=1
fi
for name in ${names[@]+"${names[@]}"}; do
  f="scripts/daemon/$name"
  if [ ! -e "$f" ]; then
    echo "❌ daemon-4: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    fail=1
    continue
  fi
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit "$fail"
