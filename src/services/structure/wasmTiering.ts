import { setFlagsFromString } from 'node:v8'

let holders = 0

function setOptimisingTier(on: boolean): void {
  setFlagsFromString(on ? '--wasm-tier-up' : '--no-wasm-tier-up')
  setFlagsFromString(on ? '--wasm-dynamic-tiering' : '--no-wasm-dynamic-tiering')
}

export const HELD_TIER_NODE_FLAGS = ['--no-wasm-tier-up', '--no-wasm-dynamic-tiering'] as const

export function optimisingTierCanBeHeld(runtime: {
  versions: Record<string, string | undefined>
  execArgv: readonly string[]
  nodeOptions: string | undefined
  released: boolean
}): boolean {
  if (runtime.released) return false
  if (runtime.versions.bun !== undefined || typeof runtime.versions.v8 !== 'string') return false
  return ![...runtime.execArgv, runtime.nodeOptions ?? ''].some(arg => /liftoff|wasm[-_](?:tier[-_]up|dynamic[-_]tiering)/.test(arg))
}

export function withOptimisingTierHeld<T>(body: () => T): T {
  holders++
  try {
    if (holders === 1) setOptimisingTier(false)
    return body()
  } finally {
    holders--
    if (holders === 0) setOptimisingTier(true)
  }
}
