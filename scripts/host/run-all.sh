#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/services/host/** src/commands/llmhost/** src/services/llmHost/** src/components/LlmHostDialog.tsx
# gate-watch: src/services/providers/providerSecrets.ts src/services/providers/openaicompat/** docs/LLM-HOST.md
# gate-watch: src/daemon/main.ts src/entrypoints/cli.tsx src/cli/run.ts src/services/projectServices/**
# gate-watch: scripts/lib/settingsPopupHarness.ts scripts/providers/lib/llmhostFixture.ts scripts/streaming/artifactArena.ts scripts/lib/captureDriver.ts scripts/ui/gridToPng.ts
# gate-watch: src/utils/messageQueueManager.ts src/utils/model/capabilities.ts src/utils/settings/changeDetector.ts
# gate-watch: src/ink.ts src/state/AppState.tsx src/components/design-system/ThemeProvider.tsx src/components/SettingsPopupSlot.tsx src/utils/cockpit/settingsPopup.ts
# gate-watch: assets/host/recipes.json assets/host/weights.json src/substrate/flagRegistry.ts src/services/privateChannel/channelCore.ts package.json
# gate-watch: src/services/host/vendors/** scripts/host/vastFixture.mjs scripts/host/lambdaFixture.mjs scripts/host/prove-vendors.ts
# gate-watch: scripts/host/prove-door-drive.ts src/services/host/door.ts src/utils/model/modelPickerGroups.ts src/commands/model/mercuryModel.tsx src/components/MercuryModelPicker.tsx
# gate-watch: src/services/engine-connector/focusedConnector.ts src/services/engine-connector/noSessionConnector.ts
# gate-watch: scripts/host/prove-vendor-road-drive.ts src/services/host/index.ts src/services/host/door.ts src/services/host/worker.ts src/services/host/store.ts src/services/host/cluster.ts src/services/host/jobs.ts src/services/host/tune.ts
# gate-watch: src/commands/host/** src/main.tsx src/services/concourse/workerModels.ts scripts/host/boxFixture.mjs scripts/host/boxDaemonProof.ts
# gate-watch: scripts/lib/firstRunSeed.ts src/Tool.ts src/daemon/controlSocket.ts src/services/providers/credentialEnvSpellings.ts src/utils/config.ts src/utils/config/globalConfig.ts src/utils/messages.ts src/utils/sessionStorage/paths.ts src/utils/systemPromptType.ts
# gate-watch: src/types/message.ts src/utils/messages/pairing.ts scripts/host/trillionKimiFixture.ts src/utils/settings/settingsCache.ts
# gate-watch: src/utils/settings/modelFacts.ts src/utils/settings/settings.ts scripts/host/prove-host-tune.ts scripts/host/runpodFixture.mjs
set -euo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
bun "$ROOT/scripts/host/prove-host-cleanup.ts"
bun "$ROOT/scripts/host/prove-pod-image-path.ts"
bun "$ROOT/scripts/host/prove-host-notice-before-turn.ts" --bundle "$ROOT/dist/mercury.mjs"
bun "$ROOT/scripts/host/prove-host-completion.ts"
bun "$ROOT/scripts/host/prove-vendors.ts"
bun "$ROOT/scripts/host/prove-vendor-road-drive.ts" --bundle "$ROOT/dist/mercury.mjs"
bun "$ROOT/scripts/host/prove-door-drive.ts"
bun "$ROOT/scripts/host/prove-door-tune-drive.ts"
bun "$ROOT/scripts/host/prove-door-seams-drive.ts"
bun "$ROOT/scripts/host/prove-mercury-host.ts" --bundle "$ROOT/dist/mercury.mjs"
bun "$ROOT/scripts/host/prove-mercury-host-drive.ts"
bun "$ROOT/scripts/host/prove-trillion-tier.ts"
bun "$ROOT/scripts/host/prove-host-launch.ts"
bun "$ROOT/scripts/host/prove-recipes-live.ts"
bun "$ROOT/scripts/host/prove-fast-load-drive.ts"
bun "$ROOT/scripts/host/prove-host-tune.ts"
bun "$ROOT/scripts/host/prove-host-rent-drive.ts" --bundle "$ROOT/dist/mercury.mjs"
bun "$ROOT/scripts/host/prove-rent-model-first-drive.ts" --bundle "$ROOT/dist/mercury.mjs"
exec bun "$ROOT/scripts/host/prove-host-job-drive.ts" --bundle "$ROOT/dist/mercury.mjs"
bun "$ROOT/scripts/host/prove-door-drive.ts" --bundle "$ROOT/dist/mercury.mjs"
