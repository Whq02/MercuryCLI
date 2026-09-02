// ============================================================================
//  debugpyResolver — ONE owner for Python debug-adapter resolution (ide
// The builtin `python` DAP adapter would otherwise be a static
//  `python3 -m debugpy.adapter` guess; this resolver makes it truthful:
//
//    interpreter  →  first HEALTH-CHECKED candidate (explicit override wins;
// 's shared Python project owner becomes the
//                    explicit source), where health = the interpreter can
//                    actually import debugpy's pydevd chain — the exact
//                    import path a broken CPython build snaps on (the
//                    Homebrew pyexpat/libexpat mismatch: the
//                    debuggee dies at `import debugpy._vendored.force_pydevd`
//                    and the adapter never answers `launch`).
//    adapter      →  1. the VENDORED tree beside the built artifact
//                       (dist/vendor/debugpy — pinned wheel, build-verified;
//                       invocation `<python> <root>/debugpy/adapter`, the
//                       directory entry proven against the extracted wheel);
//                    2. the installed `debugpy` module (`-m debugpy.adapter`);
//                    3. an honest unavailable result with the concrete remedy.
//
//  Every consumer — the Debug tool's launch path (via dapClient's builtin
//  table), /health, /capabilities readiness — reads the SAME probe, so
//  claimed readiness and launch behavior cannot disagree.
//  Proofs: scripts/ide/prove-debugpy-journey.ts · scripts/ide/run-all.sh.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import envPaths from 'env-paths'
import { flagEnv } from '../../substrate/flagRegistry.js'

// Bundle-sibling resolution (the ripgrep idiom): in the built artifact
// import.meta.url is dist/mercury.mjs, so vendor/ sits one level up from the
// running file; in dev (bun over src/) the computed dir has no vendor tree
// and resolution falls through to the installed-module route.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.join(__filename, '../')

export interface PythonDebuggerProvenance {
  /** The selected interpreter command/path, when one was viable. */
  interpreter?: string
  interpreterVersion?: string
  adapterSource: 'bundled' | 'environment' | 'none'
  debugpyVersion?: string
  /** Bundled: the vendor root dir. Environment: the module invocation. */
  adapterPath?: string
  /** Whether the artifact beside this process carries the vendored tree. */
  bundleState: 'vendored' | 'absent'
  /** One-line evidence from the probe that produced this resolution. */
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

// A healthy probe answers in ~300-700ms idle, but a POOLED gate run loads
// every core — 8s tolerates contention while still catching a wedged
// interpreter; the 30s result cache keeps status surfaces cheap either way.
const PROBE_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 30_000

const UNAVAILABLE_REMEDY =
  'rebuild the artifact with the pinned adapter (bun run scripts/vendor/fetch-debugpy.ts && bun run build.ts), ' +
  'or install debugpy into the interpreter (pip install debugpy)'

// ── W7-E (L19: managed payloads do not self-mutate) ──────────────────
//  Both python spawn sites (the resolver probe below and dapClient's adapter
//  launch) import the VENDORED debugpy tree — without a cache root, CPython
//  writes __pycache__ beside the vendored sources, growing the managed
//  version directory (the F5b field finding: 105 bytecode files) and turning
//  a repeat install into a false same-version change (installLayout's strict
//  payload digest). Bytecode now lands in Mercury's runtime cache, keyed by
//  the build tree so a payload swap can never serve stale bytecode; if the
//  cache root cannot exist, bytecode is suppressed entirely — the payload
//  stays byte-stable either way.

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
    // BOUNDED (UN-53): one live key — bytecode for retired build trees is
    // dead weight; best-effort reap keeps the cache from accumulating a
    // directory per historical build. Failure never disturbs resolution.
    try {
      for (const entry of readdirSync(parent)) {
        if (entry !== buildKey) rmSync(path.join(parent, entry), { recursive: true, force: true })
      }
    } catch {
      // best-effort
    }
    pycachePrefixMemo = root
  } catch {
    pycachePrefixMemo = null
  }
  return pycachePrefixMemo
}

/** The spawn env for EVERY bundled-python execution: the inherited env plus
 *  the byte-stability contract — PYTHONPYCACHEPREFIX into the build-keyed
 *  runtime cache, or no bytecode at all when the cache root is unavailable. */
export function pythonSpawnEnv(): NodeJS.ProcessEnv {
  const prefix = pycachePrefix()
  return prefix !== null
    ? { ...subprocessEnv(), PYTHONPYCACHEPREFIX: prefix }
    : { ...subprocessEnv(), PYTHONDONTWRITEBYTECODE: '1' }
}

