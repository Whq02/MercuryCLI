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

/** The verb catalog section, generated from the contract table. */
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
  return `Drive the running Unity editor over the Mercury bridge: play-mode control, scene listing and opening, hierarchy reads, console tailing, and Test Runner runs — the editor-side com.mercury.unity-bridge package serves a token-authed loopback connection.

Call shape: { op: "<name>", args: { … } }. Scene paths are project-relative (Assets/…). Errors return {code, message, hint} — the hint says what to try instead.

THE RELOAD FACT (Unity-specific, by design): entering or leaving play mode reloads the editor's script domain and DROPS the bridge connection — play_enter/play_exit answer first (carrying willReload), then the connection dies and reconnects on the next call. A play_state after the reconnect confirms the transition. Test runs survive reloads editor-side; results land as NUnit XML at the project's .mercury/unity-test-results/ door and the test_run_finished event reports counts when the connection is up.

Ops marked [exec] change editor run-state or execute tests and always ask permission. scene_open is a mutate: it switches the open scene (NOT an editor undo step; a dirty scene refuses with SCENE_DIRTY rather than discarding work — save in the editor first).

Setup: the bridge package must be installed in the project and the editor open. op:"unity_status" probes everything (flag, package, token, reachability on 127.0.0.1:${unityBridgePort()}); op:"unity_bridge_install" materializes the package into Packages/ (the editor compiles it on focus — first-time compile verification is the Windows-box field drill). A closed editor answers with a teaching error, never a hang.

Routing: C# SYMBOL work (definitions, references, rename) → the LSP tool's mercury-csharp lane. BREAKPOINT debugging → the Debug tool's unity adapter (attach to the running editor). HEADLESS batch-mode test/build commands → the Launch tool's unity profiles (operator-run; the exact command is printed). In-editor play, scenes, hierarchy, console, and Test Runner runs live HERE.

Op catalog (name(args) — ? marks optional):
${getUnityVerbCatalog()}`
}
