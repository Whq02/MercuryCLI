import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import type { TensorFoldEngine, TensorFoldFamily, TensorFoldMachine } from './contracts.js'
import { readTensorFoldMachineTruth, type MachineIo, type TensorFoldMachineTruth } from './fit.js'
import { TENSORFOLD_STARTING_POINTS } from './starting.js'

export const TENSORFOLD_BINARY_NAMES = ['tensorfold-native', 'tensorfold'] as const
export const TENSORFOLD_RUNTIME_FOLDER = join('.local', 'share', 'mercury-host', 'runtime', 'tensorfold')

type EngineExec = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number } | undefined>

export type EngineIo = MachineIo & {
  env?: NodeJS.ProcessEnv
  home?: string
  exists?: (path: string) => boolean
  exec?: EngineExec
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function defaultExec(env: NodeJS.ProcessEnv): EngineExec {
  return (file, args) => new Promise(resolve => {
    try {
      execFile(file, args, { encoding: 'utf8', timeout: 8_000, maxBuffer: 4 << 20, windowsHide: true, env }, (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
        resolve(error && stdout === '' && stderr === '' ? undefined : { stdout: String(stdout), stderr: String(stderr), code })
      })
    } catch {
      resolve(undefined)
    }
  })
}

export function tensorFoldBinaryCandidates(io: Pick<EngineIo, 'env' | 'home' | 'platform'> = {}): string[] {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const platform = io.platform ?? process.platform
  const dirs = [
    ...(env.PATH ?? '').split(delimiter).filter(dir => dir !== ''),
    join(home, TENSORFOLD_RUNTIME_FOLDER, 'bin'),
    join(home, '.tensorfold', 'bin'),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
  ]
  const out: string[] = []
  for (const dir of dirs) for (const name of TENSORFOLD_BINARY_NAMES) out.push(join(dir, platform === 'win32' ? `${name}.exe` : name))
  return [...new Set(out)]
}

export function parseTensorFoldVersion(text: string | undefined): string | undefined {
  const match = /tensorfold(?:-native)?\s+v?(\d+\.\d+\.\d+)/i.exec(text ?? '') ?? /\b(\d+\.\d+\.\d+)\b/.exec(text ?? '')
  return match?.[1]
}

type TensorFoldCapabilities = {
  version?: string
  chip: string | null
  backends: string[]
  families: Record<string, string[]>
  flags: string[]
  env: string[]
  optionalLibraries: Array<{ name: string; found: boolean; usable: boolean | null; problem?: string }>
}

const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function parseTensorFoldCapabilities(stdout: string): TensorFoldCapabilities | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    const start = stdout.indexOf('{')
    const end = stdout.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      parsed = JSON.parse(stdout.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
  const top = rec(parsed)
  if (top === undefined) return undefined
  const families: Record<string, string[]> = {}
  for (const [id, formats] of Object.entries(rec(top.families) ?? {})) families[id] = strings(formats)
  const flags = Object.keys(rec(rec(top.serve)?.flags) ?? {})
  const optionalLibraries = (Array.isArray(top.optional_libraries) ? top.optional_libraries : [])
    .map(rec)
    .filter((row): row is Record<string, unknown> => row !== undefined)
    .map(row => ({
      name: typeof row.name === 'string' ? row.name : '',
      found: row.found === true,
      usable: typeof row.usable === 'boolean' ? row.usable : null,
      ...(typeof row.problem === 'string' ? { problem: row.problem } : {}),
    }))
  return {
    ...(typeof top.version === 'string' ? { version: top.version } : {}),
    chip: typeof top.chip === 'string' ? top.chip : null,
    backends: strings(top.backends),
    families,
    flags,
    env: strings(top.env),
    optionalLibraries,
  }
}

function tensorFoldFamiliesOf(families: Record<string, string[]>): TensorFoldFamily[] {
  return Object.entries(families).map(([id, quantisations]) => {
    const points = TENSORFOLD_STARTING_POINTS.filter(point => point.family === id)
    const drafter = points.find(point => point.drafter !== undefined)?.drafter?.repo
    const cacheDefault = points.some(point => point.promptCacheGib === undefined) ? 16 : undefined
    return {
      id,
      repos: points.map(point => point.repo),
      quantisations,
      ...(drafter !== undefined ? { drafter } : {}),
      ...(cacheDefault !== undefined ? { promptCacheDefaultGib: cacheDefault } : {}),
      qualified: points.length > 0,
    }
  })
}

export type TensorFoldEngineFound = TensorFoldEngine & { capabilities: TensorFoldCapabilities; warnings: string[] }

let machineCache: { truth: TensorFoldMachineTruth; at: number } | null = null
const MACHINE_TTL_MS = 60_000

export async function cachedTensorFoldMachineTruth(io: MachineIo = {}, force = false): Promise<TensorFoldMachineTruth> {
  if (!force && machineCache !== null && Date.now() - machineCache.at < MACHINE_TTL_MS) return machineCache.truth
  const truth = await readTensorFoldMachineTruth(io)
  machineCache = { truth, at: Date.now() }
  return truth
}

export function __pinTensorFoldMachineForTest(truth: TensorFoldMachineTruth | null): void {
  machineCache = truth === null ? null : { truth, at: Date.now() }
}

export function tensorFoldMachine(): TensorFoldMachine {
  const truth = machineCache?.truth
  if (truth === undefined) return { chip: process.platform === 'darwin' ? 'Apple silicon' : process.platform === 'linux' ? 'Linux' : 'Windows' }
  return { chip: truth.chip, usableGib: truth.usableBytes / 1024 ** 3 }
}

export async function findTensorFoldEngine(io: EngineIo = {}): Promise<TensorFoldEngineFound | null> {
  const exists = io.exists ?? executable
  const exec = io.exec ?? defaultExec(io.env ?? subprocessEnv())
  const platform = io.platform ?? process.platform
  if (platform === 'win32') return null
  const binary = tensorFoldBinaryCandidates(io).find(exists)
  if (binary === undefined) return null
  const version = await exec(binary, ['--version'])
  const parsedVersion = parseTensorFoldVersion(version?.stdout)
  const capabilities = await exec(binary, ['capabilities', '--json'])
  const parsed = capabilities === undefined ? undefined : parseTensorFoldCapabilities(capabilities.stdout)
  const warnings = (capabilities?.stderr ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')
  const found = parsed ?? { chip: null, backends: [], families: {}, flags: [], env: [], optionalLibraries: [] }
  const truth = await cachedTensorFoldMachineTruth(io)
  return {
    version: parsedVersion ?? found.version ?? 'unknown',
    binary,
    chip: truth.chip,
    backends: found.backends,
    families: tensorFoldFamiliesOf(found.families),
    optionalLibraries: found.optionalLibraries.map(library => ({ name: library.name, found: library.found, ...(library.problem !== undefined ? { note: library.problem } : {}) })),
    capabilities: found,
    warnings,
  }
}

export function tensorFoldBackendWords(engine: Pick<TensorFoldEngine, 'backends'> | null, platform: NodeJS.Platform = process.platform): string {
  const backend = engine?.backends[0]
  if (backend === 'metal' || (backend === undefined && platform === 'darwin')) return 'Metal'
  if (backend === 'cuda' || (backend === undefined && platform === 'linux')) return 'CUDA'
  return backend ?? ''
}
