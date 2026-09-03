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
import { SPAWN_SWITCH_LABEL } from '../../switchboard/spawnSwitches.js'
import { consumeLawfulPrefixChange } from '../lawfulPrefixChange.js'

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


export type LawfulPrefixChange = 'compaction' | 'model-switch' | 'operator-setting' | 'declared' | 'roster-switch'

export interface PrefixMark {
  firstRow: string | null
  compactBoundary: string | null
  modelTransition: string | null
  rosterTransition: string | null
  rosterChange: string | null
  model: string
  settings: string
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
  return { firstRow, compactBoundary, modelTransition, rosterTransition, rosterChange, model, settings: spellOperatorSettings(live) }
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
}

interface OwnerDropState {
  mark: PrefixMark
  kind: DropKind
  consecutive: number
  defectNoticed: boolean
}

const dropStates = new Map<string, OwnerDropState>()

export function resetThinkingDropStates(): void {
  dropStates.clear()
}

export function classifyThinkingDrops(
  owner: string,
  list: readonly InputTransformation[],
  mark: PrefixMark,
): DropOutcome {
  const dropped = list.filter(entry => entry.type === 'thinking_dropped')
  const previous = dropStates.get(owner)
  const declared = consumeLawfulPrefixChange(owner)
  if (dropped.length === 0) {
    dropStates.set(owner, { mark, kind: 'none', consecutive: 0, defectNoticed: previous?.defectNoticed ?? false })
    return { kind: 'none', lawful: null, detail: null, rosterChange: null, consecutive: 0, count: 0, path: null, reason: null, paint: false }
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
  const defectNoticed = previous?.defectNoticed ?? false
  const paint = kind !== 'recurrent' || !defectNoticed
  dropStates.set(owner, { mark, kind, consecutive, defectNoticed: defectNoticed || kind === 'recurrent' })
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
  }
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
  const base = packaged.length > 0 ? packaged : 'https://github.com/Whq02/PreRelease'
  return `${base.replace(/\/$/, '')}/issues`
}

export function describeThinkingDrops(
  list: readonly InputTransformation[],
  outcome: DropOutcome,
): string | null {
  if (outcome.kind === 'none' || !outcome.paint) return null
  const count = outcome.count
  const noun = count === 1 ? 'thinking block' : 'thinking blocks'
  const path = outcome.path ?? 'an earlier turn'
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
      if (outcome.reason === 'model_binding_mismatch') return describeInputTransformations(list)
      return `Preserved thinking: the API dropped ${count} ${noun} after the model switch — the history before ${path} moved with it; the model re-plans without that reasoning this turn (expected once).`
    case 'first':
      return describeInputTransformations(list)
    case 'recurrent':
      return `Preserved thinking: the API dropped ${count} ${noun} again — Mercury rewrote already-sent history before ${path} at an earlier request with no compaction, model switch or transcript edit to explain it (${describePathClass(outcome.path)}); every thinking block after that point keeps dropping on each request until the conversation compacts. This row paints once. This is a Mercury defect, not the model's: run \`mercury doctor\` and paste its "Preserved thinking" row into a bug report at ${issuesUrl()}.`
  }
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
    kind: Exclude<DropKind, 'none'>
    lawful: LawfulPrefixChange | null
    detail?: string | null
    reason: string | null
    path: string | null
    count: number
    consecutive: number
    model: string
  }
  longestRun: number
}

export function thinkingDropLedgerPath(): string {
  return join(getMercuryHome(), 'preserved-thinking.json')
}

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
          : last.lawful === 'declared'
            ? `a change you asked for (${last.detail ?? 'unnamed'})`
            : last.lawful === 'roster-switch'
              ? "the operator's spawn-switch toggle"
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
