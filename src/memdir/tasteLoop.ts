/**
 * Taste Loop — a default-ON (opt out =0) closed usefulness loop.
 *
 * Mercury traces tools and classifies working/blocked/done/failed, but it never
 * captured when a *turn* felt "meh" or "good", diagnosed why, and adapted future
 * behaviour. This module is that loop:
 *
 *   /meh <complaint>  → capture a redacted, bounded recent-session snapshot,
 *   /good <praise>      classify the friction/success, persist an episode, and
 *                       (when a pattern repeats) promote a candidate lesson that
 *                       is recalled — precisely, throttled — into future turns.
 *
 * Storage (Mercury-owned, project-scoped, under the auto-memory dir):
 *   <memoryDir>/taste/episodes.jsonl   bounded redacted episode ring (raw data,
 *                                       NOT directly recalled — privacy/precision)
 *   <memoryDir>/taste/TASTE.md         promoted candidate lessons (human-readable
 *                                       mirror; the recall source is re-derived
 *                                       live from episodes so there is one source
 *                                       of truth)
 *
 * Gating invariant: tasteLoopEnabled() = MERCURY_TASTE_LOOP !== '0' &&
 * ON by default (unconditional), opt out with the explicit =0. When
 * OFF (flag '0') every live call-site degrades to a no-op /
 * identity, so prompt + recall output are byte-identical to a build without this
 * module (mirrors experienceCardsEnabled's discipline).
 *
 * Design notes:
 *   - Pure functions (classify / buildEpisode / caps / derivePromoted / recall
 *     formatting) are separated from IO (write/read/promote) which take an
 *     INJECTABLE memoryDir, so the proof never touches real memory.
 *   - Redaction is REDACT-in-place (keep the episode, scrub secrets) via
 *     utils/secrets/secretScanner.redactSecrets — distinct from the card store's
 *     refuse-whole doctrine, because a friction episode is worth keeping scrubbed.
 *   - Classification is DETERMINISTIC (operator keywords + recent-window tool/
 *     turn signals). No model call, no scoring engine — testable and cheap.
 *   - One complaint is not universal truth: a class is promoted to a candidate
 *     lesson only after PROMOTE_THRESHOLD repeats, and every promoted lesson is
 *     marked operator-friction-derived / candidate.
 */

import { flagEnv } from '../substrate/flagRegistry.js'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import * as lockfile from '../utils/lockfile.js'
import { redactSecrets } from '../utils/secrets/secretScanner.js'
import type { Message } from '../types/message.js'
import { durableAtomicPublish } from '../substrate/durablePublish.js'

//
// Gate
//

export const TASTE_LOOP_ENV_FLAG = 'MERCURY_TASTE_LOOP'

/**
 * Live-behavior gate. OPT-IN since: arm with
 * MERCURY_TASTE_LOOP=1. It was default-on; the flip follows the researched
 * progressive-disclosure rule
 * — an always-armed classify-every-stop + recall-attachment surface is
 * exactly the kind of standing behavioral scaffolding the current model
 * generation does not need by default. /meh · /good remain the explicit
 * entry points and say how to arm the loop when it is off. Read fresh each
 * call so the env toggle takes effect without a restart.
 */
export function tasteLoopEnabled(): boolean {
  return flagEnv(TASTE_LOOP_ENV_FLAG) === '1'
}

//
// Bounds (every input the loop persists or injects is capped)
//

/** Max episodes kept in the JSONL ring (oldest evicted on write). */
export const MAX_EPISODES = 50
/** Max recent user/assistant turns captured per snapshot. */
export const MAX_TURNS = 6
/** Per-turn text clip (chars). */
export const MAX_TURN_CHARS = 400
/** Max recent tool calls captured per snapshot. */
export const MAX_TOOLS = 12
/** Complaint/praise text clip (chars). */
export const MAX_TEXT_CHARS = 600
/** Hard per-episode byte cap — turn texts are shortened until the JSON fits. */
export const MAX_EPISODE_BYTES = 4096
/** A class must repeat this many times before it promotes to a candidate lesson. */
export const PROMOTE_THRESHOLD = 3
/** Max promoted lessons injected into a recall reminder. */
export const RECALL_MAX_LESSONS = 3
/** Throttle: re-emit the recall reminder at most once per this many human turns. */
export const RECALL_THROTTLE_TURNS = 8
/** How many recent human turns recall relevance-matches against. */
export const RECALL_RELEVANCE_WINDOW = 2

const TASTE_DIRNAME = 'taste'
const EPISODES_FILENAME = 'episodes.jsonl'
const TASTE_MD_FILENAME = 'TASTE.md'

//
// Schema
//

export type TasteKind = 'meh' | 'good'

export const MEH_CLASSES = [
  'too_passive',
  'too_verbose',
  'did_not_inspect_code',
  'wrong_tool_choice',
  'over_orchestrated',
  'under_orchestrated',
  'missing_memory',
  'no_concrete_artifact',
  'no_test_or_verification',
  'got_stuck_without_escalating',
  'ui_noise',
  'other',
] as const
export type MehClass = (typeof MEH_CLASSES)[number]

