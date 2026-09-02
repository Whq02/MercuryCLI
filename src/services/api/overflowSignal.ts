// ============================================================================
//  services/api/overflowSignal — THE context-overflow signal, one owner.
//
//  Ten provider families answer "the request does not fit the window" in
//  ten dresses: Anthropic's 400 "prompt is too long: N tokens > M maximum"
//  (and its 413 body cap), OpenAI's `context_length_exceeded` code with the
//  chat sentence ("This model's maximum context length is N tokens…") or
//  the Responses sentence ("Your input exceeds the context window…"),
//  OpenRouter's endpoint sentence with the middle-out hint, DeepSeek's
//  OpenAI-compatible sentence, Moonshot's "exceeded model token limit: N",
//  Gemini's "input token count (N) exceeds the maximum number of tokens
//  allowed (M)", the Hugging Face router's TGI validation error (HTTP 422,
//  "`inputs` tokens + `max_new_tokens` must be <= N"), vLLM's top-level
//  message, llama.cpp's "the request exceeds the available context size",
//  LM Studio's context-length overflow sentence, and Z.AI's documented
//  mid-stream finish reason `model_context_window_exceeded`. Ollama answers
//  with NO error — it truncates the prompt silently — so on that lane only
//  Mercury's own pre-call estimate (the blocking limit) can see the event.
//
//  This module classifies every one of them into ONE typed OverflowSignal
//  at each family's terminal-fault seam (the runtime stamps it on the
//  assistant API-error message it mints); consumers — the turn machine's
//  recovery ladder, the fold's own retry, the coordinator's turn — read the
//  stamped field and never sniff prose. Status is the first law: a 429 that
//  mentions tokens is a rate limit, a 401 is a credential wall, a 5xx is
//  the server — none of them is an overflow whatever their sentence says.
//  An output-cap complaint (max_tokens too large) is not an overflow either.
//
//  Pure: no env, no clock, no I/O. The recovery policy lives in
//  services/compact/overflowRecovery.ts.
// ============================================================================
import type { AssistantMessage, Message } from '../../types/message.js'
import type { CallModelRoute } from '../providers/idSpaces.js'

export type OverflowFamily = CallModelRoute | 'unknown'

export type OverflowShape =
  /** Anthropic 400 — "prompt is too long: N tokens > M maximum". */
  | 'prompt-too-long'
  /** Anthropic 413 — the request body cap (32 MB); a fold shrinks it too. */
  | 'request-too-large'
  /** The OpenAI-compatible sentence and code — OpenAI, DeepSeek, vLLM,
   *  OpenRouter, the Responses wire's "exceeds the context window". */
  | 'context-length-exceeded'
  /** Gemini — "input token count (N) exceeds the maximum number of tokens
   *  allowed (M)". */
  | 'input-token-limit'
  /** Moonshot — "Your request exceeded model token limit: N". */
  | 'token-limit'
  /** TGI behind the Hugging Face router — HTTP 422 input validation. */
  | 'input-validation'
  /** llama.cpp / LM Studio — the available context size is exceeded. */
  | 'context-size'
  /** Z.AI — the documented finish reason `model_context_window_exceeded`,
   *  a mid-stream termination rather than an HTTP refusal. */
  | 'context-window-exceeded'
  /** Mercury's own pre-call estimate crossed the blocking limit. */
  | 'blocking-limit'

export type OverflowSignal = {
  /** Who said so: the provider's wire, or Mercury's pre-call estimate. */
  source: 'provider' | 'estimate'
  family: OverflowFamily
  shape: OverflowShape
  /** The request's size in the speaker's own count, when it named one. */
  actualTokens?: number
  /** The window the speaker enforces, when it named one. */
  limitTokens?: number
  /** The speaker's own sentence, bounded — never a key, never a body. */
  detail?: string
}

const DETAIL_MAX_CHARS = 240

const num = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw.replace(/[,_]/g, ''), 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const bounded = (text: string): string | undefined => {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t === '') return undefined
  return t.length > DETAIL_MAX_CHARS ? `${t.slice(0, DETAIL_MAX_CHARS - 1)}…` : t
}

/** An output-cap complaint names max_tokens / completion tokens and never
 *  the input side — a different refusal class (the request fits; the asked
 *  output does not). TGI's validation sentence names both (`inputs` tokens
 *  + `max_new_tokens`) and IS an input overflow. */
