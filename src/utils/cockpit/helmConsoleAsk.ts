
import type { Message } from '../../types/message.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../services/api/errors.js'
import type { CacheSafeParams } from '../forkedAgent.js'
import { getLastCacheSafeParams } from '../forkedAgent.js'
import { getMessagesAfterCompactBoundary } from '../messages.js'
import {
  consoleModelOverride,
  resolveSubModel,
  subModelIdentityLine,
  type SubModelPin,
} from '../model/subModelSlots.js'
import type { ProcessUserInputContext } from '../processUserInput/processUserInput.js'
import { runSideQuestion } from '../sideQuestion.js'
import { noteCritterRealActivity } from './critterSleep.js'
import { asSystemPrompt } from '../systemPromptType.js'
import type { ConsoleRunnerResult } from './helmConsole.js'

export const CONSOLE_ROLE =
  `You are the Mercury CONSOLE: a separate side-question assistant that answers the operator's questions ABOUT this session and this project. ` +
  `You are not Mercury's main agent — the system prompt and the conversation above are the main agent's, shared with you as read-only context. ` +
  `The main agent did that work and continues independently: describe it as the main agent's work, never as your own, and do not present yourself as interrupted or refer to what you were "previously doing". ` +
  `You have no tools: you cannot read files, run commands, search, or take any action, and there is no follow-up turn — never promise to act or offer to look something up. ` +
  `Answer directly, in a single response, from what is already in the context; if you do not know, say so. ` +
  `When asked what your job or role is, say exactly this: you are the console, answering questions about the session and the project.`

export function consoleAskFraming(pin: SubModelPin): string {
  return `${subModelIdentityLine('console', pin)}\n${CONSOLE_ROLE}`
}

export function consoleAskFailure(response: string | null): string | null {
  if (response === null) return null
  const text = response.trimStart()
  if (text.startsWith(API_ERROR_MESSAGE_PREFIX) || text.startsWith('An API error occurred')) return text
  return null
}

function stripInProgressAssistantMessage(messages: Message[]): Message[] {
  const last = messages.at(-1)
  if (last?.type === 'assistant' && last.message.stop_reason === null) {
    return messages.slice(0, -1)
  }
  return messages
}

export async function runConsoleAsk({
  question,
  context,
  abortController,
  originRef,
}: {
  question: string
  context: ProcessUserInputContext
  abortController: AbortController
  originRef?: string
}): Promise<ConsoleRunnerResult> {
  const slot = resolveSubModel('console')
  if (slot.origin === 'unset') {
    return {
      response: slot.hint,
      ...(originRef !== undefined ? { originRef } : {}),
    }
  }
  const forkContextMessages = getMessagesAfterCompactBoundary(
    stripInProgressAssistantMessage(context.messages),
  )
  const saved = getLastCacheSafeParams()
  let cacheSafeParams: CacheSafeParams
  if (saved) {
    cacheSafeParams = {
      systemPrompt: saved.systemPrompt,
      userContext: saved.userContext,
      systemContext: saved.systemContext,
      toolUseContext: context,
      forkContextMessages,
    }
  } else {
    const [{ getSystemPrompt }, { getSystemContext, getUserContext }] =
      await Promise.all([
        import('../../constants/prompts.js'),
        import('../../context.js'),
      ])
    const [rawSystemPrompt, userContext, systemContext] = await Promise.all([
      getSystemPrompt(
        context.options.tools,
        context.options.mainLoopModel,
        [],
        context.options.mcpClients,
      ),
      getUserContext(),
      getSystemContext(),
    ])
    cacheSafeParams = {
      systemPrompt: asSystemPrompt(rawSystemPrompt),
      userContext,
      systemContext,
      toolUseContext: context,
      forkContextMessages,
    }
  }
  const modelOverride = consoleModelOverride(context.options.mainLoopModel)
  noteCritterRealActivity()
  let result: Awaited<ReturnType<typeof runSideQuestion>>
  try {
    result = await runSideQuestion({
      question,
      cacheSafeParams,
      abortController,
      framing: consoleAskFraming(slot),
      ...(originRef !== undefined ? { originRef } : {}),
      ...(modelOverride !== undefined ? { modelOverride } : {}),
    })
  } finally {
    noteCritterRealActivity()
  }
  const failure = consoleAskFailure(result.response)
  if (failure !== null) throw new Error(failure)
  return {
    response: result.response,
    usage: result.usage,
    ...(result.originRef !== undefined ? { originRef: result.originRef } : {}),
  }
}
