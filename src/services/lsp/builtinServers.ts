// builtinServers — Mercury's zero-config LSP server sources (MERCURY_LSP).
//
// Extensions are one LSP server source (config.ts); the IDE-hands bridge adds
// Mercury's own, merged in config.ts with first-wins priority
//   operator env (MERCURY_LSP_SERVERS)  >  extension servers  >  builtin
// so an operator override always claims its file extensions, and a richer extension
// server outranks a built-in lane:
//   · `mercury-ts` — the in-bundle TypeScript sidecar (tsSidecar/), offered
//     ONLY when the workspace has a resolvable `typescript` package AND the
//     running entry script exists on disk (we respawn our own bundle with
//     `--lsp-ts-sidecar`). No typescript ⇒ no config ⇒ the tool stays hidden
//     and /health says exactly why.
//   · `mercury-clangd` — the C/C++ lane (clangdLane.ts): the workspace's own
//     clangd, binary-gated, default-ON under the bridge (MERCURY_LSP_CPP=0
//     opts out).
//   · `mercury-godot` — the GDScript lane (godotLane.ts): the Godot editor's
//     LSP over the loopback tcp bridge, OPT-IN (MERCURY_GODOT=1) and
//     project.godot-gated.
//   · `mercury-csharp` — the Unity C# lane (unityLane.ts): PATH-probed
//     csharp-ls/OmniSharp over the Unity project root, OPT-IN
//     (MERCURY_UNITY=1) and Assets/+ProjectSettings/-gated.
//   · MERCURY_LSP_SERVERS — operator JSON (name → LspServerConfig), validated
//     against the SAME language-server Zod schema; invalid entries are skipped with a
//     debug line, never thrown (a typo must not take down boot).
//
// All of it returns {} when mercuryLspEnabled() is false — the OFF contract.

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { resolvePackagedTypescript } from '../structure/tsFacility.js'
import { LspServerConfigSchema } from './schema.js'
import { MERCURY_CLANGD_SERVER_NAME, builtinClangdServer, probeBuiltinClangd } from './clangdLane.js'
import { builtinGodotServer } from './godotLane.js'
import {
  MERCURY_CSHARP_SERVER_NAME,
  builtinUnityCsharpServer,
  unityCsharpImplementationInfo,
} from './unityLane.js'
import { MERCURY_PYRIGHT_SERVER_NAME, builtinPyrightServer, probeBuiltinPyright } from './pyrightLane.js'
import { MERCURY_RUFF_SERVER_NAME, builtinRuffServer, probeRuff } from './ruffLane.js'
import { mercuryLspEnabled, mercuryLspServersEnv } from './mercuryLsp.js'
import { resolveMercuryRespawnEntry } from './respawnEntry.js'
import { resolveWorkspaceTypescript } from './tsSidecar/sidecar.js'
import type { ScopedLspServerConfig } from './types.js'

export const MERCURY_TS_SERVER_NAME = 'mercury-ts'

const TS_EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
}

/**
 * Resolve the script the sidecar respawn should execute. The resolution
 * contract (override → bundle self → recognized Mercury argv[1], refusing
 * arbitrary hosts) lives in respawnEntry.ts, shared with the tcp-bridge
 * lanes; this wrapper only binds the sidecar's override env.
 */
function sidecarEntryScript(): { script?: string; direct?: boolean; reason?: string } {
  return resolveMercuryRespawnEntry(
    flagEnv('MERCURY_LSP_SIDECAR_ENTRY'),
    'MERCURY_LSP_SIDECAR_ENTRY',
  )
}

/**
 * Availability probe for the built-in TS sidecar — shared by the config
 * source below and the /health `lsp` check, so the doctor's evidence line
 * and the actual boot decision can never disagree.
 */