function isOutputCapComplaint(lower: string): boolean {
  if (/maximum allowed number of output tokens/.test(lower)) return true
  if (!/\b(max_tokens|max_completion_tokens|max_new_tokens)\b/.test(lower)) return false
  return !/\b(inputs?|prompt|messages|context)\b/.test(lower)
}

type ShapeMatch = { shape: OverflowShape; actualTokens?: number; limitTokens?: number }

/** The message-text table — every family's sentence, most specific first.
 *  Each entry names the shape and pulls the numbers the sentence carries. */
function matchOverflowSentence(message: string): ShapeMatch | null {
  const lower = message.toLowerCase()
  if (isOutputCapComplaint(lower)) return null

  // Anthropic: "prompt is too long: 213462 tokens > 200000 maximum".
  const ptl = /prompt is too long(?:[\s\S]*?(\d[\d,]*)\s*tokens\s*>\s*(\d[\d,]*))?/i.exec(message)
  if (ptl) return { shape: 'prompt-too-long', actualTokens: num(ptl[1]), limitTokens: num(ptl[2]) }

  // Gemini: "The input token count (1200000) exceeds the maximum number of
  // tokens allowed (1048576)."
  const gemini = /input token count \((\d[\d,]*)\) exceeds the maximum number of tokens allowed \((\d[\d,]*)\)/i.exec(message)
  if (gemini) return { shape: 'input-token-limit', actualTokens: num(gemini[1]), limitTokens: num(gemini[2]) }

  // Moonshot: "Your request exceeded model token limit: 262144".
  const moonshot = /exceeded model token limit:?\s*(\d[\d,]*)/i.exec(message)
  if (moonshot) return { shape: 'token-limit', limitTokens: num(moonshot[1]) }

  // TGI (the Hugging Face router): "Input validation error: `inputs` tokens
  // + `max_new_tokens` must be <= 32768. Given: 40000 `inputs` tokens and
  // 1024 `max_new_tokens`".
  const tgi = /`?inputs`? tokens \+ `?max_new_tokens`? must be <= (\d[\d,]*)(?:[\s\S]*?given: (\d[\d,]*) `?inputs`? tokens)?/i.exec(message)
  if (tgi) return { shape: 'input-validation', limitTokens: num(tgi[1]), actualTokens: num(tgi[2]) }

  // The OpenAI-compatible sentence (OpenAI chat, DeepSeek, vLLM, OpenRouter's
  // endpoint variant): "This model's maximum context length is 128000
  // tokens. However, your messages resulted in 135000 tokens" / "you
  // requested (about) 140000 tokens".
  const maxLen = /maximum context length is (\d[\d,]*) tokens/i.exec(message)
  if (maxLen) {
    const actual = /(?:resulted in|requested(?: about)?)\s+(\d[\d,]*)\s+tokens/i.exec(message)
    return { shape: 'context-length-exceeded', limitTokens: num(maxLen[1]), actualTokens: num(actual?.[1]) }
  }
  // The Responses wire: "Your input exceeds the context window of this model."
  if (/exceeds? the context window/i.test(message)) return { shape: 'context-length-exceeded' }
  if (/context[ _]length[ _]exceeded/i.test(message)) return { shape: 'context-length-exceeded' }

  // llama.cpp: "the request exceeds the available context size"; LM Studio:
  // "…the model is loaded with context length of only 4096 tokens, which is
  // not enough"; the generic context-size overflow spellings.
  if (/exceeds? the available context size/i.test(message)) return { shape: 'context-size' }
  if (/context length of only (\d[\d,]*) tokens/i.test(message)) {
    return { shape: 'context-size', limitTokens: num(/context length of only (\d[\d,]*) tokens/i.exec(message)?.[1]) }
  }
  if (/context (?:size|length|window)[^.]{0,80}\b(?:exceed|overflow|too (?:long|large|many))/i.test(message)) {
    return { shape: 'context-size' }
  }
  if (/\b(?:exceed|overflow)[^.]{0,80}context (?:size|length|window)/i.test(message)) {
    return { shape: 'context-size' }
  }
  if (/\btokens? (?:in the prompt |count )?exceeds? the (?:model'?s )?(?:maximum )?context/i.test(message)) {
    return { shape: 'context-size' }
  }
  return null
}

/**
 * THE classifier. `code` is the runtime's stable code-first detail
 * ('openai-context_length_exceeded', 'finish:model_context_window_exceeded',
 * 'http-413', 'api-INVALID_ARGUMENT'…); `status` the HTTP status when the
 * fault came from a response; `message` the wire's own sentence. null for
 * every fault that is not a context overflow.
 */
export function classifyOverflowFault(fault: {
  family: OverflowFamily
  status?: number
  code?: string
  message?: string
}): OverflowSignal | null {
  const { family, status } = fault
  const code = fault.code ?? ''
  const message = fault.message ?? ''
  const detail = bounded(message)

  // The status law: only a bad-request class can be an overflow. A rate
  // limit (429), a credential wall (401/403), a billing refusal (402) and a
  // server fault (5xx) are never overflows, whatever their sentence says.
  if (status !== undefined && status !== 400 && status !== 413 && status !== 422) return null

  // The code words — the two wires that name the event outright.
  if (/context_length_exceeded/i.test(code)) {
    const sentence = matchOverflowSentence(message)
    return {
      source: 'provider',
      family,
      shape: 'context-length-exceeded',
      ...(sentence?.actualTokens !== undefined ? { actualTokens: sentence.actualTokens } : {}),
      ...(sentence?.limitTokens !== undefined ? { limitTokens: sentence.limitTokens } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
  }
  if (/model_context_window_exceeded/i.test(code)) {
    return { source: 'provider', family, shape: 'context-window-exceeded', ...(detail !== undefined ? { detail } : {}) }
  }

  const sentence = matchOverflowSentence(message)
  if (sentence !== null) {
    return {
      source: 'provider',
      family,
      shape: sentence.shape,
      ...(sentence.actualTokens !== undefined ? { actualTokens: sentence.actualTokens } : {}),
      ...(sentence.limitTokens !== undefined ? { limitTokens: sentence.limitTokens } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
  }

  // Anthropic's body cap: a 413 with no overflow sentence is still "the
  // request does not fit" — a fold shrinks bytes as well as tokens; the
  // ladder's retry tells the truth if a single attachment is the cause.
  if (status === 413 || /^http-413$/.test(code)) {
    return { source: 'provider', family, shape: 'request-too-large', ...(detail !== undefined ? { detail } : {}) }
  }
  return null
}

/** Mercury's own verdict: the pre-call estimate crossed the blocking limit. */
export function estimateOverflowSignal(input: {
  family: OverflowFamily
  actualTokens: number
  limitTokens: number
}): OverflowSignal {
  return {
    source: 'estimate',
    family: input.family,
    shape: 'blocking-limit',
    actualTokens: input.actualTokens,
    limitTokens: input.limitTokens,
  }
}

/** The stamped signal on an assistant API-error message; null otherwise.
 *  The one read every consumer performs — never a prose sniff. */
export function overflowSignalOf(message: Message | undefined): OverflowSignal | null {
  if (message === undefined || message.type !== 'assistant') return null
  const assistant = message as AssistantMessage
  if (assistant.isApiErrorMessage !== true) return null
  const signal = assistant.overflowSignal
  return signal !== undefined && signal !== null ? signal : null
}

/** actual − limit when the speaker named both and the request was over;
 *  undefined when the numbers are unknown (a fixture must never guess). */
export function overflowGapTokens(signal: OverflowSignal): number | undefined {
  if (signal.actualTokens === undefined || signal.limitTokens === undefined) return undefined
  const gap = signal.actualTokens - signal.limitTokens
  return gap > 0 ? gap : undefined
}

/** The numbers as one clause for the glass — "135,000 tokens > 128,000",
 *  "over the 131,072-token window", or nothing when neither was named. */
export function overflowNumbersClause(signal: OverflowSignal): string | undefined {
  const fmt = (n: number): string => n.toLocaleString('en-US')
  if (signal.actualTokens !== undefined && signal.limitTokens !== undefined) {
    return `${fmt(signal.actualTokens)} tokens > ${fmt(signal.limitTokens)}`
  }
  if (signal.limitTokens !== undefined) return `over the ${fmt(signal.limitTokens)}-token window`
  if (signal.actualTokens !== undefined) return `${fmt(signal.actualTokens)} tokens`
  return undefined
}
