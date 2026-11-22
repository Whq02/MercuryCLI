#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/host/**
# gate-watch: scripts/lib/fixtureApi.ts scripts/lib/runnerHost.ts
# gate-watch: src/services/host/** src/commands/llmhost/**
# gate-watch: src/services/providers/openaicompat/** docs/LLM-HOST.md
# gate-watch: src/daemon/main.ts src/entrypoints/cli.tsx src/cli/run.ts src/services/projectServices/**
# gate-watch: assets/host/weights.json package.json
# gate-watch: src/services/host/vendors/**
# gate-watch: scripts/host/prove-hf-endpoints.ts src/services/providers/huggingface/** src/components/HuggingfaceConnect.tsx src/keybindings/**
# gate-watch: scripts/host/prove-door-drive.ts src/utils/model/modelPickerGroups.ts src/components/MercuryModelPicker.tsx
# gate-watch: scripts/host/prove-vendor-road-drive.ts
# gate-watch: src/main.tsx scripts/host/boxDaemonProof.ts
# gate-watch: src/types/message.ts src/services/messages/pairing.ts scripts/host/trillionKimiFixture.ts
# gate-watch: src/utils/settings/modelFacts.ts scripts/host/prove-host-tune.ts
# gate-watch: scripts/host/prove-hf-recipes.ts scripts/host/prove-host-search-drive.ts src/components/mercury-ui/menuFold.tsx
# gate-watch: scripts/host/prove-host-wheel-drive.ts src/context/overlayContext.tsx src/ink/**
# gate-watch: scripts/host/measure-recipe.ts scripts/host/prove-measure-recipe.ts scripts/host/prove-frontier-roster.ts
# gate-watch: scripts/lib/hermetic.ts vendor/** vendor/node.lock.json
# gate-watch: .github/workflows/engine-image.yml assets/host/llamacpp-engine.json scripts/lib/generated-assets-map.mjs
# gate-watch: scripts/host/prove-tensorfold-recipe-script.ts scripts/host/prove-tensorfold-pod-road.ts scripts/host/prove-tensorfold-rent-drive.ts scripts/host/fixtures/tensorfold-1.3.3-linux-x86_64.tar.gz.sha256 scripts/host/fixtures/tensorfold-1.3.3-linux-aarch64.tar.gz.sha256 src/services/tensorfold/contracts.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/host-2"
fail=0
drive_members host-2 'scripts/host/$name' "$here/members.txt" || fail=1
if [ "$fail" = "0" ]; then echo "✅ host-2 suite GREEN"; else echo "❌ host-2 suite RED"; fi
exit "$fail"
