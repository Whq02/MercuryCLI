import type { NonNullableUsage } from '../services/api/logging.js'
import { API_ERROR_MESSAGE_PREFIX } from '../services/api/errors.js'
import { formatAPIError } from '../services/api/errorUtils.js'
import type { Message, SystemMessage } from '../types/message.js'
import { createUserMessage } from './messages.js'
import type { CacheSafeParams } from './forkedAgent.js'
import { runForkedAgent } from './forkedAgent.js'

/**
 * The side-question engine: answers a quick question on a cache-sharing
 * fork of the parent context, with the answer kept out of the main
 * conversation. The fork runs with a cap at 1 turn, and tools are blocked —
 * both enforced below through the fork parameters.
 */

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

/** Nothing for a blank or absent response — a cancelled or failed fork must not pin an empty item to a shelf. */
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

/** The /btw framing: the role words a bare side question rides with. A
 *  caller with a richer identity (the Helm console stamps its engine
 *  identity and its own role — helmConsoleAsk.ts) passes its own framing;
 *  the wrapper's shape stays one: a system-reminder carrying the framing
 *  and then the question. */
export const SIDE_QUESTION_FRAMING =
  `The user has a side question, answered by you — a separate lightweight agent spawned for this one question. ` +
  `The main agent is not interrupted and continues independently; you share its conversation context but are a separate instance. ` +
  `Do not present yourself as having been interrupted and do not refer to what you were "previously doing". ` +
  `You have no tools: you cannot read files, run commands, search, or take any action, and there will be no follow-up turn. ` +
  `Answer directly, in a single response, using only information already in the conversation context. ` +
  `Never promise to take an action or offer to look something up. If you do not know, say so.`

/** The one user turn a side question sends: the framing, then the question,
 *  inside a system-reminder. Exported so a prover can pin what rides the
 *  wire without running a fork. */
export function sideQuestionTurn(question: string, framing: string = SIDE_QUESTION_FRAMING): string {
  return `<system-reminder>\n${framing}\nSide question: ${question}\n</system-reminder>`
}

/**
 * Response extraction flattens the REAL assistant content blocks across ALL
 * assistant messages before looking for text: the streaming layer records
 * each block as its own assistant message, so with thinking enabled the
 * reply is a thinking-only message followed by a text-only one.
 *
 * API-ERROR settlements are FAILURES, never answers: the engine's failure
 * channel is a synthetic assistant message (isApiErrorMessage) whose text is
 * the failure sentence — a raw runtime throw lands here too, via the turn
 * machine's catch. Flattening those as answer text painted a bare
 * "Cannot read properties of undefined (reading 'type')" as a console REPLY
 * (the live answer-seam sighting): the caller's failure detector sniffs a
 * prefix the raw text does not carry. Errors are collected separately and
 * surface ONLY through the typed 'An API error occurred:' shape every
 * caller already recognises.
 *
 * Exported for the answer-seam prover — production entry is runSideQuestion.
 */
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
  // No real answer settled: the failure channels speak — the synthetic
  // assistant error first (it carries the runtime's own sentence), then the
  // system api_error row. Both wear a recognised failure shape: a sentence
  // already carrying the API-error prefix passes through verbatim (callers
  // recognise that prefix too — no double wrap).
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
  /** Run the fork on THIS model instead of the parent's. A different model
   *  is a different cache key, so the fork re-reads the shared context
   *  uncached — callers surface that cost honestly; identical-to-parent
   *  callers pass nothing and keep the cache-hit prefix. */
  modelOverride?: string
  /** The role words the question rides with (SIDE_QUESTION_FRAMING when
   *  absent). Rides the USER turn, never the system prompt: the shared
   *  prefix stays byte-identical, so an identical-model fork keeps its
   *  cache hit. */
  framing?: string
}): Promise<SideQuestionResult> {
  // No thinking-configuration override: the provider hashes thinking
  // settings into the cache key, and a changed fork would pay for a full
  // prefix instead of sharing the parent's. The caller's controller becomes
  // the FORK'S OWN controller so an abort actually stops (and stops
  // billing) the provider stream, not just the caller's interest in it.
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
