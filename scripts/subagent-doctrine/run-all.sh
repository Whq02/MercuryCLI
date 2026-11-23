#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/update-notes/changelog.ts src/commands/update-notes/changelogArchive.ts src/engine/message-shapes/messageTags.ts src/engine/message-shapes/noContentMessage.ts src/engine/requests/querySource.ts src/engine/system-prompt/defaultSystemPrompt.ts src/engine/system-prompt/systemPromptSections.ts src/engine/tasks/local-agent/agentMessage.ts src/models/roads/attributionHeader.ts src/models/roads/betaHeaders.ts src/models/roads/localPromptProfile.ts src/models/roads/mediaLimits.ts src/models/sign-in/credentials/credentialEnvSpellings.ts src/models/sign-in/oauth/oauth.ts src/platform/primitives/localIsoDate.ts src/platform/product/legalNotice.ts src/platform/product/product.ts src/screen/spinner/spinnerVerbs.ts src/screen/spinner/turnCompletionVerbs.ts src/screen/theme/rowGlyphs.ts src/tools/crewmate/subagentDoctrine.ts src/tools/kit/crewmateBarredTools.ts src/tools/kit/names/** src/tools/kit/toolLimits.ts src/tools/read/binaryExtensions.ts
# gate-watch: src/engine/run-owner/ownerScopedStore.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/subagent-doctrine"
root="$(pwd)"
dist="$root/dist/mercury.mjs"
fail=0
echo "############################################################"
echo "# Subagent/agent doctrine — proof harness"
echo "############################################################"

drive_members subagent-doctrine 'scripts/subagent-doctrine/$name' "$here/members.txt" || fail=1

echo ""
echo "── dist-grep: the doctrine ships in the built product (string literals) ──"
if [ ! -f "$dist" ]; then
  echo "  [WARN] $dist not built — run 'bun run build.ts' first; skipping dist-greps"
else
  grep_ship() {
    local n; n=$(grep -Fc -- "$2" "$dist" 2>/dev/null || true)
    if [ "${n:-0}" -ge 1 ]; then echo "  [PASS] $1 (x$n)"; else echo "  [FAIL] $1 — not found in dist"; fail=1; fi
  }
  grep_ship "NORMAL subagent doctrine ships"            "one of Mercury's agents, "
  grep_ship "the clause after the seat ships"           ", spawned for one assignment, whose caller reads only the output you return"
  grep_ship "the one seat word ships"                   "a crewmate"
fi

echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL SUBAGENT-DOCTRINE PROOFS PASS"; else echo "# ❌ SOME PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
