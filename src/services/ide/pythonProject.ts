
import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { whichSync } from '../../utils/which.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  defaultInterpreterCandidates,
  resolvePythonDebugAdapter,
  type PythonAdapterResolution,
  type PythonDebuggerProvenance,
} from '../dap/debugpyResolver.js'

export type PythonEnvKind = 'explicit' | 'active-venv' | 'conda' | 'project-venv' | 'system'

export interface PythonInterpreterSelection {
  state: 'ok'
  command: string
  version: string
  envKind: PythonEnvKind
  prefix: string
  source: string
}

export interface PythonInterpreterUnavailable {
  state: 'unavailable'
  detail: string
  remedy: string
}

export type PythonInterpreterResult = PythonInterpreterSelection | PythonInterpreterUnavailable

export interface PythonProjectProfile {
  projectRoot: string
  markers: string[]
  interpreter: PythonInterpreterResult
  packageRootHints: string[]
  testFrameworks: {
    pytest: { detected: boolean; evidence?: string }
    unittest: { detected: boolean; evidence?: string }
  }
  pyright: { configured: boolean; evidence?: string }
  ruff: { available: boolean; version?: string; configured: boolean; evidence?: string }
  debugger: PythonDebuggerProvenance
  collectedAt: number
}

const PROBE_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 30_000
const ROOT_WALK_LIMIT = 12

const PROJECT_MARKERS = [
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'Pipfile',
  'poetry.lock',
  'uv.lock',
  'pytest.ini',
  'tox.ini',
] as const


