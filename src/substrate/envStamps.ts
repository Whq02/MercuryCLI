


import { join, resolve } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { FLAG_REGISTRY, flagSpellings, selfWrittenFlagEnv, stampFlagOnEnv } from './flagRegistry.js'
import { bootEnvSelfApplied } from './startupMenu.js'

export const SPAWN_STAMP_RECEIPT = 'MERCURY_SPAWNED_ENV'

export const LAUNCHER_STAMPS: readonly string[] = [
  'MERCURY_LAUNCH_ID',
  'MERCURY_WIN32_UTF8_PRESET',
  'MHOME',
  'MROOT',
  'MVER',
  'MBAD',
]

export const COMPILE_CACHE_ENV = 'NODE_COMPILE_CACHE'

const samePath = (a: string, b: string): boolean => {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function compileCacheIsOwn(env: NodeJS.ProcessEnv, home: string = getMercuryHome()): boolean {
  const value = env[COMPILE_CACHE_ENV]
  if (value === undefined || value === '') return false
  return samePath(value, join(home, 'compile-cache'))
}

const ownEnvWrites = new Map<string, string | undefined>()

export function recordOwnEnvWrite(name: string, previous: string | undefined): void {
  if (!ownEnvWrites.has(name)) ownEnvWrites.set(name, previous)
}

export function ownEnvWriteLedger(): ReadonlyMap<string, string | undefined> {
  return ownEnvWrites
}

export function resetOwnEnvWritesForTesting(): void {
  ownEnvWrites.clear()
}

export function spawnSelfStamped(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  const raw = flagSpellings(SPAWN_STAMP_RECEIPT)
    .map(sp => env[sp])
    .find(v => v !== undefined)
  if (raw === undefined) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  for (const [spelling, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') out.set(spelling, value)
  }
  return out
}

export function stampSpawnReceipt(env: Record<string, string | undefined>, names: readonly string[]): void {
  const receipt: Record<string, string> = {}
  for (const [spelling, value] of spawnSelfStamped(env)) receipt[spelling] = value
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string') receipt[name] = value
  }
  if (Object.keys(receipt).length === 0) return
  stampFlagOnEnv(env, SPAWN_STAMP_RECEIPT, JSON.stringify(receipt))
}

export function sessionEnvStamps(env: NodeJS.ProcessEnv = process.env): string[] {
  const stamps = new Set<string>()
  for (const spec of FLAG_REGISTRY) {
    if (spec.selfStamped === true && env[spec.env] !== undefined) stamps.add(spec.env)
  }
  for (const [spelling, value] of bootEnvSelfApplied(env)) {
    if (env[spelling] === value) stamps.add(spelling)
  }
  for (const spelling of spawnSelfStamped(env).keys()) {
    if (env[spelling] !== undefined) stamps.add(spelling)
  }
  for (const [spelling, value] of selfWrittenFlagEnv()) {
    if (env[spelling] === value) stamps.add(spelling)
  }
  for (const name of LAUNCHER_STAMPS) {
    if (env[name] !== undefined) stamps.add(name)
  }
  if (compileCacheIsOwn(env)) stamps.add(COMPILE_CACHE_ENV)
  for (const [name, previous] of ownEnvWrites) {
    if (env[name] !== undefined && env[name] !== previous) stamps.add(name)
  }
  return [...stamps].sort()
}

export function scrubSessionEnvStamps(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; scrubbed: string[] } {
  const scrubbed = sessionEnvStamps(env)
  if (scrubbed.length === 0) return { env, scrubbed }
  const clone: NodeJS.ProcessEnv = { ...env }
  for (const name of scrubbed) {
    const previous = ownEnvWrites.get(name)
    if (previous !== undefined) clone[name] = previous
    else delete clone[name]
  }
  return { env: clone, scrubbed }
}
