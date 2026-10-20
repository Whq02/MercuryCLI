#!/usr/bin/env bash
# gate-class: drives
# gate-watch: src/services/host/** src/commands/llmhost/** src/services/llmHost/** src/components/LlmHostDialog.tsx
# gate-watch: src/services/providers/providerSecrets.ts src/services/providers/openaicompat/** docs/LLM-HOST.md
# gate-watch: src/daemon/main.ts src/entrypoints/cli.tsx src/cli/run.ts src/services/projectServices/**
# gate-watch: scripts/lib/settingsPopupHarness.ts scripts/providers/lib/llmhostFixture.ts scripts/streaming/artifactArena.ts scripts/lib/captureDriver.ts scripts/ui/gridToPng.ts
# gate-watch: src/utils/messageQueueManager.ts src/utils/model/capabilities.ts src/utils/settings/changeDetector.ts
# gate-watch: src/ink.ts src/state/AppState.tsx src/components/design-system/ThemeProvider.tsx src/components/SettingsPopupSlot.tsx src/utils/cockpit/settingsPopup.ts
# gate-watch: assets/host/recipes.json src/substrate/flagRegistry.ts src/services/privateChannel/channelCore.ts package.json
# gate-watch: src/types/message.ts src/utils/messages/pairing.ts scripts/host/trillionKimiFixture.ts
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
bun "$ROOT/scripts/host/prove-trillion-tier.ts"
bun "$ROOT/scripts/host/prove-host-launch.ts"
bun "$ROOT/scripts/host/prove-recipes-live.ts"
bun "$ROOT/scripts/host/prove-host-rent-drive.ts" --bundle "$ROOT/dist/mercury.mjs"
bun "$ROOT/scripts/host/prove-rent-model-first-drive.ts" --bundle "$ROOT/dist/mercury.mjs"
exec bun "$ROOT/scripts/host/prove-host-job-drive.ts" --bundle "$ROOT/dist/mercury.mjs"
