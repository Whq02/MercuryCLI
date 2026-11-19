import { startSessionActivity } from '../../../../utils/sessionActivity.js'
import { EMPTY_USAGE } from '../../../api/logging.js'
import { openStream } from './openStream.js'
import { readStream } from './readStream.js'
import { recoverStream } from './recoverStream.js'
import type { CallState, QueryCtx, QueryYield, StreamPass } from './state.js'
import { watchStream } from './watchStream.js'

export async function* streamPass(ctx: QueryCtx, call: CallState): AsyncGenerator<QueryYield, 'again' | 'return' | 'done'> {
  const { newMessages, contentBlocks, stoppedBlockIndices, settleUnpricedAttempt } = ctx
  const pass: StreamPass = {
    noteTransportActivity: null,
    transportSawByte: false,
    firstByte: { wait: null },
    streamIdleAborted: false,
    streamedToolUse: false,
    sawFirstStreamEvent: false,
    streamEventCount: 0,
    streamWatchdogFiredAt: null,
    sawMessageStop: false,
  }
  const stream = yield* openStream(ctx, call, pass)

  settleUnpricedAttempt()
  newMessages.length = 0
  call.ttftMs = 0
  call.partialMessage = undefined
  contentBlocks.length = 0
  stoppedBlockIndices.clear()
  call.usage = EMPTY_USAGE
  call.stopReason = null
  call.ledgerSettled = false

  const watch = watchStream(ctx, call, pass)

  startSessionActivity('api_call')
  try {
    if ((yield* readStream(ctx, call, pass, watch, stream)) === 'return') return 'return'
  } catch (streamingError) {
    return yield* recoverStream(ctx, call, pass, watch, streamingError)
  } finally {
    watch.clearStreamIdleTimers()
  }
  return 'done'
}
