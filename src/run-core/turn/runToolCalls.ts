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

export async function* runToolCalls(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, TurnDecision> {
  return notBuilt('src/run-core/turn/runToolCalls.ts:48')
}
