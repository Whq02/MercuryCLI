import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { THINKING_BINDING_CONTROLS_BETA_HEADER } from '../../../constants/betas.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { getSessionId } from '../../../bootstrap/state.js'
import type { AttachmentMessage, DeadThinkingMark, Message } from '../../../types/message.js'
import { isToolResultMessage } from '../../../utils/messages/merge.js'
import { createAttachmentMessage } from '../../../utils/attachments/orchestrator.js'
import type { InputTransformation } from '../../../types/wire.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getGlobalConfig } from '../../../utils/config/globalConfig.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { thinkingFromOtherModels } from '../../../utils/messages/apiFilters.js'
import { getCanonicalName, getPublicModelDisplayName } from '../../../utils/model/model.js'
import { isFirstPartyAnthropicBaseUrl } from '../../../utils/model/providers.js'
import { SPAWN_SWITCH_LABEL } from '../../switchboard/spawnSwitches.js'
import { consumeLawfulPrefixChange } from '../lawfulPrefixChange.js'
import { PUBLIC_HOME_SLUG } from '../../privateChannel/channelCore.js'
import { DEAD_THINKING_PLACEHOLDER } from './deadThinkingPlaceholder.js'
import type { RequestContextPlan } from '../../run/requestContextPlan.js'

export type PrefixMismatchBehavior = 'drop_block' | 'error'

export type ThinkingBlockBinding = {
  block_binding: { prefix_mismatch_behavior: PrefixMismatchBehavior }
}

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

export interface ThinkingBindingReads {
  firstParty?: () => boolean
  env?: string | undefined
}

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

export function inputTransformationsOf(message: unknown): InputTransformation[] {
  const list = (message as { input_transformations?: unknown } | null | undefined)?.input_transformations
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is InputTransformation =>
      typeof entry === 'object' && entry !== null && typeof (entry as { type?: unknown }).type === 'string',
  )
}

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


export type LawfulPrefixChange =
  | 'compaction'
  | 'model-switch'
  | 'operator-setting'
  | 'declared'
  | 'roster-switch'
  | 'thinking-cleared'
  | 'context-edited'

export interface PrefixMark {
  firstRow: string | null
  compactBoundary: string | null
  modelTransition: string | null
  rosterTransition: string | null
  rosterChange: string | null
  model: string
  settings: string
  thinkingClearActive: boolean
  contextEditActive: boolean
}

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
    if (was === undefined || was === '?' || value === '?' || was === value) continue
    moved.push(`${SETTING_LABELS[key] ?? key} (${was} → ${value})`)
  }
  return moved.length === 0 ? null : moved.join(' and ')
}

export function prefixMarkOf(
  messages: readonly Message[],
  model: string,
  live?: LiveOperatorSettings,
  context?: { thinkingClearActive?: boolean; requestPlan?: RequestContextPlan },
): PrefixMark {
  let firstRow: string | null = null
  let compactBoundary: string | null = null
  let modelTransition: string | null = null
  let rosterTransition: string | null = null
  let rosterChange: string | null = null
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
    if (rosterTransition === null && subtype === 'roster_transition') {
      rosterTransition = message.uuid
      const row = message as { toggle?: 'subagents' | 'workflows'; on?: boolean }
      rosterChange = row.toggle !== undefined ? `${SPAWN_SWITCH_LABEL[row.toggle]} ${row.on === false ? 'off' : 'on'}` : null
    }
    if (compactBoundary !== null && modelTransition !== null && rosterTransition !== null) break
  }
  return {
    firstRow,
    compactBoundary,
    modelTransition,
    rosterTransition,
    rosterChange,
    model,
    settings: spellOperatorSettings(live),
    thinkingClearActive: context?.thinkingClearActive === true,
    contextEditActive: context?.requestPlan?.mode === 'apply' &&
      (context.requestPlan.reductions.timeBasedCleared > 0 || (context.requestPlan.reductions.pressurePruned?.cleared ?? 0) > 0),
  }
}

export type DropKind = 'none' | 'first' | 'lawful' | 'recurrent'

export interface DropOutcome {
  kind: DropKind
  lawful: LawfulPrefixChange | null
  detail: string | null
  rosterChange: string | null
  consecutive: number
  count: number
  path: string | null
  reason: string | null
  paint: boolean
  part: string | null
}

