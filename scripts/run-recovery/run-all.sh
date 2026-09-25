#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/run-core/** src/services/run/** src/substrate/** src/services/primitives/**
# gate-watch: src/cli/headless/** src/utils/sessionStorage/** src/query.ts
# gate-watch: src/utils/sessionRestore.ts src/utils/conversationRecovery.ts src/utils/toolResultSummary.ts src/utils/cockpit/awaySummary.ts
# gate-watch: scripts/lib/firstRunSeed.ts scripts/lib/fixtureApi.ts scripts/sessionStorage/forkedFixture.ts
# gate-watch: src/Tool.ts src/bootstrap/state.ts src/cli/print.ts src/constants/prompts.ts
# gate-watch: src/constants/systemPromptSections.ts src/daemon/controlSocket.ts src/daemon/warmRunner.ts
# gate-watch: src/services/engine-connector/daemonConnector.ts
# gate-watch: src/services/providers/anthropic/boundPrefixRecord.ts src/services/providers/toolEconomy.ts
# gate-watch: src/state/AppStateStore.ts src/tools/RecordConventionTool/prompt.ts
# gate-watch: src/tools/RememberLessonTool/prompt.ts src/tools/TaskCreateTool/constants.ts src/types/ids.ts
# gate-watch: src/utils/* src/utils/config/globalConfig.ts src/utils/messages/factories.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# MERCURY run-recovery — cross-domain integration lane"
echo "############################################################"

shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$BUN" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ run-recovery SUITE OK"; else echo "# ❌ run-recovery SUITE FAILED"; fi
echo "############################################################"
exit "$fail"
