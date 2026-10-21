import { MercuryError } from './errors.js'
import type { ResultOf } from './wire.js'

export const FEATURE_FLOORS = { perTurnSchema: '1.0.0-beta.41', fileCheckpoints: '1.0.0-beta.41' } as const
export type RunnerFeature = keyof typeof FEATURE_FLOORS
export type RunnerSupport = { readonly [F in RunnerFeature]: boolean }
const FEATURE_WORDS: Record<RunnerFeature, string> = { perTurnSchema: 'per-turn schema', fileCheckpoints: 'file checkpoints' }

type Version = { release: number[]; pre: Array<string | number> | null }
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(version: string): Version | undefined {
  const match = VERSION.exec(version.trim())
  if (!match) return undefined
  const pre = match[4] === undefined ? null : match[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part))
  return { release: [Number(match[1]), Number(match[2]), Number(match[3])], pre }
}

export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined) return undefined
  for (let i = 0; i < 3; i++) if (left.release[i] !== right.release[i]) return left.release[i]! < right.release[i]! ? -1 : 1
  if (left.pre === null || right.pre === null) return left.pre === right.pre ? 0 : left.pre === null ? 1 : -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

export function runnerSupport(initialized: Pick<ResultOf<'initialize'>, 'runner' | 'file_checkpoints'> | undefined): RunnerSupport {
  const answered = initialized?.file_checkpoints !== undefined
  const version = initialized?.runner.version ?? ''
  const reaches = (floor: string): boolean => { const order = compareVersions(version, floor); return order === undefined || order >= 0 }
  return { perTurnSchema: answered || reaches(FEATURE_FLOORS.perTurnSchema), fileCheckpoints: answered || reaches(FEATURE_FLOORS.fileCheckpoints) }
}

export function unsupportedFeature(feature: RunnerFeature, version: string): MercuryError {
  return new MercuryError(`${FEATURE_WORDS[feature]} needs Mercury ${FEATURE_FLOORS[feature]} or newer; this runner is ${version} — run \`mercury update\``, null)
}
