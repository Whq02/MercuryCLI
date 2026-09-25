#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/** mercury-skills/** src/skills/bundled/** src/skills/bundledSkills*
# gate-watch: src/utils/permissions/filesystem* scripts/skills/**
# gate-watch: src/Tool.ts src/bootstrap/state.ts src/commands.ts src/extensions/load/contributions.ts
# gate-watch: src/hooks/useSkillsChange.ts src/services/engine-connector/rosterTerms.ts
# gate-watch: src/services/instructions/sourceText.ts src/services/kitMenu/kitCatalogue.ts
# gate-watch: src/services/mcp/sessionKitPin.ts src/skills/* src/tools/AgentTool/loadAgentsDir.ts
# gate-watch: src/tools/SkillTool/* src/utils/* src/utils/attachments/skillListing.ts
# gate-watch: src/utils/cockpit/substrateSnapshot.ts src/utils/config/globalConfig.ts
# gate-watch: src/utils/messages/attachmentText.ts src/utils/messages/rejectionText.ts
# gate-watch: src/utils/processUserInput/processSlashCommand.tsx src/utils/skills/skillChangeDetector.ts
# gate-watch: src/utils/suggestions/commandSuggestions.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in scripts/skills/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ SKILLS SUITE GREEN"; else echo "❌ SKILLS SUITE RED"; fi
exit "$fail"
