
import { execFile } from 'node:child_process'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { languageServerEnv } from '../../utils/subprocessEnv.js'
import { whichSync } from '../../utils/which.js'
import { findPythonProjectRoot } from '../ide/pythonProject.js'
import { mercuryLspEnabled } from './mercuryLsp.js'
import type { ScopedLspServerConfig } from './types.js'

export const MERCURY_RUFF_SERVER_NAME = 'mercury-ruff'

const RUFF_SERVER_FLOOR: [number, number, number] = [0, 5, 3]

export interface RuffProbe {
  available: boolean
  ruffPath?: string
  version?: string
  reason?: string
  probing?: true
}

const VERSION_TTL_MS = 30_000
const VERSION_TIMEOUT_MS = 8_000

type VersionResult = { ok: true; version: string } | { ok: false; reason: string }
interface VersionEntry {
  at: number
  result: VersionResult | null
  inflight: Promise<VersionResult> | null
}
const versionCache = new Map<string, VersionEntry>()

function versionAtLeast(v: string, floor: [number, number, number]): boolean {
  const parts = v.split('.').map(n => Number(n))
  const [a, b, c] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
  if (a !== floor[0]) return a > floor[0]
  if (b !== floor[1]) return b > floor[1]
  return c >= floor[2]
}

function runVersionProbe(bin: string): Promise<VersionResult> {
  return new Promise(resolve => {
    try {
      execFile(
        bin,
        ['--version'],
        { windowsHide: true, timeout: VERSION_TIMEOUT_MS, encoding: 'utf8', env: { ...languageServerEnv() } },
        (error, stdout) => {
          const version = String(stdout ?? '').trim().replace(/^ruff\s+/, '')
          if (error || !version) {
            const code = (error as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code
            const why = typeof code === 'number' ? `exit ${code}` : error ? error.message : 'no output'
            resolve({ ok: false, reason: `ruff --version failed (${why})` })
            return
          }
          resolve({ ok: true, version })
        },
      )
    } catch (e) {
      resolve({ ok: false, reason: `ruff probe failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}

function readVersion(bin: string): VersionResult | null {
  let entry = versionCache.get(bin)
  if (!entry) {
    entry = { at: 0, result: null, inflight: null }
    versionCache.set(bin, entry)
  }
  const stale = entry.result === null || Date.now() - entry.at >= VERSION_TTL_MS
  if (stale && entry.inflight === null) {
    const owner = entry
    owner.inflight = runVersionProbe(bin).then(result => {
      owner.result = result
      owner.at = Date.now()
      owner.inflight = null
      return result
    })
  }
  return entry.result
}

export function probeRuff(): RuffProbe {
  const bin = whichSync('ruff')
  if (!bin) {
    return {
      available: false,
      reason: 'no ruff on PATH (install: brew install ruff · pipx install ruff · uv tool install ruff) — lint/fix/format for Python stays off',
    }
  }
  const version = readVersion(bin)
  if (version === null) return { available: true, ruffPath: bin, probing: true }
  if (!version.ok) return { available: false, ruffPath: bin, reason: version.reason }
  if (!versionAtLeast(version.version, RUFF_SERVER_FLOOR)) {
    return {
      available: false,
      ruffPath: bin,
      version: version.version,
      reason: `ruff ${version.version} predates \`ruff server\` (needs ≥${RUFF_SERVER_FLOOR.join('.')}) — upgrade ruff`,
    }
  }
  return { available: true, ruffPath: bin, version: version.version }
}

export async function primeRuffProbe(): Promise<RuffProbe> {
  const first = probeRuff()
  if (!first.probing || !first.ruffPath) return first
  const inflight = versionCache.get(first.ruffPath)?.inflight
  if (inflight) await inflight
  return probeRuff()
}

export function _resetRuffProbeCacheForTesting(): void {
  versionCache.clear()
}

export function builtinRuffServer(): Record<string, ScopedLspServerConfig> {
  if (!mercuryLspEnabled() || !flagEnabled('MERCURY_LSP_PYTHON')) return {}
  const probe = probeRuff()
  if (!probe.available || !probe.ruffPath) {
    logForDebugging(`[LSP BUILTIN] mercury-ruff unavailable: ${probe.reason ?? 'unknown'}`)
    return {}
  }
  return {
    [MERCURY_RUFF_SERVER_NAME]: {
      command: probe.ruffPath,
      args: ['server'],
      extensionToLanguage: { '.py': 'python' },
      transport: 'stdio',
      workspaceFolder: findPythonProjectRoot(getCwd()).root,
      startupTimeout: 15_000,
      maxRestarts: 2,
      scope: 'dynamic',
      source: 'mercury-builtin',
    },
  }
}
