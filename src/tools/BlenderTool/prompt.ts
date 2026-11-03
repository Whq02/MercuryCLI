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
  return `Drives the running Blender over the Mercury bridge, a token-authed loopback connection served by the mercury_blender_bridge add-on: scene and object truth, .blend opens, render state and still renders, the report tail, and python_run. Call shape: { op: "<name>", args: { … } }; a bridge error returns {code, message, hint}. Paths (blend_open's path, render_still's outputPath) resolve against the working directory and stay inside it.

The connection holds across blend_open and renders. blend_open switches the open .blend, not as an undo step. render_still answers {started:true} at once; the durable result is the image at outputPath, and the render_finished event arrives with a later call's drain. python_run runs your source inside Blender: a variable named \`result\` answers as its repr, output is capped with the truncation counted, and a raise answers PYTHON_EXCEPTION with the traceback tail. ${BLENDER_PYTHON_RUN_NO_SANDBOX_SENTENCE} ${BLENDER_PYTHON_RUN_NO_PREEMPTION_SENTENCE} Every op that changes something asks permission, [exec] marking code and run-state; python_run's ask carries the code's size and first line, and blend_open refuses while unsaved work is open.

blender_status probes the flag, the add-on home, the install, the token and reachability on 127.0.0.1:${blenderBridgePort()}. blender_bridge_install writes mercury_blender_bridge into the user add-on home; enabling it in Blender is the operator's act.

Ops (name(args), ? optional):
${getBlenderVerbCatalog()}`
}
