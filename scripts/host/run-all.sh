#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/host/** src/commands/llmhost/**
# gate-watch: src/services/providers/openaicompat/** docs/LLM-HOST.md
# gate-watch: src/daemon/main.ts src/entrypoints/cli.tsx src/cli/run.ts src/services/projectServices/**
# gate-watch: scripts/lib/captureDriver.ts
# gate-watch: src/services/host/vendors/**
# gate-watch: src/services/providers/huggingface/** src/components/HuggingfaceConnect.tsx src/keybindings/**
# gate-watch: src/utils/model/modelPickerGroups.ts src/components/MercuryModelPicker.tsx
# gate-watch: src/main.tsx
# gate-watch: src/types/message.ts src/services/messages/pairing.ts
# gate-watch: src/utils/settings/modelFacts.ts
# gate-watch: src/components/mercury-ui/menuFold.tsx
# gate-watch: src/context/overlayContext.tsx src/ink/**
# gate-watch: src/services/tensorfold/contracts.ts
# gate-watch: src/cli/headless/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/host"
fail=0
drive_members host 'scripts/host/$name' "$here/members.txt" || fail=1
if [ "$fail" = "0" ]; then echo "✅ host suite GREEN"; else echo "❌ host suite RED"; fi
exit "$fail"