export const GOOD_CLASSES = [
  'inspected_code_first',
  'concise_answer',
  'produced_diff',
  'verified_with_test',
  'asked_good_question',
  'avoided_overbuild',
  'remembered_context',
  'other',
] as const
export type GoodClass = (typeof GOOD_CLASSES)[number]

export type TasteSnapshot = {
  sessionId: string
  cwd: string
  project: string
  /** Active mode flags (cheap reads), e.g. ['fork', 'supercode', 'strategy']. */
  modes: string[]
  turns: { role: 'user' | 'assistant'; text: string }[]
  tools: { name: string; outcome: 'ok' | 'error' | 'pending' }[]
}

export type TasteEpisode = {
  v: 1
  id: string
  ts: string
  kind: TasteKind
  /** Classifier verdict (a MehClass or GoodClass string). */
  cls: string
  /** Why the classifier landed there (matched keywords + triggered signals). */
  signals: string[]
  /** Redacted + clipped complaint/praise text. */
  text: string
  snapshot: TasteSnapshot
}

export type ClassifyResult = {
  cls: string
  score: number
  signals: string[]
}

export type PromotedLesson = {
  kind: TasteKind
  cls: string
  count: number
  lesson: string
}

//
// Redaction + clipping
//

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** Scrub secrets in place, then collapse whitespace and clip to `n` chars. */
export function redactAndClip(text: string, n: number): string {
  return clip(redactSecrets(text ?? ''), n)
}

//
// Snapshot capture (structural read of Message[]; no heavy message.ts imports)
//

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const ORCHESTRATION_TOOLS = new Set(['Agent', 'Task', 'TaskCreate', 'Workflow'])

type ContentBlock = { type?: string; text?: string; name?: string; id?: string }

function textBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ContentBlock[])
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
}

function hasToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    (content as ContentBlock[]).some(b => b && b.type === 'tool_result')
  )
}

/**
 * Extract the recent user/assistant turns and tool name+outcome pairs from a
 * live Message[]. Pure structural read — a tool_use block lives in an assistant
 * message's content[], a tool_result (with is_error) lives in a user message's
 * content[]. Returns redacted, clipped, count-capped data.
 */
export function captureSnapshot(
  messages: readonly Message[],
  identity: { sessionId: string; cwd: string; project: string; modes: string[] },
): TasteSnapshot {
  const turns: { role: 'user' | 'assistant'; text: string }[] = []
  const toolUseOrder: { id: string; name: string }[] = []
  const resultErrorById = new Map<string, boolean>()

  for (const m of messages ?? []) {
    if (!m || typeof m !== 'object') continue
    if (m.type === 'assistant') {
      const content = (m as { message?: { content?: unknown } }).message?.content
      const t = textBlocks(content)
      if (t.trim()) turns.push({ role: 'assistant', text: t })
      if (Array.isArray(content)) {
        for (const b of content as ContentBlock[]) {
          if (b && b.type === 'tool_use' && b.name) {
            toolUseOrder.push({ id: String(b.id ?? ''), name: String(b.name) })
          }
        }
      }
    } else if (m.type === 'user') {
      const um = m as {
        isMeta?: boolean
        toolUseResult?: unknown
        message?: { content?: unknown }
      }
      const content = um.message?.content
      // Record any tool_result outcomes. Skip empty/absent ids — an id-less result
      // can't be attributed to a specific tool_use, and keying it to '' would make
      // every id-less tool_use collide on one outcome (spurious failed-tool counts).
      if (Array.isArray(content)) {
        for (const b of content as Array<ContentBlock & { tool_use_id?: string; is_error?: boolean }>) {
          if (b && b.type === 'tool_result' && b.tool_use_id) {
            resultErrorById.set(String(b.tool_use_id), b.is_error === true)
          }
        }
      }
      // A real human turn: not meta, not a structured tool-result envelope. A mixed
      // message carrying BOTH text and a tool_result still contributes its text
      // (don't drop the human signal just because a result rode along).
      if (um.isMeta || um.toolUseResult !== undefined) continue
      const t = textBlocks(content)
      if (t.trim()) turns.push({ role: 'user', text: t })
    }
  }

  const tools = toolUseOrder
    .slice(-MAX_TOOLS)
    .map(t => ({
      // Tool names are closed-vocab identifiers; still length-clip them (bounds the
      // episode) and run redactSecrets, which scrubs a boundary-delimited token. A
      // token embedded mid-identifier survives (the scanner is \b-anchored), but that
      // risk is near-zero for closed-vocab names — accepted, not silently claimed away.
      name: redactAndClip(t.name, 60),
      // An id-less tool_use (t.id === '') can never match a result → always pending.
      outcome:
        t.id !== '' && resultErrorById.has(t.id)
          ? resultErrorById.get(t.id)
            ? ('error' as const)
            : ('ok' as const)
          : ('pending' as const),
    }))

  const recentTurns = turns
    .slice(-MAX_TURNS)
    .map(t => ({ role: t.role, text: redactAndClip(t.text, MAX_TURN_CHARS) }))

  return {
    sessionId: identity.sessionId,
    cwd: identity.cwd,
    project: identity.project,
    modes: identity.modes.slice(0, 12),
    turns: recentTurns,
    tools,
  }
}

