#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/screen/renderer/Ansi.tsx src/screen/renderer/arabicPresentationForms.json src/screen/renderer/bidi.ts src/screen/renderer/bindings/** src/screen/renderer/cell-grid.ts src/screen/renderer/colorize.ts src/screen/renderer/compose-buffer.ts src/screen/renderer/compose-walk.ts src/screen/renderer/constants.ts src/screen/renderer/cursor.d.ts src/screen/renderer/dom.ts src/screen/renderer/elements/** src/screen/renderer/events/** src/screen/renderer/focus.ts src/screen/renderer/frame-writer.ts src/screen/renderer/frame.ts src/screen/renderer/geometry/** src/screen/renderer/get-max-width.ts src/screen/renderer/global.d.ts src/screen/renderer/input/** src/screen/renderer/instance/** src/screen/renderer/instances.ts src/screen/renderer/jsx-intrinsics.d.ts src/screen/renderer/launcherAltHold.ts src/screen/renderer/layout/** src/screen/renderer/line-width-cache.ts src/screen/renderer/matchPositions.ts src/screen/renderer/measure-element.ts src/screen/renderer/measure-text.ts src/screen/renderer/node-cache.ts src/screen/renderer/patch-stream.ts src/screen/renderer/recessLayer.ts src/screen/renderer/reconciler.ts src/screen/renderer/render-border.ts src/screen/renderer/renderer.ts src/screen/renderer/root.ts src/screen/renderer/root/** src/screen/renderer/screenInstance.tsx src/screen/renderer/searchHighlight.ts src/screen/renderer/squash-text-nodes.ts src/screen/renderer/stringWidth.ts src/screen/renderer/styles.ts src/screen/renderer/tabstops.ts src/screen/renderer/terminal-session/capabilities.ts src/screen/renderer/terminal-session/frameDelivery.ts src/screen/renderer/terminal-session/terminalExperience.ts src/screen/renderer/terminal-session/terminalFocusStore.ts src/screen/renderer/terminal-session/terminalProfile.ts src/screen/renderer/terminal-session/terminalQuerier.ts src/screen/renderer/terminal-session/terminalTextCells.ts src/screen/renderer/terminal-session/widthProbe.ts src/screen/renderer/terminal-session/windowsHostSetup.ts src/screen/renderer/terminalBidiFrame.ts src/screen/renderer/terminalOut.ts src/screen/renderer/terminalWrite.ts src/screen/renderer/termio/alternateScrollPolicy.ts src/screen/renderer/termio/ansi.ts src/screen/renderer/termio/csi.ts src/screen/renderer/termio/dec.ts src/screen/renderer/termio/display-types.ts src/screen/renderer/termio/displayParser.ts src/screen/renderer/termio/notifyPing.ts src/screen/renderer/termio/osc.ts src/screen/renderer/warn.ts src/screen/renderer/widest-line.ts src/screen/renderer/width-probe-table.ts src/screen/renderer/wrap-text.ts src/screen/renderer/wrapAnsi.ts
# gate-watch: src/engine/runtime-kernel/**
# gate-watch: src/integrations/resources/adapters/service.ts
# gate-watch: src/engine/run/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
export UI_RENDER=1
here="scripts/primitives-kernel-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'primitives-kernel-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members primitives-kernel-drives 'scripts/primitives-kernel/$name' "$here/members.txt"
