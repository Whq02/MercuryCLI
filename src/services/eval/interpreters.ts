
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  evalEnabled,
  evalLanguageEnabled,
  evalPythonOverride,
  type EvalLanguage,
  type EvalLanguageAvailability,
} from './contracts.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'

const PROBE_TTL_MS = 30_000
const PROBE_TIMEOUT_MS = 4_000

type ProbeResult = { ok: true; version: string } | { ok: false; whyNot: string }
interface ProbeEntry {
  at: number
  result: ProbeResult | null
  inflight: Promise<ProbeResult> | null
}
const probeCache = new Map<string, ProbeEntry>()

export function _resetInterpreterProbeCacheForTesting(): void {
  probeCache.clear()
}

function runProbe(path: string, versionArgs: string[]): Promise<ProbeResult> {
  return new Promise(resolve => {
    try {
      execFile(
        path,
        versionArgs,
        { windowsHide: true, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', env: { ...subprocessEnv() } },
        (error, stdout, stderr) => {
          if (error) {
            const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
            resolve({ ok: false, whyNot: typeof code === 'number' ? `exit ${code}` : String(error.message) })
            return
          }
          resolve({ ok: true, version: `${stdout ?? ''}${stderr ?? ''}`.trim() })
        },
      )
    } catch (error) {
      resolve({ ok: false, whyNot: String(error) })
    }
  })
}

function readProbe(path: string, versionArgs: string[]): ProbeResult | null {
  const key = `${path} ${versionArgs.join(' ')}`
  let entry = probeCache.get(key)
  if (!entry) {
    entry = { at: 0, result: null, inflight: null }
    probeCache.set(key, entry)
  }
  const stale = entry.result === null || Date.now() - entry.at >= PROBE_TTL_MS
  if (stale && entry.inflight === null) {
    const owner = entry
    owner.inflight = runProbe(path, versionArgs).then(result => {
      owner.result = result
      owner.at = Date.now()
      owner.inflight = null
      return result
    })
  }
  return entry.result
}

function pythonVersionTuple(version: string): [number, number] | null {
  const match = /Python\s+(\d+)\.(\d+)/.exec(version)
  if (!match) return null
  return [Number(match[1]), Number(match[2])]
}

export function pythonCandidates(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = []
  const explicit = evalPythonOverride()
  if (explicit) candidates.push(explicit)
  const venv = env.VIRTUAL_ENV?.trim()
  if (venv) {
    const bin = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
    if (existsSync(bin)) candidates.push(bin)
  }
  const local =
    process.platform === 'win32'
      ? join(cwd, '.venv', 'Scripts', 'python.exe')
      : join(cwd, '.venv', 'bin', 'python')
  if (existsSync(local)) candidates.push(local)
  candidates.push('python3')
  return candidates
}

export function discoverPython(cwd: string): EvalLanguageAvailability {
  if (process.platform === 'win32') {
    return {
      language: 'py',
      available: false,
      whyNot: 'Python eval kernels are POSIX-only in v1 (the fd-3 protocol pipe); the Windows packet is queued',
    }
  }
  let lastWhy = 'no python3 found on PATH'
  for (const candidate of pythonCandidates(cwd)) {
    const probe = readProbe(candidate, ['--version'])
    if (probe === null) {
      return { language: 'py', available: false, probing: true, whyNot: `probing ${candidate} (the first answer is pending)` }
    }
    if (!probe.ok) {
      lastWhy = `${candidate}: ${probe.whyNot}`
      continue
    }
    const version = pythonVersionTuple(probe.version)
    if (!version || version[0] < 3 || (version[0] === 3 && version[1] < 10)) {
      lastWhy = `${candidate} is ${probe.version} — Python 3.10+ is required`
      continue
    }
    return { language: 'py', available: true, interpreterPath: candidate, version: probe.version }
  }
  return { language: 'py', available: false, whyNot: lastWhy }
}

export function nodeBinaryForKernels(): { path: string; version: string } | { whyNot: string } | { probing: true } {
  const own = process.execPath
  if (/node/i.test(basename(own))) return { path: own, version: process.version }
  const probe = readProbe('node', ['--version'])
  if (probe === null) return { probing: true }
  if (probe.ok) return { path: 'node', version: probe.version }
  return { whyNot: `no node binary reachable (host: ${own}; PATH probe failed: ${probe.whyNot})` }
}

export function discoverJs(): EvalLanguageAvailability {
  const node = nodeBinaryForKernels()
  if ('probing' in node) return { language: 'js', available: false, probing: true, whyNot: 'probing node (the first answer is pending)' }
  if ('whyNot' in node) return { language: 'js', available: false, whyNot: node.whyNot }
  return { language: 'js', available: true, interpreterPath: node.path, version: node.version }
}

export function evalAvailability(cwd: string): EvalLanguageAvailability[] {
  const rows: EvalLanguageAvailability[] = []
  for (const language of ['py', 'js'] as EvalLanguage[]) {
    if (!evalEnabled()) {
      rows.push({ language, available: false, whyNot: 'MERCURY_EVAL is off' })
      continue
    }
    if (!evalLanguageEnabled(language)) {
      rows.push({
        language,
        available: false,
        whyNot: language === 'py' ? 'MERCURY_EVAL_PY is off' : 'MERCURY_EVAL_JS is off',
      })
      continue
    }
    rows.push(language === 'py' ? discoverPython(cwd) : discoverJs())
  }
  return rows
}

export async function primeEvalAvailability(cwd: string): Promise<EvalLanguageAvailability[]> {
  for (let pass = 0; pass < 8; pass++) {
    const rows = evalAvailability(cwd)
    if (!rows.some(row => row.probing)) return rows
    const inflight = [...probeCache.values()]
      .map(entry => entry.inflight)
      .filter((probe): probe is Promise<ProbeResult> => probe !== null)
    if (inflight.length === 0) return rows
    await Promise.all(inflight)
  }
  return evalAvailability(cwd)
}
