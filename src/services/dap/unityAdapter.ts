
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

export const UNITY_ADAPTER_ARM_HINT =
  "install the official 'Unity' VS Code extension (visualstudiotoolsforunity.vstuc ships bin/UnityDebugAdapter.dll), or point MERCURY_UNITY_DEBUG_ADAPTER at an UnityDebugAdapter.dll (unpack spot ~/.unity-dap works too); the adapter runs via the dotnet SDK on PATH"

export interface UnityAdapterResolution {
  dll: string
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

export function unityDebugPortForPid(pid: number): number {
  return 56000 + (Math.abs(Math.trunc(pid)) % 1000)
}

export interface UnityEditorEndpoint {
  host: string
  port: number
  processId: number
  evidence: string
}

export function unityEditorHint(root?: string): string {
  const where = root ? path.join(root, 'Library', 'EditorInstance.json') : 'Library/EditorInstance.json'
  return `is the Unity editor running with this project open? (${where} exists while it is; attach reads the editor pid there — port 56000 + pid % 1000)`
}

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
