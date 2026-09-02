// ============================================================================
//  workbench/serialCoalescer — the event-source adapter onto the ONE serial
//  generation lane.
//
//  extracted substrate/serialGeneration.ts from four inlined copies of
//  the same "a request arriving mid-run coalesces into one trailing run"
//  algorithm. audit found a fifth (telemetryBus's pokeTelemetry) and,
//  more importantly, found that one of them did not implement the algorithm at
//  all: useCurrentWork's
//
//      const refresh = () => { if (pending) return; ... }
//
//  DROPS a trigger that arrives mid-gather instead of deferring it. That is
//  defect G — the rendered projection stays behind until some unrelated later
//  event pokes it again. The correct policy already existed ~100 lines away,
//  inlined in pokeWorkbench; nothing was missing but a shared owner.
//
//  This is that owner's event-source face: poke-and-forget, no payload, no
//  settlement receipt. The lane keeps the guarantees (commits run serially,
//  only the newest accepted generation is committed, a generation accepted
//  during a commit always gets its own commit afterwards); this module owns
//  only the translation from "an event happened" into those terms.
// ============================================================================

import { serialGenerationLane } from '../../substrate/serialGeneration.js'

export interface SerialCoalescer {
  /** Request a run. Requests arriving while a run is in flight coalesce into
   *  exactly ONE trailing run — never zero (the defect), never one each. */
  poke: () => void
  /** Resolve once the newest requested run has finished, or once the coalescer
   *  has been released. Never rejects: a run that throws is recorded by the
   *  lane as degraded and retried on the next poke. */
  settled: () => Promise<void>
  /** Terminal: no further run starts, including a trailing one already
   *  accepted. Synchronous by contract — callers release from teardown paths
   *  (an effect cleanup, stopEngine) that have nothing to await into. */
  release: () => void
  /** Newest accepted request number: monotonic, process-scoped, and usable as
   *  a freshness stamp for whatever a run produced. Never compare it across
   *  processes. */
  generation: () => number
}

/** A run request carries no payload — what matters is the generation the lane
 *  assigns it — but the lane commits a VALUE, so it gets a constant marker. */
const REQUEST = 'run' as const

export function serialCoalescer(
  run: () => Promise<void>,
  name = 'coalescer',
): SerialCoalescer {
  // The lane's own release() awaits the in-flight commit BEFORE setting its
  // released flag, and the pump re-reads that flag only after the commit it
  // was awaiting returns. So between a mid-run release() and the flag actually
  // flipping, the lane still sees itself as live and starts the trailing run —
  // precisely the thing release() exists to prevent. This latch is set
  // SYNCHRONOUSLY, before the lane is told anything, and is read on the way
  // into every commit, which leaves no such window. Do not "simplify" it away
  // into lane.release().
  let released = false

  const lane = serialGenerationLane<typeof REQUEST>({
    name,
    commit: async () => {
      if (released) return
      await run()
    },
  })

  return {
    poke: () => {
      if (released) return
      lane.accept(REQUEST)
      lane.poke()
    },
    settled: async () => {
      await lane.settle()
    },
    release: () => {
      released = true
      // The lane still drains its own bookkeeping — a commit already in flight
      // finishes, and an accepted-but-skipped generation is marked through by
      // the wrapper above. Nothing observes a released coalescer, so that
      // drain records that the lane is done, not that the run happened.
      void lane.release()
    },
    generation: () => lane.state().accepted,
  }
}
