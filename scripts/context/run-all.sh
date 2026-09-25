#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/Tool* src/services/compact/** src/services/lsp/manager* src/services/run/**
# gate-watch: src/utils/config/** src/utils/messages/** src/utils/cockpit/contextUsageLive*
# gate-watch: src/utils/cockpit/ctxForecast* src/utils/swarm/inProcessRunner.ts src/utils/toolResultStorage.ts
# gate-watch: scripts/lib/fixtureApi.ts src/commands/fullscreen/fullscreen.tsx
# gate-watch: src/commands/model/mercuryModel.tsx src/components/* src/constants/prompts.ts
# gate-watch: src/prompt/mercuryContract.ts src/services/providers/openai/openaiCallModel.ts
# gate-watch: src/services/providers/openaicompat/compatChatCallModel.ts
# gate-watch: src/services/providers/openaicompat/compatChatClient.ts src/services/tokenEstimation.ts
# gate-watch: src/utils/* src/utils/cockpit/contextGauge.ts src/utils/cockpit/quota.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# context — context-lifecycle proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit $fail