//
// Signals derived from a snapshot (for the classifier)
//

type SnapshotStats = {
  hadEdit: boolean
  hadRead: boolean
  editBeforeRead: boolean
  hadBash: boolean
  orchestrationCount: number
  failedTools: number
  avgAssistantChars: number
}

function snapshotStats(snap: TasteSnapshot): SnapshotStats {
  const names = snap.tools.map(t => t.name)
  let firstEdit = -1
  let firstRead = -1
  let orchestrationCount = 0
  let failedTools = 0
  let hadBash = false
  names.forEach((n, i) => {
    if (EDIT_TOOLS.has(n) && firstEdit === -1) firstEdit = i
    if (READ_TOOLS.has(n) && firstRead === -1) firstRead = i
    if (ORCHESTRATION_TOOLS.has(n)) orchestrationCount++
    if (n === 'Bash') hadBash = true
  })
  snap.tools.forEach(t => {
    if (t.outcome === 'error') failedTools++
  })
  const assistantTurns = snap.turns.filter(t => t.role === 'assistant')
  const avgAssistantChars = assistantTurns.length
    ? Math.round(
        assistantTurns.reduce((a, t) => a + t.text.length, 0) /
          assistantTurns.length,
      )
    : 0
  return {
    hadEdit: firstEdit !== -1,
    hadRead: firstRead !== -1,
    editBeforeRead: firstEdit !== -1 && (firstRead === -1 || firstEdit < firstRead),
    hadBash,
    orchestrationCount,
    failedTools,
    avgAssistantChars,
  }
}

/**
 * The single most-specific class implied by the recent-window tool/turn shape, or
 * null. A CASCADE (not independent bumps) so two signals never tie — most-specific
 * / most-actionable first. Supporting evidence that stacks with keyword matches.
 */
function dominantMehSignal(
  stats: SnapshotStats,
  snap: TasteSnapshot,
): { cls: MehClass; why: string } | null {
  if (stats.failedTools >= 3) return { cls: 'got_stuck_without_escalating', why: `${stats.failedTools} failed tool calls` }
  if (stats.orchestrationCount >= 4) return { cls: 'over_orchestrated', why: `${stats.orchestrationCount} agent/workflow spawns` }
  if (stats.hadEdit && !stats.hadRead) return { cls: 'did_not_inspect_code', why: 'edited with no Read/Grep this window' }
  if (stats.editBeforeRead) return { cls: 'did_not_inspect_code', why: 'edited before reading' }
  if (snap.tools.length > 0 && !stats.hadEdit) return { cls: 'no_concrete_artifact', why: 'tools ran but no edit/write' }
  // avgAssistantChars is measured over CAPTURE-clipped turns (≤ MAX_TURN_CHARS),
  // so "consistently near the clip ceiling" is the in-domain proxy for verbose.
  if (stats.avgAssistantChars > MAX_TURN_CHARS * 0.9) return { cls: 'too_verbose', why: 'assistant turns consistently near the length cap' }
  if (stats.hadEdit && !stats.hadBash) return { cls: 'no_test_or_verification', why: 'edited with no Bash run' }
  return null
}

function dominantGoodSignal(
  stats: SnapshotStats,
): { cls: GoodClass; why: string } | null {
  if (stats.hadEdit && stats.hadBash) return { cls: 'verified_with_test', why: 'edited and ran Bash this window' }
  if (stats.hadEdit) return { cls: 'produced_diff', why: 'shipped an edit this window' }
  if (stats.hadRead && !stats.editBeforeRead) return { cls: 'inspected_code_first', why: 'read before editing this window' }
  if (stats.avgAssistantChars > 0 && stats.avgAssistantChars < 400) return { cls: 'concise_answer', why: 'short assistant turns' }
  return null
}

//
// Classifier — operator keywords (+2 each) plus recent-window signal boosts.
//