interface OwnerDropState {
  mark: PrefixMark
  kind: DropKind
  consecutive: number
  defectNoticed: boolean
  editNoticed: boolean
}

const dropStates = new Map<string, OwnerDropState>()

const rewriteNoticed = new Set<string>()

export function takeRewriteNoticeOnce(owner: string): boolean {
  if (rewriteNoticed.has(owner)) return false
  rewriteNoticed.add(owner)
  return true
}

export function resetThinkingDropStates(): void {
  dropStates.clear()
  rewriteNoticed.clear()
}

export function classifyThinkingDrops(
  owner: string,
  list: readonly InputTransformation[],
  mark: PrefixMark,
  opts?: { byteMoved?: boolean },
): DropOutcome {
  const dropped = list.filter(entry => entry.type === 'thinking_dropped')
  const previous = dropStates.get(owner)
  const declared = consumeLawfulPrefixChange(owner)
  if (dropped.length === 0) {
    dropStates.set(owner, { mark, kind: 'none', consecutive: 0, defectNoticed: previous?.defectNoticed ?? false, editNoticed: previous?.editNoticed ?? false })
    return { kind: 'none', lawful: null, detail: null, rosterChange: null, consecutive: 0, count: 0, path: null, reason: null, paint: false, part: null }
  }
  let lawful: LawfulPrefixChange | null = null
  let detail: string | null = null
  if (declared !== null) {
    lawful = 'declared'
    detail = declared
  } else if (previous !== undefined) {
    if (previous.mark.firstRow !== mark.firstRow || previous.mark.compactBoundary !== mark.compactBoundary) {
      lawful = 'compaction'
    } else if (previous.mark.model !== mark.model || previous.mark.modelTransition !== mark.modelTransition) {
      lawful = 'model-switch'
    } else if (previous.mark.rosterTransition !== mark.rosterTransition) {
      lawful = 'roster-switch'
    } else {
      const moved = describeSettingsMove(previous.mark.settings, mark.settings)
      if (moved !== null) {
        lawful = 'operator-setting'
        detail = moved
      }
    }
  }
  const reasons = new Set(dropped.map(entry => entry.reason))
  if (reasons.size === 1 && reasons.has('model_binding_mismatch')) lawful = 'model-switch'
  if (lawful === null && opts?.byteMoved !== true) {
    if (mark.contextEditActive) lawful = 'context-edited'
    else if (mark.thinkingClearActive) lawful = 'thinking-cleared'
  }
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
  const isSelfEdit = lawful === 'thinking-cleared' || lawful === 'context-edited'
  const defectNoticed = previous?.defectNoticed ?? false
  const editNoticed = previous?.editNoticed ?? false
  const paint = isSelfEdit ? !editNoticed : kind !== 'recurrent'
  dropStates.set(owner, {
    mark,
    kind,
    consecutive,
    defectNoticed: defectNoticed || kind === 'recurrent',
    editNoticed: editNoticed || isSelfEdit,
  })
  const first = dropped[0]!
  return {
    kind,
    lawful,
    detail,
    rosterChange: lawful === 'roster-switch' ? mark.rosterChange : null,
    consecutive,
    count: dropped.length,
    path: first.path,
    reason: first.reason,
    paint,
    part: null,
  }
}

function ledgerClause(outcome: DropOutcome): string {
  return outcome.part === null ? '' : ` Mercury's prefix ledger names the part that moved: ${outcome.part}.`
}

export function describePrefixRewrite(part: string, path: string): string {
  return `Preserved thinking: Mercury rewrote already-sent history before this request — ${part} (${path}); the API reported no dropped block this turn. This is a Mercury defect, not the model's: run \`mercury doctor\` and paste its "Preserved thinking" row into a bug report at ${issuesUrl()}.`
}

function describePathTurn(path: string | null, turn: number | null): string {
  const match = path === null ? null : /^messages\.(\d+)\./.exec(path)
  if (match === null) return 'an earlier turn'
  if (turn !== null) return turn <= 1 ? 'the first turn' : `turn ${turn}`
  return Number(match[1]) <= 1 ? 'the first turn' : 'an earlier turn'
}

export function turnOrdinalOfWirePath(
  path: string | null,
  wireMessageIds: readonly (string | null)[],
  history: readonly Message[],
): number | null {
  const match = path === null ? null : /^messages\.(\d+)\./.exec(path)
  if (match === null) return null
  const messageId = wireMessageIds[Number(match[1])]
  if (typeof messageId !== 'string' || messageId.length === 0) return null
  let turns = 0
  for (const row of history) {
    if (row.type === 'user' && !isToolResultMessage(row) && (row as { isMeta?: boolean }).isMeta !== true) turns++
    if (row.type === 'assistant' && row.message.id === messageId) return turns
  }
  return null
}

