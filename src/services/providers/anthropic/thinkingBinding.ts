// providers/anthropic/thinkingBinding — Mercury's preserved-thinking setting
// (the Claude Fable 5.1 conversation check) and the reading of what the API
// dropped. Mercury-owned.
//
// A Claude Fable 5.1 thinking block is bound to the exact prefix that
// produced it — the top-level system prompt, the tools set and every message
// before it. Where the check is enforced (organisations created on or after
// 2026-08-31 today; every account on later models), a request that replays a
// block after that prefix changed is a 400 unless the request opts into
// `drop_block`, in which case the API drops the block and every thinking
// block after it and names each one in the response's
// `input_transformations`. Mercury's history is append-only by design and
// the known client-side edits strip their own invalidated run
// (stripThinkingFromIndex), so a drop is a defect signal — never an outage:
// the production setting is `drop_block` under the controls header, and every
// drop reaches the operator as a transcript notice.
//
// MERCURY_THINKING_BINDING: unset ⇒ drop_block (production) · error ⇒ the
// API refuses instead (provers and CI, where an edit must fail the run) ·
// 0/off ⇒ no header, no field (the pre-controls request, byte-identical).
// The host rule: unset rides the FIRST-PARTY host only — the controls beta
// is a Claude API header a gateway or another platform may refuse; an
// EXPLICIT value rides every host, the operator's assertion that their
// gateway accepts the beta (the MERCURY_TOOL_SEARCH assertion's pattern),
// and the way a fixture-hosted prover sees the field on the wire.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { THINKING_BINDING_CONTROLS_BETA_HEADER } from '../../../constants/betas.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import type { Message } from '../../../types/message.js'
import type { InputTransformation } from '../../../types/wire.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getGlobalConfig } from '../../../utils/config/globalConfig.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { thinkingFromOtherModels } from '../../../utils/messages/apiFilters.js'
import { getCanonicalName, getPublicModelDisplayName } from '../../../utils/model/model.js'
import { isFirstPartyAnthropicBaseUrl } from '../../../utils/model/providers.js'

export type PrefixMismatchBehavior = 'drop_block' | 'error'

/** The wire field the controls beta unlocks (the SDK types lag it). */
export type ThinkingBlockBinding = {
  block_binding: { prefix_mismatch_behavior: PrefixMismatchBehavior }
}

/** The setting as read: the behavior (null = off) and whether the operator
 *  spelled it (an explicit value rides every host; unset is first-party only). */
export interface ThinkingBindingSetting {
  behavior: PrefixMismatchBehavior | null
  explicit: boolean
}

export function resolveThinkingBindingSetting(raw: string | undefined): ThinkingBindingSetting {
  if (raw === undefined || raw.trim() === '') return { behavior: 'drop_block', explicit: false }
  const value = raw.trim().toLowerCase()
  if (value === 'error') return { behavior: 'error', explicit: true }
  if (value === 'drop_block' || value === 'drop' || value === '1' || value === 'true') {
    return { behavior: 'drop_block', explicit: true }
  }
  if (value === '0' || value === 'off' || value === 'false' || value === 'none') {
    return { behavior: null, explicit: true }
  }
  logForDebugging(
    `MERCURY_THINKING_BINDING=${raw}: not a known value (drop_block · error · off) — riding drop_block`,
    { level: 'warn' },
  )
  return { behavior: 'drop_block', explicit: true }
}

export function resolveThinkingBindingBehavior(
  raw: string | undefined = flagEnv('MERCURY_THINKING_BINDING'),
): PrefixMismatchBehavior | null {
  return resolveThinkingBindingSetting(raw).behavior
}

/** Injectable reads for provers; production callers pass nothing. `env` is
 *  the raw MERCURY_THINKING_BINDING value — the KEY's presence injects it, so
 *  `{ env: undefined }` is the unset case. */
export interface ThinkingBindingReads {
  firstParty?: () => boolean
  env?: string | undefined
}

/**
 * Stamp the binding field onto a request's `thinking` object and admit the
 * controls header into `betas` (mutated in place — the caller's per-attempt
 * copy). Identity when the request carries no thinking (nothing to bind),
 * when the setting is unset off the first-party host, or when the operator
 * turned the setting off.
 */
