// ============================================================================
//  dap/unityAdapter — the `unity` attach-to-editor debug row (riding the
//  MERCURY_UNITY master gate; opt-in default-OFF — off = no row, no hint,
//  byte-identical).
//
//  Unity's managed debugging is the Mono soft debugger LISTENING INSIDE the
//  editor — there is nothing to launch: every debug gesture is an attach.
//  The maintained adapter is the one inside the official "Unity" VS Code
//  extension (visualstudiotoolsforunity.vstuc — the deprecated
//  Unity.unity-debug row is history), a .NET DAP executable third-party
//  clients spawn as `dotnet <ext>/bin/UnityDebugAdapter.dll` with an attach
//  request naming the editor endPoint (community-proven shape: nvim-dap
//  discussion #815; announced by the VS blog post "Announcing the Unity
//  extension for Visual Studio Code"; read 2026-08-29).
//
//  Editor discovery facts (read 2026-08-29):
//    · <project>/Library/EditorInstance.json exists WHILE the editor has the
//      project open and carries the editor's process_id (JetBrains Rider
//      debugging docs; the file is the attach-discovery road).
//    · debugger port = 56000 + (editor pid % 1000) (Rider troubleshooting
//      docs; docs.unity3d.com managed-code-debugging names the 56xxx range).
//
//  Resolution (never auto-installed; the remedies are the operator's):
//    MERCURY_UNITY_DEBUG_ADAPTER pin (a broken pin refuses BY NAME)
//    → VS Code extension dirs (~/.vscode{,-insiders,-server}/extensions/
//      visualstudiotoolsforunity.vstuc-*/bin/UnityDebugAdapter.dll, newest
//      version dir first) → the documented unpack spot
//      ~/.unity-dap/UnityDebugAdapter.dll. The dll runs via a PATH `dotnet`;
//      no dotnet ⇒ dormant with the SDK remedy.
//
//  Proof: scripts/dap/prove-unity-adapter.ts (fixtures + fake extension
//  trees; the editor itself is NEVER involved).
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { whichSync } from '../../utils/which.js'
import {
  compareUnityVersionsDesc,
  findUnityProjectRoot,
} from '../ide/unityProject.js'

export const UNITY_DAP_ADAPTER_KEY = 'unity'

/** Both arm roads, spoken wherever the adapter is absent (resolver-honesty
 *  rider: a drifted install path stays operator-fixable without code). */
export const UNITY_ADAPTER_ARM_HINT =
  "install the official 'Unity' VS Code extension (visualstudiotoolsforunity.vstuc ships bin/UnityDebugAdapter.dll), or point MERCURY_UNITY_DEBUG_ADAPTER at an UnityDebugAdapter.dll (unpack spot ~/.unity-dap works too); the adapter runs via the dotnet SDK on PATH"

export interface UnityAdapterResolution {
  /** Absolute UnityDebugAdapter.dll path. */
  dll: string
  /** The dotnet executable that runs it. */
  dotnet: string
  source: 'pin' | 'vscode-extension' | 'unpack'
}

export interface UnityAdapterFailure {
  reason: string
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** The VS Code extension roots scanned for the vstuc adapter. */
export function vstucExtensionRoots(home: string = homedir()): string[] {
  return [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
  ]
}

function newestVstucDll(extensionsDir: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(extensionsDir).filter(name =>
      name.toLowerCase().startsWith('visualstudiotoolsforunity.vstuc-'),
    )
  } catch {
    return null
  }
  entries.sort((a, b) =>
    compareUnityVersionsDesc(
      a.slice('visualstudiotoolsforunity.vstuc-'.length),
      b.slice('visualstudiotoolsforunity.vstuc-'.length),
    ),
  )
  for (const entry of entries) {
    const dll = path.join(extensionsDir, entry, 'bin', 'UnityDebugAdapter.dll')
    if (isFile(dll)) return dll
  }
  return null
}

/**
 * Resolve the Unity debug adapter — filesystem facts only, nothing spawned.
 * @param testOpts proof seam: fake extension roots / unpack spot / dotnet
 *   presence, so any box proves every rung deterministically.
 */
