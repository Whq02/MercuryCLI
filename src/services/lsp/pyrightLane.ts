// pyrightLane — the Python SEMANTIC lane.
//
// Pyright is the type-checker/navigation owner for .py/.pyi: definition,
// references, hover, symbols, rename, code actions, push diagnostics. It is
// pure JS running under Mercury's own node prerequisite — the artifact
// BUNDLES the pinned release at dist/vendor/pyright (the debugpy vendor
// discipline: vendor/pyright.lock.json + scripts/vendor/fetch-pyright.ts +
// the build step; manifest `pyright` + degraded 'python-intelligence' when
// absent) and falls back to a PATH `pyright-langserver` when the bundle is
// degraded. It ANALYSES the operator's selected Python environment — the
// shared project owner's interpreter rides workspace/configuration (the
// live `python` section resolver below) so Pyright, the Workshop kernel,
// the Debug tool and tests agree on ONE interpreter.
//
//   · default-ON under the IDE-hands bridge (MERCURY_LSP);
//     MERCURY_LSP_PYTHON=0 removes the python lanes (pyright + ruff).
//   · probe shared verbatim with /health (evidence and boot cannot disagree).
//   · formatting: pyright advertises NO formatter — the ruff companion lane
//     (ruffLane.ts) owns lint/fix/format; insertion order (pyright first)
//     keeps pyright the SEMANTIC owner of .py routing.
//
// Proofs: scripts/ide/prove-pyright-lane.ts (structural) +
// scripts/ide/prove-python-intel.ts (LIVE fixture journey on the vendored
// server).

import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { whichSync } from '../../utils/which.js'
import {
  findPythonProjectRoot,
  selectPythonInterpreter,
} from '../ide/pythonProject.js'
import { mercuryLspEnabled } from './mercuryLsp.js'
import type { ScopedLspServerConfig } from './types.js'

export const MERCURY_PYRIGHT_SERVER_NAME = 'mercury-pyright'

// Bundle-sibling resolution (the ripgrep/debugpy idiom): in the built
// artifact import.meta.url is dist/mercury.mjs → vendor/ sits beside it; in
// dev the computed dir has no tree and resolution falls to the PATH server.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.join(__filename, '../')

const PY_EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.py': 'python',
  '.pyi': 'python',
}

/** Lane gate: rides the IDE-hands master, `MERCURY_LSP_PYTHON=0` opts out. */
export function mercuryLspPythonEnabled(): boolean {
  return mercuryLspEnabled() && flagEnabled('MERCURY_LSP_PYTHON')
}

export interface PyrightProbe {
  available: boolean
  /** Resolution-law provenance: 'project-local' (the workspace's
   *  own pyright package — never overridden), 'bundled' (dist vendor tree),
   *  or 'path' (a pyright-langserver binary; ambient, ranked BELOW bundled —
   *  it is not a per-project choice). */
  source?: 'project-local' | 'bundled' | 'path'
  /** Project-local/bundled: the server entry script. Path: the binary. */
  entry?: string
  version?: string
  reason?: string
}

/** The vendored tree root, when present beside the running artifact
 *  (MERCURY_PYRIGHT_VENDOR_DIR overrides — proof/embedder seam). */
export function pyrightVendorRoot(): string | null {
  const override = flagEnv('MERCURY_PYRIGHT_VENDOR_DIR')
  const root = override && override !== '' ? override : path.resolve(__dirname, 'vendor', 'pyright')
  return existsSync(path.join(root, 'langserver.index.js')) ? root : null
}

/**
 * The WORKSPACE's own pyright package (the project-local rung —
 * a project that installed pyright chose its version; never overridden).
 * Deterministic walk-up, NOT createRequire (the bun global-cache phantom
 * guard — same law as tsFacility.resolveWorkspace).
 */