export function applyThinkingBinding<T extends { type: string }>(
  thinking: T | undefined,
  betas: string[],
  reads?: ThinkingBindingReads,
): T | (T & ThinkingBlockBinding) | undefined {
  if (thinking === undefined) return thinking
  const raw = reads !== undefined && 'env' in reads ? reads.env : flagEnv('MERCURY_THINKING_BINDING')
  const setting = resolveThinkingBindingSetting(raw)
  if (setting.behavior === null) return thinking
  if (!setting.explicit) {
    const firstParty = (reads?.firstParty ?? isFirstPartyAnthropicBaseUrl)()
    if (!firstParty) return thinking
  }
  if (!betas.includes(THINKING_BINDING_CONTROLS_BETA_HEADER)) {
    betas.push(THINKING_BINDING_CONTROLS_BETA_HEADER)
  }
  return { ...thinking, block_binding: { prefix_mismatch_behavior: setting.behavior } }
}

/** The dropped-block list off a response message (streaming: the
 *  message_start envelope the minted assistant message spreads). Empty when
 *  absent, null, or not an array — the field is read, never trusted. */
export function inputTransformationsOf(message: unknown): InputTransformation[] {
  const list = (message as { input_transformations?: unknown } | null | undefined)?.input_transformations
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is InputTransformation =>
      typeof entry === 'object' && entry !== null && typeof (entry as { type?: unknown }).type === 'string',
  )
}

/**
 * The operator's sentence for a non-empty drop list, or null for an empty
 * one. Names the count, the first path and the reason class; a drop is a
 * transcript row, never a silent degradation.
 */
export function describeInputTransformations(list: readonly InputTransformation[]): string | null {
  if (list.length === 0) return null
  const dropped = list.filter(entry => entry.type === 'thinking_dropped')
  const count = dropped.length > 0 ? dropped.length : list.length
  const first = list[0]!
  const reasons = new Set(list.map(entry => entry.reason))
  const noun = count === 1 ? 'thinking block' : 'thinking blocks'
  if (reasons.size === 1 && reasons.has('prefix_binding_mismatch')) {
    return `Preserved thinking: the API dropped ${count} ${noun} — the history before ${first.path} changed since they were written (a client-side edit); the model re-plans without that reasoning this turn.`
  }
  if (reasons.size === 1 && reasons.has('model_binding_mismatch')) {
    return `Preserved thinking: the API dropped ${count} ${noun} written by another model (the conversation switched models); the model re-plans without them this turn.`
  }
  return `Preserved thinking: the API dropped ${count} ${noun} (${[...reasons].join(', ')}; first at ${first.path}); the model re-plans without that reasoning this turn.`
}

// ── the recurrence reading ─────────────────────────────────────────────────
//
// A single drop after a lawful prefix change (a compaction folded the
// history, a deliberate model switch) is the one-line receipt above. A drop
// on CONSECUTIVE requests with no lawful change between them means Mercury
// itself is rewriting already-sent history: that receipt names Mercury, the
// changed path, the doctor row that carries the evidence and the bug-report
// road — never a model switch, which does not touch the cause.

/** The lawful prefix changes the history and the live settings can show:
 *  a compaction, a deliberate model switch, an explicit operator setting
 *  the system prompt or the tool roster reads (the permission mode's packs
 *  and mode-exempt tools, the response profile). (An operator's transcript
 *  edit leaves no row, so a drop after it reads as a single client-side
 *  edit.) */
export type LawfulPrefixChange = 'compaction' | 'model-switch' | 'operator-setting'

/**
 * The marks of a request's history that move only on a lawful change: the
 * first conversation row (a compaction replaces it with the summary), the
 * newest compact boundary and model-transition rows, the model itself, and
 * the operator settings the prompt build reads live (spelled as one string
 * so a change names the key that moved). Two consecutive requests whose
 * marks agree had no lawful change between them.
 */
export interface PrefixMark {
  firstRow: string | null
  compactBoundary: string | null
  modelTransition: string | null
  model: string
  settings: string
}

/** The live operator settings a mark records. Absent keys spell '?' — a
 *  caller that cannot read one never fakes a change. */
export interface LiveOperatorSettings {
  permissionMode?: string
  responseProfile?: string
}

const SETTING_LABELS: Record<string, string> = {
  mode: 'the permission mode',
  profile: 'the response profile',
}