const MEH_KEYWORDS: Record<Exclude<MehClass, 'other'>, RegExp[]> = {
  too_passive: [/\bpassive\b/i, /ask(?:ed|ing)?\s+permission/i, /didn.?t\s+act/i, /too\s+cautious/i, /hesitan|timid/i, /kept\s+asking/i, /just\s+do\s+it/i, /stop\s+asking/i],
  too_verbose: [/\bverbose\b/i, /too\s+long/i, /wall\s+of\s+text/i, /rambl/i, /\bwordy\b/i, /too\s+much\s+(?:explanation|talk|prose)/i, /\btl;?dr\b/i, /get\s+to\s+the\s+point/i, /less\s+talk/i],
  did_not_inspect_code: [/didn.?t\s+(?:read|look|check|inspect)/i, /did\s+not\s+(?:read|look|inspect)/i, /\bguess(?:ed|ing)?\b/i, /without\s+(?:reading|checking|looking)/i, /assumed\s+the\s+code/i, /read\s+the\s+(?:code|source)/i],
  // `should have used` excludes `…agents/parallel/a workflow` (those are under_orchestrated).
  wrong_tool_choice: [/wrong\s+tool/i, /should\s+have\s+used\s+(?!agents|parallel|sub|a\s+workflow|fan)/i, /used\s+the\s+wrong/i, /why\s+(?:bash|grep|sed)/i, /use\s+the\s+\w+\s+tool/i],
  over_orchestrated: [/too\s+many\s+(?:agents|subagents)/i, /overkill/i, /didn.?t\s+need\s+(?:a\s+)?(?:workflow|agents)/i, /over[-\s]?orchestrat/i, /fanned?\s+out\s+too/i],
  under_orchestrated: [/should\s+have\s+(?:parallel|fanned|used\s+agents)/i, /too\s+slow/i, /one\s+at\s+a\s+time/i, /\bsequential(?:ly)?\b/i, /in\s+parallel/i],
  missing_memory: [/should\s+have\s+remembered/i, /\bforgot\b/i, /didn.?t\s+recall/i, /you\s+(?:knew|know)\s+this/i, /already\s+told\s+you/i, /missing\s+memory/i, /no\s+memory\s+of/i],
  no_concrete_artifact: [/no\s+(?:diff|file|change|artifact|code)/i, /nothing\s+(?:shipped|changed|produced)/i, /just\s+talk/i, /all\s+talk/i, /where.?s\s+the\s+code/i],
  no_test_or_verification: [/no\s+test/i, /didn.?t\s+(?:verify|test|run|prove)/i, /\bunverified\b/i, /no\s+(?:proof|verification)/i, /prove\s+it/i, /did\s+you\s+(?:test|verify)/i],
  got_stuck_without_escalating: [/\bstuck\b/i, /\bspun\b|spinning/i, /\blooped?\b|in\s+a\s+loop/i, /gave\s+up/i, /kept\s+failing/i, /didn.?t\s+escalat/i, /ask\s+for\s+help/i],
  ui_noise: [/too\s+noisy/i, /cluttered/i, /ui\s+noise/i, /too\s+much\s+output/i, /\bspam(?:my)?\b/i, /distracting/i, /clean\s+up\s+the\s+output/i],
}

const GOOD_KEYWORDS: Record<Exclude<GoodClass, 'other'>, RegExp[]> = {
  inspected_code_first: [/read\s+the\s+(?:code|source)/i, /inspected/i, /looked\s+(?:first|at\s+the)/i, /checked\s+the\s+source/i, /\bgrounded\b/i, /\brecon\b/i, /traced\s+the/i],
  concise_answer: [/\bconcise\b/i, /\bterse\b/i, /to\s+the\s+point/i, /\bshort\b/i, /\bbrief\b/i, /no\s+fluff/i, /tight/i],
  produced_diff: [/\bdiff\b/i, /\bshipped\b/i, /the\s+(?:change|patch|code)/i, /\bconcrete\b/i, /\bimplemented\b/i, /actually\s+(?:built|wrote)/i],
  verified_with_test: [/\bverified\b/i, /\btested\b/i, /ran\s+the\s+(?:test|gate|build)/i, /\bproof\b/i, /\bgreen\b/i, /\bpassed\b/i, /the\s+gate/i],
  asked_good_question: [/good\s+question/i, /right\s+question/i, /asked\s+the\s+right/i, /clarif/i, /sharp\s+question/i],
  avoided_overbuild: [/didn.?t\s+overbuild/i, /\bminimal\b/i, /kept\s+it\s+simple/i, /no\s+overengineer/i, /\brestraint\b/i, /just\s+enough/i, /kept\s+it\s+small/i],
  remembered_context: [/remembered/i, /\brecalled\b/i, /you\s+knew/i, /good\s+memory/i, /picked\s+up\s+where/i, /kept\s+the\s+context/i],
}

function scoreKeywords(text: string, patterns: RegExp[]): string[] {
  const hits: string[] = []
  for (const re of patterns) {
    const m = text.match(re)
    if (m) hits.push(m[0].toLowerCase().replace(/\s+/g, ' ').trim())
  }
  return hits
}

/** Classify a /meh complaint into a MehClass (deterministic). */
export function classifyMeh(text: string, snap: TasteSnapshot): ClassifyResult {
  const stats = snapshotStats(snap)
  const scores = new Map<string, number>()
  const reasons = new Map<string, string[]>()
  const bump = (cls: string, by: number, why: string) => {
    scores.set(cls, (scores.get(cls) ?? 0) + by)
    const r = reasons.get(cls) ?? []
    r.push(why)
    reasons.set(cls, r)
  }

  for (const cls of Object.keys(MEH_KEYWORDS) as Array<Exclude<MehClass, 'other'>>) {
    for (const hit of scoreKeywords(text, MEH_KEYWORDS[cls])) bump(cls, 2, `said "${hit}"`)
  }
  // Recent-window evidence (one dominant signal, stacks with keyword matches).
  const sig = dominantMehSignal(stats, snap)
  if (sig) bump(sig.cls, 2, sig.why)

  return pickWinner(scores, reasons)
}

