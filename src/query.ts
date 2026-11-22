import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import {
  noteQueryTurnEnd,
  noteQueryTurnStart,
} from './services/run/runTurnObserver.js'
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
  noteQueryTurnStart(params)
  const consumedCommandUuids: string[] = []
  let terminal: Terminal | undefined
  try {
    terminal = yield* runEventCore(params, consumedCommandUuids)
    for (const uuid of consumedCommandUuids) {
      notifyCommandLifecycle(uuid, 'completed')
    }
    return terminal
  } finally {
    await noteQueryTurnEnd({
      querySource: params.querySource,
      toolUseContext: params.toolUseContext,
      reason: terminal?.reason ?? 'threw',
    })
  }
}

export async function* query(
  params: QueryParams,
): AsyncGenerator<LegacyQueryYield, Terminal> {
  return yield* projectLegacyYields(queryEvents(params))
}
