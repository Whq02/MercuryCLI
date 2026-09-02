// ============================================================================
//  persistenceActor — THE per-owner durable writer.
//
//  One actor per owner, owning everything between "a state change was
//  accepted" and "that state change is on disk":
//
//    accepted generation   what the caller handed us, monotonic
//    committed generation  what actually landed
//    writer epoch          who wrote it (stage 2 fences (epoch, revision) at
//                          the commit boundary; the epoch is stamped now so
//                          the on-disk shape does not change again later)
//    coalescing            intermediate generations may be skipped; the
//                          NEWEST accepted generation always gets its own
//                          commit
//    settlement            clean · pending · settled · degraded — a typed
//                          receipt, so a failed required write is a fact a
//                          caller can read rather than an exception someone
//                          swallowed
//    drain                 an awaited terminal settle + release, for turn
//                          teardown and owner disposal
//
//  The three defects this replaces, stated as what the old code did:
//    · the dirty flag was cleared BEFORE the write and the write error was
//      discarded, so a failure on an idle or terminal run was lost with
//      nothing left to re-arm it;
//    · one `flushing` pointer was shared by overlapping writes, so a
//      completing write cleared the pointer a newer in-flight write still
//      needed, and the forced flush returned early;
//    · disposal released the coalesce timer and nothing else, so an in-flight
//      write and a dirty snapshot were both dropped by teardown and by LRU
//      eviction.
//
//  Serialization and the trailing-commit guarantee live in the shared lane
//  (substrate/serialGeneration.ts); this module adds owner identity, the
//  writer epoch, and the scheduling policy the run kernel wants.
// ============================================================================

import { randomUUID } from 'node:crypto'
import {
  serialGenerationLane,
  type LaneSettlement,
} from '../../substrate/serialGeneration.js'
import type { OwnerKey } from './ownerKey.js'
import { currentWriterEpoch, writerEpoch, FALLBACK_EPOCH } from './writerEpoch.js'

/**
 * This writer's epoch. Monotonic per process start, so a process resumed
 * against an owner can be ordered against the epoch already on disk.
 * makes this durable and fences on it at the commit boundary; recording it
 * from stage 1 means the persisted shape does not change twice.
 */
export const WRITER_EPOCH: number = FALLBACK_EPOCH

/** Identifies this writer within its epoch (diagnostics, and stage 2's row). */
export const WRITER_ID: string = `${process.pid}-${randomUUID().slice(0, 8)}`

export interface CommitContext {
  generation: number
  epoch: number
  writerId: string
}

export interface OwnerPersistence<T> {
  /** Record an accepted state change. Returns its generation number. */
  accept: (value: T) => number
  /** Ask for a commit; 0 pokes immediately, >0 coalesces for that long. */
  schedule: (delayMs: number) => void
  /** Commit up to the newest accepted generation and report the settlement. */
  flush: () => Promise<LaneSettlement>
  /** Terminal: settle, then release. Safe to call more than once. */
  drain: () => Promise<LaneSettlement>
  settlement: () => LaneSettlement
  /** True while an accepted generation has not committed (or a commit failed). */
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
        // Claimed from the durable counter, memoized per process. A wall clock
        // could hand a LATER writer a LOWER epoch (clock step back, VM resume,
        // two processes inside one millisecond), and a fencing token that goes
        // backwards makes the stale writer look newer.
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
      // A coalesce timer must never hold the process open.
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
