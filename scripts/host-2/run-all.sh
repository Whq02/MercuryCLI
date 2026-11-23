#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/host/**
# gate-watch: scripts/lib/fixtureApi.ts scripts/lib/runnerHost.ts
# gate-watch: src/models/hosting/** src/commands/llmhost/**
# gate-watch: src/models/roads/openaicompat/** docs/LLM-HOST.md
# gate-watch: src/daemon/control/main.ts src/boot/entrypoints/cli.tsx src/daemon/runner/runHeadless.ts src/tools/engines/project-services/**
# gate-watch: assets/host/weights.json package.json
# gate-watch: src/models/hosting/vendors/**
# gate-watch: scripts/host/prove-hf-endpoints.ts src/models/roads/huggingface/** src/models/sign-in/flow-cards/HuggingfaceConnect.tsx src/screen/keys/KeybindingContext.tsx src/screen/keys/KeybindingProviderSetup.tsx src/screen/keys/RouteSurfaceScope.ts src/screen/keys/actionGraph.ts src/screen/keys/atlas.ts src/screen/keys/defaultBindings.ts src/screen/keys/delivery.ts src/screen/keys/keyCapture.ts src/screen/keys/loadUserBindings.ts src/screen/keys/match.ts src/screen/keys/parser.ts src/screen/keys/pendingChordMirror.ts src/screen/keys/reservedShortcuts.ts src/screen/keys/resolver.ts src/screen/keys/schema.ts src/screen/keys/shortcutFormat.ts src/screen/keys/template.ts src/screen/keys/types.ts src/screen/keys/useKeybinding.ts src/screen/keys/useShortcutDisplay.ts src/screen/keys/validate.ts src/screen/keys/writeBindings.ts
# gate-watch: scripts/host/prove-door-drive.ts src/models/facts/modelPickerGroups.ts src/commands/model/picker/MercuryModelPicker.tsx
# gate-watch: scripts/host/prove-vendor-road-drive.ts
# gate-watch: src/boot/main.tsx scripts/host/boxDaemonProof.ts
# gate-watch: src/engine/message-shapes/message.ts src/engine/messages/wirePairing.ts scripts/host/trillionKimiFixture.ts
# gate-watch: src/platform/settings/modelFacts.ts scripts/host/prove-host-tune.ts
# gate-watch: scripts/host/prove-hf-recipes.ts scripts/host/prove-host-search-drive.ts src/screen/widgets/menuFold.tsx
# gate-watch: scripts/host/prove-host-wheel-drive.ts src/screen/overlays/overlayHooks.tsx src/screen/renderer/Ansi.tsx src/screen/renderer/arabicPresentationForms.json src/screen/renderer/bidi.ts src/screen/renderer/bindings/** src/screen/renderer/cell-grid.ts src/screen/renderer/colorize.ts src/screen/renderer/compose-buffer.ts src/screen/renderer/compose-walk.ts src/screen/renderer/constants.ts src/screen/renderer/cursor.d.ts src/screen/renderer/dom.ts src/screen/renderer/elements/** src/screen/renderer/events/** src/screen/renderer/focus.ts src/screen/renderer/frame-writer.ts src/screen/renderer/frame.ts src/screen/renderer/geometry/** src/screen/renderer/get-max-width.ts src/screen/renderer/global.d.ts src/screen/renderer/input/** src/screen/renderer/instance/** src/screen/renderer/instances.ts src/screen/renderer/jsx-intrinsics.d.ts src/screen/renderer/launcherAltHold.ts src/screen/renderer/layout/** src/screen/renderer/line-width-cache.ts src/screen/renderer/matchPositions.ts src/screen/renderer/measure-element.ts src/screen/renderer/measure-text.ts src/screen/renderer/node-cache.ts src/screen/renderer/patch-stream.ts src/screen/renderer/recessLayer.ts src/screen/renderer/reconciler.ts src/screen/renderer/render-border.ts src/screen/renderer/renderer.ts src/screen/renderer/root.ts src/screen/renderer/root/** src/screen/renderer/screenInstance.tsx src/screen/renderer/searchHighlight.ts src/screen/renderer/squash-text-nodes.ts src/screen/renderer/stringWidth.ts src/screen/renderer/styles.ts src/screen/renderer/tabstops.ts src/screen/renderer/terminal-session/capabilities.ts src/screen/renderer/terminal-session/frameDelivery.ts src/screen/renderer/terminal-session/terminalExperience.ts src/screen/renderer/terminal-session/terminalFocusStore.ts src/screen/renderer/terminal-session/terminalProfile.ts src/screen/renderer/terminal-session/terminalQuerier.ts src/screen/renderer/terminal-session/terminalTextCells.ts src/screen/renderer/terminal-session/widthProbe.ts src/screen/renderer/terminal-session/windowsHostSetup.ts src/screen/renderer/terminalBidiFrame.ts src/screen/renderer/terminalOut.ts src/screen/renderer/terminalWrite.ts src/screen/renderer/termio/alternateScrollPolicy.ts src/screen/renderer/termio/ansi.ts src/screen/renderer/termio/csi.ts src/screen/renderer/termio/dec.ts src/screen/renderer/termio/display-types.ts src/screen/renderer/termio/displayParser.ts src/screen/renderer/termio/notifyPing.ts src/screen/renderer/termio/osc.ts src/screen/renderer/warn.ts src/screen/renderer/widest-line.ts src/screen/renderer/width-probe-table.ts src/screen/renderer/wrap-text.ts src/screen/renderer/wrapAnsi.ts
# gate-watch: scripts/host/measure-recipe.ts scripts/host/prove-measure-recipe.ts scripts/host/prove-frontier-roster.ts
# gate-watch: scripts/lib/hermetic.ts vendor/** vendor/node.lock.json
# gate-watch: .github/workflows/engine-image.yml assets/host/llamacpp-engine.json scripts/lib/generated-assets-map.mjs
# gate-watch: scripts/host/prove-tensorfold-recipe-script.ts scripts/host/prove-tensorfold-pod-road.ts scripts/host/prove-tensorfold-rent-drive.ts scripts/host/fixtures/tensorfold-1.3.3-linux-x86_64.tar.gz.sha256 scripts/host/fixtures/tensorfold-1.3.3-linux-aarch64.tar.gz.sha256 src/models/tensorfold/contracts.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/host-2"
fail=0
drive_members host-2 'scripts/host/$name' "$here/members.txt" || fail=1
if [ "$fail" = "0" ]; then echo "✅ host-2 suite GREEN"; else echo "❌ host-2 suite RED"; fi
exit "$fail"
