// ============================================================================
//  providers/openaicompat/compatWire — the PURE per-lane request-knob
//  builders. Zero heavy imports BY DESIGN (pins +
//  the shared effort ordering only) so the transport prover pins the EXACT
//  knobs each wire sends without loading the callModel runtime graph — the
//  profiles in the lane modules delegate here (one law, display truth =
//  dispatch truth).
// ============================================================================
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

/** Moonshot/Kimi knobs:
 *  reasoning_effort (kimi-k3's documented vocabulary, nearest-below
 *  resolution); stream_options.include_usage asks for token counts in the
 *  final chunk before [DONE] (the documented opt-in — nothing states usage
 *  arrives without it); max_completion_tokens only on an explicit override;
 *  NEVER temperature (K3/K2.x fix their sampling — documented only for the
 *  legacy moonshot-v1-* family). */
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

/** DeepSeek knobs: the thinking
 *  object carries type + reasoning_effort (low|high|max, nearest-below);
 *  stream_options.include_usage asks for the usage object before [DONE];
 *  max_tokens only on an explicit override. */
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

/** OpenRouter's documented `reasoning.effort` vocabulary (openrouter.ai/
 *  docs/use-cases/reasoning-tokens, fetched 2026-08-25: max · xhigh · high ·
 *  medium · low · minimal · none), in Mercury's rankable spellings. Which
 *  levels a ROW accepts is the live catalogue's statement (the row's
 *  `reasoning.supported_efforts`, else this ladder when the row lists
 *  `reasoning` among its supported_parameters) — never assumed per model. */
export const OPENROUTER_REASONING_EFFORTS: readonly string[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** OpenRouter knobs: `reasoning: { effort }` from the row's live vocabulary
 *  (nearest-below resolution — the Kimi/DeepSeek law), sent only when the
 *  row accepts a dial, the session thinks, and an effort was requested;
 *  stream_options.include_usage for the usage chunk; max_tokens only on an
 *  explicit override. A row without a stated vocabulary sends no dial —
 *  the provider default governs (absent beats invented). */
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

/** Gemini's documented `reasoning_effort` vocabulary on its OpenAI-
 *  compatibility surface (ai.google.dev/gemini-api/docs/openai, fetched
 *  2026-08-25: minimal · low · medium · high · none; "If no reasoning_effort
 *  is specified, Gemini uses the model's default level or budget"), kept to
 *  the levels Mercury's ladder can name and a thinking model always honours
 *  ("Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models" — so
 *  'none' is never offered). Which ROWS take the dial is the live
 *  catalogue's statement (`thinking: true`), never assumed per model. */
export const GEMINI_REASONING_EFFORTS: readonly string[] = ['low', 'medium', 'high']

/** Gemini knobs: reasoning_effort from the documented vocabulary (nearest-
 *  below) only when the live row states a thinking model (`acceptsEffort`)
 *  and the session thinks; stream_options.include_usage; max_tokens only on
 *  an explicit override. */
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

/** The compat slot's knobs: the baseline dialect — include_usage + the
 *  max_tokens override; no effort/thinking (no documented vocabulary to
 *  verify against, so the provider default governs). */
export function buildCompatSlotExtras(args: LaneExtrasArgs): Record<string, unknown> {
  return {
    stream_options: { include_usage: true },
    ...(args.maxOutputTokensOverride !== undefined
      ? { max_tokens: args.maxOutputTokensOverride }
      : {}),
  }
}

/** Hugging Face router knobs (huggingface.co/docs/inference-providers/tasks/
 *  chat-completion, fetched): stream_options.include_usage asks
 *  for the usage chunk before [DONE]; max_tokens only on an explicit
 *  override. reasoning_effort is documented there as "provider and model-
 *  dependent" with no per-model vocabulary, so no effort dial is sent —
 *  the provider default governs (absent beats invented). */
export function buildHuggingfaceExtras(args: LaneExtrasArgs): Record<string, unknown> {
  return {
    stream_options: { include_usage: true },
    ...(args.maxOutputTokensOverride !== undefined ? { max_tokens: args.maxOutputTokensOverride } : {}),
  }
}

/** The locally served families' documented knobs, per server kind. */
export type LocalServerKind = 'ollama' | 'lmstudio' | 'vllm' | 'llamacpp' | 'openai-compatible'

/** Each server's documented reasoning_effort vocabulary on its OpenAI-
 *  compatible chat surface (all fetched/read):
 *    ollama   — high | medium | low | max | none (docs.ollama.com/api/
 *               openai-compatibility; thinking models only);
 *    vllm     — none | minimal | low | medium | high | xhigh | max (vllm
 *               entrypoints/openai/chat_completion/protocol.py);
 *    llamacpp — the value is handed to the chat template, none disables
 *               thinking (tools/server/README.md) — the same ladder vLLM
 *               accepts is offered;
 *    lmstudio / unknown-kind servers — no documented vocabulary on the
 *               /v1 surface ⇒ no dial. */
export const LOCAL_SERVER_EFFORTS: Readonly<Record<LocalServerKind, readonly string[]>> = {
  ollama: ['low', 'medium', 'high', 'max'],
  vllm: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  llamacpp: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  lmstudio: [],
  'openai-compatible': [],
}

/** Local-server knobs: stream_options.include_usage (documented on every
 *  kind that states a feature list); max_tokens only on an explicit
 *  override; reasoning_effort from the server's vocabulary (nearest-below)
 *  only when the model is known to take it (`acceptsEffort`). */
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
