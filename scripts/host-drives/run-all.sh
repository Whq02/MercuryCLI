#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/lib/runnerHost.ts
# gate-watch: src/boot/entrypoints/cli.tsx src/boot/main.tsx
# gate-watch: docs/LLM-HOST.md src/commands/llmhost/**
# gate-watch: src/commands/model/picker/MercuryModelPicker.tsx src/daemon/control/main.ts src/daemon/runner/runHeadless.ts src/engine/message-shapes/message.ts
# gate-watch: assets/host/recipes.json assets/host/weights.json package.json
# gate-watch: scripts/host/vastFixture.mjs scripts/host/lambdaFixture.mjs scripts/host/prove-vendors.ts src/engine/messages/wirePairing.ts
# gate-watch: scripts/host/hfEndpointsFixture.mjs scripts/host/prove-hf-endpoints.ts src/models/facts/modelPickerGroups.ts src/models/hosting/** src/models/roads/huggingface/**
# gate-watch: scripts/host/prove-door-drive.ts src/models/roads/openaicompat/** src/models/sign-in/flow-cards/HuggingfaceConnect.tsx
# gate-watch: scripts/host/prove-vendor-road-drive.ts
# gate-watch: scripts/host/boxFixture.mjs scripts/host/boxDaemonProof.ts src/models/tensorfold/contracts.ts
# gate-watch: scripts/host/trillionKimiFixture.ts src/platform/settings/modelFacts.ts src/screen/keys/**
# gate-watch: scripts/host/prove-host-tune.ts src/screen/overlays/overlayHooks.tsx
# gate-watch: scripts/host/hfFixture.mjs scripts/host/prove-hf-recipes.ts scripts/host/prove-host-search-drive.ts src/screen/renderer/**
# gate-watch: scripts/host/prove-host-bank-drive.ts scripts/host/prove-llmhost-qc-drive.ts
# gate-watch: scripts/host/prove-host-wheel-drive.ts src/screen/widgets/menuFold.tsx src/tools/engines/project-services/**
# gate-watch: scripts/host/measure-recipe.ts scripts/host/prove-measure-recipe.ts scripts/host/prove-frontier-roster.ts
# gate-watch: scripts/lib/hermetic.ts vendor/** vendor/node.lock.json
# gate-watch: .github/workflows/engine-image.yml assets/host/llamacpp-engine.json scripts/lib/generated-assets-map.mjs
# gate-watch: scripts/host/prove-tensorfold-recipe-script.ts scripts/host/prove-tensorfold-pod-road.ts scripts/host/prove-tensorfold-rent-drive.ts scripts/host/fixtures/tensorfold-1.3.4-linux-x86_64.tar.gz.sha256 scripts/host/fixtures/tensorfold-1.3.4-linux-aarch64.tar.gz.sha256
# gate-watch: scripts/lib/observed_walk.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/host-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'host-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members host-drives 'scripts/host/$name' "$here/members.txt"
