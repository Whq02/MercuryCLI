#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/workbench/** src/services/resources/adapters/workbench.ts
# gate-watch: src/services/acp/**
# gate-watch: src/utils/artifacts/** src/components/diff/** src/components/prompts-panel/**
# gate-watch: LICENSE.md NOTICE
# gate-watch: src/cli/run.ts
# gate-watch: src/services/mcp/client.ts src/services/run/*
# gate-watch: src/utils/*
# gate-watch: scripts/idiom/prove-body-shape-registry.ts src/fabric/validate.ts
# gate-watch: src/utils/attachments/mentionResolvers.ts src/utils/attachments/types.ts
# gate-watch: src/utils/messages/attachmentText.ts
# gate-watch: src/rows/* src/runner/wire/* src/tools/AskUserQuestionTool/**
# gate-watch: scripts/lib/ptyRecorder.ts src/components/ConsoleOAuthFlow.tsx src/components/loginFamilyRows.ts src/ink.ts src/ink/instances.ts
# gate-watch: src/services/engine-connector/midTurnText.ts src/utils/sessionStorage/*
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"

prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

bun=${BUN:-$HOME/.bun/bin/bun}
cd "$(dirname "$0")/../.." || exit 1

red=0
claimed=$(cat scripts/editor-bridge-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
for proof in scripts/editor-bridge/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")" && continue
  echo "== $proof"
  __t=$SECONDS; __rc=0; if ! { "$bun" run "$proof"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "RED: $proof"
    red=1
  fi
  prover_mark "$proof" "$__t" "$__rc"
done

exit "$red"