/** Classify a /good praise into a GoodClass (deterministic). */
export function classifyGood(text: string, snap: TasteSnapshot): ClassifyResult {
  const stats = snapshotStats(snap)
  const scores = new Map<string, number>()
  const reasons = new Map<string, string[]>()
  const bump = (cls: string, by: number, why: string) => {
    scores.set(cls, (scores.get(cls) ?? 0) + by)
    const r = reasons.get(cls) ?? []
    r.push(why)
    reasons.set(cls, r)
  }

  for (const cls of Object.keys(GOOD_KEYWORDS) as Array<Exclude<GoodClass, 'other'>>) {
    for (const hit of scoreKeywords(text, GOOD_KEYWORDS[cls])) bump(cls, 2, `said "${hit}"`)
  }
  const sig = dominantGoodSignal(stats)
  if (sig) bump(sig.cls, 2, sig.why)

  return pickWinner(scores, reasons)
}

function pickWinner(
  scores: Map<string, number>,
  reasons: Map<string, string[]>,
): ClassifyResult {
  let bestCls = 'other'
  let bestScore = 0
  for (const [cls, score] of scores) {
    if (score > bestScore) {
      bestScore = score
      bestCls = cls
    }
  }
  return { cls: bestCls, score: bestScore, signals: reasons.get(bestCls) ?? [] }
}

//
// The "one next adjustment" per class — also the promoted lesson body.
//

const MEH_ADJUSTMENT: Record<MehClass, string> = {
  too_passive: 'Act through tools on reversible work; don\'t ask permission — report after.',
  too_verbose: 'Cut the prose — one short worklog line, then tools; save the summary for the end.',
  did_not_inspect_code: 'Read the real code / types / call-sites before editing — recon to ground truth first.',
  wrong_tool_choice: 'Pick the dedicated tool for the job (Read/Grep/Edit over raw shell).',
  over_orchestrated: 'Hand-code small or off-distribution work; reserve fan-out for genuinely independent breadth.',
  under_orchestrated: 'Parallelize independent work — batch reads / fan out agents when breadth warrants.',
  missing_memory: 'Recall the relevant lesson — and bank it with /remember so it sticks next time.',
  no_concrete_artifact: 'Produce a concrete artifact — a diff / file / command — not just discussion.',
  no_test_or_verification: 'Verify by running the test/build/gate; assert state from output, not vibes.',
  got_stuck_without_escalating: 'When stuck after ~2 tries, change approach or escalate — surface the blocker, don\'t spin.',
  ui_noise: 'Reduce UI noise — terse status, no decorative output.',
  other: 'Note the friction and adjust deliberately next time.',
}

const GOOD_REINFORCE: Record<GoodClass, string> = {
  inspected_code_first: 'Grounding in the real code before editing paid off — keep recon-first.',
  concise_answer: 'Concise, to-the-point answers land well — keep the prose tight.',
  produced_diff: 'Shipping a concrete diff is what helps — keep producing artifacts.',
  verified_with_test: 'Verifying with a test/gate built trust — keep proving changes.',
  asked_good_question: 'A sharp, option-bearing question at the right moment helped — keep them structured and rare.',
  avoided_overbuild: 'Restraint — a minimal complete solution — was right; keep avoiding overbuild.',
  remembered_context: 'Recalling prior context helped — keep surfacing relevant memory.',
  other: 'Whatever worked here, keep doing it.',
}

/** The transferable lesson body for a (kind, class) pair. */
export function lessonFor(kind: TasteKind, cls: string): string {
  return kind === 'meh'
    ? MEH_ADJUSTMENT[(cls as MehClass) in MEH_ADJUSTMENT ? (cls as MehClass) : 'other']
    : GOOD_REINFORCE[(cls as GoodClass) in GOOD_REINFORCE ? (cls as GoodClass) : 'other']
}

//
// Episode construction (pure) + size cap
//

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 8)
}

/** Build (and classify) an episode from a kind + raw operator text + snapshot. */
export function buildEpisode(
  kind: TasteKind,
  rawText: string,
  snapshot: TasteSnapshot,
  nowIso: string,
): TasteEpisode {
  const text = redactAndClip(rawText, MAX_TEXT_CHARS)
  const result =
    kind === 'meh' ? classifyMeh(text, snapshot) : classifyGood(text, snapshot)
  const episode: TasteEpisode = {
    v: 1,
    id: shortHash(nowIso + '|' + text),
    ts: nowIso,
    kind,
    cls: result.cls,
    signals: result.signals,
    text,
    snapshot,
  }
  return capEpisodeSize(episode)
}

