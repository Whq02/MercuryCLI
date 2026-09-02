// ruffLane — the Python LINT/FIX/FORMAT companion (`mercury-ruff`,
// Ruff is deliberately NOT a Pyright replacement: pyright owns
// semantics/navigation; ruff owns lint diagnostics, fix code actions,
// formatting and import organization. Both claim `.py` — insertion order in
// builtinServers (pyright BEFORE ruff) keeps pyright the ROUTED semantic
// owner, while the manager's multi-claimant document sync
// feeds ruff didOpen/didChange/didSave so its push diagnostics and code
// actions stay live; capability-routed operations (formatDocument,
// codeActions merge) reach it explicitly via getServersForFile.
//
//   · NOT vendored (operator-installed binary only — platform-specific
//     distribution is out of this's scope; the deliberate
//     non-vendored decision holds);
//   · binary-gated: PATH `ruff` with `server` support (stable since 0.5.3;
//     probed by VERSION, cached 30s, shared with /health);
//   · same lane flag as pyright (MERCURY_LSP_PYTHON=0 removes both).

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

/** `ruff server` left preview and stabilized in 0.5.3 (2024) — refuse older
 *  binaries with a precise reason instead of a wedged spawn. */
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

/** Availability probe — shared by the config source and /health. */
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
      // env spread is load-bearing (Bun spawnSync drops live env mutations).
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

/** Test-only: drop the probe cache (gating proofs). */
export function _resetRuffProbeCacheForTesting(): void {
  probeCache = undefined
}

/** The builtin `mercury-ruff` companion source (empty when gated/absent).
 *  MUST be merged AFTER builtinPyrightServer() — insertion order is the
 *  semantic-ownership contract for `.py`. */
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
