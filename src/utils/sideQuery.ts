
import type { ApiMessage } from '../types/wire.js'
import { setLastApiCompletionTimestamp } from '../bootstrap/state.js'
import { STRUCTURED_OUTPUTS_BETA_HEADER } from '../constants/betas.js'
import { getAttributionHeader, getCLISyspromptPrefix } from '../constants/system.js'
import type { QuerySource } from '../constants/querySource.js'
import { getAnthropicClient } from '../services/api/client.js'
import { getAPIMetadata } from '../services/providers/anthropic/requestParams.js'
import type { JsonOutputFormat, MessageParam, TextBlockParam } from '../types/wire.js'
import { computeFingerprint } from './fingerprint.js'
import {
  foldToolChoiceForModel,
  getMergedBetas,
  modelSupportsAdaptiveThinking,
  modelSupportsStructuredOutputs,
  modelSupportsTemperature,
  modelThinkingAlwaysOn,
} from './model/capabilities.js'
import { normalizeModelStringForAPI } from './model/model.js'

/**
 * The ONE wrapper for provider calls outside the main loop (permission
 * explanation/classification, session search, model validation, memory
 * relevance). Direct client calls must not replace it: this wrapper is what
 * guarantees correct OAuth attribution.
 */

export type SideQueryOptions = {
  model: string
  system?: string | TextBlockParam[]
  messages: MessageParam[]
  tools?: unknown[]
  tool_choice?: unknown
  output_format?: JsonOutputFormat
  max_tokens?: number
  maxRetries?: number
  signal?: AbortSignal
  skipSystemPromptPrefix?: boolean
  temperature?: number
  /** A number is a budget; false is an explicit disable; absent sends no thinking configuration. */
  thinking?: number | false
  stop_sequences?: string[]
  /** Required by the option type for cost attribution; callers must pass it. */
  querySource: QuerySource | string
}

function harnessVersion(): string {
  return typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : '0.0.0'
}

export type SideQueryThinkingParam =
  | { type: 'disabled' }
  | { type: 'adaptive' }
  | { type: 'enabled'; budget_tokens: number }
  | undefined

/**
 * The wire `thinking` parameter for a side query — pure, exported for its
 * prover. A number is a budget, but an adaptive-capable model takes no
 * budget (adaptive rides — the same law as the main stream; a manual budget
 * is a 400 on the 5-family). `false` is an explicit disable, OMITTED on the
 * always-on frontier family (Fable 5 / 5.1, the Mythos mirrors — `disabled`
 * is a 400 there; adaptive runs). Absent sends no thinking configuration.
 */
export function sideQueryThinkingParam(
  model: string,
  thinking: SideQueryOptions['thinking'],
  maxTokens: number,
): SideQueryThinkingParam {
  if (thinking === false) {
    return modelThinkingAlwaysOn(model) ? undefined : { type: 'disabled' }
  }
  if (typeof thinking === 'number') {
    if (modelSupportsAdaptiveThinking(model)) return { type: 'adaptive' }
    // The budget must stay under max tokens.
    return { type: 'enabled', budget_tokens: Math.min(thinking, maxTokens - 1) }
  }
  return undefined
}

function firstUserMessageText(messages: MessageParam[]): string {
  const first = messages.find(message => message.role === 'user')
  if (!first) return ''
  if (typeof first.content === 'string') return first.content
  const textBlock = first.content.find(block => (block as { type?: string }).type === 'text') as
    | { text?: string }
    | undefined
  return textBlock?.text ?? ''
}

export async function sideQuery(opts: SideQueryOptions): Promise<ApiMessage> {
  const maxRetries = opts.maxRetries ?? 2
  const maxTokens = opts.max_tokens ?? 1024
  const client = await getAnthropicClient({ maxRetries, source: 'side_query' })

  const betas = [...getMergedBetas(opts.model)]
  if (opts.output_format && modelSupportsStructuredOutputs(opts.model) && !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  // The attribution header rides in ITS OWN system block so server-side
  // parsing extracts the entrypoint without swallowing system content.
  const fingerprint = computeFingerprint(firstUserMessageText(opts.messages), harnessVersion())
  const attributionHeader = getAttributionHeader(fingerprint)
  const systemBlocks: TextBlockParam[] = []
  if (attributionHeader) systemBlocks.push({ type: 'text', text: attributionHeader })
  if (!opts.skipSystemPromptPrefix) {
    // A non-interactive-false, no-appended-prompt posture.
    systemBlocks.push({ type: 'text', text: getCLISyspromptPrefix({ isNonInteractive: false, hasAppendSystemPrompt: false }) })
  }
  if (typeof opts.system === 'string') {
    systemBlocks.push({ type: 'text', text: opts.system })
  } else if (Array.isArray(opts.system)) {
    systemBlocks.push(...opts.system)
  }

  const thinking = sideQueryThinkingParam(opts.model, opts.thinking, maxTokens)
  // A forced tool choice folds to `auto` on a model that rejects it (Claude
  // Fable 5.1) — the prompt still names the tool; never a 400.
  const toolChoice = opts.tool_choice
    ? foldToolChoiceForModel(opts.model, opts.tool_choice as { type: string })
    : undefined

  // Some model families refuse any request naming a temperature; the caller
  // still wants an answer more than it wants a 400.
  const includeTemperature = opts.temperature !== undefined && modelSupportsTemperature(opts.model)

  const request: Record<string, unknown> = {
    model: normalizeModelStringForAPI(opts.model),
    max_tokens: maxTokens,
    messages: opts.messages,
    system: systemBlocks,
    metadata: getAPIMetadata(),
    ...(includeTemperature ? { temperature: opts.temperature } : {}),
    ...(thinking ? { thinking } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(opts.stop_sequences ? { stop_sequences: opts.stop_sequences } : {}),
    ...(opts.output_format ? { output_config: { format: opts.output_format } } : {}),
    ...(betas.length > 0 ? { betas } : {}),
  }

  const response = await client.beta.messages.create(
    request as unknown as Parameters<typeof client.beta.messages.create>[0],
    // The abort signal is a request option, not baked into the body.
    opts.signal ? { signal: opts.signal } : undefined,
  )
  // Live behaviour: the last-API-completion timestamp is written after the
  // call. (The request id, the previous timestamp and the pre-call start
  // time the removed telemetry consumed are not reconstructed.)
  setLastApiCompletionTimestamp(Date.now())
  return response as unknown as ApiMessage
}
