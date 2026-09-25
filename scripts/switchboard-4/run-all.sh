#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/switchboard/** scripts/switchboard-4/**
# gate-watch: src/services/concourse/** src/components/concourse/** src/daemon/concourseSupervisor.ts
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/prompt/engineIdentity.ts src/constants/prompts.ts
# gate-watch: docs/SESSIONS.md scripts/lib/firstRunSeed.ts scripts/lib/fixtureApi.ts src/commands.ts
# gate-watch: src/commands/clear/clear.ts src/commands/enablement.ts src/commands/retired.ts
# gate-watch: src/components/HelmLanesRail.tsx src/components/messages/TranscriptNameplate.tsx
# gate-watch: src/daemon/headlessRun.ts src/fabric/entryCodec.ts src/fabric/ordinal.ts
# gate-watch: src/hooks/useLogMessages.ts src/main.tsx src/screens/REPL.tsx
# gate-watch: src/services/engine-connector/daemonConnector.ts
# gate-watch: src/services/engine-connector/focusedConnector.ts src/services/switchboard/hopIntoSession.ts
# gate-watch: src/services/switchboard/launchAuthority.ts src/state/telemetryBus.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/processUserInput/processSlashCommand.tsx
# gate-watch: src/utils/sessionStorage/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/switchboard-4"

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/switchboard/$name"
  if [ ! -e "$f" ]; then
    echo "❌ switchboard-4: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── switchboard-4: $name"
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done < "$here/members.txt"

exit "$failed"
