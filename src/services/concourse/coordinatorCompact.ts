
import type { CoordinatorConversationEntryV1 } from './coordinatorConversation.js'
import type { OverflowSignal } from '../api/overflowSignal.js'
import { overflowWhoClause } from '../compact/overflowRecovery.js'

export const COORDINATOR_COMPACT_KEEP = 8
export const COORDINATOR_SUMMARY_MAX_CHARS = 4000
const FOLD_TRANSCRIPT_MAX_CHARS = 60_000
const FOLD_ENTRY_CLIP = 600

export const CONVERSATION_CAP_FOLD_MARGIN = 24

export type CoordinatorCompactTrigger = 'manual' | 'context-threshold' | 'store-cap' | 'overflow'

export interface CoordinatorCompactResult {
  compacted: number
  refused?: string
}

export type CoordinatorSummarizer = (args: {
  systemPrompt: string
  transcript: string
  modelId: string
}) => Promise<string>

export function coordinatorCompactSummaryPrompt(): string {
  return [
    'You are summarizing the older portion of a coordination conversation between an operator and Mercury’s session coordinator. The newest turns are kept verbatim; your summary REPLACES the older turns and is the only memory of them, so it must carry everything a reader needs to continue the thread.',
    '',
    'Write these four numbered sections, each as terse plain prose (no markdown headings):',
    '1. Standing asks: what the operator wanted, including preferences and constraints they stated (models, effort tiers, projects, working style).',
    '2. What ran: sessions launched, messaged, paused, resumed or stopped — with their titles/models/branches where named — and what the receipts said happened, including refusals.',
    '3. Open threads: questions still unanswered, work still expected, anything the operator was promised.',
    '4. Ground truth to carry: facts about the board, folders, branches or agreements that later turns will need.',
    '',
    'Report only what the transcript states — never invent sessions, receipts or preferences. Output the summary text alone: no preamble, no code fences.',
  ].join('\n')
}

const roleWord = (e: CoordinatorConversationEntryV1): string =>
  e.harness === true ? 'harness' : e.role === 'operator' ? 'operator' : 'coordinator'

export function renderCoordinatorFoldTranscript(entries: readonly CoordinatorConversationEntryV1[]): string {
  const lines: string[] = []
  for (const e of entries) {
    const clipped = e.text.length > FOLD_ENTRY_CLIP ? `${e.text.slice(0, FOLD_ENTRY_CLIP)}…` : e.text
    if (clipped.length > 0) lines.push(`[${roleWord(e)}] ${clipped.replace(/\s+/g, ' ')}`)
    for (const r of (e.receipts ?? []).slice(0, 12)) {
      lines.push(`  · ${r.label.slice(0, 240)}`)
    }
  }
  let out = lines.join('\n')
  if (out.length > FOLD_TRANSCRIPT_MAX_CHARS) {
    out = `[…older lines elided…]\n${out.slice(out.length - FOLD_TRANSCRIPT_MAX_CHARS)}`
  }
  return out
}

export function coordinatorCompactMarkerLine(compacted: number): string {
  return `conversation compacted — ${compacted} earlier turn${compacted === 1 ? '' : 's'} folded away`
}

export function coordinatorCompactTriggerClause(
  trigger: CoordinatorCompactTrigger,
  modelId: string,
  overflow?: OverflowSignal,
): string | undefined {
  switch (trigger) {
    case 'manual':
      return undefined
    case 'context-threshold':
      return `(automatic — the context neared the ${modelId} window)`
    case 'store-cap':
      return '(automatic — the conversation neared its stored cap)'
    case 'overflow':
      return `(automatic — the context overflowed the ${modelId} window${overflow !== undefined ? `: ${overflowWhoClause(overflow)}` : ''}; folded and the turn retried)`
  }
}

export async function liveCoordinatorSummarizer(args: {
  systemPrompt: string
  transcript: string
  modelId: string
}): Promise<string> {
  const [{ routedCallModel }, { asSystemPrompt }, { createUserMessage }, { getEmptyToolPermissionContext }] =
    await Promise.all([
      import('../providers/callModelRouter.js'),
      import('../../utils/systemPromptType.js'),
      import('../../utils/messages.js'),
      import('../../Tool.js'),
    ])
  const stream = routedCallModel({
    messages: [createUserMessage({ content: `<conversation_to_fold>\n${args.transcript}\n</conversation_to_fold>` })],
    systemPrompt: asSystemPrompt([args.systemPrompt]),
    thinkingConfig: { type: 'disabled' },
    tools: [] as never,
    signal: AbortSignal.timeout(60_000),
    options: {
      model: args.modelId,
      querySource: 'concourse_coordinator_compact',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      maxOutputTokensOverride: 1500,
      enablePromptCaching: false,
      async getToolPermissionContext() {
        return getEmptyToolPermissionContext()
      },
    } as never,
  })
  const texts: string[] = []
  for await (const ev of stream) {
    const e = ev as { type?: string; message?: { content?: unknown } }
    if (e.type !== 'assistant' || e.message === undefined) continue
    const content = e.message.content
    if (typeof content === 'string') {
      texts.push(content)
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
          texts.push((b as { text: string }).text)
        }
      }
    }
  }
  const summary = texts.join('\n').trim()
  if (summary.length === 0) throw new Error('the summarizer returned no text')
  return summary
}

