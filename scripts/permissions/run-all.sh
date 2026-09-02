#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/Tool* src/hooks/toolPermission/handlers/interactiveHandler*
# gate-watch: src/tools/PushNotificationTool/PushNotificationTool* src/tools/SkillTool/SkillTool*
# gate-watch: src/utils/betas* src/utils/hooks/** src/utils/messages/streaming*
# gate-watch: src/utils/permissions/classifierFailClosed* src/utils/permissions/denialTracking*
# gate-watch: src/utils/permissions/flowBlockReview* src/utils/permissions/decision/wrapper*
# gate-watch: src/utils/messages/rejectionText* src/components/permissions/PermissionRuleExplanation* src/constants/prompts*
# ============================================================================
#  scripts/permissions/run-all.sh — the permission ladder / auto-mode proof suite.
#
#  The auto-mode classifier path (permissions.ts mode==='auto') is WIRED LIVE for
#  the fork and a real behavior change, but had no regression coverage. `bun run
#  typecheck` is strict (AGENTS.md); the proof suites are the behavioural gate.
#  This suite covers:
#  the 4 auto-mode safety floors, isAutoModeAllowlistedTool name/action gating,
#  the denialTracking limits, and the remote 'disabled' kill-switch.
#
#  Also the permissions & commit-safety group (gated DEFAULT-OFF, opt-in):
#  the classifier fail-closed guard (MERCURY_CLASSIFIER_FAIL_CLOSED), the standalone
#  commit gate (MERCURY_COMMIT_GATE), and PushNotification honest-delivery.
#
#  Auto-joins the top-level gate via scripts/run-all-suites.sh's scripts/*/run-all.sh
#  glob. Non-zero exit on any fail.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Permission ladder / auto-mode — proof suite"
echo "############################################################"
# Glob, not an explicit list: 4 of 9 provers (classifier-fallback, mcp-roots-
# wide, skill-readonly-safe, temperature-gate) sat ORPHANED because this list
# wasn't updated when they landed — one of them silently pinned a call site
# New prove-*.ts auto-join.
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "$bun" run "$f" || fail=1; prover_mark "$f" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PERMISSION PROOFS PASS"; else echo "# ❌ SOME PERMISSION PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
