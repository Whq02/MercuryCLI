// ============================================================================
//  permissions/classifierRouted — the auto-mode classifier's provider-routed
//  transport and the family-aware model-chain law.
//
//  sideQuery rides the Anthropic transport only, so classification for a
//  session with no usable Anthropic lane rides the provider-routed transport
//  instead (queryWithModel → the routed callModel seam). The chain law keeps
//  the Anthropic tier first whenever that lane can take work (the verified
//  classifier family), and otherwise classifies on the session's own family.
//
//  The routed transport speaks the XML verdict grammar (<block>/<reason>/
//  <thinking>) — the same grammar the two-stage Anthropic path uses — because
//  a forced tool_choice is not part of the routed callModel contract and the
//  XML grammar is parseable fail-closed from any chat-capable lane.
//
//  This module is bun-loadable and cycle-free (it must never import
//  yoloClassifier); the transport is late-imported so the pure chain law
//  stays light.
// ============================================================================
import { extractTextContent } from '../messages.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { declaredRouteOf } from '../../services/providers/routeLaw.js'
import type { YoloClassifierResult } from '../../types/permissions.js'

/** The sentinel line the tool-reporting prompt carries; the XML variant
 *  replaces it with the XML output-format section. */
export const CLASSIFY_SENTINEL = 'Use the classify_result tool to report your classification.'

/** Strip a trailing bracketed context-window tag for model comparison. */
export function classifierBaseModel(m: string): string {
  return m.replace(/\[[^\]]*\]\s*$/, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// The family-aware model chain (pure law)
// ─────────────────────────────────────────────────────────────────────────────

export type ClassifierChainInput = {
  /** The auto-mode config's classifier model, when configured. */
  configuredModel?: string
  /** The session's main-loop model. */
  sessionModel: string
  /** Whether the Anthropic lane can take work right now — the owning
   *  resolver's (providerUsability) composed answer, never a hardcoded
   *  family assumption. */
  anthropicUsable: boolean
  /** The Anthropic classifier tier (CLASSIFIER_FALLBACK_MODELS). */
  anthropicTier: readonly string[]
}

/**
 * The classifier model chain, first entry primary. Anthropic-grade
 * classification is preferred whenever that lane is usable (the
 * prompt-injection-verified tier); the session's own family is the honest
 * fallback — and the only chain — when it is not. Deduped by base model.
 */
export function classifierModelChain(input: ClassifierChainInput): string[] {
  const preferred = input.configuredModel || input.sessionModel
  let chain: string[]
  if (declaredRouteOf(preferred) === 'anthropic') {
    // The home lane: the preferred model, then the tier (no usability
    // preflight — the session already runs here).
    chain = [preferred, ...input.anthropicTier]
  } else if (input.anthropicUsable) {
    // Engine sessions with a usable Anthropic lane classify Anthropic-first,
    // with the session's own family as the last-resort tail so an Anthropic
    // outage cannot kill auto mode.
    chain = [...input.anthropicTier, preferred]
  } else {
    // No usable Anthropic lane: the session's own family IS the classifier.
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

// ─────────────────────────────────────────────────────────────────────────────
// The XML verdict grammar (shared by the two-stage Anthropic path and the
// routed transport)
// ─────────────────────────────────────────────────────────────────────────────

/** Strip thinking content (closed and unterminated trailing) before parsing. */
export function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').replace(/<thinking>[\s\S]*$/i, '')
}

/** The first `<block>` immediately followed by yes/no → true (block) / false / null. */
export function parseBlockVerdict(text: string): boolean | null {
  const match = /<block>\s*(yes|no)\b/i.exec(stripThinking(text))
  if (!match) return null
  return match[1].toLowerCase() === 'yes'
}

/** The contents of the first `<reason>…</reason>`, trimmed, or null. */
export function parseReasonTag(text: string): string | null {
  const match = /<reason>([\s\S]*?)<\/reason>/i.exec(stripThinking(text))
  return match ? match[1].trim() : null
}

/** The contents of the first `<thinking>…</thinking>`, trimmed. */
export function parseThinkingTag(text: string): string {
  const match = /<thinking>([\s\S]*?)<\/thinking>/i.exec(text)
  return match ? match[1].trim() : ''
}

/** Replace the sentinel tool line with an XML output-format section. */
export function buildXmlSystemPrompt(systemPrompt: string): string {
  const xmlSection = [
    'To block the action, answer with a <block> element holding yes, followed by a <reason>',
    'element holding a single short sentence. To allow it, answer with a <block> element holding',
    'no and emit no reason element at all. Your response must open with the <block> element',
    'itself — no analysis, no lead-in, nothing in front of it.',
  ].join('\n')
  return systemPrompt.split(CLASSIFY_SENTINEL).join(xmlSection)
}

// ─────────────────────────────────────────────────────────────────────────────
// The routed transport
// ─────────────────────────────────────────────────────────────────────────────

const ROUTED_BIAS = [
  'Work the classification procedure through rather than answering from impression.',
  'Err against letting a blockable action past. Accept a user go-ahead as an override only',
  'when it was actually stated, never inferred. Put your reasoning inside a <thinking> element',
  'before the <block> answer.',
].join(' ')

export type RoutedClassifyArgs = {
  model: string
  /** The assembled classifier system prompt (tool-sentinel form; the XML
   *  section is spliced here). */
  systemPrompt: string
  /** The project-instructions prefix, when present. */
  instructionPrefix?: string
  /** The projected transcript body and the projected action, in the
   *  transcript grammar. */
  transcript: string
  actionText: string
  signal: AbortSignal
  /** Error-dump hook (yoloClassifier's writeErrorDump); returns the path. */
  onError?: (errorText: string) => string | undefined
}

/**
 * Classify one action over the provider-routed transport. Fail-closed on
 * every unparseable, missing, or errored outcome, with the same retry
 * classes the Anthropic path reports: an unparseable verdict is `retryable`
 * (same-model re-ask), a transport/API failure is `unavailable` (chain
 * walk), an abort or context overflow ends the chain.
 */
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
      // The routed runtimes surface API failures as error-marked assistant
      // messages rather than throws — the unavailable (chain-walk) class.
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