export function findPythonProjectRoot(from: string = getCwd()): { root: string; markers: string[] } {
  let dir = path.resolve(from)
  for (let depth = 0; depth < ROOT_WALK_LIMIT; depth++) {
    const markers: string[] = PROJECT_MARKERS.filter(m => existsSync(path.join(dir, m)))
    if (existsSync(path.join(dir, '.venv'))) markers.push('.venv')
    else if (existsSync(path.join(dir, 'venv'))) markers.push('venv')
    if (markers.length > 0) return { root: dir, markers }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { root: path.resolve(from), markers: [] }
}


interface InterpreterProbe {
  ok: boolean
  version?: string
  prefix?: string
  detail: string
}

function probeInterpreter(command: string): InterpreterProbe {
  const script =
    'import sys, json\n' +
    'print(json.dumps({"v": "%d.%d.%d" % sys.version_info[:3], "prefix": sys.prefix}))\n'
  try {
    const r = spawnSync(command, ['-c', script], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      env: { ...subprocessEnv() },
    })
    if (r.error) throw r.error
    if (r.status === 0) {
      const parsed = JSON.parse((r.stdout ?? '').trim()) as { v?: string; prefix?: string }
      return { ok: true, version: parsed.v, prefix: parsed.prefix, detail: `probed ${command} → ${parsed.v}` }
    }
    const tail = `${r.stderr ?? ''}`.trim().split('\n').slice(-1)[0]?.slice(0, 160) ?? ''
    return { ok: false, detail: `${command}: ${tail || `probe exited ${r.status ?? 'null'}`}` }
  } catch (e) {
    return { ok: false, detail: `${command}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function venvPython(prefix: string): string {
  return process.platform === 'win32'
    ? path.join(prefix, 'Scripts', 'python.exe')
    : path.join(prefix, 'bin', 'python')
}


let selectionCache: { at: number; key: string; result: PythonInterpreterResult } | null = null

function selectionKey(root: string): string {
  return [
    root,
    flagEnv('MERCURY_PYTHON') ?? '',
    process.env.VIRTUAL_ENV ?? '',
    process.env.CONDA_PREFIX ?? '',
    process.env.PATH ?? '',
  ].join('\0')
}

export function _resetPythonProjectForTesting(): void {
  selectionCache = null
}

export function selectPythonInterpreter(from: string = getCwd()): PythonInterpreterResult {
  const { root } = findPythonProjectRoot(from)
  const key = selectionKey(root)
  if (selectionCache && selectionCache.key === key && Date.now() - selectionCache.at < CACHE_TTL_MS) {
    return selectionCache.result
  }

  const candidates: Array<{ command: string; envKind: PythonEnvKind; source: string }> = []
  const pin = flagEnv('MERCURY_PYTHON')
  if (pin && pin !== '') {
    candidates.push({ command: pin, envKind: 'explicit', source: 'MERCURY_PYTHON pin' })
  } else {
    if (process.env.VIRTUAL_ENV) {
      candidates.push({
        command: venvPython(process.env.VIRTUAL_ENV),
        envKind: 'active-venv',
        source: `$VIRTUAL_ENV (${process.env.VIRTUAL_ENV})`,
      })
    }
    if (process.env.CONDA_PREFIX) {
      candidates.push({
        command: venvPython(process.env.CONDA_PREFIX),
        envKind: 'conda',
        source: `$CONDA_PREFIX (${process.env.CONDA_PREFIX})`,
      })
    }
    for (const name of ['.venv', 'venv'] as const) {
      const envDir = path.join(root, name)
      if (existsSync(envDir)) {
        candidates.push({ command: venvPython(envDir), envKind: 'project-venv', source: `project ${name}/` })
      }
    }
    candidates.push({ command: 'python3', envKind: 'system', source: 'python3 on PATH' })
    candidates.push({ command: 'python', envKind: 'system', source: 'python on PATH' })
  }

  const failures: string[] = []
  let result: PythonInterpreterResult | null = null
  for (const c of candidates) {
    const probe = probeInterpreter(c.command)
    if (probe.ok && probe.version && probe.prefix) {
      result = {
        state: 'ok',
        command: c.command,
        version: probe.version,
        envKind: c.envKind,
        prefix: probe.prefix,
        source: c.source,
      }
      break
    }
    failures.push(probe.detail)
    if (c.envKind === 'explicit') break
  }
  if (!result) {
    result = {
      state: 'unavailable',
      detail:
        pin && pin !== ''
          ? `the MERCURY_PYTHON pin is not viable: ${failures[0] ?? pin}`
          : `no viable Python interpreter — ${failures.slice(0, 3).join(' | ') || 'no candidates'}`,
      remedy:
        pin && pin !== ''
          ? 'fix or unset MERCURY_PYTHON — install Python 3 to use the python lanes'
          : 'install Python 3 to use the python lanes (or pin one: MERCURY_PYTHON=/path/to/python)',
    }
  }
  selectionCache = { at: Date.now(), key, result }
  return result
}


export function projectPythonDebugAdapter(from: string = getCwd()): PythonAdapterResolution {
  const selection = selectPythonInterpreter(from)
  const pin = flagEnv('MERCURY_PYTHON')
  if (pin && pin !== '') {
    return resolvePythonDebugAdapter({ candidates: [pin], exclusive: true })
  }
  const rest = defaultInterpreterCandidates()
  const candidates =
    selection.state === 'ok'
      ? [selection.command, ...rest.filter(c => c !== selection.command)]
      : rest
  return resolvePythonDebugAdapter({ candidates })
}

export function projectPythonDebuggerProvenance(from: string = getCwd()): PythonDebuggerProvenance {
  return projectPythonDebugAdapter(from).provenance
}


function fileContains(p: string, needle: string): boolean {
  try {
    return readFileSync(p, 'utf8').includes(needle)
  } catch {
    return false
  }
}

let profileCache: { at: number; key: string; profile: PythonProjectProfile } | null = null

export function buildPythonProjectProfile(from: string = getCwd()): PythonProjectProfile {
  const { root, markers } = findPythonProjectRoot(from)
  const key = selectionKey(root)
  if (profileCache && profileCache.key === key && Date.now() - profileCache.at < CACHE_TTL_MS) {
    return profileCache.profile
  }
  const interpreter = selectPythonInterpreter(from)

  const pyproject = path.join(root, 'pyproject.toml')
  const setupCfg = path.join(root, 'setup.cfg')

  let pytestEvidence: string | undefined
  if (existsSync(path.join(root, 'pytest.ini'))) pytestEvidence = 'pytest.ini'
  else if (existsSync(pyproject) && fileContains(pyproject, '[tool.pytest')) pytestEvidence = 'pyproject.toml [tool.pytest]'
  else if (existsSync(setupCfg) && fileContains(setupCfg, '[tool:pytest]')) pytestEvidence = 'setup.cfg [tool:pytest]'
  else if (existsSync(path.join(root, 'conftest.py'))) pytestEvidence = 'conftest.py'
  else if (existsSync(path.join(root, 'tests', 'conftest.py'))) pytestEvidence = 'tests/conftest.py'

  let unittestEvidence: string | undefined
  for (const dir of ['tests', 'test']) {
    const p = path.join(root, dir)
    if (existsSync(p)) {
      unittestEvidence = `${dir}/ directory`
      break
    }
  }

  let pyrightEvidence: string | undefined
  if (existsSync(path.join(root, 'pyrightconfig.json'))) pyrightEvidence = 'pyrightconfig.json'
  else if (existsSync(pyproject) && fileContains(pyproject, '[tool.pyright')) pyrightEvidence = 'pyproject.toml [tool.pyright]'

  const { probeRuff } = require('../lsp/ruffLane.js') as typeof import('../lsp/ruffLane.js')
  const ruffProbe = probeRuff()
  const ruffBin = ruffProbe.ruffPath ?? null
  const ruffVersion = ruffProbe.version
  let ruffConfigEvidence: string | undefined
  if (existsSync(path.join(root, '.ruff.toml'))) ruffConfigEvidence = '.ruff.toml'
  else if (existsSync(path.join(root, 'ruff.toml'))) ruffConfigEvidence = 'ruff.toml'
  else if (existsSync(pyproject) && fileContains(pyproject, '[tool.ruff')) ruffConfigEvidence = 'pyproject.toml [tool.ruff]'

  const packageRootHints = [
    ...(existsSync(path.join(root, 'src')) ? [path.join(root, 'src')] : []),
    root,
  ]

  const profile: PythonProjectProfile = {
    projectRoot: root,
    markers,
    interpreter,
    packageRootHints,
    testFrameworks: {
      pytest: { detected: pytestEvidence !== undefined, ...(pytestEvidence ? { evidence: pytestEvidence } : {}) },
      unittest: {
        detected: unittestEvidence !== undefined,
        ...(unittestEvidence ? { evidence: unittestEvidence } : {}),
      },
    },
    pyright: { configured: pyrightEvidence !== undefined, ...(pyrightEvidence ? { evidence: pyrightEvidence } : {}) },
    ruff: {
      available: ruffBin !== null && ruffBin !== undefined,
      ...(ruffVersion ? { version: ruffVersion } : {}),
      configured: ruffConfigEvidence !== undefined,
      ...(ruffConfigEvidence ? { evidence: ruffConfigEvidence } : {}),
    },
    debugger: projectPythonDebuggerProvenance(from),
    collectedAt: Date.now(),
  }
  profileCache = { at: Date.now(), key, profile }
  return profile
}
