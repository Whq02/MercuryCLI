import type { AssistantMessage, Message } from '../../types/message.js'
import { isBedrockThrottle } from './bedrockThrottle.js'
import type { CallModelRoute } from '../providers/idSpaces.js'
import { providerDisplayName } from '../providers/routeLaw.js'

export type OverflowFamily = CallModelRoute | 'unknown'

type OverflowShape =

  | 'prompt-too-long'
  | 'request-too-large'
  | 'context-length-exceeded'
  | 'input-token-limit'
  | 'token-limit'
  | 'input-validation'
  | 'context-size'
  | 'context-window-exceeded'
  | 'blocking-limit'

export type OverflowSignal = {

  source: 'provider' | 'estimate'
  family: OverflowFamily
  shape: OverflowShape

  actualTokens?: number

  limitTokens?: number

  detail?: string
  measuredTokens?: number
  measuredWindow?: number
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

function isOutputCapComplaint(lower: string): boolean {
  if (/maximum allowed number of output tokens/.test(lower)) return true
  if (!/\b(max_tokens|max_completion_tokens|max_new_tokens)\b/.test(lower)) return false
  return !/\b(inputs?|prompt|messages|context)\b/.test(lower)
}

function isRateLimitComplaint(lower: string): boolean {
  return /\b(?:tokens|requests) per (?:minute|second|day|hour)\b|\((?:tpm|rpm|tpd|rpd)\)|\brate[ _-]?limit|\bquota\b/.test(lower)
}

function isBodilessRefusal(message: string): boolean {
  const t = message.trim()
  return t === '' || /^(?:http\s+)?4\d\d(?:\s+status code)?(?:\s*\(no body\))?$/i.test(t) || /^\(no body\)$/i.test(t) || /^bad request$/i.test(t)
}

export const NEAR_WINDOW_SHARE = 0.8

type ShapeMatch = { shape: OverflowShape; actualTokens?: number; limitTokens?: number }

function matchOverflowSentence(message: string): ShapeMatch | null {
  const lower = message.toLowerCase()
  if (isOutputCapComplaint(lower) || isRateLimitComplaint(lower)) return null

  const ptl = /prompt is too long(?:[\s\S]*?(\d[\d,]*)\s*tokens\s*>\s*(\d[\d,]*))?/i.exec(message)
  if (ptl) return { shape: 'prompt-too-long', actualTokens: num(ptl[1]), limitTokens: num(ptl[2]) }

  const gemini = /input token count \((\d[\d,]*)\) exceeds the maximum number of tokens allowed \((\d[\d,]*)\)/i.exec(message)
  if (gemini) return { shape: 'input-token-limit', actualTokens: num(gemini[1]), limitTokens: num(gemini[2]) }

  const moonshot = /exceeded model token limit:?\s*(\d[\d,]*)/i.exec(message)
  if (moonshot) return { shape: 'token-limit', limitTokens: num(moonshot[1]) }

  const tgi = /`?inputs`? tokens \+ `?max_new_tokens`? must be <= (\d[\d,]*)(?:[\s\S]*?given: (\d[\d,]*) `?inputs`? tokens)?/i.exec(message)
  if (tgi) return { shape: 'input-validation', limitTokens: num(tgi[1]), actualTokens: num(tgi[2]) }

  const maxLen = /maximum context length is (\d[\d,]*) tokens/i.exec(message)
  if (maxLen) {
    const actual = /(?:resulted in|requested(?: about)?)\s+(\d[\d,]*)\s+tokens/i.exec(message)
    return { shape: 'context-length-exceeded', limitTokens: num(maxLen[1]), actualTokens: num(actual?.[1]) }
  }
  const inputBudget = /context length is only (\d[\d,]*) tokens[\s\S]*?maximum input length of (\d[\d,]*) tokens[\s\S]*?reduce the length of the input prompt/i.exec(message)
  if (inputBudget) {
    const actual = /passed (\d[\d,]*) input tokens/i.exec(message)
    return { shape: 'context-length-exceeded', limitTokens: num(inputBudget[2]), actualTokens: num(actual?.[1]) }
  }

  if (/exceeds? the context window/i.test(message)) return { shape: 'context-length-exceeded' }
  if (/context[ _]length[ _]exceeded/i.test(message)) return { shape: 'context-length-exceeded' }

  if (/exceeds? the available context size/i.test(message)) return { shape: 'context-size' }
  if (/prompt is longer than the context length/i.test(message)) return { shape: 'context-size' }
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
  return matchFurtherOverflowSentence(message)
}

const PROMPT_LENGTH_LIMIT = /maximum prompt length is (\d[\d,]*)/i
const PROMPT_TOO_LARGE_FOR_MODEL = /prompt contains (\d[\d,]*) tokens[\s\S]{0,60}?too large for model with (\d[\d,]*) maximum context length/i
const INPUTS_MUST_HAVE_LESS = /`?inputs`? must have less than (\d[\d,]*) tokens(?:[\s\S]*?given: (\d[\d,]*))?/i
const TOKENS_CANNOT_EXCEED = /too many tokens:?[\s\S]{0,80}?cannot exceed (\d[\d,]*)(?:[\s\S]{0,40}?received (\d[\d,]*))?/i
const INPUT_TOO_LONG = /\b(?:input|prompt|messages?|conversation|content|request) (?:is |are )?too long\b/i
const INPUT_EXCEEDS_LIMIT = /\b(?:number of )?(?:input|prompt) (?:tokens? |length |size )?exceeds? (?:the )?(?:model'?s )?(?:max(?:imum)?|limit|allowed)\b/i
const OVER_THE_MAXIMUM_TOKENS = /\b(?:exceeds?|over) the (?:maximum|max) (?:number of )?(?:input |prompt )?tokens?\b/i
const TOO_MANY_INPUT_TOKENS = /\btoo many (?:input |prompt )tokens\b/i
const PROMPT_TOO_LONG_CJK = /prompt\s*超长|(?:prompt|token|上下文|输入)[^。.]{0,20}(?:超长|过长)/i
const BODY_TOO_LARGE = /request entity too large|payload too large|request body (?:is )?too large|body exceeds/i

function matchFurtherOverflowSentence(message: string): ShapeMatch | null {
  const promptLimit = PROMPT_LENGTH_LIMIT.exec(message)
  if (promptLimit) {
    const actual = /(?:prompt|request|input) (?:is|contains|has|had) (\d[\d,]*) tokens/i.exec(message)
    return { shape: 'context-length-exceeded', limitTokens: num(promptLimit[1]), actualTokens: num(actual?.[1]) }
  }
  const tooLargeForModel = PROMPT_TOO_LARGE_FOR_MODEL.exec(message)
  if (tooLargeForModel) return { shape: 'context-length-exceeded', actualTokens: num(tooLargeForModel[1]), limitTokens: num(tooLargeForModel[2]) }
  const inputsLess = INPUTS_MUST_HAVE_LESS.exec(message)
  if (inputsLess) return { shape: 'input-validation', limitTokens: num(inputsLess[1]), actualTokens: num(inputsLess[2]) }
  const cannotExceed = TOKENS_CANNOT_EXCEED.exec(message)
  if (cannotExceed) return { shape: 'token-limit', limitTokens: num(cannotExceed[1]), actualTokens: num(cannotExceed[2]) }
  if (BODY_TOO_LARGE.test(message)) return { shape: 'request-too-large' }
  if (INPUT_TOO_LONG.test(message) || INPUT_EXCEEDS_LIMIT.test(message) || OVER_THE_MAXIMUM_TOKENS.test(message)) return { shape: 'context-size' }
  if (TOO_MANY_INPUT_TOKENS.test(message) || PROMPT_TOO_LONG_CJK.test(message)) return { shape: 'context-size' }
  return null
}

export function classifyOverflowFault(fault: {
  family: OverflowFamily
  status?: number
  code?: string
  message?: string
  measured?: () => { tokens: number; window: number }
}): OverflowSignal | null {
  const { family, status } = fault
  const code = fault.code ?? ''
  const message = fault.message ?? ''
  const detail = bounded(message)

  if (status !== undefined && status !== 400 && status !== 413 && status !== 422) return null
  if (isBedrockThrottle(fault) || isRateLimitComplaint(message.toLowerCase())) return null
  if (status === 400 && fault.measured !== undefined && isBodilessRefusal(message)) {
    const { tokens, window } = fault.measured()
    if (window > 0 && tokens >= Math.floor(window * NEAR_WINDOW_SHARE)) {
      return { source: 'provider', family, shape: 'context-size', measuredTokens: tokens, measuredWindow: window }
    }
    return null
  }

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

  if (status === 413 || /^http-413$/.test(code)) {
    return { source: 'provider', family, shape: 'request-too-large', ...(detail !== undefined ? { detail } : {}) }
  }
  return null
}

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

export function overflowSignalOf(message: Message | undefined): OverflowSignal | null {
  if (message === undefined || message.type !== 'assistant') return null
  const assistant = message as AssistantMessage
  if (assistant.isApiErrorMessage !== true) return null
  const signal = assistant.overflowSignal
  return signal !== undefined && signal !== null ? signal : null
}

export function overflowGapTokens(signal: OverflowSignal): number | undefined {
  if (signal.actualTokens === undefined || signal.limitTokens === undefined) return undefined
  const gap = signal.actualTokens - signal.limitTokens
  return gap > 0 ? gap : undefined
}

export function overflowNumbersClause(signal: OverflowSignal): string | undefined {
  const fmt = (n: number): string => n.toLocaleString('en-US')
  if (signal.actualTokens !== undefined && signal.limitTokens !== undefined) {
    return `${fmt(signal.actualTokens)} tokens > ${fmt(signal.limitTokens)}`
  }
  if (signal.limitTokens !== undefined) return `over the ${fmt(signal.limitTokens)}-token window`
  if (signal.actualTokens !== undefined) return `${fmt(signal.actualTokens)} tokens`
  return undefined
}

export function overflowMeasuredClause(signal: OverflowSignal): string | undefined {
  if (signal.measuredTokens === undefined || signal.measuredWindow === undefined) return undefined
  const fmt = (n: number): string => n.toLocaleString('en-US')
  return `about ${fmt(signal.measuredTokens)} tokens by Mercury's count against the ${fmt(signal.measuredWindow)}-token window`
}

export function overflowWhoClause(signal: OverflowSignal): string {
  const numbers = overflowNumbersClause(signal)
  if (signal.source === 'estimate') return numbers !== undefined ? `estimated ${numbers}` : 'by estimate'
  const who = signal.family === 'unknown' ? 'the provider' : providerDisplayName(signal.family)
  if (numbers !== undefined) return `${who}: ${numbers}`
  const measured = overflowMeasuredClause(signal)
  return measured !== undefined ? `${who}; ${measured}` : who
}