/**
 * Cap the episode's JSON at MAX_EPISODE_BYTES. Two stages:
 *  (1) a best-effort progressive trim of the largest contributor — turn texts →
 *      tool names → complaint text → signals → identity — preserving as much
 *      useful content as possible; then
 *  (2) a FINAL HARD CLAMP that collapses to a minimal episode if the trim budget
 *      was somehow exhausted, so the cap is NEVER violated (the invariant is
 *      unconditional, not dependent on the loop converging within its guard).
 * On the production path the clamp is unreachable — captureSnapshot/buildEpisode
 * pre-bound every field, so a maximal real capture is well under the cap — but it
 * makes the guarantee hold for any (e.g. synthetic/test) caller too.
 */
export function capEpisodeSize(ep: TasteEpisode): TasteEpisode {
  let out = ep
  let guard = 0
  while (JSON.stringify(out).length > MAX_EPISODE_BYTES && guard++ < 200) {
    const turns = out.snapshot.turns
    // 1. Shrink the longest turn text by half, or drop the oldest tiny turn.
    let idx = -1
    let longest = 0
    turns.forEach((t, i) => {
      if (t.text.length > longest) {
        longest = t.text.length
        idx = i
      }
    })
    if (idx !== -1 && longest > 16) {
      out = {
        ...out,
        snapshot: {
          ...out.snapshot,
          turns: turns.map((t, i) =>
            i === idx ? { ...t, text: clip(t.text, Math.max(16, Math.floor(longest / 2))) } : t,
          ),
        },
      }
      continue
    }
    if (turns.length > 0) {
      out = { ...out, snapshot: { ...out.snapshot, turns: turns.slice(1) } }
      continue
    }
    // 2. Turns exhausted — clip an oversize tool name, else drop the last tool.
    const tools = out.snapshot.tools
    const longTool = tools.findIndex(t => t.name.length > 24)
    if (longTool !== -1) {
      out = {
        ...out,
        snapshot: {
          ...out.snapshot,
          tools: tools.map((t, i) => (i === longTool ? { ...t, name: clip(t.name, 24) } : t)),
        },
      }
      continue
    }
    if (tools.length > 0) {
      out = { ...out, snapshot: { ...out.snapshot, tools: tools.slice(0, -1) } }
      continue
    }
    // 3. Still over — clip the complaint text, then shed signals.
    if (out.text.length > 24) {
      out = { ...out, text: clip(out.text, Math.max(24, Math.floor(out.text.length / 2))) }
      continue
    }
    if (out.signals.length > 0) {
      out = { ...out, signals: out.signals.slice(0, -1) }
      continue
    }
    // 4. Last resort — clip the identity fields (normally tiny: a UUID + paths,
    //    but a pathological cwd/project must not be allowed to blow the cap).
    const sn = out.snapshot
    if (sn.cwd.length > 64 || sn.project.length > 64 || sn.sessionId.length > 64 || sn.modes.length > 0) {
      out = {
        ...out,
        snapshot: {
          ...sn,
          cwd: clip(sn.cwd, 64),
          project: clip(sn.project, 64),
          sessionId: clip(sn.sessionId, 64),
          modes: [],
        },
      }
      continue
    }
    break // only small fixed fields remain (well under the cap) — accept.
  }
  // (2) Guaranteed backstop — collapse to a minimal episode if the progressive
  // trim above couldn't get under the cap (pathological multi-axis input).
  if (JSON.stringify(out).length > MAX_EPISODE_BYTES) {
    out = {
      ...out,
      // Clamp the scalar string fields too — in production these are bounded by
      // construction (id = 8-hex hash, ts = ISO-8601, cls = closed vocab), but the
      // backstop's guarantee is unconditional, so a synthetic caller can't smuggle
      // an over-cap episode through an unclipped scalar.
      id: clip(out.id, 32),
      ts: clip(out.ts, 32),
      cls: clip(out.cls, 64),
      text: clip(out.text, 200),
      signals: out.signals.slice(0, 3).map(s => clip(s, 80)),
      snapshot: {
        sessionId: clip(out.snapshot.sessionId, 64),
        cwd: clip(out.snapshot.cwd, 64),
        project: clip(out.snapshot.project, 64),
        modes: [],
        turns: [],
        tools: [],
      },
    }
  }
  return out
}

//
// Paths + atomic write + fail-open flock (mirrors experienceCards discipline)
//

export function tasteDir(memoryDir: string): string {
  return join(memoryDir, TASTE_DIRNAME)
}
export function episodesPath(memoryDir: string): string {
  return join(tasteDir(memoryDir), EPISODES_FILENAME)
}
export function tasteMdPath(memoryDir: string): string {
  return join(tasteDir(memoryDir), TASTE_MD_FILENAME)
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  // The one durable publication primitive (collision-free exclusive temp,
  // fsync barriers, self-cleaning failure path).
  await durableAtomicPublish(path, content)
}

