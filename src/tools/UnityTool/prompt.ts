import {
  UNITY_BRIDGE_VERBS,
  unityBridgeVerbNames,
  type UnityBridgeVerbSpec,
} from '../../services/unity/bridgeProtocol.js'
import { unityBridgePort } from '../../utils/unity/bridgeGates.js'

export const UNITY_TOOL_NAME = 'Unity' as const

function verbSignature(name: string, spec: UnityBridgeVerbSpec): string {
  const args = Object.entries(spec.args).map(([k, note]) =>
    /^optional/i.test(note) ? `${k}?` : k,
  )
  return `${name}(${args.join(', ')})${spec.cls === 'exec' ? ' [exec]' : ''}`
}

export function getUnityVerbCatalog(): string {
  const wire = unityBridgeVerbNames()
    .map(name => verbSignature(name, UNITY_BRIDGE_VERBS[name]))
    .join(' · ')
  return [
    `bridge: ${wire}`,
    'local: unity_status() · unity_bridge_install() [mutate] · unity_bridge_uninstall() [mutate]',
  ].join('\n')
}

export function getUnityToolDescription(): string {
  return `Drives the running Unity editor over the Mercury bridge, a token-authed loopback connection served by the editor-side com.mercury.unity-bridge package: play-mode control, scene listing and opening, hierarchy reads, console tailing, and Test Runner runs. Call shape: { op: "<name>", args: { … } }; scene paths are project-relative (Assets/…), and a bridge error returns {code, message, hint}.

Entering or leaving play mode reloads the editor's script domain and drops the bridge connection: play_enter and play_exit answer first, carrying willReload, then the connection dies and reconnects on the next call, and play_state after the reconnect confirms the transition. tests_run answers {started:true} at once; the results land as NUnit XML under the project's .mercury/unity-test-results/, and the test_run_finished event reports the counts when the connection is up. scene_open switches the open scene, not as an editor undo step. Every op that changes something asks permission, [exec] marking editor run-state and test runs; scene_open refuses while unsaved work is open.

unity_status probes the flag, the package, the token and reachability on 127.0.0.1:${unityBridgePort()}; unity_bridge_install writes the package into Packages/, and the editor compiles it on focus.

Ops (name(args), ? optional):
${getUnityVerbCatalog()}`
}