export function probeBuiltinTsServer(): {
  available: boolean
  typescriptPath?: string
  /** resolution-law provenance: which rung supplied the compiler. */
  typescriptSource?: 'project-local' | 'packaged'
  typescriptVersion?: string
  entryScript?: string
  /** True when entryScript is the sidecar module itself (spawned without the --lsp-ts-sidecar flag). */
  directEntry?: boolean
  reason?: string
} {
  // Resolution law: project-local compiler first — a project's
  // chosen typescript is never overridden; the PACKAGED compiler beside the
  // artifact (the ONE tsFacility resolver) is the zero-setup fallback rung.
  const workspacePath = resolveWorkspaceTypescript(getCwd())
  let typescriptPath = workspacePath
  let typescriptSource: 'project-local' | 'packaged' | undefined = workspacePath ? 'project-local' : undefined
  let typescriptVersion: string | undefined
  if (workspacePath) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.resolve(path.dirname(workspacePath), '..', 'package.json'), 'utf8'),
      ) as { version?: string }
      if (typeof pkg.version === 'string') typescriptVersion = pkg.version
    } catch {
      /* version unknown — the project-local path is still authoritative */
    }
  } else {
    const packaged = resolvePackagedTypescript()
    if (packaged) {
      typescriptPath = packaged.modulePath
      typescriptSource = 'packaged'
      typescriptVersion = packaged.version
    }
  }
  if (!typescriptPath) {
    return {
      available: false,
      reason: `no resolvable 'typescript' package from ${getCwd()} and no packaged compiler beside the artifact`,
    }
  }
  const entry = sidecarEntryScript()
  if (!entry.script) {
    return {
      available: false,
      typescriptPath,
      ...(typescriptSource ? { typescriptSource } : {}),
      ...(typescriptVersion ? { typescriptVersion } : {}),
      reason: entry.reason ?? 'no sidecar entry script',
    }
  }
  const probe: {
    available: boolean
    typescriptPath?: string
    typescriptSource?: 'project-local' | 'packaged'
    typescriptVersion?: string
    entryScript?: string
    directEntry?: boolean
    reason?: string
  } = { available: true, typescriptPath, entryScript: entry.script }
  if (typescriptSource) probe.typescriptSource = typescriptSource
  if (typescriptVersion) probe.typescriptVersion = typescriptVersion
  if (entry.direct) probe.directEntry = true
  return probe
}

// Spawn-time provenance: the implementation each
// lane's CONFIG was built with — the truth the boot decision actually used.
// Status surfaces read THIS first; a live probe is only the fallback for a
// lane that never built a config in this process (so a mid-session
// `npm i typescript` can never make the row claim a compiler the running
// sidecar is not driving).
const spawnImplementation = new Map<string, { source: string; version?: string }>()

function builtinTsServer(): Record<string, ScopedLspServerConfig> {
  const probe = probeBuiltinTsServer()
  if (!probe.available || !probe.typescriptPath || !probe.entryScript) {
    logForDebugging(
      `[LSP BUILTIN] mercury-ts unavailable: ${probe.reason ?? 'unknown'}`,
    )
    spawnImplementation.delete(MERCURY_TS_SERVER_NAME)
    return {}
  }
  if (probe.typescriptSource) {
    spawnImplementation.set(MERCURY_TS_SERVER_NAME, {
      source: probe.typescriptSource,
      ...(probe.typescriptVersion ? { version: probe.typescriptVersion } : {}),
    })
  }
  return {
    [MERCURY_TS_SERVER_NAME]: {
      command: process.execPath,
      // A direct entry (MERCURY_LSP_SIDECAR_ENTRY → tsSidecar/entry.ts) runs
      // the sidecar via its own direct-exec guard; a Mercury entry needs the
      // cli route flag.
      args: probe.directEntry
        ? [probe.entryScript]
        : [probe.entryScript, '--lsp-ts-sidecar'],
      extensionToLanguage: TS_EXTENSION_TO_LANGUAGE,
      transport: 'stdio',
      initializationOptions: { typescriptPath: probe.typescriptPath },
      workspaceFolder: getCwd(),
      startupTimeout: 30_000,
      maxRestarts: 2,
      scope: 'dynamic',
      source: 'mercury-builtin',
    },
  }
}

export const MERCURY_WEB_SERVER_NAME = 'mercury-web'

const WEB_EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.yaml': 'yaml',
  '.yml': 'yaml',
}

/** Lane gate: rides the IDE-hands master; `MERCURY_LSP_WEB=0`
 *  removes just the web lanes. */
export function mercuryLspWebEnabled(): boolean {
  return mercuryLspEnabled() && flagEnabled('MERCURY_LSP_WEB')
}

function webSidecarEntryScript(): { script?: string; direct?: boolean; reason?: string } {
  return resolveMercuryRespawnEntry(
    flagEnv('MERCURY_LSP_WEB_SIDECAR_ENTRY'),
    'MERCURY_LSP_WEB_SIDECAR_ENTRY',
  )
}

/**
 * The mercury-web lane: html/css/json/yaml via the BUNDLED
 * language services — the packaged rung by construction (the services live
 * inside mercury.mjs; an operator or extension server for these file extensions wins via
 * the first-wins merge, and a project's own toolchain is never touched).
 */
function builtinWebServer(): Record<string, ScopedLspServerConfig> {
  if (!mercuryLspWebEnabled()) return {}
  const entry = webSidecarEntryScript()
  if (!entry.script) {
    logForDebugging(`[LSP BUILTIN] mercury-web unavailable: ${entry.reason ?? 'no entry'}`)
    return {}
  }
  return {
    [MERCURY_WEB_SERVER_NAME]: {
      command: process.execPath,
      args: entry.direct ? [entry.script] : [entry.script, '--lsp-web-sidecar'],
      extensionToLanguage: WEB_EXTENSION_TO_LANGUAGE,
      transport: 'stdio',
      workspaceFolder: getCwd(),
      startupTimeout: 30_000,
      maxRestarts: 2,
      scope: 'dynamic',
      source: 'mercury-builtin',
    },
  }
}

