
import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import envPaths from 'env-paths'
import { flagEnv } from '../../substrate/flagRegistry.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.join(__filename, '../')

export interface PythonDebuggerProvenance {
  interpreter?: string
  interpreterVersion?: string
  adapterSource: 'bundled' | 'environment' | 'none'
  debugpyVersion?: string
  adapterPath?: string
  bundleState: 'vendored' | 'absent'
  lastProbe: string
}

export type PythonAdapterResolution =
  | {
      state: 'ok'
      command: string
      args: string[]
      provenance: PythonDebuggerProvenance
    }
  | {
      state: 'unavailable'
      reason: string
      remedy: string
      provenance: PythonDebuggerProvenance
    }

const PROBE_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 30_000

const UNAVAILABLE_REMEDY =
  'rebuild the artifact with the pinned adapter (bun run scripts/vendor/fetch-debugpy.ts && bun run build.ts), ' +
  'or install debugpy into the interpreter (pip install debugpy)'


let pycachePrefixMemo: string | null | undefined
function pycachePrefix(): string | null {
  if (pycachePrefixMemo !== undefined) return pycachePrefixMemo
  try {
    const manifestPath = path.resolve(__dirname, 'manifest.json')
    let buildKey = 'dev'
    if (existsSync(manifestPath)) {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { buildTree?: string }
      if (typeof m.buildTree === 'string' && m.buildTree.length >= 12) {
        buildKey = m.buildTree.slice(0, 12)
      }
    }
    const parent = path.join(envPaths('mercury').cache, 'pycache')
    const root = path.join(parent, buildKey)
    mkdirSync(root, { recursive: true })
    try {
      for (const entry of readdirSync(parent)) {
        if (entry !== buildKey) rmSync(path.join(parent, entry), { recursive: true, force: true })
      }
    } catch {
    }
    pycachePrefixMemo = root
  } catch {
    pycachePrefixMemo = null
  }
  return pycachePrefixMemo
}

export function pythonSpawnEnv(): NodeJS.ProcessEnv {
  const prefix = pycachePrefix()
  return prefix !== null
    ? { ...subprocessEnv(), PYTHONPYCACHEPREFIX: prefix }
    : { ...subprocessEnv(), PYTHONDONTWRITEBYTECODE: '1' }
}

export function debugpyVendorRoot(): string | null {
  const override = flagEnv('MERCURY_DEBUGPY_VENDOR_DIR')
  const root = override && override !== '' ? override : path.resolve(__dirname, 'vendor', 'debugpy')
  return existsSync(path.join(root, 'debugpy', 'adapter', '__main__.py')) ? root : null
}

export function debugpyVendorDiagnosis(): {
  pin: string | null
  pinBroken: boolean
  bundledPresent: boolean
} {
  const override = flagEnv('MERCURY_DEBUGPY_VENDOR_DIR')
  const pin = override && override !== '' ? override : null
  const adapterAt = (root: string): boolean => existsSync(path.join(root, 'debugpy', 'adapter', '__main__.py'))
  return {
    pin,
    pinBroken: pin !== null && !adapterAt(pin),
    bundledPresent: adapterAt(path.resolve(__dirname, 'vendor', 'debugpy')),
  }
}

function vendoredVersion(root: string): string | undefined {
  try {
    const m = JSON.parse(
      readFileSync(path.join(root, '.vendor-manifest.json'), 'utf8'),
    ) as { version?: string }
    return typeof m.version === 'string' ? m.version : undefined
  } catch {
    return undefined
  }
}

export function defaultInterpreterCandidates(): string[] {
  const out = ['python3', 'python']
  if (process.platform === 'win32') out.push('py')
  if (process.platform === 'darwin') out.push('/usr/bin/python3')
  return out
}

export interface ResolveOptions {
  candidates?: string[]
  exclusive?: boolean
}

interface ProbeOutcome {
  ok: boolean
  interpreterVersion?: string
  debugpyVersion?: string
  detail: string
}

