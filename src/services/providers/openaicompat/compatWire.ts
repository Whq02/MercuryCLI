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

export const LOCAL_SERVER_EFFORTS: Readonly<Record<LocalServerKind, readonly string[]>> = {
  ollama: ['none', 'low', 'medium', 'high', 'max'],
  vllm: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  llamacpp: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  lmstudio: [],
  'openai-compatible': [],
}

export const LOCAL_SERVER_STATES_THINKING: Readonly<Record<LocalServerKind, boolean>> = {
  ollama: true,
  lmstudio: true,
  vllm: false,
  llamacpp: false,
  'openai-compatible': false,
}

export function localThinkingOff(args: { server: LocalServerKind; acceptsEffort: boolean; thinkingEnabled: boolean }): boolean {
  return !args.thinkingEnabled && args.acceptsEffort && LOCAL_SERVER_STATES_THINKING[args.server]
}

export function localThinkingOffWireEffort(server: LocalServerKind): string | undefined {
  return LOCAL_SERVER_STATES_THINKING[server] ? thinkingOffWireEffort(LOCAL_SERVER_EFFORTS[server]) : undefined
}

export function buildLocalExtras(
  args: LaneExtrasArgs & { server: LocalServerKind; acceptsEffort: boolean },
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
