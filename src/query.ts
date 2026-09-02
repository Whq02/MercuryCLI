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

export async function* queryEvents(
  params: QueryParams,
): AsyncGenerator<RunEvent, Terminal> {
  const consumedCommandUuids: string[] = []
  noteQueryTurnStart(params)
  let runTerminalReason = 'threw'
  try {
    const terminal = yield* runEventCore(params, consumedCommandUuids)
    runTerminalReason = terminal.reason
    for (const uuid of consumedCommandUuids) {
      notifyCommandLifecycle(uuid, 'completed')
    }
    return terminal
  } finally {
    await noteQueryTurnEnd({
      querySource: params.querySource,
      toolUseContext: params.toolUseContext,
      reason: runTerminalReason,
    })
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
