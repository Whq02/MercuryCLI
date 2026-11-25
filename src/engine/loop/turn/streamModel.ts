import type { EngineLadder } from '../../requests/backupEngines.js'
import type { RunEvent } from '../events.js'
import type { EventMint, IterationState, RunCtx } from './turnState.js'
import { callWithPolicy, streamReceipts, type ModelCall, type StreamOutcome } from './callPolicy.js'
import { readStream } from './readStream.js'
import { announceModelCall, firstTurnContext, openCall, sentMessages } from './callRequest.js'

export { emitSyntheticSettlements, modelCallFailed, streamReceipts, waitForModelPermit } from './callPolicy.js'
export { classifyDroppedThinking, settleReply } from './readStream.js'
export { announceModelCall } from './callRequest.js'

export function streamOneCall(run: RunCtx, iter: IterationState, emit: EventMint, call: ModelCall, backups: EngineLadder): AsyncGenerator<RunEvent> {
  return readStream(run, iter, emit, call, {
    firstTurnContext: () => firstTurnContext(run, iter),
    sent: firstTurn => sentMessages(iter, firstTurn),
    open: sending => openCall(run, iter, call, backups, sending),
    receipts: streamReceipts,
  })
}

export function streamModel(run: RunCtx, iter: IterationState, emit: EventMint): AsyncGenerator<RunEvent, StreamOutcome> {
  return callWithPolicy(run, iter, emit, { announce: announceModelCall, stream: streamOneCall })
}
