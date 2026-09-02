// ============================================================================
//  query.ts — the public turn entrypoint.
//
//  There is no queryLoop monolith. The
//  turn state machine is the run-event core (run-core/turn-machine.ts) —
//  ONE owned TurnMachine emitting the typed RunEvent stream — and this
//  module's generator contract is a total projection over that stream
//  (run-core/project-legacy.ts). Existing consumers (REPL · QueryEngine ·
//  runAgent · forkedAgent · hooks · tasks) keep importing { query,
//  QueryParams } from here unchanged; switch them to consume the
//  event stream directly.
//
//  What stays HERE is the run lifecycle that wraps the machine:
//  • the run kernel begin/end seam (noteQueryTurnStart/End — durable run
//    reconciliation + the terminal-outcome sidecar flush),
//  • the exactly-once command-lifecycle settlement ('completed' fires only
//    on normal return — throw and .return() skip it, the same asymmetric
//    started-without-completed signal as print.ts's drainCommandQueue),
//  • the turn-effort floor + AUTOPILOT tier turn-boundary clears.
// ============================================================================
import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import {
  noteQueryTurnEnd,
  noteQueryTurnStart,
} from './services/run/runTurnObserver.js'
import { isTurnOwningQuerySource } from './utils/effort.js'
import { tierTurnEnded } from './utils/autopilot/tierState.js'
import type { Terminal } from './query/transitions.js'
import { runEventCore, type QueryParams } from './run-core/turn-machine.js'
import type { RunEvent } from './run-core/events.js'
import {
  projectLegacyYields,
  type LegacyQueryYield,
} from './run-core/project-legacy.js'

export type { QueryParams } from './run-core/turn-machine.js'

/**
 * The RUN-EVENT entrypoint (native-core): the TurnMachine's typed
 * event stream WITH the run lifecycle attached — every consumer of the
 * event vocabulary comes through here so the kernel seam, the
 * exactly-once command-lifecycle settlement and the turn-boundary clears
 * exist ONCE. QueryEngine consumes this directly; query() below is its
 * legacy-shaped projection for the remaining surfaces (T11/ switch
 * them, then the projection serves only external compat).
 */
export async function* queryEvents(
  params: QueryParams,
): AsyncGenerator<RunEvent, Terminal> {
  const consumedCommandUuids: string[] = []
  // Run kernel: a turn-owning query begins/reconciles the
  // owner's durable run. Non-turn service sources are filtered inside.
  noteQueryTurnStart(params)
  let runTerminalReason = 'threw'
  try {
    const terminal = yield* runEventCore(params, consumedCommandUuids)
    runTerminalReason = terminal.reason
    // Reached only when the machine returns normally. A throw skips it (the
    // error rides out through yield*), and so does .return(), whose Return
    // completion closes the generator. The resulting asymmetry — started
    // without completed — is the same signal print.ts's drainCommandQueue
    // gives on a failed turn.
    for (const uuid of consumedCommandUuids) {
      notifyCommandLifecycle(uuid, 'completed')
    }
    return terminal
  } finally {
    // Run kernel: terminal outcome + the owner's terminal drain, AWAITED
    //
    await noteQueryTurnEnd({
      querySource: params.querySource,
      toolUseContext: params.toolUseContext,
      reason: runTerminalReason,
    })
    // AUTOPILOT: the turn boundary advances the tier cooldown clock and
    // reverts this thread's turn-scoped SetTier override — scope:'turn' dies
    // with its turn. Gated to turn-owning sources: service loops
    // (compact/classifiers) run nested query() calls mid-turn under the SAME
    // main-thread agent key and must not revert the owning turn's override.
    if (isTurnOwningQuerySource(params.querySource)) {
      tierTurnEnded(params.toolUseContext.agentId)
    }
  }
}

export async function* query(
  params: QueryParams,
): AsyncGenerator<LegacyQueryYield, Terminal> {
  return yield* projectLegacyYields(queryEvents(params))
}
