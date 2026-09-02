import {
  BLENDER_BRIDGE_VERBS,
  BLENDER_PYTHON_RUN_NO_PREEMPTION_SENTENCE,
  BLENDER_PYTHON_RUN_NO_SANDBOX_SENTENCE,
  blenderBridgeVerbNames,
  type BlenderBridgeVerbSpec,
} from '../../services/blender/bridgeProtocol.js'
import { blenderBridgePort } from '../../utils/blender/bridgeGates.js'

export const BLENDER_TOOL_NAME = 'Blender' as const

function verbSignature(name: string, spec: BlenderBridgeVerbSpec): string {
  const args = Object.entries(spec.args).map(([k, note]) =>
    /^optional/i.test(note) ? `${k}?` : k,
  )
  return `${name}(${args.join(', ')})${spec.cls === 'exec' ? ' [exec]' : ''}`
}

/** The verb catalog section, generated from the contract table. */
export function getBlenderVerbCatalog(): string {
  const wire = blenderBridgeVerbNames()
    .map(name => verbSignature(name, BLENDER_BRIDGE_VERBS[name]))
    .join(' · ')
  return [
    `bridge: ${wire}`,
    'local: blender_status() · blender_bridge_install() [mutate] · blender_bridge_uninstall() [mutate]',
  ].join('\n')
}

export function getBlenderToolDescription(): string {
  return `Drive the running Blender over the Mercury bridge: scene and object truth, opening .blend files, render state and still-frame renders, the report tail, and python_run — the mercury_blender_bridge add-on serves a token-authed loopback connection.

Call shape: { op: "<name>", args: { … } }. Paths (blend_open's path, render_still's outputPath) may be context-relative; the tool resolves them against the working directory and FENCES them inside it before anything reaches the wire.

THE NO-RELOAD FACT (the deliberate inverse of Unity): Blender never reloads the add-on's state on file opens or renders — the connection HOLDS across blend_open, and a mid-flight drop means Blender quit or the add-on was disabled, never a by-design transition. Renders run as editor jobs: render_still answers {started:true} at once, the DURABLE result is the image file at outputPath, and the render_finished event reports the end on the next call's drain. While a render job runs, mutate/exec ops refuse RENDER_ACTIVE; reads stay free (render_state during a render is the point).

python_run — the two sentences that are contract:
· ${BLENDER_PYTHON_RUN_NO_SANDBOX_SENTENCE}
· ${BLENDER_PYTHON_RUN_NO_PREEMPTION_SENTENCE}
Every python_run asks permission with the code's size and first line. Output is capped with truncation counted; a raise answers PYTHON_EXCEPTION with the traceback tail; a variable named \`result\` answers as its repr.

Ops marked [exec] always ask permission. blend_open is a mutate: it switches the open .blend (NOT an undo step; unsaved work refuses with BLEND_DIRTY rather than discarding — save in Blender first).

Setup: the add-on must be installed AND ENABLED, with Blender open. op:"blender_status" probes everything (flag, addon home, install, token, reachability on 127.0.0.1:${blenderBridgePort()}); op:"blender_bridge_install" materializes mercury_blender_bridge into the user addon home — ENABLING IT IN BLENDER STAYS YOUR ACT (Edit > Preferences > Add-ons, search "Mercury"; the install receipt prints the one-liner alternative). A closed Blender answers with a teaching error, never a hang.

Routing: PYTHON BREAKPOINT debugging inside Blender → the Debug tool's debugpy recipe (the Launch tool's blender-debug row prints the listener line). HEADLESS batch renders/scripts → the Launch tool's blender profiles (operator-run; the exact command is printed, arguments in documented order). In-Blender scene/object/render truth, file opens, still renders, reports, and python_run live HERE.

Op catalog (name(args) — ? marks optional):
${getBlenderVerbCatalog()}`
}
