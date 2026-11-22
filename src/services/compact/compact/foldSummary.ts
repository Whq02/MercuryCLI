import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage, Message } from '../../../types/message.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { CacheSafeParams } from '../../agents/forkedAgent.js'
import type { OverflowSignal } from '../../api/overflowSignal.js'
import { estimateRequestGauge, type readRequestGauge } from '../../run/requestGauge.js'
import { computeVerbatimRecentTail, isMercuryCompactKeepTailEnabled } from '../verbatimTail.js'
import { SPLIT_STAND_IN_FLOOR_TOKENS, SPLIT_STAND_IN_LANDING_SHARE } from './limits.js'
import { validateSummary } from './summaryCheck.js'
import { newFoldLadder, foldLadderExhausted, proseSkippedNote, proseSkippedLine, summarizeWithPtlRetry } from './ladder.js'
import { summariserFitFor, prefitSummariserInput } from './summariserFit.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

export type FitsUnder = (limit: number | undefined, resultsFolded: boolean, prose: string, memoryNote: string | null) => (keep: Message[]) => boolean

type SummaryNeeds = Unbuilt

export async function summariseForFold(arg0: SummaryNeeds): Promise<{ splitRounds: number; response: AssistantMessage | undefined; rawSummary: string; proseSkipped: string | undefined; proseSkippedReceipt: string | undefined }> {
  return notBuilt('src/services/compact/compact/foldSummary.ts:29')
}