function probeInterpreter(interpreter: string, vendorRoot: string | null): ProbeOutcome {
  const script =
    'import sys\n' +
    'assert sys.version_info >= (3, 8), "python %d.%d < 3.8" % sys.version_info[:2]\n' +
    (vendorRoot ? `sys.path.insert(0, ${JSON.stringify(vendorRoot)})\n` : '') +
    'import debugpy\n' +
    'import debugpy._vendored.force_pydevd\n' +
    'print("%d.%d.%d" % sys.version_info[:3], debugpy.__version__)\n'
  try {
    const r = spawnSync(interpreter, ['-c', script], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      env: pythonSpawnEnv(),
    })
    if (r.error) throw r.error
    if (r.status === 0) {
      const [pyVersion, debugpyVersion] = (r.stdout ?? '').trim().split(/\s+/)
      return {
        ok: true,
        ...(pyVersion ? { interpreterVersion: pyVersion } : {}),
        ...(debugpyVersion ? { debugpyVersion } : {}),
        detail: `pydevd import chain OK via ${interpreter}${vendorRoot ? ' (vendored tree)' : ' (installed module)'}`,
      }
    }
    const tail = `${r.stderr ?? ''}`.trim().split('\n').slice(-2).join(' · ').slice(0, 220)
    return { ok: false, detail: `${interpreter}: ${tail || `probe exited ${r.status ?? 'null'}`}` }
  } catch (e) {
    return { ok: false, detail: `${interpreter}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

let cache: { at: number; key: string; result: PythonAdapterResolution } | null = null

export function _resetDebugpyResolverForTesting(): void {
  cache = null
}

export function resolvePythonDebugAdapter(opts?: ResolveOptions): PythonAdapterResolution {
  const vendorRoot = debugpyVendorRoot()
  const candidates =
    opts?.exclusive && opts.candidates?.[0]
      ? [opts.candidates[0]]
      : (opts?.candidates?.length ? opts.candidates : defaultInterpreterCandidates())
  const key = `${opts?.exclusive ? 'x:' : ''}${candidates.join(',')}::${vendorRoot ?? 'no-vendor'}`
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.result

  const bundleState: PythonDebuggerProvenance['bundleState'] = vendorRoot ? 'vendored' : 'absent'
  const failures: string[] = []
  let result: PythonAdapterResolution | null = null

  for (const interpreter of candidates) {
    if (vendorRoot) {
      const probe = probeInterpreter(interpreter, vendorRoot)
      if (probe.ok) {
        result = {
          state: 'ok',
          command: interpreter,
          args: [path.join(vendorRoot, 'debugpy', 'adapter')],
          provenance: {
            interpreter,
            ...(probe.interpreterVersion ? { interpreterVersion: probe.interpreterVersion } : {}),
            adapterSource: 'bundled',
            debugpyVersion: vendoredVersion(vendorRoot) ?? probe.debugpyVersion ?? 'unknown',
            adapterPath: vendorRoot,
            bundleState,
            lastProbe: probe.detail,
          },
        }
        break
      }
      failures.push(probe.detail)
    }
    const envProbe = probeInterpreter(interpreter, null)
    if (envProbe.ok) {
      result = {
        state: 'ok',
        command: interpreter,
        args: ['-m', 'debugpy.adapter'],
        provenance: {
          interpreter,
          ...(envProbe.interpreterVersion ? { interpreterVersion: envProbe.interpreterVersion } : {}),
          adapterSource: 'environment',
          ...(envProbe.debugpyVersion ? { debugpyVersion: envProbe.debugpyVersion } : {}),
          adapterPath: '-m debugpy.adapter',
          bundleState,
          lastProbe: envProbe.detail,
        },
      }
      break
    }
    if (!vendorRoot) failures.push(envProbe.detail)
  }

  if (!result) {
    const reason =
      failures.length > 0
        ? `no viable Python debug interpreter${opts?.exclusive ? ` (explicit pin ${candidates[0]})` : ''} — ${failures.slice(0, 3).join(' | ')}`
        : `no Python interpreter found (tried ${candidates.join(', ')})`
    const vendorDiag = debugpyVendorDiagnosis()
    const remedy = vendorDiag.pinBroken
      ? `MERCURY_DEBUGPY_VENDOR_DIR points at ${vendorDiag.pin}, which holds no debugpy adapter${
          vendorDiag.bundledPresent
            ? " — the artifact's own vendored debugpy IS present; unset the pin to use it"
            : ''
        }; fix or unset the pin`
      : UNAVAILABLE_REMEDY
    result = {
      state: 'unavailable',
      reason,
      remedy,
      provenance: {
        adapterSource: 'none',
        bundleState,
        lastProbe: failures[0] ?? 'no interpreter candidates resolved',
      },
    }
  }

  cache = { at: Date.now(), key, result }
  return result
}
