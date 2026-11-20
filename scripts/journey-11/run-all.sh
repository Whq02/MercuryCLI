#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/journey/**
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/utils/sessionStoragePortable*
# gate-watch: src/guards/mission* src/services/mission/missionCard* src/utils/sessionRestore*
# gate-watch: src/services/providers/anthropic/** src/services/providers/toolEconomy.ts src/services/api/dumpPrompts.ts
# gate-watch: src/commands/model/mercuryModel.tsx src/ink.ts src/services/providers/catalogueEpoch.ts
# gate-watch: src/services/providers/gemini/geminiCatalogue.ts
# gate-watch: src/services/providers/huggingface/huggingfaceCatalogue.ts
# gate-watch: src/services/providers/local/localDiscovery.ts
# gate-watch: src/services/providers/moonshot/moonshotCatalogue.ts
# gate-watch: src/services/providers/openai/openaiCatalogue.ts
# gate-watch: src/services/providers/openrouter/openrouterCatalogue.ts src/services/providers/slotSwitch.ts
# gate-watch: src/state/AppState.tsx src/state/store.ts src/utils/auth.ts src/utils/config/globalConfig.ts
# gate-watch: src/utils/model/modelOptions.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/journey-11"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ journey-11: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
drive_members journey-11 'scripts/journey/$name' "$here/members.txt" '' run || failed=1

exit "$failed"