function describePathClass(path: string | null): string {
  const match = path === null ? null : /^messages\.(\d+)\./.exec(path)
  if (match === null) return 'somewhere before the dropped block'
  const index = Number(match[1])
  if (index <= 1) return 'the first exchange changed: the top-level system prompt, the tools array or the first user turn'
  return `a turn before messages.${index} changed, or the system prompt or the tools array`
}

function issuesUrl(): string {
  const packaged = typeof MACRO !== 'undefined' && typeof MACRO.PACKAGE_URL === 'string' ? MACRO.PACKAGE_URL : ''
  const base = packaged.length > 0 ? packaged : `https://github.com/${PUBLIC_HOME_SLUG}`
  return `${base.replace(/\/$/, '')}/issues`
}

export function describeThinkingDrops(
  list: readonly InputTransformation[],
  outcome: DropOutcome,
  turn: number | null = null,
): string | null {
  if (outcome.kind === 'none' || !outcome.paint) return null
  const count = outcome.count
  const noun = count === 1 ? 'thinking block' : 'thinking blocks'
  const path = describePathTurn(outcome.path ?? null, turn)
  switch (outcome.kind) {
    case 'lawful':
      if (outcome.lawful === 'compaction') {
        return `Preserved thinking: the API dropped ${count} ${noun} after the compaction — the history before ${path} was folded into the summary, so the model re-plans without that reasoning this turn (expected once).`
      }
      if (outcome.lawful === 'roster-switch') {
        return `Preserved thinking: the API dropped ${count} ${noun} after the operator toggled ${outcome.rosterChange ?? 'a spawn switch'} — the tool roster changed with it, so the model re-plans without that reasoning this turn (expected once).`
      }
      if (outcome.lawful === 'operator-setting') {
        return `Preserved thinking: the API dropped ${count} ${noun} after you changed ${outcome.detail ?? 'a setting'} — the system prompt and the tool roster moved with it, so the model re-plans without that reasoning this turn (expected once).`
      }
      if (outcome.lawful === 'declared') {
        return `Preserved thinking: the API dropped ${count} ${noun} after ${outcome.detail ?? 'a change you asked for'} — the system prompt and the tool roster moved with it, so the model re-plans without that reasoning this turn (expected once).`
      }
      if (outcome.lawful === 'thinking-cleared') {
        return `Preserved thinking: the API dropped ${count} ${noun} — Mercury cleared reasoning older than the last turn after an hour idle (its own context edit), so the model re-plans without that earlier reasoning; later requests carry it no more (expected once).`
      }
      if (outcome.lawful === 'context-edited') {
        return `Preserved thinking: the API dropped ${count} ${noun} — Mercury pruned superseded tool results to fit the context window, and the reasoning bound to them was cleared with them, so the model re-plans without it; later requests carry it no more (expected once).`
      }
      if (outcome.reason === 'model_binding_mismatch') return describeInputTransformations(list)
      return `Preserved thinking: the API dropped ${count} ${noun} after the model switch — the history before ${path} moved with it; the model re-plans without that reasoning this turn (expected once).`
    case 'first':
      return `${describeInputTransformations(list) ?? ''}${ledgerClause(outcome)}`
    case 'recurrent':
      return null
  }
}


export function deadMarksFromDrops(
  list: readonly InputTransformation[],
  wireMessageIds: readonly (string | null)[],
  existing: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): DeadThinkingMark[] {
  const out: DeadThinkingMark[] = []
  for (const entry of list) {
    if (entry.type !== 'thinking_dropped') continue
    const match = /^messages\.(\d+)\.content\.(\d+)$/.exec(entry.path ?? '')
    if (match === null) continue
    const messageId = wireMessageIds[Number(match[1])]
    if (typeof messageId !== 'string' || messageId.length === 0) continue
    const sentIndex = Number(match[2])
    const dead = existing.get(messageId)
    let original = sentIndex
    if (dead !== undefined && dead.size > 0) {
      let seen = -1
      original = -1
      for (let index = 0; index < sentIndex + dead.size + 1; index++) {
        if (dead.has(index)) continue
        seen++
        if (seen === sentIndex) {
          original = index
          break
        }
      }
      if (original < 0) continue
    }
    if (!out.some(mark => mark.messageId === messageId && mark.blockIndex === original)) out.push({ messageId, blockIndex: original })
  }
  return out
}