export function resolveUnityDebugAdapter(testOpts?: {
  extensionRoots?: string[]
  unpackDll?: string
  dotnetOverride?: string | null
}): UnityAdapterResolution | UnityAdapterFailure {
  const dotnet =
    testOpts?.dotnetOverride !== undefined ? testOpts.dotnetOverride : whichSync('dotnet')
  const pin = flagEnv('MERCURY_UNITY_DEBUG_ADAPTER')
  if (pin && pin.trim() !== '') {
    if (!isFile(pin)) {
      return {
        reason: `MERCURY_UNITY_DEBUG_ADAPTER set but ${pin} is not an existing file — the pin names itself, no silent fallback`,
      }
    }
    if (!dotnet) {
      return { reason: 'UnityDebugAdapter.dll pinned but no dotnet SDK on PATH — install the .NET SDK (dotnet.microsoft.com) to run it' }
    }
    return { dll: pin, dotnet, source: 'pin' }
  }
  let dll: string | null = null
  let source: UnityAdapterResolution['source'] = 'vscode-extension'
  for (const root of testOpts?.extensionRoots ?? vstucExtensionRoots()) {
    dll = newestVstucDll(root)
    if (dll) break
  }
  if (!dll) {
    const unpack = testOpts?.unpackDll ?? path.join(homedir(), '.unity-dap', 'UnityDebugAdapter.dll')
    if (isFile(unpack)) {
      dll = unpack
      source = 'unpack'
    }
  }
  if (!dll) return { reason: `no UnityDebugAdapter.dll found — ${UNITY_ADAPTER_ARM_HINT}` }
  if (!dotnet) {
    return { reason: `UnityDebugAdapter.dll found (${dll}) but no dotnet SDK on PATH — install the .NET SDK (dotnet.microsoft.com) to run it` }
  }
  return { dll, dotnet, source }
}

/** The documented editor debugger-port law: 56000 + (pid % 1000). */
export function unityDebugPortForPid(pid: number): number {
  return 56000 + (Math.abs(Math.trunc(pid)) % 1000)
}

export interface UnityEditorEndpoint {
  host: string
  port: number
  processId: number
  /** Where the fact came from (the EditorInstance.json path). */
  evidence: string
}

/** The teaching line every "editor unreachable" surface repeats. */
export function unityEditorHint(root?: string): string {
  const where = root ? path.join(root, 'Library', 'EditorInstance.json') : 'Library/EditorInstance.json'
  return `is the Unity editor running with this project open? (${where} exists while it is; attach reads the editor pid there — port 56000 + pid % 1000)`
}

/**
 * Read <root>/Library/EditorInstance.json → the editor's loopback debug
 * endpoint. Absent/unreadable/foreign ⇒ a reason carrying the teaching
 * line, never a throw.
 */
export function unityEditorEndpoint(root: string): UnityEditorEndpoint | { reason: string } {
  const file = path.join(root, 'Library', 'EditorInstance.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { reason: unityEditorHint(root) }
  }
  try {
    const parsed = JSON.parse(raw) as { process_id?: unknown }
    const pid = typeof parsed.process_id === 'number' ? parsed.process_id : Number.NaN
    if (!Number.isFinite(pid) || pid <= 0) {
      return { reason: `${file} carries no usable process_id — ${unityEditorHint(root)}` }
    }
    return { host: '127.0.0.1', port: unityDebugPortForPid(pid), processId: pid, evidence: file }
  } catch {
    return { reason: `${file} is not parseable JSON — ${unityEditorHint(root)}` }
  }
}

export interface UnityAttachInput {
  program: string
  cwd: string
  host?: string
  port?: number
  pid?: number
}

/**
 * The vstuc attach body. Preference: explicit port > explicit pid (the
 * documented port law) > the project's EditorInstance.json. No target ⇒
 * throws the teaching line (caught by the session machinery, surfaced with
 * the install hint + output tail — the honest-refusal-at-use road).
 * `type` rides IN the body (the js-debug lesson: adapters that check their
 * config discriminator refuse without it; extras are ignored by the rest).
 */
export function buildUnityAttachArgs(options: UnityAttachInput): Record<string, unknown> {
  const host = options.host ?? '127.0.0.1'
  const programDir =
    options.program && existsSync(options.program)
      ? statSync(options.program).isDirectory()
        ? options.program
        : path.dirname(options.program)
      : options.cwd
  const root = findUnityProjectRoot(programDir) ?? findUnityProjectRoot(options.cwd)
  if (options.port !== undefined) {
    return {
      type: 'vstuc',
      endPoint: `${host}:${options.port}`,
      ...(root ? { projectPath: root } : {}),
    }
  }
  if (options.pid !== undefined) {
    return {
      type: 'vstuc',
      endPoint: `${host}:${unityDebugPortForPid(options.pid)}`,
      ...(root ? { projectPath: root } : {}),
    }
  }
  if (!root) {
    throw new Error(
      `no Unity project (Assets/ + ProjectSettings/) from ${programDir} — pass the project (or an explicit port/pid); ${unityEditorHint()}`,
    )
  }
  const endpoint = unityEditorEndpoint(root)
  if ('reason' in endpoint) throw new Error(endpoint.reason)
  return {
    type: 'vstuc',
    endPoint: `${endpoint.host}:${endpoint.port}`,
    projectPath: root,
  }
}
