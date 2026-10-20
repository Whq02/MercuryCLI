import { nearestSupportedWireEffort } from '../openai/gptPins.js'
import {
  kimiAcceptsEffort,
  KIMI_EFFORTS,
  KIMI_EFFORT_MODELS,
} from '../moonshot/kimiPins.js'
import {
  deepseekAcceptsEffort,
  DEEPSEEK_EFFORTS,
} from '../deepseek/deepseekPins.js'
import { EFFORT_STAMP_THINKING_OFF, type EffortWireFact } from '../../../utils/effortStamp.js'

export function thinkingOffWireEffort(vocabulary: readonly string[]): string | undefined {
  if (vocabulary.length === 0) return undefined
  return nearestSupportedWireEffort('none', vocabulary)
}

export interface LaneExtrasArgs {
  wireModel: string
  effortValue: string | undefined
  thinkingEnabled: boolean
  maxOutputTokensOverride: number | undefined
  conversationKey?: string
  cacheDomainKey?: string
  crewmate?: boolean
}

export function compatEffortWireFact(
  extra: Record<string, unknown>,
  args: { thinkingGated: boolean; thinkingEnabled: boolean; supported: boolean },
): EffortWireFact {
  const thinkingOff = args.thinkingGated && !args.thinkingEnabled
  const word = extra.reasoning_effort
  if (typeof word === 'string' && word !== '') {
    return { kind: 'sent', parameter: 'reasoning_effort', value: word, ...(thinkingOff ? { applied: EFFORT_STAMP_THINKING_OFF } : {}) }
  }
  const template = extra.chat_template_kwargs as Record<string, unknown> | undefined
  if (typeof template?.reasoning_effort === 'string') return { kind: 'sent', parameter: 'chat_template_kwargs.reasoning_effort', value: template.reasoning_effort }
  const reasoning = extra.reasoning
  const nested = typeof reasoning === 'object' && reasoning !== null ? (reasoning as { effort?: unknown }).effort : undefined
  if (typeof nested === 'string' && nested !== '') {
    return { kind: 'sent', parameter: 'reasoning.effort', value: nested, ...(thinkingOff ? { applied: EFFORT_STAMP_THINKING_OFF } : {}) }
  }
  const thinking = extra.thinking
  const thinkingType = typeof thinking === 'object' && thinking !== null ? (thinking as { type?: unknown }).type : undefined
  if (thinkingType === 'disabled') {
    return { kind: 'sent', parameter: 'thinking.type', value: 'disabled', applied: EFFORT_STAMP_THINKING_OFF }
  }
  return args.supported ? { kind: 'omitted' } : { kind: 'unsupported' }
}

export function buildMoonshotExtras(args: LaneExtrasArgs): Record<string, unknown> {
  const wireEffort =
    args.effortValue !== undefined && KIMI_EFFORT_MODELS.has(args.wireModel)
      ? kimiAcceptsEffort(args.wireModel, args.effortValue)
        ? args.effortValue
        : nearestSupportedWireEffort(args.effortValue, [...KIMI_EFFORTS])
      : undefined
  return {
    stream_options: { include_usage: true },
    ...(wireEffort !== undefined ? { reasoning_effort: wireEffort } : {}),
    ...(args.maxOutputTokensOverride !== undefined
      ? { max_completion_tokens: args.maxOutputTokensOverride }
      : {}),
  }
}

export function buildDeepseekExtras(args: LaneExtrasArgs): Record<string, unknown> {
  const wireEffort =
    args.effortValue !== undefined
      ? deepseekAcceptsEffort(args.wireModel, args.effortValue)
        ? args.effortValue
        : nearestSupportedWireEffort(args.effortValue, [...DEEPSEEK_EFFORTS])
      : undefined
  return {
    thinking: { type: args.thinkingEnabled ? 'enabled' : 'disabled' },
    ...(args.thinkingEnabled && wireEffort !== undefined
      ? { reasoning_effort: wireEffort }
      : {}),
    stream_options: { include_usage: true },
    ...(args.maxOutputTokensOverride !== undefined
      ? { max_tokens: args.maxOutputTokensOverride }
      : {}),
  }
}

export const OPENROUTER_REASONING_EFFORTS: readonly string[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export function buildOpenrouterExtras(
  args: LaneExtrasArgs & { vocabulary: readonly string[]; providerPolicy?: Record<string, unknown> },
): Record<string, unknown> {
  const wireEffort = !args.thinkingEnabled
    ? thinkingOffWireEffort(args.vocabulary)
    : args.effortValue !== undefined && args.vocabulary.length > 0
      ? args.vocabulary.includes(args.effortValue)
        ? args.effortValue
        : nearestSupportedWireEffort(args.effortValue, args.vocabulary)
      : undefined
  return {
    stream_options: { include_usage: true },
    ...(wireEffort !== undefined ? { reasoning: { effort: wireEffort } } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_tokens: args.maxOutputTokensOverride } : {}),
    ...(args.providerPolicy !== undefined ? { provider: args.providerPolicy } : {}),
  }
}

export const GEMINI_REASONING_EFFORTS: readonly string[] = ['low', 'medium', 'high']

export function buildGeminiExtras(
  args: LaneExtrasArgs & { acceptsEffort: boolean },
): Record<string, unknown> {
  const wireEffort = !args.acceptsEffort
    ? undefined
    : !args.thinkingEnabled
      ? thinkingOffWireEffort(GEMINI_REASONING_EFFORTS)
      : args.effortValue !== undefined
        ? GEMINI_REASONING_EFFORTS.includes(args.effortValue)
          ? args.effortValue
          : nearestSupportedWireEffort(args.effortValue, GEMINI_REASONING_EFFORTS)
        : undefined
  return {
    stream_options: { include_usage: true },
    ...(wireEffort !== undefined ? { reasoning_effort: wireEffort } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_tokens: args.maxOutputTokensOverride } : {}),
  }
}