/**
 * Resolution-law provenance for the STATUS surfaces: which
 * implementation + version owns a builtin lane right now. Consumed by the
 * LSP serverStatus op (and through it /health) — the row the operator reads
 * names the same truth the boot decision used, never a re-derivation.
 */
export function builtinImplementationInfo(name: string): { source: string; version?: string } | null {
  // The spawn-time record wins (C3): the row must name the truth the boot
  // decision used, never a fresh re-derivation against a changed fs.
  const recorded = spawnImplementation.get(name)
  if (recorded) return recorded
  if (name === MERCURY_TS_SERVER_NAME) {
    const p = probeBuiltinTsServer()
    if (!p.available || !p.typescriptSource) return null
    return { source: p.typescriptSource, ...(p.typescriptVersion ? { version: p.typescriptVersion } : {}) }
  }
  if (name === MERCURY_PYRIGHT_SERVER_NAME) {
    const p = probeBuiltinPyright()
    if (!p.available || !p.source) return null
    return { source: p.source, ...(p.version ? { version: p.version } : {}) }
  }
  if (name === MERCURY_RUFF_SERVER_NAME) {
    const p = probeRuff()
    if (!p.available) return null
    return { source: 'path', ...(p.version ? { version: p.version } : {}) }
  }
  if (name === MERCURY_CLANGD_SERVER_NAME) {
    const p = probeBuiltinClangd()
    if (!p.available) return null
    return { source: 'path' }
  }
  if (name === MERCURY_CSHARP_SERVER_NAME) {
    return unityCsharpImplementationInfo()
  }
  if (name === MERCURY_WEB_SERVER_NAME) {
    // The services are IN the bundle — packaged by construction.
    return { source: 'packaged' }
  }
  return null
}

function operatorEnvServers(): Record<string, ScopedLspServerConfig> {
  const raw = mercuryLspServersEnv()
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    logForDebugging(
      `[LSP BUILTIN] MERCURY_LSP_SERVERS is not valid JSON — ignored (${String(e)})`,
    )
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logForDebugging(
      '[LSP BUILTIN] MERCURY_LSP_SERVERS must be an object of name → config — ignored',
    )
    return {}
  }
  const out: Record<string, ScopedLspServerConfig> = {}
  for (const [name, config] of Object.entries(parsed as Record<string, unknown>)) {
    const result = LspServerConfigSchema().safeParse(config)
    if (!result.success) {
      logForDebugging(
        `[LSP BUILTIN] MERCURY_LSP_SERVERS['${name}'] invalid — skipped: ${result.error.message}`,
      )
      continue
    }
    out[`env:${name}`] = {
      ...result.data,
      scope: 'dynamic',
      source: 'mercury-env',
    }
  }
  return out
}

/**
 * Mercury's LSP server sources, in PRIORITY ORDER for the first-wins merge
 * in config.ts (operator env ahead of extensions ahead of builtin). Returns
 * `{ env, builtin }` so the merge site can interleave extension servers between
 * them; both empty when the bridge is off. Builtin insertion order (ts →
 * clangd → godot → csharp → pyright → ruff → web) is also the extension-claim
 * order (csharp = the Unity lane, MERCURY_UNITY-gated, claiming only .cs).
 * Every lane's extension set is disjoint from the others except `.py`, which
 * is DELIBERATELY claimed twice: pyright first = the routed SEMANTIC owner,
 * ruff second = the lint/fix/format companion the manager syncs documents to
 * and capability-routed ops (formatting, code-action merge) reach explicitly;
 * mercury-web claims only its own html/css/json/yaml family, last.
 */
export function getMercuryLspServerSources(): {
  env: Record<string, ScopedLspServerConfig>
  builtin: Record<string, ScopedLspServerConfig>
} {
  if (!mercuryLspEnabled()) return { env: {}, builtin: {} }
  const builtin = {
    ...builtinTsServer(),
    ...builtinClangdServer(),
    ...builtinGodotServer(),
    ...builtinUnityCsharpServer(),
    ...builtinPyrightServer(),
    ...builtinRuffServer(),
    ...builtinWebServer(),
  }
  // C3 spawn-time provenance for pyright: the probe the config builder just
  // used (30s cache — the SAME decision) becomes the recorded truth.
  if (MERCURY_PYRIGHT_SERVER_NAME in builtin) {
    const p = probeBuiltinPyright()
    if (p.available && p.source) {
      spawnImplementation.set(MERCURY_PYRIGHT_SERVER_NAME, {
        source: p.source,
        ...(p.version ? { version: p.version } : {}),
      })
    }
  } else {
    spawnImplementation.delete(MERCURY_PYRIGHT_SERVER_NAME)
  }
  return {
    env: operatorEnvServers(),
    builtin,
  }
}
