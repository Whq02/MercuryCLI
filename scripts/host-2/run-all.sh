#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/host/**
# gate-watch: src/utils/envUtils.ts src/services/providers/huggingface/huggingfaceAccounts.ts
# gate-watch: scripts/lib/fixtureApi.ts scripts/lib/runnerHost.ts src/input-core/command-queue.ts src/utils/messages/noticeRows.ts
# gate-watch: src/services/host/** src/commands/llmhost/** src/services/llmHost/** src/components/LlmHostDialog.tsx
# gate-watch: src/services/providers/providerSecrets.ts src/services/providers/openaicompat/** docs/LLM-HOST.md
# gate-watch: src/daemon/main.ts src/entrypoints/cli.tsx src/cli/run.ts src/services/projectServices/**
# gate-watch: scripts/lib/settingsPopupHarness.ts scripts/providers/lib/llmhostFixture.ts scripts/lib/captureDriver.ts scripts/ui/gridToPng.ts
# gate-watch: src/utils/messageQueueManager.ts src/utils/model/capabilities.ts src/utils/settings/changeDetector.ts
# gate-watch: src/ink.ts src/state/AppState.tsx src/components/design-system/ThemeProvider.tsx src/components/SettingsPopupSlot.tsx src/utils/cockpit/settingsPopup.ts
# gate-watch: assets/host/recipes.json assets/host/weights.json src/substrate/flagRegistry.ts src/services/privateChannel/channelCore.ts package.json
# gate-watch: src/services/host/vendors/** scripts/host/vastFixture.mjs scripts/host/lambdaFixture.mjs scripts/host/prove-vendors.ts
# gate-watch: scripts/host/hfEndpointsFixture.mjs scripts/host/prove-hf-endpoints.ts src/services/providers/huggingface/** src/components/HuggingfaceConnect.tsx src/keybindings/**
# gate-watch: scripts/host/prove-door-drive.ts src/services/host/door.ts src/utils/model/modelPickerGroups.ts src/commands/model/mercuryModel.tsx src/components/MercuryModelPicker.tsx
# gate-watch: src/services/engine-connector/focusedConnector.ts src/services/engine-connector/noSessionConnector.ts
# gate-watch: scripts/host/prove-vendor-road-drive.ts src/services/host/index.ts src/services/host/door.ts src/services/host/worker.ts src/services/host/store.ts src/services/host/cluster.ts src/services/host/jobs.ts src/services/host/tune.ts
# gate-watch: src/commands/host/** src/main.tsx src/services/concourse/workerModels.ts scripts/host/boxFixture.mjs scripts/host/boxDaemonProof.ts
# gate-watch: scripts/lib/firstRunSeed.ts src/Tool.ts src/daemon/controlSocket.ts src/services/providers/credentialEnvSpellings.ts src/utils/config.ts src/utils/config/globalConfig.ts src/utils/messages.ts src/utils/sessionStorage/paths.ts src/utils/systemPromptType.ts
# gate-watch: src/types/message.ts src/utils/messages/pairing.ts scripts/host/trillionKimiFixture.ts src/utils/settings/settingsCache.ts
# gate-watch: src/utils/settings/modelFacts.ts src/utils/settings/settings.ts scripts/host/prove-host-tune.ts scripts/host/runpodFixture.mjs
# gate-watch: scripts/host/hfFixture.mjs scripts/host/prove-hf-recipes.ts scripts/host/prove-host-search-drive.ts src/services/host/hfRecipes.ts src/services/host/recipesFile.ts src/components/mercury-ui/menuFold.tsx
# gate-watch: scripts/host/prove-host-bank-drive.ts scripts/host/prove-llmhost-qc-drive.ts
# gate-watch: scripts/host/prove-host-wheel-drive.ts src/components/ScrollKeybindingHandler.tsx src/context/overlayContext.tsx src/context/overlayStack.ts src/ink/**
# gate-watch: scripts/host/measure-recipe.ts scripts/host/prove-measure-recipe.ts scripts/host/prove-frontier-roster.ts src/services/providers/zai/zaiCodec.ts src/utils/envUtils.ts
# gate-watch: scripts/lib/hermetic.ts vendor/** vendor/node.lock.json
# gate-watch: .github/workflows/engine-image.yml assets/host/llamacpp-engine.json scripts/lib/generated-assets-map.mjs
# gate-watch: scripts/lib/ownerOnly.ts scripts/lib/python3.ts
# gate-watch: scripts/host/prove-tensorfold-recipe-script.ts scripts/host/prove-tensorfold-pod-road.ts scripts/host/prove-tensorfold-rent-drive.ts src/services/host/tensorfoldRelease.ts src/services/host/tensorfoldPod.ts scripts/host/fixtures/tensorfold-1.2.9-linux-x86_64.tar.gz.sha256 scripts/host/fixtures/tensorfold-1.2.9-linux-aarch64.tar.gz.sha256 src/services/tensorfold/contracts.ts src/services/providers/local/tensorfoldHosts.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
cd "$(dirname "$0")/../.." || exit 1
ROOT="$(pwd)"
here="scripts/host-2"
fail=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/host/$name"
  if [ ! -e "$f" ]; then
    echo "❌ host-2: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    fail=1
    continue
  fi
  run_proof "$ROOT/$f" bun "$ROOT/$f" < /dev/null || fail=1
done < "$here/members.txt"
if [ "$fail" = "0" ]; then echo "✅ host-2 suite GREEN"; else echo "❌ host-2 suite RED"; fi
exit "$fail"
