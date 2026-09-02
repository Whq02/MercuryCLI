
import { randomUUID } from 'node:crypto'
import {
  serialGenerationLane,
  type LaneSettlement,
} from '../../substrate/serialGeneration.js'
import type { OwnerKey } from './ownerKey.js'
import { currentWriterEpoch, writerEpoch, FALLBACK_EPOCH } from './writerEpoch.js'

export const WRITER_EPOCH: number = FALLBACK_EPOCH

export const WRITER_ID: string = `${process.pid}-${randomUUID().slice(0, 8)}`

export interface CommitContext {
  generation: number
  epoch: number
  writerId: string
}

export interface OwnerPersistence<T> {
  accept: (value: T) => number
  schedule: (delayMs: number) => void
  flush: () => Promise<LaneSettlement>
  drain: () => Promise<LaneSettlement>
  settlement: () => LaneSettlement
  hasUncommittedWork: () => boolean
  readonly epoch: number
}

export interface OwnerPersistenceOptions<T> {
  name: string
  owner: OwnerKey
  commit: (owner: OwnerKey, value: T, ctx: CommitContext) => Promise<void>
}

export function ownerPersistence<T>(opts: OwnerPersistenceOptions<T>): OwnerPersistence<T> {
  const lane = serialGenerationLane<T>({
    name: `${opts.name}:${opts.owner}`,
    commit: async (value, ctx) =>
      opts.commit(opts.owner, value, {
        generation: ctx.generation,
        epoch: await writerEpoch(),
        writerId: WRITER_ID,
      }),
  })

  let timer: ReturnType<typeof setTimeout> | null = null
  const clearTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return {
    get epoch(): number {
      return currentWriterEpoch()
    },
    accept: value => lane.accept(value),
    schedule: delayMs => {
      if (delayMs <= 0) {
        clearTimer()
        lane.poke()
        return
      }
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        lane.poke()
      }, delayMs)
      timer.unref?.()
    },
    flush: async () => {
      clearTimer()
      return lane.settle()
    },
    drain: async () => {
      clearTimer()
      await lane.settle()
      return lane.release()
    },
    settlement: () => lane.state(),
    hasUncommittedWork: () => {
      const s = lane.state()
      return s.state === 'pending' || s.state === 'degraded'
    },
  }
}
