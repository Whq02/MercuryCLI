import { notifyCommandLifecycle } from '../daemon/runner/commandLifecycle.js'
import {
  observeTurnEnd,
  observeTurnStart,
} from './run/runTurnObserver.js'
import type { Terminal } from './turn-entry/transitions.js'
import { runEventCore, type TurnParams } from './loop/turn-machine.js'
import type { RunEvent } from './loop/events.js'
import {
  projectLegacyYields,
  type LegacyTurnYield,
} from './loop/project-legacy.js'

export type { TurnParams } from './loop/turn-machine.js'

export async function* turnDoorEvents(
  params: TurnParams,
): AsyncGenerator<RunEvent, Terminal> {
  observeTurnStart(params)
  const consumedCommandUuids: string[] = []
  let terminal: Terminal | undefined
  try {
    terminal = yield* runEventCore(params, consumedCommandUuids)
    for (const uuid of consumedCommandUuids) {
      notifyCommandLifecycle(uuid, 'completed')
    }
    return terminal
  } finally {
    await observeTurnEnd({
      querySource: params.querySource,
      toolUseContext: params.toolUseContext,
      reason: terminal?.reason ?? 'threw',
    })
  }
}

export async function* turnDoor(
  params: TurnParams,
): AsyncGenerator<LegacyTurnYield, Terminal> {
  return yield* projectLegacyYields(turnDoorEvents(params))
}
