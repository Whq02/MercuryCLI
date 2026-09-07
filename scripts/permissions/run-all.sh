#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/Tool* src/hooks/toolPermission/handlers/interactiveHandler*
# gate-watch: src/tools/PushNotificationTool/PushNotificationTool* src/tools/SkillTool/SkillTool*
# gate-watch: src/utils/betas* src/utils/hooks/** src/utils/messages/streaming*
# gate-watch: src/utils/permissions/classifierFailClosed* src/utils/permissions/denialTracking*
# gate-watch: src/utils/permissions/flowBlockReview* src/utils/permissions/decision/wrapper*
# gate-watch: src/utils/messages/rejectionText* src/components/permissions/PermissionRuleExplanation* src/constants/prompts*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Permission ladder / auto-mode — proof suite"
echo "############################################################"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "$bun" run "$f" || fail=1; prover_mark "$f" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PERMISSION PROOFS PASS"; else echo "# ❌ SOME PERMISSION PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
