import type { Message } from '../../types/message.js'
import {
  settleMemoryWriteRefusals,
  toolCallRefusalCorrection,
} from '../../services/providers/toolCallGate.js'
import {
  createUserMessage,
  normalizeMessagesForAPI,
} from '../../services/messages.js'
import { createAttachmentMessage } from '../../services/attachments.js'
import { runTools } from '../../services/tools/toolOrchestration.js'
import { turnCutResultText, type TurnCut } from '../../utils/messages/rejectionText.js'
import type { Terminal } from '../../query/transitions.js'
import type { RunEvent } from '../events.js'
import type { EventMint, IterationState, RunCtx, TurnDecision } from './state.js'
import { emitSyntheticSettlements } from './streamModel.js'
import { notBuilt } from '../../pi/holes.js'

const MAX_TURNS_CUT: TurnCut = { kind: 'cut', detail: 'the turn budget was spent' }

function toolUpdateEvent(message: Message, emit: EventMint): RunEvent {
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    const toolResult = message.message.content.find(
      c => c.type === 'tool_result',
    )
    if (toolResult) {
      return emit({
        kind: 'tool_settled',
        toolUseId: toolResult.tool_use_id,
        outcome: toolResult.is_error === true ? 'error' : 'ok',
        synthetic: false,
        message,
      })
    }
  }
  if (message.type === 'progress') {
    return emit({
      kind: 'tool_progress',
      toolUseId: message.toolUseID ?? '',
      message,
    })
  }
  if (message.type === 'attachment') {
    return emit({ kind: 'attachment', message })
  }
  return emit({ kind: 'notice', message })
}

export async function* runToolCalls(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, TurnDecision> {
  return notBuilt('src/run-core/turn/runToolCalls.ts:48')
}
