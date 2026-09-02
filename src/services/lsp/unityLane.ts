// unityLane — the Unity C# IDE-hands lane (`mercury-csharp`, riding the
// MERCURY_UNITY master gate; opt-in default-OFF per the operator's arming
// ruling — off = no source, byte-identical).
//
// A Unity project's C# intelligence is a Roslyn-class language server over
// the project root. The lane is PATH-probed and never auto-installed (the
// remedies are the operator's to run — the pyright/ruff honesty grammar):
//   · csharp-ls first (stdio LSP by default; install:
//     `dotnet tool install --global csharp-ls` — the serverCatalogue's own
//     remedy line for its csharp row);
//   · OmniSharp second, spawned `-lsp` — the flag that arms its LSP-stdio
//     mode (OmniSharp/omnisharp-roslyn: LSP mode + stdio transport; the
//     zeusedit LSP config uses the same spelling; read 2026-08-29). A bare
//     OmniSharp spawn speaks its own HTTP/stdio protocol, NOT LSP — the
//     flag is load-bearing.
//   · the dotnet-workload road in the remedy: no `dotnet` on PATH ⇒ the
//     install line names the .NET SDK FIRST (the tool install needs it).
//
// Why a builtin lane when serverCatalogue has a csharp row: the catalogue
// row is *.sln/*.csproj-gated, and a fresh Unity project has NEITHER until
// the Unity editor generates them — Assets/ + ProjectSettings/ (the
// unityProject owner) is the honest Unity marker. In a generated project
// both rows can claim .cs; the builtin outranks by the first-wins merge
// (operator env > extensions > builtin > catalogue), so Unity projects get
// the Unity-scoped workspace root either way. Non-Unity C# repos keep the
// catalogue row untouched.
//
// Registration gates (ALL required): MERCURY_LSP (bridge) + MERCURY_UNITY
// (the boot-menu row "Unity dev lanes") + a Unity project root from cwd.
// Probe shared verbatim with the readiness row (evidence and boot cannot
// disagree — the clangd/pyright law).
//
// Proof: scripts/lsp/prove-unity-lane.ts (gate polarity, probe resolution
// order via PATH shims, config shape, remedy honesty, catalogue
// coexistence).

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
  /** Which server resolved ('csharp-ls' outranks 'omnisharp'). */
  server?: 'csharp-ls' | 'omnisharp'
  path?: string
  /** Spawn args for the resolved server (OmniSharp NEEDS -lsp). */
  args?: string[]
  /** The honest install road when absent (dotnet-aware). */
  reason?: string
}

// 30s cache (the clangd negative-cache idiom): probes run at manager
// init/reinit and from the readiness sweep; a mid-session
// `dotnet tool install` becomes visible without a restart.
let probeCache: { at: number; result: UnityCsharpProbe } | undefined
const PROBE_CACHE_TTL_MS = 30_000

/** TEST-ONLY: drop the probe cache (PATH-shim proofs). */
export function _resetUnityCsharpProbeForTesting(): void {
  probeCache = undefined
}

/**
 * Availability probe — shared by the config source and the readiness row.
 * csharp-ls > OmniSharp (both PATH; project-local dotnet tools are invoked
 * through their PATH shims when the operator arms them). Never spawns.
 */
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

/** The builtin `mercury-csharp` source (empty unless MERCURY_LSP +
 *  MERCURY_UNITY + a Unity project root + a probed server). */
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

/**
 * Readiness rows for the Unity lane — EMPTY while disarmed (the opt-in off
 * contract: nothing contributes, not even a disabled row). Armed:
 *   · no Unity project here ⇒ configured (armed, activates in a project);
 *   · project + probed server ⇒ configured (binary present, never spawned
 *     by this probe — only a RUNNING server reads ready, as its own
 *     lane:lsp:mercury-csharp row);
 *   · project + no server ⇒ unavailable with the dotnet-aware remedy.
 */
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

/** Spawn-provenance hook for builtinImplementationInfo (PATH source only —
 *  the probe never runs the binary, so version stays unclaimed). */
export function unityCsharpImplementationInfo(): { source: string } | null {
  const probe = probeUnityCsharpServer()
  return probe.available ? { source: 'path' } : null
}
