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
  return `Drives the running Unity editor over the token-authed com.mercury.unity-bridge loopback bridge: play mode, scene listing/opening, hierarchy reads, console tailing and Test Runner runs. Call shape: { op: "<name>", args: { … } }; scene paths are project-relative (Assets/…); bridge errors return {code, message, hint}.

Play-mode transitions reload the script domain and drop the bridge: play_enter/play_exit reply first with willReload, then reconnect on the next call (confirm with play_state). tests_run replies {started:true} immediately, writing NUnit XML under .mercury/unity-test-results/ and emitting test_run_finished counts when connected. scene_open switches scenes directly (not undoable) and refuses when unsaved work is open. Mutating ops ask permission ([exec] marks run-state and tests).

unity_status probes flag, package, token and reachability on 127.0.0.1:${unityBridgePort()}; unity_bridge_install writes into Packages/ (compiled on editor focus).

Ops (name(args), ? optional):
${getUnityVerbCatalog()}`
}
