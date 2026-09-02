// ============================================================================
//  services/concourse/coordinatorCompact — the coordinator conversation's
//  REAL compaction (chat-relief item 1): /compact SUMMARIZES-IN-PLACE, the
//  landed compaction contract, instead of the v1 drop-with-marker (which
//  discarded the folded turns' content outright — relief by amnesia).
//
//  WHY THIS LIVES HERE and not on the main compact service: the coordinator's
//  turn road is not the main query loop — its context is the durable
//  conversation store replayed per turn (coordinatorReplay), not a Message[]
//  transcript, so compactConversation's machinery (ToolUseContext, hooks,
//  attachments) cannot ride it. The honest shared layer is the CONTRACT:
//  fold the older turns into ONE summary through a model call, keep the
//  newest tail verbatim, and speak the fold in the main chat's compact
//  boundary grammar with the harness voice.
//
//  THE SUMMARIZER MODEL is the composed coordinator model (the same
//  validateCoordinatorModelChoice road every coordinator turn and the
//  manager mode resolve through); none composed ⇒ a TYPED refusal and the
//  store untouched — never a silent drop, never a fold without a summary.
//
//  Callers: the ConcourseScreen composer's /compact, and the message door's
//  auto-compaction (runOperatorMessageTurn — the gauge-threshold and
//  store-cap arms). The `summarize` seam is injectable so provers pin the
//  contract cpu-pure; production rides routedCallModel one-shot.
// ============================================================================

import type { CoordinatorConversationEntryV1 } from './coordinatorConversation.js'
import type { OverflowSignal } from '../api/overflowSignal.js'
import { overflowWhoClause } from '../compact/overflowRecovery.js'

/** Newest turns kept verbatim through a fold (the v1 keep, unchanged). */
export const COORDINATOR_COMPACT_KEEP = 8
/** The summary's own cap — rides the replay WHOLE (coordinatorReplay's
 *  summary-row law), well inside the store's 8000-char entry clip. */
export const COORDINATOR_SUMMARY_MAX_CHARS = 4000
/** The fold transcript's cap — the summarizer's bounded input. */
const FOLD_TRANSCRIPT_MAX_CHARS = 60_000
const FOLD_ENTRY_CLIP = 600

/** Approach margin for the store-cap arm (auto-compaction): fold BEFORE
 *  CONVERSATION_CAP evicts silently — a turn writes a handful of entries,
 *  so this margin makes the cap unreachable in ordinary use. */
export const CONVERSATION_CAP_FOLD_MARGIN = 24

export type CoordinatorCompactTrigger = 'manual' | 'context-threshold' | 'store-cap' | 'overflow'

export interface CoordinatorCompactResult {
  compacted: number
  /** Present iff the fold was REFUSED (no model composed, the summarizer
   *  failed) — the store is then untouched. */
  refused?: string
}

/** The injectable summarizer seam: prompt + transcript in, the summary's
 *  plain text out. Throws ⇒ the fold refuses with the thrown reason. */
export type CoordinatorSummarizer = (args: {
  systemPrompt: string
  transcript: string
  modelId: string
}) => Promise<string>

/** The fold's summary instruction — coordinator-scale sections (this
 *  surface coordinates sessions; it does not edit code), the main compact
 *  prompt's posture at this genre. */
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

/** The summarizer's bounded input: role-tagged lines, each entry clipped,
 *  receipt labels riding beneath their entry (what actually executed is
 *  exactly what the summary must not lose). Oldest first; over the whole
 *  cap the OLDEST lines drop first with an honest elision head. */
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

/** The marker's FIRST line — the main chat's compact boundary grammar,
 *  byte-stable (the pane plate, the replay row and the prover pin all read
 *  this sentence). */
export function coordinatorCompactMarkerLine(compacted: number): string {
  return `conversation compacted — ${compacted} earlier turn${compacted === 1 ? '' : 's'} folded away`
}

/** The auto arms name WHY the fold fired — the operator must never be
 *  surprised by a compaction (chat-relief item 3). */
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

/** The LIVE summarizer: one bounded no-tool call through the ONE
 *  provider-aware seam (routedCallModel — the same road every coordinator
 *  turn rides, so anthropic ids ride the streaming core and engine ids
 *  ride their native runtimes). */
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

/** Resolve the summarizer's model: the composed coordinator model — the
 *  SAME validate road every coordinator turn and manager mode use. */
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

/**
 * Summarize-in-place: fold every entry older than the newest `keep` into
 * ONE harness-voiced summary marker (the main chat's compact grammar),
 * keep the tail verbatim, clear the context gauge (accurate counts are
 * unavailable until the next turn answers). The summarizer call runs
 * OUTSIDE the store lock; the swap drops exactly the entries that were
 * summarized, so turns that landed mid-summarize survive untouched.
 */
export async function summarizeCoordinatorConversation(opts: {
  keep?: number
  dir?: string
  trigger?: CoordinatorCompactTrigger
  /** Proof seam; production rides liveCoordinatorSummarizer. */
  summarize?: CoordinatorSummarizer
  /** Proof seam for the model resolve (skips the composed registry). */
  modelId?: string
  /** The overflow this fold answers (trigger 'overflow'): the marker's
   *  clause names the family and the numbers. */
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

/**
 * AUTO-COMPACTION's decision + act (chat-relief item 2): called by the
 * message door BEFORE each model turn. Two arms, both riding LANDED
 * numbers — never a second threshold system:
 *   · context-threshold — the stamped gauge (the last turn's real provider
 *     usage) crossed the main chat's own auto-compact ceiling for the model
 *     THIS turn runs on (getAutoCompactThreshold: the buffer-derived
 *     default, the settings window, MERCURY_AUTOCOMPACT_PCT_OVERRIDE all
 *     apply exactly as in the main chat);
 *   · store-cap — the durable conversation neared CONVERSATION_CAP, whose
 *     eviction is otherwise SILENT (the silent-drop class): the fold
 *     preserves the older turns as a summary before the cap can eat them.
 * isAutoCompactEnabled() gates both arms (DISABLE_COMPACT /
 * DISABLE_AUTO_COMPACT / the config toggle — the one law). A refused fold
 * returns typed and the caller proceeds with the turn: relief must never
 * block the operator's ask.
 */
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