/** Cross-process flock around a read-modify-write of a SHARED file (the episode
 *  ring / TASTE.md). Fail-OPEN (a contended or unavailable lock never blocks the
 *  write; the atomic rename still prevents a torn file).
 *
 *  proper-lockfile realpath()s the target, so if the file does not exist yet the
 *  lock throws ENOENT and — fail-open — the read-modify-write would run UNLOCKED;
 *  concurrent FIRST writers then each read the empty file and clobber each other
 *  (lost episodes). Pre-create the empty target with `wx` (create-if-absent, never
 *  truncate) so the lock actually engages on the first write — mirrors
 *  experienceCards.applyIndexUpdate's same guard for the shared MEMORY.md index. */
async function withTasteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await writeFile(path, '', { flag: 'wx' }).catch(() => {}) // create-if-absent; swallow EEXIST
  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(path, {
      // Generous retry budget: episodes.jsonl / TASTE.md are SHARED files, so a
      // burst of writers must serialize rather than fail open and clobber. Each
      // holder releases in ~ms, so this resolves fast; the cap just bounds a
      // pathological wait. (Still fail-open as a last resort below.)
      retries: { retries: 100, minTimeout: 10, maxTimeout: 250 },
    })
  } catch {
    release = undefined
  }
  try {
    return await fn()
  } finally {
    if (release) await release().catch(() => {})
  }
}

//
// Persistence
//

/** Append an episode to the bounded JSONL ring (atomic + fail-open flock). */
export async function writeEpisode(
  memoryDir: string,
  episode: TasteEpisode,
): Promise<string> {
  const dir = tasteDir(memoryDir)
  await mkdir(dir, { recursive: true })
  const path = episodesPath(memoryDir)
  await withTasteLock(path, async () => {
    let lines: string[] = []
    try {
      const raw = await readFile(path, 'utf-8')
      lines = raw.split('\n').filter(Boolean)
    } catch {
      lines = []
    }
    lines.push(JSON.stringify(episode))
    if (lines.length > MAX_EPISODES) lines = lines.slice(lines.length - MAX_EPISODES)
    await atomicWriteFile(path, lines.join('\n') + '\n')
  })
  return path
}

/** Read all persisted episodes (malformed lines skipped). */
export async function readEpisodes(memoryDir: string): Promise<TasteEpisode[]> {
  let raw: string
  try {
    raw = await readFile(episodesPath(memoryDir), 'utf-8')
  } catch {
    return []
  }
  const out: TasteEpisode[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const ep = JSON.parse(line) as TasteEpisode
      if (ep && ep.v === 1 && (ep.kind === 'meh' || ep.kind === 'good')) out.push(ep)
    } catch {
      // skip a torn / partial line
    }
  }
  return out
}

//
// Promotion — repeated classes become candidate lessons (one source of truth:
// derived live from episodes; TASTE.md is the human-readable mirror).
//

/** Count classes across episodes; return those at/above the promote threshold. */
export function derivePromoted(
  episodes: readonly TasteEpisode[],
  threshold: number = PROMOTE_THRESHOLD,
): PromotedLesson[] {
  const counts = new Map<string, PromotedLesson>()
  for (const e of episodes) {
    if (!e || e.cls === 'other' || (e.kind !== 'meh' && e.kind !== 'good')) continue
    const key = `${e.kind}:${e.cls}`
    const cur = counts.get(key) ?? {
      kind: e.kind,
      cls: e.cls,
      count: 0,
      lesson: lessonFor(e.kind, e.cls),
    }
    cur.count++
    counts.set(key, cur)
  }
  return [...counts.values()]
    .filter(l => l.count >= threshold)
    .sort((a, b) => b.count - a.count)
}

/** Render the TASTE.md candidate-lessons artifact. */
export function renderTasteMd(promoted: readonly PromotedLesson[]): string {
  const meh = promoted.filter(l => l.kind === 'meh')
  const good = promoted.filter(l => l.kind === 'good')
  const line = (l: PromotedLesson) =>
    `- [${l.kind}:${l.cls} ×${l.count}, candidate] ${l.lesson}`
  const header = `# TASTE.md — operator-friction-derived taste lessons

<!-- Auto-maintained by the Taste Loop (/meh, /good). Each entry is a CANDIDATE
     lesson derived from >= ${PROMOTE_THRESHOLD} repeated operator signals — NOT
     universal truth. Treat as a soft preference for this project, not an order. -->
`
  const friction = meh.length
    ? `\n## Friction — avoid\n${meh.map(line).join('\n')}\n`
    : ''
  const worked = good.length
    ? `\n## What worked — keep\n${good.map(line).join('\n')}\n`
    : ''
  const empty = !meh.length && !good.length
    ? '\n_(No pattern has repeated enough to promote yet.)_\n'
    : ''
  return header + friction + worked + empty
}

