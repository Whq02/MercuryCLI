#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/interview/**
# gate-watch: src/tools/AskUserQuestionTool/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: src/utils/messages/attachmentText.ts
# gate-watch: scripts/engine-durability/harness.ts scripts/lib/captureDriver.ts
# gate-watch: scripts/streaming/artifactArena.ts
# gate-watch: src/components/CustomSelect/* src/components/mercury-ui/glyphs.ts
# gate-watch: src/input-core/composer-document.ts src/services/acp/** src/services/interview/*
# gate-watch: src/substrate/flagRegistry.ts src/substrate/storeRecovery.ts src/utils/*
# gate-watch: src/utils/messages/rejectionText.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: scripts/lib/hermetic.ts src/Tool.ts src/services/providers/gemini/geminiCodec.ts src/services/providers/openai/responsesBridge.ts src/services/providers/zai/zaiCodec.ts src/services/schema/jsonSchemaEngine.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/interview-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'interview-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members interview-drives 'scripts/interview/$name' "$here/members.txt"