export function deadThinkingMarks(messages: readonly Message[]): Map<string, Set<number>> {
  const marks = new Map<string, Set<number>>()
  for (const message of messages) {
    const dead =
      message.type === 'attachment' && (message.attachment as { type?: string }).type === 'dead_thinking'
        ? (message.attachment as { dead?: unknown }).dead
        : message.type === 'system' && (message as { subtype?: string }).subtype === 'thinking_dead'
          ? (message as { dead?: unknown }).dead
          : undefined
    if (!Array.isArray(dead)) continue
    for (const mark of dead) {
      const m = mark as { messageId?: unknown; blockIndex?: unknown }
      if (typeof m.messageId !== 'string' || typeof m.blockIndex !== 'number') continue
      let set = marks.get(m.messageId)
      if (set === undefined) {
        set = new Set<number>()
        marks.set(m.messageId, set)
      }
      set.add(m.blockIndex)
    }
  }
  return marks
}

export function createDeadThinkingAttachment(dead: DeadThinkingMark[]): AttachmentMessage {
  return createAttachmentMessage({ type: 'dead_thinking', dead })
}

const isThinkingContent = (block: unknown): boolean => {
  const type = (block as { type?: unknown } | null)?.type
  return type === 'thinking' || type === 'redacted_thinking'
}

export function stripDeadThinking<M extends Message>(messages: M[], marks: ReadonlyMap<string, ReadonlySet<number>>): M[] {
  if (marks.size === 0) return messages
  let changed = false
  const result = messages.map(msg => {
    if (msg.type !== 'assistant') return msg
    const indices = marks.get(msg.message.id)
    if (indices === undefined) return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg
    const filtered = content.filter((block, index) => !(indices.has(index) && isThinkingContent(block)))
    if (filtered.length === content.length) return msg
    changed = true
    if (filtered.length === 0) {
      filtered.push({ type: 'text' as const, text: DEAD_THINKING_PLACEHOLDER, citations: [] })
    }
    return { ...msg, message: { ...msg.message, content: filtered } } as typeof msg
  })
  return changed ? result : messages
}


export function isSameModel(a: string, b: string): boolean {
  return getCanonicalName(a) === getCanonicalName(b)
}

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


export interface ThinkingDropLedger {
  last: {
    at: string
    kind: Exclude<DropKind, 'none'> | 'rewrite'
    lawful: LawfulPrefixChange | null
    detail?: string | null
    reason: string | null
    path: string | null
    count: number
    consecutive: number
    model: string
    part?: string | null
  }
  longestRun: number
  session?: {
    id: string
    drops: number
    notice: string | null
  }
}

export function thinkingDropLedgerPath(): string {
  return join(getMercuryHome(), 'preserved-thinking.json')
}

function sessionRecord(
  previous: ThinkingDropLedger | null,
  sessionId: string,
  drops: number,
  notice: string | null,
): NonNullable<ThinkingDropLedger['session']> {
  const same = previous?.session?.id === sessionId ? previous.session : undefined
  return {
    id: sessionId,
    drops: (typeof same?.drops === 'number' ? same.drops : 0) + drops,
    notice: notice ?? (typeof same?.notice === 'string' ? same.notice : null),
  }
}

export function recordThinkingDropLedger(
  outcome: DropOutcome,
  model: string,
  notice: string | null = null,
  sessionId: string = getSessionId(),
): void {
  if (outcome.kind === 'none') return
  try {
    const previous = readThinkingDropLedger()
    if (outcome.part === null && outcome.kind === 'recurrent' && typeof previous?.last.part === 'string' && previous.last.kind !== 'lawful') {
      outcome.part = previous.last.part
    }
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
        ...(outcome.part !== null ? { part: outcome.part } : {}),
      },
      longestRun: Math.max(previous?.longestRun ?? 0, outcome.kind === 'lawful' ? 0 : outcome.consecutive),
      session: sessionRecord(previous, sessionId, 1, notice),
    }
    writeThinkingDropLedger(ledger)
  } catch (error) {
    logForDebugging(`preserved thinking: the doctor ledger could not be written (${String(error)})`, { level: 'warn' })
  }
}