export function spellOperatorSettings(live: LiveOperatorSettings | undefined): string {
  let profile = live?.responseProfile
  if (profile === undefined) {
    try {
      profile = getGlobalConfig().responseProfile ?? 'balanced'
    } catch {
      profile = undefined
    }
  }
  return `mode=${live?.permissionMode ?? '?'};profile=${profile ?? '?'}`
}

/** "the permission mode (default → apollo)" for every key whose value moved. */
export function describeSettingsMove(previous: string, current: string): string | null {
  const parse = (spelled: string): Map<string, string> =>
    new Map(spelled.split(';').filter(Boolean).map(part => {
      const at = part.indexOf('=')
      return [part.slice(0, at), part.slice(at + 1)] as [string, string]
    }))
  const before = parse(previous)
  const after = parse(current)
  const moved: string[] = []
  for (const [key, value] of after) {
    const was = before.get(key)
    // An unreadable side ('?') never fakes an operator action.
    if (was === undefined || was === '?' || value === '?' || was === value) continue
    moved.push(`${SETTING_LABELS[key] ?? key} (${was} → ${value})`)
  }
  return moved.length === 0 ? null : moved.join(' and ')
}

export function prefixMarkOf(
  messages: readonly Message[],
  model: string,
  live?: LiveOperatorSettings,
): PrefixMark {
  let firstRow: string | null = null
  let compactBoundary: string | null = null
  let modelTransition: string | null = null
  for (const message of messages) {
    if (message.type === 'user' || message.type === 'assistant') {
      firstRow = message.uuid
      break
    }
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type !== 'system') continue
    const subtype = (message as { subtype?: string }).subtype
    if (compactBoundary === null && subtype === 'compact_boundary') compactBoundary = message.uuid
    if (modelTransition === null && subtype === 'model_transition') modelTransition = message.uuid
    if (compactBoundary !== null && modelTransition !== null) break
  }
  return { firstRow, compactBoundary, modelTransition, model, settings: spellOperatorSettings(live) }
}

export type DropKind = 'none' | 'first' | 'lawful' | 'recurrent'

export interface DropOutcome {
  kind: DropKind
  lawful: LawfulPrefixChange | null
  /** The operator setting that moved, when `lawful` is 'operator-setting'. */
  detail: string | null
  /** The unlawful run this drop extends (1 for a first drop). */
  consecutive: number
  count: number
  path: string | null
  reason: string | null
}

interface OwnerDropState {
  mark: PrefixMark
  kind: DropKind
  consecutive: number
}

/** Per conversation owner: the previous response's mark and verdict. */
const dropStates = new Map<string, OwnerDropState>()

/** Test seam: forget every conversation's previous verdict. */
export function resetThinkingDropStates(): void {
  dropStates.clear()
}

/**
 * Classify one response's drop list against the previous response of the
 * same conversation. Every response is recorded, dropped or not, so the
 * verdict on the next one is honest: a drop right after a no-drop request
 * is a first drop; a drop after a drop with unchanged marks is Mercury
 * rewriting history; a drop whose marks moved is the lawful change.
 */
export function classifyThinkingDrops(
  owner: string,
  list: readonly InputTransformation[],
  mark: PrefixMark,
): DropOutcome {
  const dropped = list.filter(entry => entry.type === 'thinking_dropped')
  const previous = dropStates.get(owner)
  if (dropped.length === 0) {
    dropStates.set(owner, { mark, kind: 'none', consecutive: 0 })
    return { kind: 'none', lawful: null, detail: null, consecutive: 0, count: 0, path: null, reason: null }
  }
  let lawful: LawfulPrefixChange | null = null
  let detail: string | null = null
  if (previous !== undefined) {
    if (previous.mark.firstRow !== mark.firstRow || previous.mark.compactBoundary !== mark.compactBoundary) {
      lawful = 'compaction'
    } else if (previous.mark.model !== mark.model || previous.mark.modelTransition !== mark.modelTransition) {
      lawful = 'model-switch'
    } else {
      const moved = describeSettingsMove(previous.mark.settings, mark.settings)
      if (moved !== null) {
        lawful = 'operator-setting'
        detail = moved
      }
    }
  }
  const reasons = new Set(dropped.map(entry => entry.reason))
  // A model-binding drop is a model switch by the API's own reading.
  if (reasons.size === 1 && reasons.has('model_binding_mismatch')) lawful = 'model-switch'
  let kind: DropKind
  let consecutive: number
  if (lawful !== null) {
    kind = 'lawful'
    consecutive = 1
  } else if (previous !== undefined && (previous.kind === 'first' || previous.kind === 'recurrent')) {
    kind = 'recurrent'
    consecutive = previous.consecutive + 1
  } else {
    kind = 'first'
    consecutive = 1
  }
  dropStates.set(owner, { mark, kind, consecutive })
  const first = dropped[0]!
  return { kind, lawful, detail, consecutive, count: dropped.length, path: first.path, reason: first.reason }
}

