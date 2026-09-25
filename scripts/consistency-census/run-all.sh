#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/consistency-census/** src/constants/systemPromptSections.ts
# gate-watch: src/utils/worktree.ts src/utils/cache/cacheClock.ts scripts/release/payloadContract.mjs
# gate-watch: scripts/lib/git.ts scripts/lib/executionProfile.ts scripts/lib/captureDriver.ts
# gate-watch: assets/splash/mercury-splash.mjs src/bootstrap/state.ts src/commands/mouse/mouse.ts
# gate-watch: src/components/* src/components/PromptInput/PromptInput.tsx
# gate-watch: src/components/PromptInput/promptIntent.ts src/components/Spinner/SpinnerAnimationRow.tsx
# gate-watch: src/components/mercury-ui/assets.tsx src/components/mercury-ui/components.tsx
# gate-watch: src/constants/prompts.ts src/entrypoints/cli.tsx src/fabric/entryCodec.ts src/fabric/ordinal.ts
# gate-watch: src/ink/ink.tsx src/services/dap/dapClient.ts src/services/dap/debugpyResolver.ts
# gate-watch: src/services/privateChannel/channelCore.ts src/services/workContexts/workContexts.ts
# gate-watch: src/state/selectors.ts src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/runAgent.ts
# gate-watch: src/tools/WorkflowTool/agentHooks.ts src/utils/* src/utils/cockpit/critterData.ts
# gate-watch: src/utils/messages/systemMessages.ts src/utils/model/modelTransition.ts
# gate-watch: src/utils/sessionStorage/chain.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/consistency-census/prove-*.ts; do
  echo "── consistency-census: $(basename "$f")"
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done

exit "$failed"
