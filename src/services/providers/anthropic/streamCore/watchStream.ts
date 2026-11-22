import type { ApiStreamEvent as BetaRawMessageStreamEvent } from '../../../../types/wire.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import type { AssistantMessage } from '../../../../types/message.js'
import { getPublicModelDisplayName } from '../../../model/model.js'
import { settleTranscriptMessage } from '../../../../utils/sessionStorage/writer.js'
import {
  silentAfterHeadersFaultWords,
  silentAfterHeadersWindowMs,
  createStreamActivityRelay,
  createStreamIdleWatchdog,
  streamEndReceiptLine,
  streamIdleTimeoutMsForRoute,
  streamIdleWarningMsOf,
  type StreamEndV1,
} from '../../streamIdleBudget.js'
import { patienceSeconds } from '../../patience.js'
import type { CallState, QueryCtx, StreamPass } from './state.js'
import { notBuilt, type Unbuilt } from '../../../../pi/holes.js'

export function watchStream(ctx: QueryCtx, call: CallState, pass: StreamPass): Unbuilt {
  return notBuilt('src/services/providers/anthropic/streamCore/watchStream.ts:20')
}
