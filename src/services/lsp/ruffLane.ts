
import { spawnSync } from 'node:child_process'
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
}

let probeCache: { at: number; result: RuffProbe } | undefined
const PROBE_CACHE_TTL_MS = 30_000

function versionAtLeast(v: string, floor: [number, number, number]): boolean {
  const parts = v.split('.').map(n => Number(n))
  const [a, b, c] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
  if (a !== floor[0]) return a > floor[0]
  if (b !== floor[1]) return b > floor[1]
  return c >= floor[2]
}

export function probeRuff(): RuffProbe {
  const now = Date.now()
  if (probeCache && now - probeCache.at < PROBE_CACHE_TTL_MS) return probeCache.result
  let result: RuffProbe
  const bin = whichSync('ruff')
  if (!bin) {
    result = {
      available: false,
      reason: 'no ruff on PATH (install: brew install ruff · pipx install ruff · uv tool install ruff) — lint/fix/format for Python stays off',
    }
  } else {
    try {
      const r = spawnSync(bin, ['--version'], { windowsHide: true, timeout: 8_000, encoding: 'utf8', env: { ...languageServerEnv() } })
      const version = (r.stdout ?? '').trim().replace(/^ruff\s+/, '')
      if (r.status !== 0 || !version) {
        result = { available: false, ruffPath: bin, reason: `ruff --version failed (exit ${r.status ?? 'null'})` }
      } else if (!versionAtLeast(version, RUFF_SERVER_FLOOR)) {
        result = {
          available: false,
          ruffPath: bin,
          version,
          reason: `ruff ${version} predates \`ruff server\` (needs ≥${RUFF_SERVER_FLOOR.join('.')}) — upgrade ruff`,
        }
      } else {
        result = { available: true, ruffPath: bin, version }
      }
    } catch (e) {
      result = { available: false, ruffPath: bin, reason: `ruff probe failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  probeCache = { at: now, result }
  return result
}

export function _resetRuffProbeCacheForTesting(): void {
  probeCache = undefined
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
