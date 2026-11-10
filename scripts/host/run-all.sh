#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/utils/envUtils.ts src/services/providers/huggingface/huggingfaceAccounts.ts
# gate-watch: scripts/lib/fixtureApi.ts scripts/lib/runnerHost.ts src/input-core/command-queue.ts src/utils/messages/noticeRows.ts
# gate-watch: src/services/host/** src/commands/llmhost/** src/services/llmHost/** src/components/LlmHostDialog.tsx
# gate-watch: src/services/providers/providerSecrets.ts src/services/providers/openaicompat/** docs/LLM-HOST.md
# gate-watch: src/daemon/main.ts src/entrypoints/cli.tsx src/cli/run.ts src/services/projectServices/**
# gate-watch: scripts/lib/settingsPopupHarness.ts scripts/providers/lib/llmhostFixture.ts scripts/streaming/artifactArena.ts scripts/streaming/ptydrive.py scripts/lib/observed_walk.py scripts/lib/captureDriver.ts scripts/ui/gridToPng.ts
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
# gate-watch: scripts/host/prove-tensorfold-recipe-script.ts scripts/host/prove-tensorfold-pod-road.ts scripts/host/prove-tensorfold-rent-drive.ts src/services/host/tensorfoldRelease.ts src/services/host/tensorfoldPod.ts scripts/host/fixtures/tensorfold-1.2.5-linux-x86_64.tar.gz.sha256 scripts/host/fixtures/tensorfold-1.2.5-linux-aarch64.tar.gz.sha256 src/services/tensorfold/contracts.ts src/services/providers/local/tensorfoldHosts.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail=0
run_proof "$ROOT/scripts/host/prove-boundary-worker.ts" bun "$ROOT/scripts/host/prove-boundary-worker.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-boundary-manifest.ts" bun "$ROOT/scripts/host/prove-boundary-manifest.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-boundary-credentials.ts" bun "$ROOT/scripts/host/prove-boundary-credentials.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-boundary-watch-recipes.ts" bun "$ROOT/scripts/host/prove-boundary-watch-recipes.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-boundary-notices.ts" bun "$ROOT/scripts/host/prove-boundary-notices.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-cleanup.ts" bun "$ROOT/scripts/host/prove-host-cleanup.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-words-truth.ts" bun "$ROOT/scripts/host/prove-host-words-truth.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-pod-image-path.ts" bun "$ROOT/scripts/host/prove-pod-image-path.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-notice-before-turn.ts" bun "$ROOT/scripts/host/prove-host-notice-before-turn.ts" --bundle "$ROOT/dist/mercury.mjs" || fail=1
run_proof "$ROOT/scripts/host/prove-host-completion.ts" bun "$ROOT/scripts/host/prove-host-completion.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-vendors.ts" bun "$ROOT/scripts/host/prove-vendors.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-hf-endpoints.ts" bun "$ROOT/scripts/host/prove-hf-endpoints.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-hf-oauth-endpoints.ts" bun "$ROOT/scripts/host/prove-hf-oauth-endpoints.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-vendor-road-drive.ts" bun "$ROOT/scripts/host/prove-vendor-road-drive.ts" --bundle "$ROOT/dist/mercury.mjs" || fail=1
run_proof "$ROOT/scripts/host/prove-door-drive.ts" bun "$ROOT/scripts/host/prove-door-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-hf-recipes.ts" bun "$ROOT/scripts/host/prove-hf-recipes.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-hf-bank-persistence.ts" bun "$ROOT/scripts/host/prove-hf-bank-persistence.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-hf-mirror.ts" bun "$ROOT/scripts/host/prove-hf-mirror.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-cluster-fatal-cleanup.ts" bun "$ROOT/scripts/host/prove-cluster-fatal-cleanup.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-prebuilt-host-tune.ts" bun "$ROOT/scripts/host/prove-prebuilt-host-tune.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-bank-transfer.ts" bun "$ROOT/scripts/host/prove-host-bank-transfer.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-pod-list-completeness.ts" bun "$ROOT/scripts/host/prove-pod-list-completeness.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-search-drive.ts" bun "$ROOT/scripts/host/prove-host-search-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-bank-drive.ts" bun "$ROOT/scripts/host/prove-host-bank-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-wheel-drive.ts" bun "$ROOT/scripts/host/prove-host-wheel-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-llmhost-qc-drive.ts" bun "$ROOT/scripts/host/prove-llmhost-qc-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-door-tune-drive.ts" bun "$ROOT/scripts/host/prove-door-tune-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-door-seams-drive.ts" bun "$ROOT/scripts/host/prove-door-seams-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-mercury-host.ts" bun "$ROOT/scripts/host/prove-mercury-host.ts" --bundle "$ROOT/dist/mercury.mjs" || fail=1
run_proof "$ROOT/scripts/host/prove-mercury-host-drive.ts" bun "$ROOT/scripts/host/prove-mercury-host-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-trillion-tier.ts" bun "$ROOT/scripts/host/prove-trillion-tier.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-launch.ts" bun "$ROOT/scripts/host/prove-host-launch.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-recipes-live.ts" bun "$ROOT/scripts/host/prove-recipes-live.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-private-recipes-drive.ts" bun "$ROOT/scripts/host/prove-private-recipes-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-frontier-roster.ts" bun "$ROOT/scripts/host/prove-frontier-roster.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-measure-recipe.ts" bun "$ROOT/scripts/host/prove-measure-recipe.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-fast-load-drive.ts" bun "$ROOT/scripts/host/prove-fast-load-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-tune.ts" bun "$ROOT/scripts/host/prove-host-tune.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-rent-drive.ts" bun "$ROOT/scripts/host/prove-host-rent-drive.ts" --bundle "$ROOT/dist/mercury.mjs" || fail=1
run_proof "$ROOT/scripts/host/prove-rent-model-first-drive.ts" bun "$ROOT/scripts/host/prove-rent-model-first-drive.ts" --bundle "$ROOT/dist/mercury.mjs" || fail=1
run_proof "$ROOT/scripts/host/prove-fast-load-private-drive.ts" bun "$ROOT/scripts/host/prove-fast-load-private-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-bank-folder-drive.ts" bun "$ROOT/scripts/host/prove-host-bank-folder-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-bank-identity.ts" bun "$ROOT/scripts/host/prove-host-bank-identity.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-guard.ts" bun "$ROOT/scripts/host/prove-host-guard.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-engine-oom-after-ready.ts" bun "$ROOT/scripts/host/prove-engine-oom-after-ready.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-pause.ts" bun "$ROOT/scripts/host/prove-host-pause.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-hf-refresh.ts" bun "$ROOT/scripts/host/prove-host-hf-refresh.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-hiccups.ts" bun "$ROOT/scripts/host/prove-host-hiccups.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-keep-safe-drive.ts" bun "$ROOT/scripts/host/prove-host-keep-safe-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-key-door.ts" bun "$ROOT/scripts/host/prove-host-key-door.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-key-management-drive.ts" bun "$ROOT/scripts/host/prove-host-key-management-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-precreate-words.ts" bun "$ROOT/scripts/host/prove-host-precreate-words.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-projectors.ts" bun "$ROOT/scripts/host/prove-host-projectors.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-paid-machine-count.ts" bun "$ROOT/scripts/host/prove-paid-machine-count.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-vast-hosting-tag.ts" bun "$ROOT/scripts/host/prove-vast-hosting-tag.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-vast-next-offer.ts" bun "$ROOT/scripts/host/prove-vast-next-offer.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-vast-volumes-drive.ts" bun "$ROOT/scripts/host/prove-vast-volumes-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-vast-volumes.ts" bun "$ROOT/scripts/host/prove-vast-volumes.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-hyperstack-drive.ts" bun "$ROOT/scripts/host/prove-hyperstack-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-verda-drive.ts" bun "$ROOT/scripts/host/prove-verda-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-digitalocean-drive.ts" bun "$ROOT/scripts/host/prove-digitalocean-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-vast-screen-reads.ts" bun "$ROOT/scripts/host/prove-vast-screen-reads.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-vast-attach-key.ts" bun "$ROOT/scripts/host/prove-vast-attach-key.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-reliability.ts" bun "$ROOT/scripts/host/prove-host-reliability.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-link-pause.ts" bun "$ROOT/scripts/host/prove-host-link-pause.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-ready-switches-session.ts" bun "$ROOT/scripts/host/prove-host-ready-switches-session.ts" "$ROOT/dist/mercury.mjs" || fail=1
run_proof "$ROOT/scripts/host/prove-host-ready-switch-reread.ts" bun "$ROOT/scripts/host/prove-host-ready-switch-reread.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-recipe-tool-parsers.ts" bun "$ROOT/scripts/host/prove-recipe-tool-parsers.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-log-hold.ts" bun "$ROOT/scripts/host/prove-host-log-hold.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-rental-screen-values.ts" bun "$ROOT/scripts/host/prove-rental-screen-values.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-vendor-drift-signals.ts" bun "$ROOT/scripts/host/prove-vendor-drift-signals.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-vendor-drift.ts" bun "$ROOT/scripts/host/prove-vendor-drift.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-engine-death-words.ts" bun "$ROOT/scripts/host/prove-engine-death-words.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-engine-after-ready.ts" bun "$ROOT/scripts/host/prove-engine-after-ready.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-bank-download-fixture.ts" bun "$ROOT/scripts/host/prove-bank-download-fixture.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-hf-engine-check.ts" bun "$ROOT/scripts/host/prove-hf-engine-check.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-llamacpp-engine-upkeep.ts" bun "$ROOT/scripts/host/prove-llamacpp-engine-upkeep.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-model-trust-drive.ts" bun "$ROOT/scripts/host/prove-host-model-trust-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-upload-confirm-drive.ts" bun "$ROOT/scripts/host/prove-host-upload-confirm-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-volume-read-drive.ts" bun "$ROOT/scripts/host/prove-host-volume-read-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-llmhost-first-screen.ts" bun "$ROOT/scripts/host/prove-llmhost-first-screen.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-plain-words-drive.ts" bun "$ROOT/scripts/host/prove-host-plain-words-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-weights-source.ts" bun "$ROOT/scripts/host/prove-weights-source.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-bank-rail-hint-drive.ts" bun "$ROOT/scripts/host/prove-bank-rail-hint-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-tensorfold-recipe-script.ts" bun "$ROOT/scripts/host/prove-tensorfold-recipe-script.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-tensorfold-pod-road.ts" bun "$ROOT/scripts/host/prove-tensorfold-pod-road.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-tensorfold-rent-drive.ts" bun "$ROOT/scripts/host/prove-tensorfold-rent-drive.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-tensorfold-pod-turns.ts" bun "$ROOT/scripts/host/prove-tensorfold-pod-turns.ts" --bundle "$ROOT/dist/mercury.mjs" || fail=1
run_proof "$ROOT/scripts/host/prove-host-job-drive.ts" bun "$ROOT/scripts/host/prove-host-job-drive.ts" --bundle "$ROOT/dist/mercury.mjs" || fail=1
run_proof "$ROOT/scripts/host/prove-rental-selected-shape.ts" bun "$ROOT/scripts/host/prove-rental-selected-shape.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-tensorfold-bank-safety.ts" bun "$ROOT/scripts/host/prove-tensorfold-bank-safety.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-vast-log-location.ts" bun "$ROOT/scripts/host/prove-vast-log-location.ts" || fail=1
run_proof "$ROOT/scripts/host/prove-host-terminal-state.ts" bun "$ROOT/scripts/host/prove-host-terminal-state.ts" || fail=1
if [ "$fail" = "0" ]; then echo "✅ host suite GREEN"; else echo "❌ host suite RED"; fi
exit "$fail"
