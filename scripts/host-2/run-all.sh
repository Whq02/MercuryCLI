#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/host/**
# gate-watch: scripts/lib/fixtureApi.ts scripts/lib/runnerHost.ts
# gate-watch: src/boot/entrypoints/cli.tsx src/boot/main.tsx
# gate-watch: docs/LLM-HOST.md src/commands/llmhost/**
# gate-watch: src/commands/model/picker/MercuryModelPicker.tsx src/daemon/control/main.ts src/daemon/runner/runHeadless.ts src/engine/message-shapes/message.ts
# gate-watch: assets/host/weights.json package.json
# gate-watch: src/engine/messages/wirePairing.ts
# gate-watch: scripts/host/prove-hf-endpoints.ts src/models/facts/modelPickerGroups.ts src/models/hosting/** src/models/roads/huggingface/**
# gate-watch: scripts/host/prove-door-drive.ts src/models/roads/openaicompat/** src/models/sign-in/flow-cards/HuggingfaceConnect.tsx
# gate-watch: scripts/host/prove-vendor-road-drive.ts
# gate-watch: scripts/host/boxDaemonProof.ts src/models/tensorfold/contracts.ts
# gate-watch: scripts/host/trillionKimiFixture.ts src/platform/settings/modelFacts.ts src/screen/keys/**
# gate-watch: scripts/host/prove-host-tune.ts src/screen/overlays/overlayHooks.tsx
# gate-watch: scripts/host/prove-hf-recipes.ts scripts/host/prove-host-search-drive.ts src/screen/renderer/**
# gate-watch: scripts/host/prove-host-wheel-drive.ts src/screen/widgets/menuFold.tsx src/tools/engines/project-services/**
# gate-watch: scripts/host/measure-recipe.ts scripts/host/prove-measure-recipe.ts scripts/host/prove-frontier-roster.ts
# gate-watch: scripts/lib/hermetic.ts vendor/** vendor/node.lock.json
# gate-watch: .github/workflows/engine-image.yml assets/host/llamacpp-engine.json scripts/lib/generated-assets-map.mjs
# gate-watch: scripts/host/prove-tensorfold-recipe-script.ts scripts/host/prove-tensorfold-pod-road.ts scripts/host/prove-tensorfold-rent-drive.ts scripts/host/fixtures/tensorfold-1.3.3-linux-x86_64.tar.gz.sha256 scripts/host/fixtures/tensorfold-1.3.3-linux-aarch64.tar.gz.sha256
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/host-2"
fail=0
drive_members host-2 'scripts/host/$name' "$here/members.txt" || fail=1
if [ "$fail" = "0" ]; then echo "✅ host-2 suite GREEN"; else echo "❌ host-2 suite RED"; fi
exit "$fail"
