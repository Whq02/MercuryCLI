#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/boot/entrypoints/cli.tsx src/boot/main.tsx
# gate-watch: docs/LLM-HOST.md src/commands/llmhost/**
# gate-watch: src/commands/model/picker/MercuryModelPicker.tsx src/daemon/control/main.ts src/daemon/runner/* src/engine/message-shapes/message.ts
# gate-watch: scripts/lib/captureDriver.ts
# gate-watch: src/engine/messages/wirePairing.ts
# gate-watch: src/models/facts/modelPickerGroups.ts src/models/hosting/** src/models/roads/huggingface/**
# gate-watch: src/models/roads/openaicompat/** src/models/sign-in/flow-cards/HuggingfaceConnect.tsx
# gate-watch: src/models/tensorfold/contracts.ts
# gate-watch: src/platform/settings/modelFacts.ts src/screen/keys/**
# gate-watch: src/screen/overlays/overlayHooks.tsx
# gate-watch: src/screen/renderer/**
# gate-watch: src/screen/widgets/menuFold.tsx src/tools/engines/project-services/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/host"
fail=0
drive_members host 'scripts/host/$name' "$here/members.txt" || fail=1
if [ "$fail" = "0" ]; then echo "✅ host suite GREEN"; else echo "❌ host suite RED"; fi
exit "$fail"
