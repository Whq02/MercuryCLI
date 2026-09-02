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

export interface LaneExtrasArgs {
  wireModel: string
  effortValue: string | undefined
  thinkingEnabled: boolean
  maxOutputTokensOverride: number | undefined
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
    thinking: {
      type: args.thinkingEnabled ? 'enabled' : 'disabled',
      ...(args.thinkingEnabled && wireEffort !== undefined
        ? { reasoning_effort: wireEffort }
        : {}),
    },
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
  args: LaneExtrasArgs & { vocabulary: readonly string[] },
): Record<string, unknown> {
  const wireEffort =
    args.thinkingEnabled && args.effortValue !== undefined && args.vocabulary.length > 0
      ? args.vocabulary.includes(args.effortValue)
        ? args.effortValue
        : nearestSupportedWireEffort(args.effortValue, args.vocabulary)
      : undefined
  return {
    stream_options: { include_usage: true },
    ...(wireEffort !== undefined ? { reasoning: { effort: wireEffort } } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_tokens: args.maxOutputTokensOverride } : {}),
  }
}

export const GEMINI_REASONING_EFFORTS: readonly string[] = ['low', 'medium', 'high']

export function buildGeminiExtras(
  args: LaneExtrasArgs & { acceptsEffort: boolean },
): Record<string, unknown> {
  const wireEffort =
    args.acceptsEffort && args.thinkingEnabled && args.effortValue !== undefined
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
  ollama: ['low', 'medium', 'high', 'max'],
  vllm: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  llamacpp: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  lmstudio: [],
  'openai-compatible': [],
}

export function buildLocalExtras(
  args: LaneExtrasArgs & { server: LocalServerKind; acceptsEffort: boolean },
): Record<string, unknown> {
  const vocabulary = LOCAL_SERVER_EFFORTS[args.server]
  const wireEffort =
    args.acceptsEffort && args.effortValue !== undefined && vocabulary.length > 0
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
