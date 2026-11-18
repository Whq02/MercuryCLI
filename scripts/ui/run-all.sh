#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/tools/FileReadTool/** src/tools/FileWriteTool/**
# gate-watch: src/screens/Chat.tsx src/services/engine-connector/** src/guards/** src/query/stopHooks.ts src/cli/run.ts src/services/mission/**
# gate-env: MERCURY_UI_BILLED MERCURY_LOGINS_COPY_KEEP MERCURY_LOGINS_COPY_FRAMES MERCURY_RENDER_CWD MERCURY_CARD_FIT_CAPTURE_DIR MERCURY_MODE_BAND_DRIVE_CAPTURE_DIR
# gate-watch: src/commands/appearance/index* src/commands/health/HealthCertificate*
# gate-watch: src/commands/run/runInspectorModel* src/commands/feedback/** src/commands/exit/exit.tsx
# gate-watch: src/commands/crew/index* src/components/** src/context/overlayContext*
# gate-watch: src/context/overlayStack* src/daemon/** src/hooks/useCwdState* src/hooks/useFocusedWorkspaceCwd* src/ink/**
# gate-watch: src/context/notifications*
# gate-watch: src/services/anthropicLimits*
# gate-watch: src/utils/ripgrep.ts src/hooks/fileSuggestions.ts
# gate-watch: src/services/rateLimitMessages* src/services/run/**
# gate-watch: scripts/providers/anthropicAccountsFixture.ts
# gate-watch: src/substrate/bootNotes*
# gate-watch: src/types/logs* src/utils/**
# gate-watch: design-system/readme.md docs/ENGINES.md mercury-skills/provider-apis/SKILL.md
# gate-watch: scripts/cockpit-interaction/prove-action-graph.ts
# gate-watch: scripts/critters/prove-critter-mini-drive.ts
# gate-watch: scripts/engine-durability/harness.ts
# gate-watch: scripts/ink-runtime/prove-viewport-clamp.ts
# gate-watch: scripts/lib/*
# gate-watch: scripts/ops/launcher-mercury.sh
# gate-watch: scripts/search/lib/bundle-for-node.ts
# gate-watch: src/commands/config/config.tsx src/commands/login/login.tsx src/commands/usage/usage.tsx
# gate-watch: src/services/providers/anthropic/anthropicCatalogue.ts src/services/wallet/identityWords.ts
# gate-watch: src/services/switchboard/capacityCheck.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/components/mercury-ui/CritterArt.tsx
# gate-watch: src/services/engine-connector/queuedNotices.ts src/tasks/LocalAgentTask/LocalAgentTask.tsx src/input-core/command-queue.ts
# gate-watch: src/types/message.ts src/tools/BashTool/BashTool.tsx
# gate-watch: scripts/host/runpodFixture.mjs scripts/providers/lib/llmhostFixture.ts
# gate-watch: src/cli/headless/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
claimed=$(cat scripts/ui-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
dupes=$(printf '%s\n' "$claimed" | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "❌ ui: prover(s) named by TWO sibling member lists (a double run across shards):"
  printf '%s\n' "$dupes" | sed 's/^/    /'
  fail=1
fi
globs=(scripts/ui/prove-*.ts)
[ "${UI_RENDER:-0}" = "1" ] && globs+=(scripts/ui/render-*.ts scripts/ui/render-*.tsx)
for f in "${globs[@]}"; do
  [ -e "$f" ] || continue
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$f")"; then continue; fi
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ UI SUITE GREEN"; else echo "❌ UI SUITE RED"; fi
exit "$fail"
