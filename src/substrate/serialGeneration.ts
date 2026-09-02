
export type LaneState = 'clean' | 'pending' | 'settled' | 'degraded'

export interface LaneSettlement {
  state: LaneState
  accepted: number
  committed: number
  reason?: string
  attempts: number
  released: boolean
}

export interface SerialGenerationLane<T> {
  accept: (value: T) => number
  poke: () => void
  settle: () => Promise<LaneSettlement>
  release: () => Promise<LaneSettlement>
  state: () => LaneSettlement
}

export interface SerialGenerationOptions<T> {
  name: string
  commit: (value: T, ctx: { generation: number }) => Promise<void>
}

const MAX_SETTLE_ROUNDS = 8

const MAX_COMMITS_PER_PUMP = 64

export function serialGenerationLane<T>(
  opts: SerialGenerationOptions<T>,
): SerialGenerationLane<T> {
  let accepted = 0
  let committed = 0
  let pendingValue: T | null = null
  let running: Promise<void> | null = null
  let active = false
  let reason: string | undefined
  let attempts = 0
  let released = false

  const state = (): LaneSettlement => {
    const base = { accepted, committed, attempts, released }
    if (reason !== undefined) return { state: 'degraded', reason, ...base }
    if (accepted === 0) return { state: 'clean', ...base }
    if (committed < accepted) return { state: 'pending', ...base }
    return { state: 'settled', ...base }
  }

  const pump = (): Promise<void> => {
    if (active && running) return running
    active = true
    running = (async () => {
      let commitsThisPump = 0
      try {
        while (!released && committed < accepted && pendingValue !== null) {
          if (commitsThisPump >= MAX_COMMITS_PER_PUMP) return
          commitsThisPump += 1
          const generation = accepted
          const value = pendingValue
          try {
            await opts.commit(value, { generation })
            committed = generation
            reason = undefined
            attempts = 0
          } catch (e) {
            attempts += 1
            reason = `[${opts.name}] ${e instanceof Error ? e.message : String(e)}`
            return
          }
        }
      } finally {
        active = false
      }
    })()
    return running
  }

  const settle = async (): Promise<LaneSettlement> => {
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
      await pump()
      if (released) break
      if (reason !== undefined) break
      if (committed >= accepted) break
    }
    return state()
  }

  return {
    accept: value => {
      accepted += 1
      pendingValue = value
      if (released) {
        reason = `[${opts.name}] generation ${accepted} was accepted after release and cannot be committed`
      }
      return accepted
    },
    poke: () => {
      if (released) return
      void pump()
    },
    settle,
    release: async () => {
      if (running) await running
      released = true
      return state()
    },
    state,
  }
}
