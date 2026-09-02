
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

function sidecarEntryScript(): { script?: string; direct?: boolean; reason?: string } {
  return resolveMercuryRespawnEntry(
    flagEnv('MERCURY_LSP_SIDECAR_ENTRY'),
    'MERCURY_LSP_SIDECAR_ENTRY',
  )
}

export function probeBuiltinTsServer(): {
  available: boolean
  typescriptPath?: string
  typescriptSource?: 'project-local' | 'packaged'
  typescriptVersion?: string
  entryScript?: string
  directEntry?: boolean
  reason?: string
} {
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

export function mercuryLspWebEnabled(): boolean {
  return mercuryLspEnabled() && flagEnabled('MERCURY_LSP_WEB')
}

function webSidecarEntryScript(): { script?: string; direct?: boolean; reason?: string } {
  return resolveMercuryRespawnEntry(
    flagEnv('MERCURY_LSP_WEB_SIDECAR_ENTRY'),
    'MERCURY_LSP_WEB_SIDECAR_ENTRY',
  )
}

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

export function builtinImplementationInfo(name: string): { source: string; version?: string } | null {
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