export function recordPrefixRewriteLedger(
  part: string,
  path: string,
  model: string,
  notice: string | null = null,
  sessionId: string = getSessionId(),
): void {
  try {
    const previous = readThinkingDropLedger()
    writeThinkingDropLedger({
      last: { at: new Date().toISOString(), kind: 'rewrite', lawful: null, reason: null, path, count: 0, consecutive: 1, model, part },
      longestRun: Math.max(previous?.longestRun ?? 0, 1),
      session: sessionRecord(previous, sessionId, 0, notice),
    })
  } catch (error) {
    logForDebugging(`preserved thinking: the doctor ledger could not be written (${String(error)})`, { level: 'warn' })
  }
}

function writeThinkingDropLedger(ledger: ThinkingDropLedger): void {
  const path = thinkingDropLedgerPath()
  mkdirSync(dirname(path), { recursive: true })
  const staging = `${path}.${process.pid}.tmp`
  writeFileSync(staging, JSON.stringify(ledger, null, 2) + '\n')
  renameSync(staging, path)
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

function sessionClause(ledger: ThinkingDropLedger, sessionId: string): string {
  const session = ledger.session
  if (session === undefined || typeof session.id !== 'string' || typeof session.drops !== 'number') return ''
  const where = session.id === sessionId ? 'this session' : `in session ${session.id.slice(0, 8)}`
  const count = ` · ${session.drops} ${session.drops === 1 ? 'drop' : 'drops'} ${where}`
  const cause = typeof session.notice === 'string' && session.notice.length > 0 ? ` · last cause: ${session.notice}` : ''
  return `${count}${cause}`
}

export function preservedThinkingHealth(ledger: ThinkingDropLedger | null, sessionId: string = getSessionId()): {
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
  const named = typeof last.part === 'string' && last.part.length > 0 ? ` Mercury's prefix ledger named the part that moved: ${last.part}.` : ''
  const session = sessionClause(ledger, sessionId)
  if (last.kind === 'rewrite') {
    return {
      status: 'warn',
      evidence: `Mercury rewrote sent history at ${last.at} — ${last.part ?? 'an unnamed part'} (${last.path ?? 'unknown path'}, model ${last.model}); the API reported no dropped block on that response${session}`,
      detail: `Longest run on this machine: ${ledger.longestRun}.`,
      fix: `Paste this row into a bug report at ${issuesUrl()} (the bug template, with the output of mercury doctor --json).`,
    }
  }
  if (last.kind === 'lawful') {
    const cause =
      last.lawful === 'compaction'
        ? 'a compaction'
        : last.lawful === 'operator-setting'
          ? `a setting change (${last.detail ?? 'unnamed'})`
          : last.lawful === 'declared'
            ? `a change you asked for (${last.detail ?? 'unnamed'})`
            : last.lawful === 'roster-switch'
              ? "the operator's spawn-switch toggle"
              : last.lawful === 'thinking-cleared'
                ? "Mercury's idle-hour thinking clear (its own context edit)"
                : last.lawful === 'context-edited'
                  ? "Mercury's tool-result prune (its own context edit)"
                  : 'a model switch'
    return {
      status: 'info',
      evidence: `last drop ${last.at}: ${blocks} after ${cause} (${where}, model ${last.model}) — expected once${session}`,
    }
  }
  if (last.kind === 'first') {
    return {
      status: named.length > 0 ? 'warn' : 'info',
      evidence: `last drop ${last.at}: ${blocks} (${where}, model ${last.model}) — ${named.length > 0 ? `a rewrite of sent history.${named}` : "a single drop; a resumed session's first request or a client-side edit"}${session}`,
      detail: `Longest run of consecutive drops on this machine: ${ledger.longestRun}.`,
      ...(named.length > 0 ? { fix: `Paste this row into a bug report at ${issuesUrl()} (the bug template, with the output of mercury doctor --json).` } : {}),
    }
  }
  return {
    status: 'warn',
    evidence: `Mercury rewrote sent history on ${last.consecutive} consecutive requests — last ${last.at}: ${blocks} dropped, ${where}, model ${last.model}${named}${session}`,
    detail: `${describePathClass(last.path)}. Longest run on this machine: ${ledger.longestRun}.`,
    fix: `Paste this row into a bug report at ${issuesUrl()} (the bug template, with the output of mercury doctor --json).`,
  }
}
