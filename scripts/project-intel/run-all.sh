#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/project-intel/**
# gate-watch: src/services/projectIntel/** src/services/resources/adapters/project.ts
# gate-watch: src/utils/cockpit/repoSurfaceMap*
# gate-watch: src/bootstrap/state.ts src/commands/orient/orient.ts
# gate-watch: src/components/messages/nullRenderingAttachments.ts src/services/lsp/manager.ts
# gate-watch: src/services/primitives/owner.ts src/services/resources/adapters/transcript.ts
# gate-watch: src/services/resources/registry.ts src/services/run/resolveOwner.ts
# gate-watch: src/services/run/runContinuationCapsule.ts src/tools/GrepTool/GrepTool.ts
# gate-watch: src/utils/attachments/contextCapsule.ts src/utils/attachments/orchestrator.ts
# gate-watch: src/utils/messages/attachmentText.ts src/utils/processUserInput/processUserInput.ts
# gate-watch: src/utils/sessionStorage/paths.ts src/utils/verification/verificationState.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Project intelligence — proof suite"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROJECT-INTEL PROOFS PASS"; else echo "# ❌ SOME PROJECT-INTEL PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
