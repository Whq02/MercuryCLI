
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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.join(__filename, '../')

const PY_EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.py': 'python',
  '.pyi': 'python',
}

export function mercuryLspPythonEnabled(): boolean {
  return mercuryLspEnabled() && flagEnabled('MERCURY_LSP_PYTHON')
}

export interface PyrightProbe {
  available: boolean
  source?: 'project-local' | 'bundled' | 'path'
  entry?: string
  version?: string
  reason?: string
}

export function pyrightVendorRoot(): string | null {
  const override = flagEnv('MERCURY_PYRIGHT_VENDOR_DIR')
  const root = override && override !== '' ? override : path.resolve(__dirname, 'vendor', 'pyright')
  return existsSync(path.join(root, 'langserver.index.js')) ? root : null
}

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

export function probeBuiltinPyright(): PyrightProbe {
  const key = `${flagEnv('MERCURY_PYRIGHT_VENDOR_DIR') ?? ''}::${getCwd()}`
  const now = Date.now()
  if (probeCache && probeCache.key === key && now - probeCache.at < PROBE_CACHE_TTL_MS) {
    return probeCache.result
  }
  let result: PyrightProbe
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

export function _resetPyrightProbeCacheForTesting(): void {
  probeCache = undefined
}

export function pyrightWorkspaceConfiguration(section: string | undefined): unknown {
  if (section === 'python') {
    const selection = selectPythonInterpreter()
    return selection.state === 'ok' ? { pythonPath: selection.command } : {}
  }
  return null
}

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