/** The vendored tree root, when present. Env override (proof/embedder seam,
 *  registered as MERCURY_DEBUGPY_VENDOR_DIR) beats the bundle-sibling path. */
export function debugpyVendorRoot(): string | null {
  const override = flagEnv('MERCURY_DEBUGPY_VENDOR_DIR')
  const root = override && override !== '' ? override : path.resolve(__dirname, 'vendor', 'debugpy')
  return existsSync(path.join(root, 'debugpy', 'adapter', '__main__.py')) ? root : null
}

/** The pin-vs-pack diagnosis (FC-106): a broken MERCURY_DEBUGPY_VENDOR_DIR
 *  must never be remedied with "rebuild the artifact" while the artifact's
 *  own vendored debugpy sits present and healthy beside it — the pin is
 *  exclusive (the js-debug precedent), so the remedy names the pin. */
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

/** Default interpreter candidates, most preferred first. The shared Python
 *  project owner passes its own
 *  ordered list through ResolveOptions; these are the bare-machine fallbacks. */
export function defaultInterpreterCandidates(): string[] {
  const out = ['python3', 'python']
  // The Windows Python Launcher (FC-054): a box whose only Python is
  // reachable through `py` reported the debugpy lane unavailable with a
  // remedy naming neither the cause nor the launcher. `py` resolves last so
  // a real python/python3 on PATH keeps winning.
  if (process.platform === 'win32') out.push('py')
  // The macOS system python (CommandLineTools) — the healthy fallback when a
  // package-manager python ships broken C extensions (the pyexpat class).
  if (process.platform === 'darwin') out.push('/usr/bin/python3')
  return out
}

export interface ResolveOptions {
  /** Ordered interpreter candidates (the project owner's selection first).
   *  Omitted ⇒ defaultInterpreterCandidates(). */
  candidates?: string[]
  /** True when candidates[0] is an EXPLICIT operator pin: resolution never
   *  falls past it — a broken pin reports honest-unavailable naming the pin,
   *  never a silent substitute. */
  exclusive?: boolean
}

interface ProbeOutcome {
  ok: boolean
  interpreterVersion?: string
  debugpyVersion?: string
  detail: string
}

/**
 * One spawn per (interpreter, source): verifies the version floor (≥3.8) AND
 * that the pydevd import chain the DEBUGGEE needs actually loads — the exact
 * chain a broken interpreter snaps on. For the bundled source the vendor root
 * rides sys.path; for the environment source the installed module must
 * satisfy it. Prints `<py-version> <debugpy-version>` on success.
 */
function probeInterpreter(interpreter: string, vendorRoot: string | null): ProbeOutcome {
  const script =
    'import sys\n' +
    'assert sys.version_info >= (3, 8), "python %d.%d < 3.8" % sys.version_info[:2]\n' +
    (vendorRoot ? `sys.path.insert(0, ${JSON.stringify(vendorRoot)})\n` : '') +
    'import debugpy\n' +
    'import debugpy._vendored.force_pydevd\n' +
    'print("%d.%d.%d" % sys.version_info[:3], debugpy.__version__)\n'
  try {
    // env spread is load-bearing: Bun's spawnSync drops live env mutations
    // unless the whole env is passed explicitly (the recorded house lesson).
    // W7-E: the byte-stability env — the probe imports the vendored
    // tree, so IT is a payload writer without the cache prefix (L19).
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

/** TEST-ONLY: drop the resolution cache (availability-path proofs). */
export function _resetDebugpyResolverForTesting(): void {
  cache = null
}

/**
 * Resolve the Python debug adapter. Deterministic, cached 30s. Never throws —
 * the unavailable arm carries the exact reason + remedy.
 */
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
    // 1. the vendored tree (pinned wheel beside the artifact) — preferred.
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
    // 2. the installed debugpy module.
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
    // 3. honest unavailability with the concrete remedy.
    const reason =
      failures.length > 0
        ? `no viable Python debug interpreter${opts?.exclusive ? ` (explicit pin ${candidates[0]})` : ''} — ${failures.slice(0, 3).join(' | ')}`
        : `no Python interpreter found (tried ${candidates.join(', ')})`
    // The remedy must name the actual fault (FC-106): a pin at a missing
    // directory is the operator's own knob, not a broken install.
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

// Status-surface provenance moved to the project owner:
// services/ide/pythonProject.ts projectPythonDebuggerProvenance() — ONE
// consumer path, shared interpreter selection.
