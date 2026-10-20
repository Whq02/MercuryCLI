#!/usr/bin/env bash
# gate-class: drives
# gate-watch: src/services/host/** src/commands/llmhost/** src/services/llmHost/** src/components/LlmHostDialog.tsx
# gate-watch: src/services/providers/providerSecrets.ts src/services/providers/openaicompat/** docs/LLM-HOST.md
# gate-watch: scripts/lib/settingsPopupHarness.ts scripts/providers/lib/llmhostFixture.ts scripts/streaming/artifactArena.ts scripts/lib/captureDriver.ts scripts/ui/gridToPng.ts
# gate-watch: src/ink.ts src/state/AppState.tsx src/components/design-system/ThemeProvider.tsx src/components/SettingsPopupSlot.tsx src/utils/cockpit/settingsPopup.ts
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec bun "$ROOT/scripts/host/prove-host-rent-drive.ts" --bundle "$ROOT/dist/mercury.mjs"
