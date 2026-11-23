#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/tools/engines/eval-kernels/** src/tools/eval/**
# gate-watch: src/integrations/samples/**
# gate-watch: src/integrations/event-hooks/answer.ts src/integrations/event-hooks/background.ts src/integrations/event-hooks/commandRunner.ts src/integrations/event-hooks/contextBound.ts src/integrations/event-hooks/contract.ts src/integrations/event-hooks/fileChangedWatcher.ts src/integrations/event-hooks/fire.ts src/integrations/event-hooks/hookEvents.ts src/integrations/event-hooks/hooksConfigManager.ts src/integrations/event-hooks/hooksConfigSnapshot.ts src/integrations/event-hooks/hooksSettings.ts src/integrations/event-hooks/matcherGrammar.ts src/integrations/event-hooks/matching.ts src/integrations/event-hooks/registerFrontmatterHooks.ts src/integrations/event-hooks/rows.ts src/integrations/event-hooks/runnerRegistry.ts src/integrations/event-hooks/sessionHooks.ts src/integrations/event-hooks/toolPermission.ts src/integrations/event-hooks/wait.ts
# gate-watch: src/permissions/rules/PermissionRule.ts src/permissions/rules/PermissionUpdateSchema.ts src/permissions/rules/askClock.ts src/permissions/rules/askWords.ts src/permissions/rules/bashRuleVerdict.ts src/permissions/rules/bypassPermissionsKillswitch.ts src/permissions/rules/capabilityGate.ts src/permissions/rules/commandContent.ts src/permissions/rules/dangerousPatterns.ts src/permissions/rules/decision/** src/permissions/rules/decisionReasonWire.ts src/permissions/rules/filesystem.ts src/permissions/rules/flowLaw.ts src/permissions/rules/flowPolicy.ts src/permissions/rules/getNextPermissionMode.ts src/permissions/rules/lateAllowRules.ts src/permissions/rules/modeTransitions.ts src/permissions/rules/ownGround.ts src/permissions/rules/pathValidation.ts src/permissions/rules/permissionDoor.ts src/permissions/rules/permissionFocus.ts src/permissions/rules/permissionMode.ts src/permissions/rules/permissionResult.ts src/permissions/rules/permissionRuleParser.ts src/permissions/rules/permissionSetup.ts src/permissions/rules/permissionUpdate.ts src/permissions/rules/permissionsLoader.ts src/permissions/rules/protectedPaths.ts src/permissions/rules/rootNotice.ts src/permissions/rules/ruleBraces.ts src/permissions/rules/ruleReason.ts src/permissions/rules/runtimeProtection.ts src/permissions/rules/safeWrappers.ts src/permissions/rules/serviceInputHistory.ts src/permissions/rules/shadowedRuleDetection.ts src/permissions/rules/shell-protected-paths/** src/permissions/rules/shellProtectedPaths.ts src/permissions/rules/shellRuleMatching.ts src/permissions/rules/uncPath.ts src/permissions/rules/webFetchRuleMatches.ts src/permissions/rules/windowsPath.ts
# gate-watch: src/engine/connector/daemonConnector.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/eval"
fail=0
echo "############################################################"
echo "# eval kernels — proof harness"
echo "############################################################"
drive_members eval 'scripts/eval/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL EVAL PROOFS PASS"; else echo "# ❌ SOME EVAL PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
