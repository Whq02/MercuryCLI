import { extractTextContent } from '../messages.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { declaredRouteOf } from '../../services/providers/routeLaw.js'
import type { YoloClassifierResult } from '../../types/permissions.js'

export const CLASSIFY_SENTINEL = 'Use the classify_result tool to report your classification.'

export function classifierBaseModel(m: string): string {
  return m.replace(/\[[^\]]*\]\s*$/, '')
}


export type ClassifierChainInput = {
  configuredModel?: string
  sessionModel: string
  anthropicUsable: boolean
  anthropicTier: readonly string[]
}

export function classifierModelChain(input: ClassifierChainInput): string[] {
  const preferred = input.configuredModel || input.sessionModel
  let chain: string[]
  if (declaredRouteOf(preferred) === 'anthropic') {
    chain = [preferred, ...input.anthropicTier]
  } else if (input.anthropicUsable) {
    chain = [...input.anthropicTier, preferred]
  } else {
    chain = [preferred]
  }
  const seen = new Set<string>()
  return chain.filter(model => {
    const base = classifierBaseModel(model)
    if (seen.has(base)) return false
    seen.add(base)
    return true
  })
}


export function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').replace(/<thinking>[\s\S]*$/i, '')
}

export function parseBlockVerdict(text: string): boolean | null {
  const match = /<block>\s*(yes|no)\b/i.exec(stripThinking(text))
  if (!match) return null
  return match[1].toLowerCase() === 'yes'
}

export function parseReasonTag(text: string): string | null {
  const match = /<reason>([\s\S]*?)<\/reason>/i.exec(stripThinking(text))
  return match ? match[1].trim() : null
}

export function parseThinkingTag(text: string): string {
  const match = /<thinking>([\s\S]*?)<\/thinking>/i.exec(text)
  return match ? match[1].trim() : ''
}

export function buildXmlSystemPrompt(systemPrompt: string): string {
  const xmlSection = [
    'To block the action, answer with a <block> element holding yes, followed by a <reason>',
    'element holding a single short sentence. To allow it, answer with a <block> element holding',
    'no and emit no reason element at all. Your response must open with the <block> element',
    'itself — no analysis, no lead-in, nothing in front of it.',
  ].join('\n')
  return systemPrompt.split(CLASSIFY_SENTINEL).join(xmlSection)
}


const ROUTED_BIAS = [
  'Work the classification procedure through rather than answering from impression.',
  'Err against letting a blockable action past. Accept a user go-ahead as an override only',
  'when it was actually stated, never inferred. Put your reasoning inside a <thinking> element',
  'before the <block> answer.',
].join(' ')

export type RoutedClassifyArgs = {
  model: string
  systemPrompt: string
  instructionPrefix?: string
  transcript: string
  actionText: string
  signal: AbortSignal
  onError?: (errorText: string) => string | undefined
}

export async function classifyOverRoutedTransport(args: RoutedClassifyArgs): Promise<YoloClassifierResult> {
  const { model, signal } = args
  const userPrompt =
    (args.instructionPrefix ? `${args.instructionPrefix}\n\n` : '') +
    `<transcript>\n${args.transcript}${args.actionText}</transcript>\n${ROUTED_BIAS}`
  try {
    const { queryWithModel } = await import('../../services/providers/anthropic/streamCore.js')
    const result = await queryWithModel({
      systemPrompt: asSystemPrompt([buildXmlSystemPrompt(args.systemPrompt)]),
      userPrompt,
      signal,
      options: {
        model,
        querySource: 'auto_mode',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        maxOutputTokensOverride: 4096,
      },
    })
    if (signal.aborted) {
      return { shouldBlock: true, unavailable: true, reason: 'Classifier request aborted.', model }
    }
    const text = extractTextContent(result.message.content)
    if (result.isApiErrorMessage) {
      const dumpPath = args.onError?.(text)
      return {
        shouldBlock: true,
        unavailable: true,
        reason: 'Classifier unavailable — blocking for safety.',
        model,
        ...(dumpPath ? { errorDumpPath: dumpPath } : {}),
      }
    }
    const verdict = parseBlockVerdict(text)
    if (verdict === null) {
      return {
        shouldBlock: true,
        retryable: true,
        reason: 'Invalid classifier response - blocking for safety',
        model,
      }
    }
    return {
      shouldBlock: verdict,
      reason: parseReasonTag(text) ?? (verdict ? 'no reason provided' : 'Allowed by the classifier.'),
      thinking: parseThinkingTag(text),
      model,
    }
  } catch (error) {
    if (signal.aborted) {
      return { shouldBlock: true, unavailable: true, reason: 'Classifier request aborted.', model }
    }
    if (error instanceof Error && error.message.toLowerCase().includes('prompt is too long')) {
      return {
        shouldBlock: true,
        transcriptTooLong: true,
        reason: 'Classifier transcript exceeded the context window.',
        model,
      }
    }
    const dumpPath = args.onError?.(String(error))
    return {
      shouldBlock: true,
      unavailable: true,
      reason: 'Classifier unavailable — blocking for safety.',
      model,
      ...(dumpPath ? { errorDumpPath: dumpPath } : {}),
    }
  }
}
