import type { NonNullableUsage } from '../services/api/logging.js'
import { API_ERROR_MESSAGE_PREFIX } from '../services/api/errors.js'
import { formatAPIError } from '../services/api/errorUtils.js'
import type { Message, SystemMessage } from '../types/message.js'
import { createUserMessage } from './messages.js'
import type { CacheSafeParams } from './forkedAgent.js'
import { runForkedAgent } from './forkedAgent.js'


export type SideQuestionResult = {
  response: string | null
  usage: NonNullableUsage
  originRef?: string
  question?: string
}

export type SideQuestionContextItem = {
  kind: 'side-question'
  question: string
  response: string
  originRef?: string
  atMs: number
}

export function toContextItem(result: SideQuestionResult, atMs: number): SideQuestionContextItem | null {
  if (!result.response || result.response.trim() === '') return null
  return {
    kind: 'side-question',
    question: result.question ?? '',
    response: result.response,
    ...(result.originRef !== undefined ? { originRef: result.originRef } : {}),
    atMs,
  }
}

export const SIDE_QUESTION_FRAMING =
  `The user has a side question, answered by you — a separate lightweight agent spawned for this one question. ` +
  `The main agent is not interrupted and continues independently; you share its conversation context but are a separate instance. ` +
  `Do not present yourself as having been interrupted and do not refer to what you were "previously doing". ` +
  `You have no tools: you cannot read files, run commands, search, or take any action, and there will be no follow-up turn. ` +
  `Answer directly, in a single response, using only information already in the conversation context. ` +
  `Never promise to take an action or offer to look something up. If you do not know, say so.`

export function sideQuestionTurn(question: string, framing: string = SIDE_QUESTION_FRAMING): string {
  return `<system-reminder>\n${framing}\nSide question: ${question}\n</system-reminder>`
}

export function extractResponse(messages: Message[]): string | null {
  const blocks: Array<{ type?: string; text?: string; name?: string }> = []
  let assistantApiErrorText: string | null = null
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    if (message.isApiErrorMessage === true) {
      const content = message.message.content
      const errText = Array.isArray(content)
        ? (content as typeof blocks)
            .filter(b => !!b && b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text as string)
            .join('\n')
            .trim()
        : ''
      if (assistantApiErrorText === null && errText !== '') assistantApiErrorText = errText
      continue
    }
    const content = message.message.content
    if (Array.isArray(content)) blocks.push(...(content as typeof blocks))
  }
  const text = blocks
    .filter(block => !!block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
    .map(block => block.text as string)
    .join('\n\n')
    .trim()
  if (text !== '') return text
  const toolUse = blocks.find(block => !!block && block.type === 'tool_use')
  if (toolUse) {
    const named = toolUse.name ? `the ${toolUse.name} tool` : 'a tool'
    return `The model tried to call ${named} instead of answering directly. Try rephrasing the question, or ask it in the main conversation.`
  }
  if (assistantApiErrorText !== null) {
    return assistantApiErrorText.startsWith(API_ERROR_MESSAGE_PREFIX)
      ? assistantApiErrorText
      : `An API error occurred: ${assistantApiErrorText}`
  }
  const apiError = messages.find(
    (message): message is SystemMessage =>
      message.type === 'system' && (message as { subtype?: string }).subtype === 'api_error',
  )
  if (apiError) {
    const detail = (apiError as { error?: Error | undefined }).error
    return `An API error occurred: ${detail ? formatAPIError(detail) : 'unknown error'}`
  }
  return null
}

export async function runSideQuestion({
  question,
  cacheSafeParams,
  abortController,
  originRef,
  modelOverride,
  framing,
}: {
  question: string
  cacheSafeParams: CacheSafeParams
  abortController?: AbortController
  originRef?: string
  modelOverride?: string
  framing?: string
}): Promise<SideQuestionResult> {
  const overrides = {
    ...(abortController ? { abortController } : {}),
    ...(modelOverride !== undefined
      ? {
          options: {
            ...cacheSafeParams.toolUseContext.options,
            mainLoopModel: modelOverride,
          },
        }
      : {}),
  }
  const { messages, totalUsage } = await runForkedAgent({
    promptMessages: [createUserMessage({ content: sideQuestionTurn(question, framing) })],
    cacheSafeParams,
    canUseTool: async (_tool, _input) =>
      ({
        behavior: 'deny',
        message: 'Side questions cannot use tools; tools are blocked for this fork.',
        decisionReason: { type: 'other', reason: 'side_question' },
      }) as never,
    querySource: 'side_question' as never,
    forkLabel: 'side_question',
    overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    maxTurns: 1,
    skipCacheWrite: true,
  })
  return {
    response: extractResponse(messages),
    usage: totalUsage,
    ...(originRef !== undefined ? { originRef } : {}),
    question,
  }
}