/** Where the change sits, read off the dropped block's path. */
function describePathClass(path: string | null): string {
  const match = path === null ? null : /^messages\.(\d+)\./.exec(path)
  if (match === null) return 'somewhere before the dropped block'
  const index = Number(match[1])
  if (index <= 1) return 'the first exchange changed: the top-level system prompt, the tools array or the first user turn'
  return `a turn before messages.${index} changed, or the system prompt or the tools array`
}

function issuesUrl(): string {
  const packaged = typeof MACRO !== 'undefined' && typeof MACRO.PACKAGE_URL === 'string' ? MACRO.PACKAGE_URL : ''
  const base = packaged.length > 0 ? packaged : 'https://github.com/Whq02/PreRelease'
  return `${base.replace(/\/$/, '')}/issues`
}

/** The operator's sentence for a classified drop, or null when nothing dropped. */
export function describeThinkingDrops(
  list: readonly InputTransformation[],
  outcome: DropOutcome,
): string | null {
  if (outcome.kind === 'none') return null
  const count = outcome.count
  const noun = count === 1 ? 'thinking block' : 'thinking blocks'
  const path = outcome.path ?? 'an earlier turn'
  switch (outcome.kind) {
    case 'lawful':
      if (outcome.lawful === 'compaction') {
        return `Preserved thinking: the API dropped ${count} ${noun} after the compaction — the history before ${path} was folded into the summary, so the model re-plans without that reasoning this turn (expected once).`
      }
      if (outcome.lawful === 'operator-setting') {
        return `Preserved thinking: the API dropped ${count} ${noun} after you changed ${outcome.detail ?? 'a setting'} — the system prompt and the tool roster moved with it, so the model re-plans without that reasoning this turn (expected once).`
      }
      if (outcome.reason === 'model_binding_mismatch') return describeInputTransformations(list)
      return `Preserved thinking: the API dropped ${count} ${noun} after the model switch — the history before ${path} moved with it; the model re-plans without that reasoning this turn (expected once).`
    case 'first':
      return describeInputTransformations(list)
    case 'recurrent':
      return `Preserved thinking: the API dropped ${count} ${noun} again — Mercury rewrote already-sent history before ${path} on ${outcome.consecutive} consecutive requests with no compaction, model switch or transcript edit between them (${describePathClass(outcome.path)}). This is a Mercury defect, not the model's: run \`mercury doctor\` and paste its "Preserved thinking" row into a bug report at ${issuesUrl()}.`
  }
}

// ── the model-switch receipt ───────────────────────────────────────────────

/** Two model ids name the same model when their canonical families agree
 *  (an alias, a dated spelling or a context suffix never reads as a switch). */
export function isSameModel(a: string, b: string): boolean {
  return getCanonicalName(a) === getCanonicalName(b)
}

/**
 * The one quiet line a model switch earns: the previous model's thinking
 * blocks stay out of the requests to the current model (the assembler
 * strips them — stripThinkingFromOtherModels — so the API never drops and
 * re-reports them turn after turn). Null when the history carries no such
 * block. `key` identifies the switch (the conversation owner and the
 * current model's family) so the caller paints it once.
 */
export function modelSwitchReceipt(
  owner: string,
  messages: readonly Message[],
  currentModel: string,
): { key: string; text: string } | null {
  const foreign = thinkingFromOtherModels(messages, currentModel, isSameModel)
  if (foreign.count === 0) return null
  const display = (model: string): string => getPublicModelDisplayName(model) ?? model
  const writers = foreign.models.map(display).join(', ')
  const noun = foreign.count === 1 ? 'thinking block' : 'thinking blocks'
  return {
    key: `${owner}|${getCanonicalName(currentModel)}`,
    text: `Preserved thinking: ${foreign.count} ${noun} written by ${writers} stay out of the requests to ${display(currentModel)} (the conversation switched models); the model re-plans without them.`,
  }
}

