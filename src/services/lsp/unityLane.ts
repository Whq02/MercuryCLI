
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { whichSync } from '../../utils/which.js'
import {
  findUnityProjectRoot,
  mercuryUnityEnabled,
} from '../ide/unityProject.js'
import { mercuryLspEnabled } from './mercuryLsp.js'
import type { ScopedLspServerConfig } from './types.js'

export const MERCURY_CSHARP_SERVER_NAME = 'mercury-csharp'

const CS_EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.cs': 'csharp',
}

export interface UnityCsharpProbe {
  available: boolean
  server?: 'csharp-ls' | 'omnisharp'
  path?: string
  args?: string[]
  reason?: string
}

let probeCache: { at: number; result: UnityCsharpProbe } | undefined
const PROBE_CACHE_TTL_MS = 30_000

export function _resetUnityCsharpProbeForTesting(): void {
  probeCache = undefined
}

export function probeUnityCsharpServer(): UnityCsharpProbe {
  const now = Date.now()
  if (probeCache && now - probeCache.at < PROBE_CACHE_TTL_MS) {
    return probeCache.result
  }
  let result: UnityCsharpProbe
  const csharpLs = whichSync('csharp-ls')
  const omnisharp = csharpLs ? null : (whichSync('OmniSharp') ?? whichSync('omnisharp'))
  if (csharpLs) {
    result = { available: true, server: 'csharp-ls', path: csharpLs, args: [] }
  } else if (omnisharp) {
    result = { available: true, server: 'omnisharp', path: omnisharp, args: ['-lsp'] }
  } else {
    const dotnet = whichSync('dotnet')
    result = {
      available: false,
      reason: dotnet
        ? 'no C# language server on PATH — install one: dotnet tool install --global csharp-ls (or an OmniSharp release)'
        : 'no C# language server on PATH and no dotnet SDK — install the .NET SDK first (dotnet.microsoft.com), then: dotnet tool install --global csharp-ls',
    }
  }
  probeCache = { at: now, result }
  return result
}

export function builtinUnityCsharpServer(): Record<string, ScopedLspServerConfig> {
  if (!mercuryLspEnabled() || !mercuryUnityEnabled()) return {}
  const root = findUnityProjectRoot(getCwd())
  if (!root) {
    logForDebugging(
      `[LSP BUILTIN] mercury-csharp unavailable: no Unity project (Assets/ + ProjectSettings/) from ${getCwd()}`,
    )
    return {}
  }
  const probe = probeUnityCsharpServer()
  if (!probe.available || !probe.path) {
    logForDebugging(`[LSP BUILTIN] mercury-csharp unavailable: ${probe.reason ?? 'unknown'}`)
    return {}
  }
  return {
    [MERCURY_CSHARP_SERVER_NAME]: {
      command: probe.path,
      args: probe.args ?? [],
      extensionToLanguage: { ...CS_EXTENSION_TO_LANGUAGE },
      transport: 'stdio',
      workspaceFolder: root,
      startupTimeout: 30_000,
      maxRestarts: 2,
      scope: 'dynamic',
      source: 'mercury-builtin',
    },
  }
}

export function unityLaneReadinessRecords(): Array<{
  id: string
  kind: 'lane'
  label: string
  state: 'configured' | 'unavailable'
  detail: string
  remedy?: string
  source: string
  lastCheckedAt: number
}> {
  if (!mercuryLspEnabled() || !mercuryUnityEnabled()) return []
  const at = Date.now()
  const base = {
    id: 'lane:unity',
    kind: 'lane' as const,
    label: 'Unity C# lane',
    source: 'unityProject root + C# server probe (shared with the config source)',
    lastCheckedAt: at,
  }
  const root = findUnityProjectRoot(getCwd())
  if (!root) {
    return [
      {
        ...base,
        state: 'configured',
        detail:
          'armed — activates in a Unity project (Assets/ + ProjectSettings/); none found from the working directory',
      },
    ]
  }
  const probe = probeUnityCsharpServer()
  if (!probe.available || !probe.path) {
    return [
      {
        ...base,
        state: 'unavailable',
        detail: `Unity project at ${root} — no C# language server`,
        ...(probe.reason ? { remedy: probe.reason } : {}),
      },
    ]
  }
  return [
    {
      ...base,
      state: 'configured',
      detail: `${probe.server} at ${probe.path} — engages on the first .cs touch (workspace ${root})`,
    },
  ]
}

export function unityCsharpImplementationInfo(): { source: string } | null {
  const probe = probeUnityCsharpServer()
  return probe.available ? { source: 'path' } : null
}