async function resolveCompactModel(): Promise<{ ok: true; modelId: string } | { ok: false; line: string }> {
  try {
    const { getGlobalConfig } = await import('../../utils/config.js')
    const choice = getGlobalConfig().concourseCoordinator?.assistModel
    const { validateCoordinatorModelChoice } = await import('./coordinatorModels.js')
    const validated = await validateCoordinatorModelChoice(choice)
    if (!validated.ok) {
      return {
        ok: false,
        line: 'compact needs the coordinator model to write the summary — pick one (the rail chip ⌄), or /clear starts fresh',
      }
    }
    return { ok: true, modelId: validated.entry.modelId }
  } catch (e) {
    return { ok: false, line: `compact could not resolve the coordinator model — ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function summarizeCoordinatorConversation(opts: {
  keep?: number
  dir?: string
  trigger?: CoordinatorCompactTrigger
  summarize?: CoordinatorSummarizer
  modelId?: string
  overflow?: OverflowSignal
} = {}): Promise<CoordinatorCompactResult> {
  const keep = opts.keep ?? COORDINATOR_COMPACT_KEEP
  const trigger = opts.trigger ?? 'manual'
  const conv = await import('./coordinatorConversation.js')
  const entries = await conv.readCoordinatorConversation(opts.dir)
  if (entries.length <= keep) return { compacted: 0 }
  const fold = entries.slice(0, entries.length - keep)
  let modelId = opts.modelId
  if (modelId === undefined) {
    const resolved = await resolveCompactModel()
    if (!resolved.ok) return { compacted: 0, refused: resolved.line }
    modelId = resolved.modelId
  }
  const summarize = opts.summarize ?? liveCoordinatorSummarizer
  let summary: string
  try {
    summary = (
      await summarize({
        systemPrompt: coordinatorCompactSummaryPrompt(),
        transcript: renderCoordinatorFoldTranscript(fold),
        modelId,
      })
    )
      .trim()
      .slice(0, COORDINATOR_SUMMARY_MAX_CHARS)
    if (summary.length === 0) return { compacted: 0, refused: 'the summarizer returned no text — nothing was folded' }
  } catch (e) {
    return {
      compacted: 0,
      refused: `the summary call failed — ${e instanceof Error ? e.message : String(e)}; nothing was folded`,
    }
  }
  const foldedIds = new Set(fold.map(e => e.id))
  const clause = coordinatorCompactTriggerClause(trigger, modelId, opts.overflow)
  const marker: CoordinatorConversationEntryV1 = {
    id: `co:compact:${Date.now().toString(36)}`,
    role: 'coordinator',
    text: `${coordinatorCompactMarkerLine(foldedIds.size)}${clause !== undefined ? `\n${clause}` : ''}\n\n${summary}`,
    ts: Date.now(),
    harness: true,
    summary: true,
  }
  await conv.applyCoordinatorFold(marker, foldedIds, opts.dir)
  return { compacted: foldedIds.size }
}

export async function maybeAutoCompactCoordinator(
  modelId: string,
  opts: { dir?: string; summarize?: CoordinatorSummarizer } = {},
): Promise<CoordinatorCompactResult & { trigger?: CoordinatorCompactTrigger }> {
  const { isAutoCompactEnabled, calculateTokenWarningState } = await import('../compact/autoCompact.js')
  if (!isAutoCompactEnabled()) return { compacted: 0 }
  const conv = await import('./coordinatorConversation.js')
  const entries = await conv.readCoordinatorConversation(opts.dir)
  if (entries.length <= COORDINATOR_COMPACT_KEEP) return { compacted: 0 }
  let trigger: CoordinatorCompactTrigger | undefined
  const gauge = await conv.readCoordinatorGauge(opts.dir)
  if (gauge !== undefined) {
    const { level } = calculateTokenWarningState(gauge.contextTokens, modelId)
    if (level === 'compact' || level === 'blocked') trigger = 'context-threshold'
  }
  if (trigger === undefined) {
    const { CONVERSATION_CAP } = conv
    if (entries.length >= CONVERSATION_CAP - CONVERSATION_CAP_FOLD_MARGIN) trigger = 'store-cap'
  }
  if (trigger === undefined) return { compacted: 0 }
  const res = await summarizeCoordinatorConversation({
    trigger,
    modelId,
    ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
    ...(opts.summarize !== undefined ? { summarize: opts.summarize } : {}),
  })
  return { ...res, trigger }
}
