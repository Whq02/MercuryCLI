import { randomUUID } from 'node:crypto'
import type { Message, UserMessage } from '../types/message.js'
import type { AssistantMessage } from '../types/message.js'
import { readToolCallChain, type ToolUseContext } from '../Tool.js'
import type { QuerySource } from '../constants/querySource.js'
import type { TurnAnswerContext } from './turnAnswerContext.js'
import type { SystemPrompt } from '../utils/systemPromptType.js'
import { getSessionId } from '../bootstrap/state.js'
import { judgeTurnEnd } from '../guards/guards.js'
import { createAttachmentMessage } from '../utils/attachments.js'
import { logForDebugging } from '../utils/debug.js'
import { isBareMode } from '../utils/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { createCacheSafeParams, saveCacheSafeParams } from '../utils/forkedAgent.js'
import { prepareHooks } from '../utils/hooks/fire.js'
import { hookProgressMessage, hookRowsOfResult } from '../utils/hooks/rows.js'
import { extractTextContent, getLastAssistantMessage } from '../utils/messages.js'
import { createUserInterruptionMessage, createUserMessage } from '../utils/messages/factories.js'
import { createSystemMessage } from '../utils/messages/systemMessages.js'

export type StopHookOutcome = {
  blockingErrors: UserMessage[]
  preventContinuation: boolean
}

const MAIN_THREAD_SOURCE = 'main_thread'
const SDK_SOURCE = 'sdk'

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
  const history = [...messagesForQuery, ...assistantMessages]
  const hookContext: TurnAnswerContext = { messages: history, systemPrompt, userContext, systemContext, toolUseContext, querySource }

  if (querySource === MAIN_THREAD_SOURCE || querySource === SDK_SOURCE) {
    saveCacheSafeParams(createCacheSafeParams(hookContext))
  }

  const agentId = toolUseContext.agentId

  if (!isBareMode()) {
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const suggestion = require('../services/PromptSuggestion/promptSuggestion.js') as {
        executePromptSuggestion: (context: TurnAnswerContext) => Promise<void>
      }
      void suggestion.executePromptSuggestion(hookContext).catch(error => {
        logForDebugging(`prompt suggestion failed: ${errorMessage(error)}`)
      })
    }
    if (!agentId) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mneme = require('../mneme/mnemeMaintenance.js') as {
        scheduleMnemeMaintenance: (trigger: 'turn-end') => void
      }
      mneme.scheduleMnemeMaintenance('turn-end')
    }
  }

  const settlementBlocks: UserMessage[] = []
  const holds = await judgeTurnEnd(agentId ?? String(getSessionId()), { messages: history }, toolUseContext.abortController.signal)
  for (const hold of holds) {
    const message = createUserMessage({ content: hold.words, isMeta: true })
    settlementBlocks.push(message)
    yield message
    if (!hold.silent) yield createSystemMessage(`${hold.guard} held the turn: ${hold.words.split('\n')[0]}`, 'info')
  }

  try {
    const signal = toolUseContext.abortController.signal
    const lastAssistant = getLastAssistantMessage(history)
    const answer = lastAssistant ? extractTextContent(lastAssistant.message.content, '\n').trim() || undefined : undefined
    const turnId = readToolCallChain(toolUseContext)?.key ?? ''
    const toolUseID = randomUUID()
    const prepared = await prepareHooks(
      'turn.answer',
      { turn_id: turnId, ...(answer !== undefined ? { answer } : {}), again: stopHookActive ?? false },
      { scope: { sessionId: String(getSessionId()), ...(agentId !== undefined ? { crewmateId: agentId } : {}) }, signal, toolUseContext },
    )
    for (const name of prepared.names) yield hookProgressMessage('turn.answer', name, 'running', toolUseID, prepared.names.length)
    if (prepared.names.length === 0) return { blockingErrors: settlementBlocks, preventContinuation: false }
    const result = await prepared.run()
    for (const outcome of result.outcomes) yield hookProgressMessage('turn.answer', outcome.name, 'ran', toolUseID, result.outcomes.length)
    for (const row of hookRowsOfResult(result)) yield createAttachmentMessage(row)
    if (signal.aborted) {
      yield createUserInterruptionMessage({ toolUse: false, reason: signal.reason })
      return { blockingErrors: [], preventContinuation: true }
    }
    if (result.answer.stop !== undefined) return { blockingErrors: [], preventContinuation: true }
    const blockingErrors: UserMessage[] = []
    for (const context of result.answer.contexts) {
      const message = createUserMessage({ content: context, isMeta: true })
      blockingErrors.push(message)
      yield message
    }
    if (result.answer.block !== undefined) {
      const message = createUserMessage({ content: result.answer.block, isMeta: true })
      blockingErrors.push(message)
      yield message
      return { blockingErrors: [...settlementBlocks, ...blockingErrors], preventContinuation: false }
    }
    return { blockingErrors: settlementBlocks, preventContinuation: false }
  } catch (error) {
    yield createSystemMessage(`the turn.answer hooks could not run: ${errorMessage(error)}`, 'warning')
    return { blockingErrors: settlementBlocks, preventContinuation: false }
  }
}
