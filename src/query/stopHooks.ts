import { randomUUID } from 'node:crypto'
import { confirmCitedFacts } from '../mneme/mnemeFootnotes.js'
import { scheduleMnemeMaintenance } from '../mneme/mnemeMaintenance.js'
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
import { executePromptSuggestion } from '../services/PromptSuggestion/promptSuggestion.js'
import { prepareHooks } from '../utils/hooks/fire.js'
import { hookProgressMessage, hookRowsOfResult } from '../utils/hooks/rows.js'
import { extractTextContent, getLastAssistantMessage } from '../services/messages.js'
import { createUserInterruptionMessage, createUserMessage } from '../utils/messages/factories.js'
import { createSystemMessage } from '../utils/messages/systemMessages.js'

type StopHookOutcome = {
  blockingErrors: Message[]
  preventContinuation: boolean
}

export async function* handleStopHooks(
  messagesForQuery: Message[],
  assistantMessages: AssistantMessage[],
  systemPrompt: SystemPrompt,
  userContext: { [k: string]: string },
  systemContext: { [k: string]: string },
  toolUseContext: ToolUseContext,
  querySource?: QuerySource,
  stopHookActive?: boolean,
): AsyncGenerator<Message, StopHookOutcome> {
  if (querySource === 'side_question') {
    return { blockingErrors: [], preventContinuation: false }
  }

  const allMessages: Message[] = [...messagesForQuery, ...assistantMessages]
  const hookContext: TurnAnswerContext = {
    messages: allMessages,
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    querySource,
  }

  if (querySource === 'main_thread' || querySource === 'sdk') {
    saveCacheSafeParams(createCacheSafeParams(hookContext))
  }

  const bare = isBareMode()
  if (!bare) {
    void executePromptSuggestion(hookContext).catch(error => {
      logForDebugging(`prompt suggestion failed: ${errorMessage(error)}`)
    })
    if (!toolUseContext.agentId) {
      scheduleMnemeMaintenance('turn-end')
    }
  }

  const settlement: Message[] = []
  const owner = ownerFromToolUseContext(toolUseContext)
  const pendingVerification = takeUnscoredVerification(owner)
  if (pendingVerification !== undefined) {
    yield createUserMessage({ content: pendingVerification, isMeta: true })
  }

  const guardKey = toolUseContext.agentId ?? getSessionId()
  const holds = await judgeTurnEnd(guardKey, { messages: allMessages }, toolUseContext.abortController.signal)
  for (const note of takeTurnNotes(guardKey)) {
    yield createSystemMessage(note.text, note.level)
  }
  for (const hold of holds) {
    const holdRow: UserMessage = createUserMessage({ content: hold.words, isMeta: true })
    settlement.push(holdRow)
    yield holdRow
    if (!hold.silent) {
      const firstLine = hold.words.split('\n')[0] ?? hold.words
      yield createSystemMessage(`${hold.guard} held the turn: ${firstLine}`, 'info')
    }
  }

  if (!bare) {
    try {
      const diagnostics = await settleWriterDiagnosticsAtTurnEnd(toolUseContext)
      for (const diagnostic of diagnostics) {
        const row = createAttachmentMessage(diagnostic)
        yield row
        if (stopHookActive !== true) {
          settlement.push(row)
        }
      }
    } catch (error) {
      logForDebugging(`turn-end diagnostics settlement failed: ${errorMessage(error)}`)
    }
  }

  try {
    const lastAssistant = getLastAssistantMessage(allMessages)
    const extracted = lastAssistant ? extractTextContent(lastAssistant.message.content, '\n').trim() : ''
    const answer = extracted.length > 0 ? extracted : undefined

    if (!bare && answer !== undefined && !toolUseContext.abortController.signal.aborted && assistantMessages.length > 0) {
      confirmCitedFacts(answer)
    }

    const turnId = readToolCallChain(toolUseContext)?.key ?? ''
    const prepared = await prepareHooks(
      'turn.answer',
      {
        turn_id: turnId,
        ...(answer !== undefined ? { answer } : {}),
        again: stopHookActive ?? false,
      },
      {
        scope: {
          sessionId: getSessionId(),
          ...(toolUseContext.agentId !== undefined ? { crewmateId: toolUseContext.agentId } : {}),
        },
        signal: toolUseContext.abortController.signal,
        toolUseContext,
      },
    )

    const toolUseID = randomUUID()
    for (const name of prepared.names) {
      yield hookProgressMessage('turn.answer', name, 'running', toolUseID, prepared.names.length)
    }
    if (prepared.names.length === 0) {
      return { blockingErrors: settlement, preventContinuation: false }
    }

    const result = await prepared.run()
    for (const outcome of result.outcomes) {
      yield hookProgressMessage('turn.answer', outcome.name, 'ran', toolUseID, result.outcomes.length)
    }
    for (const row of hookRowsOfResult(result)) {
      yield createAttachmentMessage(row)
    }

    if (toolUseContext.abortController.signal.aborted) {
      yield createUserInterruptionMessage({ toolUse: false, reason: toolUseContext.abortController.signal.reason })
      return { blockingErrors: [], preventContinuation: true }
    }

    if (result.answer.stop !== undefined) {
      return { blockingErrors: [], preventContinuation: true }
    }

    const contextRows: UserMessage[] = []
    for (const context of result.answer.contexts) {
      const row = createUserMessage({ content: context, isMeta: true })
      contextRows.push(row)
      yield row
    }

    if (result.answer.block !== undefined) {
      const blockRow = createUserMessage({ content: result.answer.block, isMeta: true })
      yield blockRow
      return {
        blockingErrors: [...settlement, ...contextRows, blockRow],
        preventContinuation: false,
      }
    }

    return { blockingErrors: settlement, preventContinuation: false }
  } catch (error) {
    yield createSystemMessage(`the turn.answer hooks could not run: ${errorMessage(error)}`, 'warning')
    return { blockingErrors: settlement, preventContinuation: false }
  }
}