function resolveWorkspacePyright(root: string): { entry: string; version?: string } | null {
  let dir = path.resolve(root)
  for (let i = 0; i < 40; i++) {
    const pkgDir = path.join(dir, 'node_modules', 'pyright')
    const entry = path.join(pkgDir, 'langserver.index.js')
    if (existsSync(entry)) {
      let version: string | undefined
      try {
        const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { version?: string }
        if (typeof pkg.version === 'string') version = pkg.version
      } catch {
        /* version unknown — the entry is still authoritative */
      }
      return { entry, ...(version ? { version } : {}) }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

let probeCache: { at: number; key: string; result: PyrightProbe } | undefined
const PROBE_CACHE_TTL_MS = 30_000

/**
 * Availability probe — shared by the config source and /health. Resolution
 * law: the workspace's OWN pyright package first, then the
 * bundled tree (pinned, self-contained), then a PATH `pyright-langserver`
 * (ambient), honest unavailable with the remedy otherwise.
 */
export function probeBuiltinPyright(): PyrightProbe {
  const key = `${flagEnv('MERCURY_PYRIGHT_VENDOR_DIR') ?? ''}::${getCwd()}`
  const now = Date.now()
  if (probeCache && probeCache.key === key && now - probeCache.at < PROBE_CACHE_TTL_MS) {
    return probeCache.result
  }
  let result: PyrightProbe
  // Env-pin supremacy + pin honesty: an explicit
  // MERCURY_PYRIGHT_VENDOR_DIR outranks every rung (the estate's proof-seam
  // law), and a BROKEN pin refuses by name — never a silent fallback (the
  // browserResolver/tsFacility exemplars).
  const pin = flagEnv('MERCURY_PYRIGHT_VENDOR_DIR')
  if (pin && pin !== '') {
    const pinned = pyrightVendorRoot()
    if (!pinned) {
      result = {
        available: false,
        reason: `MERCURY_PYRIGHT_VENDOR_DIR set but ${pin} holds no langserver.index.js — the pin names itself, no silent fallback`,
      }
      probeCache = { at: now, key, result }
      return result
    }
    let version: string | undefined
    try {
      const vman = JSON.parse(readFileSync(path.join(pinned, '.vendor-manifest.json'), 'utf8')) as { version?: string }
      version = typeof vman.version === 'string' ? vman.version : undefined
    } catch {
      /* pinned without a manifest — still runnable; version unknown */
    }
    result = {
      available: true,
      source: 'bundled',
      entry: path.join(pinned, 'langserver.index.js'),
      ...(version ? { version } : {}),
    }
    probeCache = { at: now, key, result }
    return result
  }
  const workspace = resolveWorkspacePyright(getCwd())
  const vendorRoot = workspace ? null : pyrightVendorRoot()
  if (workspace) {
    result = {
      available: true,
      source: 'project-local',
      entry: workspace.entry,
      ...(workspace.version ? { version: workspace.version } : {}),
    }
  } else if (vendorRoot) {
    let version: string | undefined
    try {
      const vman = JSON.parse(
        readFileSync(path.join(vendorRoot, '.vendor-manifest.json'), 'utf8'),
      ) as { version?: string }
      version = typeof vman.version === 'string' ? vman.version : undefined
    } catch {
      /* vendored without its manifest — still runnable; version unknown */
    }
    result = {
      available: true,
      source: 'bundled',
      entry: path.join(vendorRoot, 'langserver.index.js'),
      ...(version ? { version } : {}),
    }
  } else {
    const onPath = whichSync('pyright-langserver')
    result = onPath
      ? { available: true, source: 'path', entry: onPath }
      : {
          available: false,
          reason:
            'no bundled pyright (rebuild: bun run scripts/vendor/fetch-pyright.ts && bun run build.ts) and no pyright-langserver on PATH (npm i -g pyright)',
        }
  }
  probeCache = { at: now, key, result }
  return result
}

/** Test-only: drop the probe cache (gating proofs). */
export function _resetPyrightProbeCacheForTesting(): void {
  probeCache = undefined
}

/**
 * LIVE workspace/configuration answer for pyright's `python`/`python.analysis`
 * section requests: the SHARED project interpreter (services/ide/
 * pythonProject.ts) — consulted per request by the manager, so a venv switch
 * (env-keyed selection cache) reaches pyright without a reconfig dance.
 */
export function pyrightWorkspaceConfiguration(section: string | undefined): unknown {
  if (section === 'python') {
    const selection = selectPythonInterpreter()
    return selection.state === 'ok' ? { pythonPath: selection.command } : {}
  }
  // python.analysis / basedpyright-style sections: defer to project config
  // files (pyrightconfig.json / pyproject [tool.pyright]) — answer null so
  // the server uses its own resolution rather than an empty override.
  return null
}

/** The builtin `mercury-pyright` server source (empty when gated/absent). */
export function builtinPyrightServer(): Record<string, ScopedLspServerConfig> {
  if (!mercuryLspPythonEnabled()) return {}
  const probe = probeBuiltinPyright()
  if (!probe.available || !probe.entry) {
    logForDebugging(`[LSP BUILTIN] mercury-pyright unavailable: ${probe.reason ?? 'unknown'}`)
    return {}
  }
  const workspaceFolder = findPythonProjectRoot(getCwd()).root
  return {
    [MERCURY_PYRIGHT_SERVER_NAME]: {
      // JS-entry sources (bundled + project-local) run under Mercury's own
      // node; only the PATH source is a directly executable binary.
      command: probe.source === 'path' ? probe.entry : process.execPath,
      args: probe.source === 'path' ? ['--stdio'] : [probe.entry, '--stdio'],
      extensionToLanguage: { ...PY_EXTENSION_TO_LANGUAGE },
      transport: 'stdio',
      workspaceFolder,
      startupTimeout: 30_000,
      maxRestarts: 2,
      scope: 'dynamic',
      source: 'mercury-builtin',
    },
  }
}
