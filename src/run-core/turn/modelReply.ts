import type { AssistantMessage, RefusedToolCall } from '../../types/message.js'
import { getModelMaxOutputTokens } from '../../utils/model/capabilities.js'
import { outputRoomOf } from '../../services/api/outputFit.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import { turnCutOf, turnCutResultText } from '../../utils/messages/rejectionText.js'
import type { Terminal } from '../../query/transitions.js'
import { isWithheldMaxOutputTokens } from '../model-lane.js'
import type { RunEvent } from '../events.js'
import { CUT_TOOL_CALL_RECOVERY_LIMIT, decideCutToolCallRecovery } from './judgements.js'
import { trimChantedIteration, type IterationState, type NextTurn, type RunCtx, type TurnDecision } from './state.js'
import { emitSyntheticSettlements, streamModel } from './streamModel.js'
import { notBuilt } from '../../pi/holes.js'

function cutToolCallOf(assistantMessages: readonly AssistantMessage[], refused: readonly RefusedToolCall[]): { name: string; cutAt: number } | null {
  const cut = refused.find(r => r.code === 'invalid-json')
  if (cut === undefined) return null
  const replies = assistantMessages.filter(m => m.isApiErrorMessage !== true)
  const stopped = assistantMessages.some(isWithheldMaxOutputTokens) || replies.some(m => m.message.stop_reason === 'max_tokens')
  if (!stopped) return null
  const cutAt = Math.max(0, ...replies.map(m => m.message.usage?.output_tokens ?? 0))
  return { name: cut.name || 'unnamed', cutAt }
}

export async function* modelReply(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, TurnDecision> {
  return notBuilt('src/run-core/turn/modelReply.ts:34')
}
