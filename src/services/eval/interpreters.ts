// ============================================================================
//  services/eval/interpreters — interpreter discovery + availability truth.
//
//  Python ladder (spec'd): explicit MERCURY_EVAL_PYTHON → the active
//  virtualenv → <cwd>/.venv → system python3. The managed-venv rung is a
//  named scope fence (deferred). Every probe is a real --version spawn with
//  a bounded timeout, cached briefly; /health and doctor read the SAME
//  probe, so the advertised schema and the runnable truth cannot drift.
// ============================================================================

import { spawnSync } from 'node:child_process'
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
const probeCache = new Map<string, { at: number; result: ProbeResult }>()

type ProbeResult = { ok: true; version: string } | { ok: false; whyNot: string }

export function _resetInterpreterProbeCacheForTesting(): void {
  probeCache.clear()
}

function probeBinary(path: string, versionArgs: string[]): ProbeResult {
  const key = `${path} ${versionArgs.join(' ')}`
  const cached = probeCache.get(key)
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.result
  let result: ProbeResult
  try {
    const run = spawnSync(path, versionArgs, {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...subprocessEnv() },
    })
    if (run.error || run.status !== 0) {
      result = { ok: false, whyNot: run.error ? String(run.error.message) : `exit ${run.status}` }
    } else {
      result = { ok: true, version: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() }
    }
  } catch (error) {
    result = { ok: false, whyNot: String(error) }
  }
  probeCache.set(key, { at: Date.now(), result })
  return result
}

function pythonVersionTuple(version: string): [number, number] | null {
  const match = /Python\s+(\d+)\.(\d+)/.exec(version)
  if (!match) return null
  return [Number(match[1]), Number(match[2])]
}

/** The Python interpreter candidates, in ladder order (existing files /
 *  bare PATH names only). */
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
    const probe = probeBinary(candidate, ['--version'])
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

/** The node binary kernels spawn: the host's own execPath when the host IS
 *  node (the shipped dist), else a PATH probe (the bun-driven dev/prover
 *  case — the dist never depends on this rung). */
export function nodeBinaryForKernels(): { path: string; version: string } | { whyNot: string } {
  const own = process.execPath
  if (/node/i.test(basename(own))) {
    const probe = probeBinary(own, ['--version'])
    if (probe.ok) return { path: own, version: probe.version }
  }
  const probe = probeBinary('node', ['--version'])
  if (probe.ok) return { path: 'node', version: probe.version }
  return { whyNot: `no node binary reachable (host: ${own}; PATH probe failed)` }
}

export function discoverJs(): EvalLanguageAvailability {
  const node = nodeBinaryForKernels()
  if ('whyNot' in node) return { language: 'js', available: false, whyNot: node.whyNot }
  return { language: 'js', available: true, interpreterPath: node.path, version: node.version }
}

/** The availability table the schema, /health and doctor all read. Gate-off
 *  languages report available:false with the gate named — the live schema
 *  advertises ONLY available languages, so an all-off state is an absent
 *  tool, never a union schema that rejects everything. */
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