// ── the doctor ledger ──────────────────────────────────────────────────────

export interface ThinkingDropLedger {
  last: {
    at: string
    kind: Exclude<DropKind, 'none'>
    lawful: LawfulPrefixChange | null
    detail?: string | null
    reason: string | null
    path: string | null
    count: number
    consecutive: number
    model: string
  }
  /** The longest unlawful run recorded on this machine. */
  longestRun: number
}

export function thinkingDropLedgerPath(): string {
  return join(getMercuryHome(), 'preserved-thinking.json')
}

/** Record a classified drop for `mercury doctor`; never throws (the ledger
 *  is evidence, not a dependency of the turn). */
export function recordThinkingDropLedger(outcome: DropOutcome, model: string): void {
  if (outcome.kind === 'none') return
  try {
    const previous = readThinkingDropLedger()
    const ledger: ThinkingDropLedger = {
      last: {
        at: new Date().toISOString(),
        kind: outcome.kind,
        lawful: outcome.lawful,
        ...(outcome.detail !== null ? { detail: outcome.detail } : {}),
        reason: outcome.reason,
        path: outcome.path,
        count: outcome.count,
        consecutive: outcome.consecutive,
        model,
      },
      longestRun: Math.max(previous?.longestRun ?? 0, outcome.kind === 'lawful' ? 0 : outcome.consecutive),
    }
    const path = thinkingDropLedgerPath()
    mkdirSync(dirname(path), { recursive: true })
    const staging = `${path}.${process.pid}.tmp`
    writeFileSync(staging, JSON.stringify(ledger, null, 2) + '\n')
    renameSync(staging, path)
  } catch (error) {
    logForDebugging(`preserved thinking: the doctor ledger could not be written (${String(error)})`, { level: 'warn' })
  }
}

export function readThinkingDropLedger(): ThinkingDropLedger | null {
  try {
    const parsed = JSON.parse(readFileSync(thinkingDropLedgerPath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const last = (parsed as { last?: unknown }).last
    if (typeof last !== 'object' || last === null) return null
    return parsed as ThinkingDropLedger
  } catch {
    return null
  }
}

/** The doctor row's content: what the last drop was and whether the
 *  machine has seen Mercury rewrite history — a tester pastes this. */
export function preservedThinkingHealth(ledger: ThinkingDropLedger | null): {
  status: 'ok' | 'info' | 'warn'
  evidence: string
  detail?: string
  fix?: string
} {
  if (ledger === null) {
    return { status: 'ok', evidence: 'no dropped thinking block recorded on this machine (input_transformations empty on every response seen)' }
  }
  const { last } = ledger
  const blocks = `${last.count} ${last.count === 1 ? 'block' : 'blocks'}`
  const where = `${last.reason ?? 'unknown reason'} at ${last.path ?? 'unknown path'}`
  if (last.kind === 'lawful') {
    const cause =
      last.lawful === 'compaction'
        ? 'a compaction'
        : last.lawful === 'operator-setting'
          ? `a setting change (${last.detail ?? 'unnamed'})`
          : 'a model switch'
    return {
      status: 'info',
      evidence: `last drop ${last.at}: ${blocks} after ${cause} (${where}, model ${last.model}) — expected once`,
    }
  }
  if (last.kind === 'first') {
    return {
      status: 'info',
      evidence: `last drop ${last.at}: ${blocks} (${where}, model ${last.model}) — a single drop; a resumed session's first request or a client-side edit`,
      detail: `Longest run of consecutive drops on this machine: ${ledger.longestRun}.`,
    }
  }
  return {
    status: 'warn',
    evidence: `Mercury rewrote sent history on ${last.consecutive} consecutive requests — last ${last.at}: ${blocks} dropped, ${where}, model ${last.model}`,
    detail: `${describePathClass(last.path)}. Longest run on this machine: ${ledger.longestRun}.`,
    fix: `Paste this row into a bug report at ${issuesUrl()} (the bug template, with the output of mercury doctor --json).`,
  }
}