export function buildCompatSlotExtras(args: LaneExtrasArgs): Record<string, unknown> {
  return {
    stream_options: { include_usage: true },
    ...(args.maxOutputTokensOverride !== undefined
      ? { max_tokens: args.maxOutputTokensOverride }
      : {}),
  }
}

export function buildHuggingfaceExtras(args: LaneExtrasArgs): Record<string, unknown> {
  return {
    stream_options: { include_usage: true },
    ...(args.maxOutputTokensOverride !== undefined ? { max_tokens: args.maxOutputTokensOverride } : {}),
  }
}

export type LocalServerKind = 'ollama' | 'lmstudio' | 'vllm' | 'llamacpp' | 'openai-compatible'

export const LOCAL_SERVER_EFFORTS: Readonly<Record<LocalServerKind | 'sglang', readonly string[]>> = {
  ollama: ['none', 'low', 'medium', 'high', 'max'],
  vllm: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  sglang: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  llamacpp: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  lmstudio: [],
  'openai-compatible': [],
}

export const LOCAL_SERVER_STATES_THINKING: Readonly<Record<LocalServerKind | 'sglang', boolean>> = {
  ollama: true,
  lmstudio: true,
  vllm: false,
  sglang: false,
  llamacpp: false,
  'openai-compatible': false,
}

export function localThinkingOff(args: { server: LocalServerKind | 'sglang'; acceptsEffort: boolean; thinkingEnabled: boolean }): boolean {
  return !args.thinkingEnabled && args.acceptsEffort && LOCAL_SERVER_STATES_THINKING[args.server]
}

export function localThinkingOffWireEffort(server: LocalServerKind | 'sglang'): string | undefined {
  return LOCAL_SERVER_STATES_THINKING[server] ? thinkingOffWireEffort(LOCAL_SERVER_EFFORTS[server]) : undefined
}

export function buildLocalExtras(
  args: LaneExtrasArgs & { server: LocalServerKind | 'sglang'; acceptsEffort: boolean; idSlot?: number },
): Record<string, unknown> {
  const vocabulary = LOCAL_SERVER_EFFORTS[args.server]
  const wireEffort =
    !args.acceptsEffort || vocabulary.length === 0
      ? undefined
      : localThinkingOff(args)
        ? localThinkingOffWireEffort(args.server)
        : args.effortValue !== undefined
          ? vocabulary.includes(args.effortValue)
            ? args.effortValue
            : nearestSupportedWireEffort(args.effortValue, vocabulary)
          : undefined
  return {
    stream_options: { include_usage: true },
    ...(wireEffort !== undefined ? { reasoning_effort: wireEffort } : {}),
    ...(args.server === 'sglang' ? { chat_template_kwargs: { clear_thinking: false } } : {}),
    ...(args.server === 'llamacpp' && args.idSlot !== undefined ? { id_slot: args.idSlot, cache_prompt: true } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_tokens: args.maxOutputTokensOverride } : {}),
  }
}

export function buildXaiExtras(args: LaneExtrasArgs & { vocabulary: readonly string[] }): Record<string, unknown> {
  const effort = args.vocabulary.length === 0 ? undefined
    : !args.thinkingEnabled ? thinkingOffWireEffort(args.vocabulary)
      : args.effortValue !== undefined ? nearestSupportedWireEffort(args.effortValue, args.vocabulary) : undefined
  return {
    stream_options: { include_usage: true },
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_completion_tokens: args.maxOutputTokensOverride } : {}),
  }
}

export function buildHostedExtras(args: LaneExtrasArgs & { dialect: import('./compatProbe.js').CompatDialect; vocabulary: readonly string[]; idSlot?: number }): Record<string, unknown> {
  const base = args.dialect === 'chat-completions' || args.dialect === 'responses'
    ? buildCompatSlotExtras(args)
    : buildLocalExtras({ ...args, effortValue: undefined, server: args.dialect, acceptsEffort: true })
  const effort = base.reasoning_effort === undefined && args.effortValue !== undefined && args.vocabulary.length > 0 ? nearestSupportedWireEffort(args.effortValue, args.vocabulary) : undefined
  if (effort === undefined) return base
  return args.dialect === 'llamacpp'
    ? { ...base, chat_template_kwargs: { reasoning_effort: effort } }
    : { ...base, reasoning_effort: effort }
}

export function rejectedHostedEffortField(extra: Record<string, unknown>, fault: { status?: number; message: string; parameter?: string }): 'reasoning_effort' | 'chat_template_kwargs' | undefined {
  if (fault.status !== 400) return undefined
  const template = extra.chat_template_kwargs as Record<string, unknown> | undefined
  if (extra.reasoning_effort === undefined && template?.reasoning_effort === undefined) return undefined
  const named = fault.parameter ?? fault.message
  if (/\breasoning_effort\b/i.test(named)) return 'reasoning_effort'
  if (template?.reasoning_effort !== undefined && /\bchat_template_kwargs\b/i.test(named)) return 'chat_template_kwargs'
  return undefined
}

export function withoutHostedEffort(extra: Record<string, unknown>, field: 'reasoning_effort' | 'chat_template_kwargs'): Record<string, unknown> {
  const next = { ...extra }
  delete next.reasoning_effort
  if (field === 'chat_template_kwargs') delete next.chat_template_kwargs
  else if (typeof next.chat_template_kwargs === 'object' && next.chat_template_kwargs !== null) {
    const template = { ...next.chat_template_kwargs } as Record<string, unknown>
    delete template.reasoning_effort
    if (Object.keys(template).length) next.chat_template_kwargs = template
    else delete next.chat_template_kwargs
  }
  return next
}