/** Recompute promotions and rewrite the TASTE.md mirror (atomic + flock). */
export async function promoteLessons(
  memoryDir: string,
  threshold: number = PROMOTE_THRESHOLD,
): Promise<{ promoted: PromotedLesson[]; path: string }> {
  const episodes = await readEpisodes(memoryDir)
  const promoted = derivePromoted(episodes, threshold)
  await mkdir(tasteDir(memoryDir), { recursive: true })
  const path = tasteMdPath(memoryDir)
  await withTasteLock(path, () => atomicWriteFile(path, renderTasteMd(promoted)))
  return { promoted, path }
}

//
// Recall — precise, throttled injection of promoted lessons into future turns.
//

/**
 * Throttle: emit the recall reminder on the first eligible turn and then at
 * most once per RECALL_THROTTLE_TURNS human turns. Mirrors the auto_mode /
 * ultra_effort attachment-counting cadence (stateless, derived from history).
 */
export function shouldEmitTasteRecall(messages: readonly Message[]): boolean {
  let humanTurns = 0
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i] as
      | { type?: string; isMeta?: boolean; toolUseResult?: unknown; attachment?: { type?: string }; message?: { content?: unknown } }
      | undefined
    if (!m) continue
    if (m.type === 'attachment' && m.attachment?.type === 'taste_recall') {
      // Found a prior reminder — only re-emit if enough human turns have passed.
      return humanTurns >= RECALL_THROTTLE_TURNS
    }
    if (
      m.type === 'user' &&
      !m.isMeta &&
      m.toolUseResult === undefined &&
      !hasToolResult(m.message?.content)
    ) {
      humanTurns++
    }
  }
  // No prior reminder in history — emit.
  return true
}

/** Format the short recall reminder from promoted lessons (null when none). */
export function buildTasteRecallText(promoted: readonly PromotedLesson[]): string | null {
  if (!promoted.length) return null
  const top = promoted.slice(0, RECALL_MAX_LESSONS)
  const meh = top.filter(l => l.kind === 'meh')
  const good = top.filter(l => l.kind === 'good')
  const lines: string[] = []
  for (const l of meh) lines.push(`- Avoid: ${l.lesson}`)
  for (const l of good) lines.push(`- Keep: ${l.lesson}`)
  return (
    `Taste Loop — operator-tuned preferences for this project, learned from repeated /meh and /good signals and surfaced by relevance to what you're doing now. ` +
    `These are candidate soft-preferences (not absolute rules); honor them unless the task says otherwise. Never mention this reminder to the user.\n` +
    lines.join('\n')
  )
}

/** Concatenated text of the last `n` human turns (for relevance ranking). */
function recentUserText(messages: readonly Message[], n: number): string {
  const out: string[] = []
  for (let i = (messages?.length ?? 0) - 1; i >= 0 && out.length < n; i--) {
    const m = messages[i] as
      | { type?: string; isMeta?: boolean; toolUseResult?: unknown; message?: { content?: unknown } }
      | undefined
    if (
      m?.type === 'user' &&
      !m.isMeta &&
      m.toolUseResult === undefined &&
      !hasToolResult(m.message?.content)
    ) {
      const t = textBlocks(m.message?.content)
      if (t.trim()) out.push(t)
    }
  }
  return out.join(' ')
}

function lessonKeywords(kind: TasteKind, cls: string): RegExp[] {
  const table = kind === 'meh' ? MEH_KEYWORDS : GOOD_KEYWORDS
  return (table as Record<string, RegExp[]>)[cls] ?? []
}

/**
 * Precision rank for recall: promoted lessons whose class keywords match the
 * recent user text come FIRST (relevant-to-this-turn), ties and the no-signal
 * case fall back to frequency (count) order. Deterministic, no model call — so a
 * promoted lesson only displaces another when it is actually on-topic.
 */
export function rankByRelevance(
  promoted: readonly PromotedLesson[],
  recentText: string,
): PromotedLesson[] {
  const lc = (recentText ?? '').toLowerCase()
  if (!lc.trim()) return [...promoted]
  const matches = (l: PromotedLesson): number =>
    lessonKeywords(l.kind, l.cls).some(re => re.test(lc)) ? 1 : 0
  return [...promoted].sort((a, b) => matches(b) - matches(a) || b.count - a.count)
}

/**
 * The recall content for a turn (null ⇒ inject nothing): off / disabled /
 * throttled / no promoted lessons all yield null. Precision-biased: only promoted
 * (repeated ≥ threshold) lessons, re-derived live from episodes, RANKED by
 * relevance to the recent turns, then capped (buildTasteRecallText keeps the top
 * RECALL_MAX_LESSONS).
 */
export async function getTasteRecallContent(
  memoryDir: string,
  messages: readonly Message[],
): Promise<string | null> {
  if (!tasteLoopEnabled()) return null
  if (!shouldEmitTasteRecall(messages)) return null
  const episodes = await readEpisodes(memoryDir)
  const promoted = rankByRelevance(
    derivePromoted(episodes),
    recentUserText(messages, RECALL_RELEVANCE_WINDOW),
  )
  return buildTasteRecallText(promoted)
}
