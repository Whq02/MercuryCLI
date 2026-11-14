#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/instructions/** src/constants/prompts.ts src/prompt/** AGENTS.md
# gate-watch: src/bootstrap/state.ts src/mneme/mnemeFrontPage.ts src/tools.ts src/utils/cockpit/promptProvenance.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/config/projectConfig.ts src/utils/settings/types.ts
# gate-watch: src/Tool.ts src/context.ts src/utils/attachments/nestedMemory.ts src/utils/fileStateCache.ts src/tools/AgentTool/built-in/mercuryCrewAgent.ts
# gate-watch: scripts/lib/firstRunSeed.ts
# gate-watch: src/projectOnboardingState.ts src/utils/cockpit/repoSurfaceMap.ts src/utils/config/trust.ts
# gate-watch: src/components/mercury-ui/TrimChip.tsx
# gate-watch: docs/COMPATIBILITY.md src/utils/envUtils.ts
# gate-watch: src/utils/platform.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="bun"
fail=0
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-root-guide-composition.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-root-guide-composition.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-shared-guide-composition.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-shared-guide-composition.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-instruction-excludes.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-instruction-excludes.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-exclude-pattern-follows-links.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-exclude-pattern-follows-links.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-personal-guide-decides-nothing.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-personal-guide-decides-nothing.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-format-gemini.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-format-gemini.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-format-copilot.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-format-copilot.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-format-copilot-named-folders.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-format-copilot-named-folders.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-format-agent-folders.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-format-agent-folders.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-format-cursor.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-format-cursor.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-format-windsurf.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-format-windsurf.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-format-cline.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-format-cline.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-format-claude-code.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-format-claude-code.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-rule-imports-keep-scope.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-rule-imports-keep-scope.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-other-tools-listing.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-other-tools-listing.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-attached-files-are-listed.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-attached-files-are-listed.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-other-tools-refresh.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-other-tools-refresh.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-instruction-modules-load-alone.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-instruction-modules-load-alone.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-orient-keeps-what-loads.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-orient-keeps-what-loads.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-other-tools-hidden-characters.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-other-tools-hidden-characters.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-formats-page-names-what-is-read.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-formats-page-names-what-is-read.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-other-tools-cost-nothing-where-absent.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-other-tools-cost-nothing-where-absent.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-instruction-file-not-a-regular-file.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-instruction-file-not-a-regular-file.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-personal-files-by-import.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-personal-files-by-import.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-import-line-backslashes.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-import-line-backslashes.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-project-local-owner.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-project-local-owner.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-instruction-capture.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-instruction-capture.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-capture-doctrine.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-capture-doctrine.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-effective-size.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-effective-size.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-static-section-names.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-static-section-names.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-nested-external-imports.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-nested-external-imports.ts" "$__t" "$__rc"
BOM_HOME="$(mktemp -d "${TMPDIR:-/tmp}/native-bom-home.XXXXXX")"
for model in claude-fable-5 claude-opus-5 claude-sonnet-5; do
  MERCURY_CONFIG_DIR="$BOM_HOME" "$BUN" run scripts/self-hosting/bom.ts --model "$model" --mode interactive >/dev/null 2>&1 || { echo "BOM smoke FAILED for $model"; fail=1; }
done
MERCURY_CONFIG_DIR="$BOM_HOME" "$BUN" run scripts/self-hosting/bom.ts --model claude-fable-5 --mode subagent >/dev/null 2>&1 || { echo "BOM smoke FAILED for subagent mode"; fail=1; }
rm -rf "$BOM_HOME"
exit "$fail"
