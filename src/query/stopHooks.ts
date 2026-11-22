import { randomUUID } from 'node:crypto'
import { confirmCitedFacts } from '../mneme/mnemeFootnotes.js'
import type { Message, UserMessage } from '../types/message.js'
import type { AssistantMessage } from '../types/message.js'
import { readToolCallChain, type ToolUseContext } from '../Tool.js'
import type { QuerySource } from '../constants/querySource.js'
import type { TurnAnswerContext } from './turnAnswerContext.js'
import type { SystemPrompt } from '../utils/systemPromptType.js'
import { getSessionId } from '../bootstrap/state.js'
import { ownerFromToolUseContext } from '../utils/run/resolveOwner.js'
import { takeUnscoredVerification } from '../utils/verification/verificationState.js'
import { judgeTurnEnd, takeTurnNotes } from '../guards/guards.js'
import { createAttachmentMessage } from '../services/attachments.js'
import { settleWriterDiagnosticsAtTurnEnd } from '../services/attachments/diagnostics.js'
import { logForDebugging } from '../utils/debug.js'
import { isBareMode } from '../utils/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { createCacheSafeParams, saveCacheSafeParams } from '../services/agents/forkedAgent.js'
import { prepareHooks } from '../utils/hooks/fire.js'
import { hookProgressMessage, hookRowsOfResult } from '../utils/hooks/rows.js'
import { extractTextContent, getLastAssistantMessage } from '../services/messages.js'
import { createUserInterruptionMessage, createUserMessage } from '../utils/messages/factories.js'
import { createSystemMessage } from '../utils/messages/systemMessages.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type StopHookOutcome = Unbuilt

export async function* handleStopHooks(
  messagesForQuery: Message[],
  assistantMessages: AssistantMessage[],
  systemPrompt: SystemPrompt,
  userContext: { [k: string]: string },
  systemContext: { [k: string]: string },
  toolUseContext: ToolUseContext,
  querySource: QuerySource | undefined,
  stopHookActive?: boolean,
): AsyncGenerator<Message, StopHookOutcome> {
  return notBuilt('src/query/stopHooks.ts:33')
}
