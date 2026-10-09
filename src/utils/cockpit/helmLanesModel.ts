import { basename } from 'node:path'
import type { TaskStatus } from '../../Task.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { TaskState } from '../../tasks/types.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import type { SessionListing } from '../../types/logs.js'
import type { WorkRosterV1 } from '../../services/engine-connector/types.js'
import { crewSettled, crewStateLabel, crewTokensLabel, type CrewAgentFacts } from '../../services/engine-connector/crewFacts.js'
import { workRowRuns } from '../../services/engine-connector/workCounts.js'
import type { CrewLedgerRow } from '../../state/crewLedger.js'
import { isTerminalLifecycle, type RunSnapshot } from '../../services/run/runKernel.js'
import type { ActiveSourceUsage } from '../../services/providers/providerUsage.js'
import { usageAgeTail } from '../../services/providers/usageFreshness.js'
import { formatSessionCost } from '../../cost-tracker.js'
import { contextPercentLabel, contextWindowLabel } from '../contextFill.js'
import type { LiveContextUsage } from './contextUsageLive.js'
import type { ComposedCertChip } from '../healthCertCore.js'
import { formatCountdown } from './quota.js'
import { saturnWakeGlanceWords, type SaturnWakeGlanceV1 } from '../../daemon/saturn.js'
import { helmRowSig, type HelmRow } from './helmFocus.js'
import { densityPlan, hintBudget, HELM_DENSITY_FLOOR, type DensityPlan } from '../helmDensity.js'
import type { ActivityState } from './cockpitActivity.js'
import { GLYPH, displayWidth, truncateToWidth } from '../../components/mercury-ui/glyphs.js'
import { getLogDisplayTitle } from '../log.js'
import { lerpHex } from '../theme.js'
import { LEAD_ROW_NAME } from './crewmateWords.js'
import { railPanelInnerWidth } from '../../components/mercury-ui/RailPanel.js'
import type { MercuryThemeTokens } from '../mercuryTokens.js'

export const CREW_ROWS = 6
export const RUNS_ROWS = 4

export function recentLaneLabel(log: SessionListing): string {
  const cleaned = Array.from(getLogDisplayTitle(log, 'untitled'), ch => (ch.charCodeAt(0) < 0x20 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'untitled'
}

export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = s / 60
  if (m < 90) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`
  return `${Math.round(h / 24)}d`
}

export function wrapRailRows(text: string, width: number, maxRows: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const rows: string[] = []
  let line = ''
  const push = (row: string): boolean => {
    rows.push(row)
    if (rows.length === maxRows) {
      rows[maxRows - 1] = truncateToWidth(`${rows[maxRows - 1]!}…`, width)
      return true
    }
    return false
  }
  for (const w of words) {
    const candidate = line === '' ? w : `${line} ${w}`
    if (displayWidth(candidate) <= width) {
      line = candidate
      continue
    }
    if (line !== '' && push(line)) return rows
    if (displayWidth(w) <= width) {
      line = w
      continue
    }
    if (push(truncateToWidth(w, width))) return rows
    line = ''
  }
  if (line !== '') rows.push(line)
  return rows.slice(0, maxRows)
}

export type RunKind = 'shell' | 'monitor' | 'workflow' | 'cloud' | 'run'
export type RunRow = { id: string; title: string; status: TaskStatus; kind: RunKind; startedAtMs: number }

export function runKindOf(t: TaskState): RunKind {
  if (isLocalShellTask(t)) return t.kind === 'monitor' ? 'monitor' : 'shell'
  switch (t.type) {
    case 'local_workflow':
      return 'workflow'
    case 'remote_agent':
      return 'cloud'
    case 'monitor_mcp':
      return 'monitor'
    default:
      return 'run'
  }
}

export function statusTone(status: TaskStatus, tok: MercuryThemeTokens): { label: string; tone: string } {
  switch (status) {
    case 'running':
      return { label: 'running', tone: tok.success }
    case 'pending':
      return { label: 'pending', tone: tok.textSecondary }
    case 'completed':
      return { label: 'done', tone: tok.textMuted }
    case 'failed':
      return { label: 'failed', tone: tok.failure }
    case 'killed':
      return { label: 'killed', tone: tok.failure }
    default:
      return { label: status, tone: tok.textMuted }
  }
}

export type CrewRow = { id: string; label: string; status: TaskStatus; hosted?: boolean; facts?: CrewAgentFacts }
export type CrewEntry = { kind: 'task'; row: CrewRow }

export function crewRowsOf(sessionCrew: readonly CrewLedgerRow[]): CrewRow[] {
  return sessionCrew.map(row => ({
    id: row.facts.id,
    label: row.facts.name,
    status: row.facts.status as TaskStatus,
    ...(row.hosted ? { hosted: true } : {}),
    facts: row.facts,
  }))
}

export function orderCrew(crewRows: readonly CrewRow[], keptIds: readonly string[]): CrewRow[] {
  const crewAll = [...crewRows].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1))
  const keptBeyondCap = crewAll.filter((c, i) => i >= CREW_ROWS && keptIds.includes(c.id))
  if (keptBeyondCap.length === 0) return crewAll
  const rest = crewAll.filter(c => !keptBeyondCap.includes(c))
  rest.splice(Math.max(0, CREW_ROWS - keptBeyondCap.length), 0, ...keptBeyondCap)
  return rest
}

export function runsOf(tasks: Record<string, TaskState>, roster: Pick<WorkRosterV1, 'rows'>): RunRow[] {
  const localRuns: RunRow[] = Object.values(tasks)
    .filter(t => !isLocalAgentTask(t))
    .filter(t => !isTerminalTaskStatus(t.status))
    .map(t => ({
      id: t.id,
      title: t.description || (isLocalShellTask(t) ? t.command : t.type),
      status: t.status,
      kind: runKindOf(t),
      startedAtMs: t.startTime,
    }))
  const localRunIds = new Set(localRuns.map(r => r.id))
  const hostedRuns: RunRow[] = roster.rows
    .filter(row => !localRunIds.has(row.id) && row.kind !== 'agent' && workRowRuns(row))
    .map(row => ({
      id: row.id,
      title: row.name,
      status: row.status === 'pending' ? 'pending' : 'running',
      kind: row.kind === 'workflow' ? 'workflow' : row.kind === 'monitor' ? 'monitor' : 'shell',
      startedAtMs: row.startTime,
    }))
  return [...localRuns, ...hostedRuns].sort(
    (a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || a.startedAtMs - b.startedAtMs,
  )
}

export function planningObjectiveOf(snap: RunSnapshot | null): string | null {
  return snap &&
    snap.substantive &&
    !isTerminalLifecycle(snap.lifecycle) &&
    snap.deliverables.length >= 2 &&
    snap.deliverables.every(d => d.state !== 'done')
    ? snap.objective
    : null
}

export type WorkLedgerRow = { id: string; status: string; blockedBy?: readonly string[] }
export type WorkDigest = { rows: Array<{ text: string; color: string }>; doneCount: number; total: number; terminal: boolean }

export function workDigestOf(
  snap: RunSnapshot | null,
  ledger: readonly WorkLedgerRow[],
  rowW: number,
  planningObjective: string | null,
  workShape: string | null,
  tok: MercuryThemeTokens,
): WorkDigest | null {
  if (!snap || !snap.substantive) return null
  if (snap.lifecycle === 'cancelled') return null
  const w = Math.max(8, rowW - 2)
  const cont = Math.max(6, w - 2)
  const rows: Array<{ text: string; color: string }> = []
  const pushWrapped = (prefix: string, text: string, color: string, maxRows: number): void => {
    const parts = wrapRailRows(text, cont, maxRows)
    parts.forEach((p, i) => rows.push({ text: i === 0 ? `${prefix}${p}` : `  ${p}`, color }))
  }
  pushWrapped('', snap.objective, tok.textPrimary, 3)
  const doneCount = snap.deliverables.filter(d => d.state === 'done').length
  const terminal = snap.lifecycle === 'completed'
  const statusBits = [terminal ? 'done' : snap.phase]
  if (snap.deliverables.length > 0) statusBits.push(`${doneCount}/${snap.deliverables.length}`)
  if (snap.unresolvedBadEffects > 0) statusBits.push(`${snap.unresolvedBadEffects}!`)
  rows.push({ text: truncateToWidth(statusBits.join(' · '), w), color: tok.textSecondary })
  if (planningObjective !== null && snap.objective === planningObjective) {
    if (workShape) rows.push({ text: truncateToWidth(`via ${workShape}`, w), color: tok.textSecondary })
    pushWrapped('', 'plan: edit /runs · steer by typing', tok.textMuted, 2)
  }
  const active = snap.deliverables.find(d => d.state === 'in-progress')
  if (active && !terminal) pushWrapped(`${GLYPH.busy} `, active.title || active.id, tok.success, 2)
  if (snap.blocker) {
    pushWrapped(`${GLYPH.circledBullet} `, `${snap.blocker.ownedBy}: ${snap.blocker.description}`, tok.warning, 2)
  } else if (snap.nextAction) {
    pushWrapped('→ ', snap.nextAction, tok.success, 3)
  }
  const vState = snap.verification.state
  const vColor = vState === 'verified' ? tok.success : vState === 'failed' ? tok.failure : tok.warning
  if (snap.changedPaths.length > 0) {
    const first = basename(snap.changedPaths[0]!)
    const extra = snap.totalChangedPaths - 1
    rows.push({ text: truncateToWidth(`± ${first}${extra > 0 ? ` +${extra}` : ''}`, w), color: tok.textSecondary })
    rows.push({ text: truncateToWidth(`checks: ${vState}`, w), color: vColor })
  } else if (terminal || snap.verification.state !== 'unverified') {
    rows.push({ text: truncateToWidth(`checks: ${vState}`, w), color: vColor })
  }
  const ledgerById = new Map(ledger.map(t => [t.id, t]))
  const openIds = new Set(ledger.filter(t => t.status !== 'completed').map(t => t.id))
  const isDepBlocked = (id: string): boolean => (ledgerById.get(id)?.blockedBy ?? []).some(b => openIds.has(b))
  if (!terminal) {
    const queued = snap.deliverables.find(d => d.state === 'open' && !isDepBlocked(d.id))
    if (queued) pushWrapped(`${GLYPH.pending} `, queued.title || queued.id, tok.textSecondary, 2)
    const depBlocked = snap.deliverables.find(
      d => (d.state === 'open' || d.state === 'in-progress') && d.id !== active?.id && isDepBlocked(d.id),
    )
    if (depBlocked) pushWrapped(`${GLYPH.circledBullet} `, depBlocked.title || depBlocked.id, tok.warning, 2)
  }
  if (terminal && !snap.nextAction) rows.push({ text: truncateToWidth('review: /diff', w), color: tok.success })
  return { rows, doneCount, total: snap.deliverables.length, terminal }
}

export type GlanceReads = {
  usage: ActiveSourceUsage
  focusedSpendUSD: number
  focusedUnpriced: number
  ctx: LiveContextUsage
  chip: ComposedCertChip
  nowMs: number
}

export function glanceLabelsOf(reads: GlanceReads, tok: MercuryThemeTokens): {
  usage: string
  ctx: string
  health: string
  healthTone: string
  healthGlyph: string
} {
  const { usage, focusedSpendUSD, focusedUnpriced, ctx, chip, nowMs } = reads
  const lead = usage.windows.find(w => w.state === 'live' && w.usedPct != null)
  const leadAge = lead !== undefined ? usageAgeTail(lead, nowMs) : undefined
  const usageLabel =
    lead !== undefined
      ? `${lead.label} ${Math.round(lead.usedPct!)}%${lead.resetsAtMs != null ? ` · ${formatCountdown(lead.resetsAtMs - nowMs)}` : ''}${leadAge !== undefined ? ` · ${leadAge}` : ''}`
      : usage.shape === 'api-spend'
        ? `spend ${focusedUnpriced > 0 ? formatSessionCost(focusedSpendUSD, focusedUnpriced) : focusedSpendUSD > 0 ? `$${focusedSpendUSD.toFixed(2)}` : '—'}`
        : 'usage — after first reply'
  const ctxLabel = `ctx ${contextPercentLabel(ctx.usedPct, ctx.fillSource)} · ${contextWindowLabel(ctx.window, ctx.windowSource, ctx.windowPinned)}`
  const verdictUp = chip.verdict != null ? String(chip.verdict).toUpperCase() : null
  const healthLabel =
    chip.verdict != null
      ? `${String(chip.verdict).toLowerCase()}${chip.ageMs != null ? ` · ${formatCountdown(chip.ageMs)} old` : ''}`
      : 'health — run /health'
  const healthTone = verdictUp === 'FAULT' ? tok.failure : verdictUp === 'CAUTION' ? tok.warning : tok.textSecondary
  const healthGlyph = verdictUp === 'FAULT' ? GLYPH.fail : verdictUp === 'CAUTION' ? GLYPH.warn : GLYPH.dot
  return { usage: usageLabel, ctx: ctxLabel, health: healthLabel, healthTone, healthGlyph }
}

export type LanesRowSpec =
  | {
      kind: 'rail'
      key: string
      glyph: string
      glyphColor: string
      glyphLive?: boolean
      name: string
      nameColor: string
      nameBold?: boolean
      verb?: string
      verbColor?: string
      verbPulse?: boolean
      marked?: boolean
      directActivate?: boolean
      tint?: string
      row?: HelmRow
    }
  | { kind: 'text'; key: string; text: string; color: string }
  | { kind: 'card'; key: string; lines: string[] | null; row: HelmRow }
  | { kind: 'more'; key: string; n: number; row: HelmRow }

export type LanesSectionSpec = {
  key: string
  glyph: string
  label: string
  count?: string
  open?: string | 'files'
  rows: LanesRowSpec[]
  marginAlways?: boolean
}

export type LanesInput = {
  width: number
  mergedVitals: boolean
  availRows: number | undefined
  activity: ActivityState
  cursorRow: HelmRow | undefined
  sessionCrew: readonly CrewLedgerRow[]
  viewingAgentTaskId: string | undefined
  mainChatTaskId: string | undefined
  tasks: Record<string, TaskState>
  roster: Pick<WorkRosterV1, 'rows'>
  workRunSnap: RunSnapshot | null
  workShape: string | null
  ledger: readonly WorkLedgerRow[]
  lastSentPrompt: string | null
  filesOff: boolean
  filesFolder: string
  recent: SessionListing[] | null
  missionCondition: string | null
  wakeGlance: SaturnWakeGlanceV1 | null
  glance: GlanceReads | null
  nowMs: number
  tok: MercuryThemeTokens
  accent: string
}

export type LanesModel = {
  boxed: boolean
  rowW: number
  solo: boolean
  density: DensityPlan
  sections: LanesSectionSpec[]
  shed: string[]
  pointer: string | null
  rows: HelmRow[]
  runsLive: number
}

export function soloOf(input: Pick<LanesInput, 'sessionCrew' | 'viewingAgentTaskId' | 'mainChatTaskId' | 'tasks' | 'roster'>): boolean {
  const keptIds = [input.viewingAgentTaskId, input.mainChatTaskId].filter((id): id is string => id != null)
  return input.sessionCrew.length === 0 && keptIds.length === 0 && runsOf(input.tasks, input.roster).length === 0
}

export function cursorSectionOf(sections: readonly LanesSectionSpec[], cursorRow: HelmRow | undefined): string | null {
  if (cursorRow === undefined) return null
  const sig = helmRowSig(cursorRow)
  for (const s of sections) {
    for (const r of s.rows) {
      if (r.kind !== 'text' && r.row !== undefined && helmRowSig(r.row) === sig) return s.key
    }
  }
  return null
}

export function shedPointerOf(shed: readonly string[]): string {
  return '  more: ' + shed.map(k => (k === 'next' ? '/help' : k === 'recent' ? '/sessions' : `/${k}`)).join(' · ')
}

export function buildLanesModel(input: LanesInput): LanesModel {
  const { tok, accent, nowMs } = input
  const boxed = !input.mergedVitals
  const rowW = boxed ? railPanelInnerWidth(input.width) : input.width

  const keptIds = [input.viewingAgentTaskId, input.mainChatTaskId].filter((id): id is string => id != null)
  const crewAll = orderCrew(crewRowsOf(input.sessionCrew), keptIds)
  const crewEntries: CrewEntry[] = crewAll.map(row => ({ kind: 'task' as const, row }))
  const crewShown = crewEntries.slice(0, CREW_ROWS)
  const crewMore = crewEntries.length - crewShown.length

  const runsAll = runsOf(input.tasks, input.roster)
  const runsShown = runsAll.slice(0, RUNS_ROWS)
  const runsMore = runsAll.length - runsShown.length
  const runsLive = runsAll.reduce((n, r) => n + (r.status === 'running' ? 1 : 0), 0)

  const planningObjective = planningObjectiveOf(input.workRunSnap)
  const work = workDigestOf(input.workRunSnap, input.ledger, rowW, planningObjective, input.workShape, tok)

  const workbenchRows: string[] | null = input.lastSentPrompt !== null
    ? wrapRailRows(input.lastSentPrompt.replace(/\s+/g, ' ').trim(), Math.max(6, rowW - 2), 2)
    : null

  const solo = soloOf(input)
  const mission = input.missionCondition
  const density = densityPlan(input.activity, input.availRows ?? Infinity)
  const hintCap = hintBudget(density)

  const viewingChild = input.viewingAgentTaskId != null
  const mainChatTint = lerpHex(tok.success, tok.surface1, 0.78)

  const crewSection = (): LanesSectionSpec | null => {
    if (solo) return null
    if (crewEntries.length === 0 && keptIds.length === 0) return null
    const rows: LanesRowSpec[] = []
    rows.push({
      kind: 'rail',
      key: 'crewroot',
      glyph: GLYPH.spark,
      glyphColor: viewingChild ? tok.textMuted : accent,
      name: LEAD_ROW_NAME,
      nameColor: viewingChild ? tok.textPrimary : accent,
      nameBold: true,
      marked: !viewingChild,
      directActivate: true,
      row: { kind: 'main', label: 'crew:root' },
    })
    for (const entry of crewShown) {
      const c = entry.row
      const isViewing = input.viewingAgentTaskId != null && c.id === input.viewingAgentTaskId
      const isMainChat = input.mainChatTaskId != null && c.id === input.mainChatTaskId
      const base = statusTone(c.status, tok)
      const finished = c.facts !== undefined ? crewSettled(c.facts) : c.status !== 'running' && c.status !== 'pending'
      const greyed = finished && c.facts?.state !== 'failed'
      const idle = c.facts?.state === 'idle'
      const live = c.status === 'running' && !idle
      const tokensVerb = live && c.facts !== undefined ? crewTokensLabel(c.facts) : null
      const verbLabel = tokensVerb ?? (c.facts !== undefined ? crewStateLabel(c.facts) : base.label)
      rows.push({
        kind: 'rail',
        key: `crew:${c.id}`,
        glyph: isMainChat ? GLYPH.star : isViewing ? GLYPH.circledBullet : live ? GLYPH.busy : GLYPH.idle,
        glyphColor: isMainChat ? tok.warning : isViewing ? accent : live ? tok.success : tok.textMuted,
        glyphLive: live && !isViewing && !isMainChat,
        name: c.label,
        nameColor: greyed ? tok.textMuted : tok.textPrimary,
        nameBold: isViewing || isMainChat,
        marked: isViewing,
        tint: isMainChat ? mainChatTint : isViewing ? tok.selection : undefined,
        directActivate: true,
        verb: verbLabel,
        verbColor: greyed ? tok.textMuted : base.tone,
        row: { kind: 'crewmate', id: c.id, label: c.hosted ? `crew:h:${c.id}` : c.label },
      })
    }
    if (crewMore > 0) rows.push({ kind: 'more', key: 'crew:more', n: crewMore, row: { kind: 'command', command: '/crewmates', label: 'crew:more' } })
    const crewWord = crewEntries.length === 1 ? 'agent' : 'agents'
    return { key: 'crew', glyph: GLYPH.fisheye, label: 'CREW', count: `${crewEntries.length} ${crewWord}`, open: '/crewmates', rows }
  }

  const workSection = (): LanesSectionSpec | null => {
    if (!work) return null
    return {
      key: 'work',
      glyph: work.terminal ? GLYPH.done : GLYPH.busy,
      label: 'WORK',
      count: work.total > 0 ? `${work.doneCount}/${work.total}` : undefined,
      open: '/workbench',
      rows: work.rows.map((r, i) => ({ kind: 'text', key: `work:${i}`, text: `  ${r.text}`, color: r.color })),
    }
  }

  const runsSection = (): LanesSectionSpec | null => {
    if (solo || runsShown.length === 0) return null
    const rows: LanesRowSpec[] = runsShown.map(r => {
      const live = r.status === 'running'
      const verb = live && r.startedAtMs > 0 ? `${r.kind} ${formatSpan(nowMs - r.startedAtMs)}` : r.kind
      return {
        kind: 'rail',
        key: `run:${r.id}`,
        glyph: live ? GLYPH.busy : GLYPH.pending,
        glyphColor: live ? tok.success : tok.textMuted,
        glyphLive: live,
        name: r.title,
        nameColor: live ? tok.textPrimary : tok.textSecondary,
        verb,
        verbColor: live ? tok.textSecondary : tok.textMuted,
        row: { kind: 'command', command: `/runs ${r.id}`, label: `run:${r.id}` },
      }
    })
    if (runsMore > 0) rows.push({ kind: 'more', key: 'runs:more', n: runsMore, row: { kind: 'command', command: '/runs', label: 'runs:more' } })
    return { key: 'runs', glyph: GLYPH.turns, label: 'RUNS', count: `${runsLive} live`, open: '/runs', rows }
  }

  const recentSection = (): LanesSectionSpec | null => {
    if (!solo) return null
    const rows: LanesRowSpec[] = []
    for (const log of input.recent ?? []) {
      const label = recentLaneLabel(log)
      rows.push({
        kind: 'rail',
        key: `recent:${log.value}`,
        glyph: GLYPH.pending,
        glyphColor: tok.textMuted,
        name: label,
        nameColor: tok.textSecondary,
        row: { kind: 'command', command: '/sessions', label: `recent:${label}` },
      })
    }
    if (input.recent == null) rows.push({ kind: 'text', key: 'recent:scanning', text: '  scanning…', color: tok.textMuted })
    if (rows.length === 0) return null
    return { key: 'recent', glyph: GLYPH.read, label: 'RECENT', open: '/sessions', rows }
  }

  const missionSection = (): LanesSectionSpec | null => {
    if (!solo || mission === null) return null
    return {
      key: 'mission',
      glyph: GLYPH.mission,
      label: 'MISSION',
      open: '/mission',
      rows: [
        {
          kind: 'rail',
          key: 'mission',
          glyph: GLYPH.mission,
          glyphColor: tok.success,
          name: mission,
          nameColor: tok.textPrimary,
          row: { kind: 'command', command: '/mission', label: 'mission' },
        },
      ],
    }
  }

  const workbenchSection = (): LanesSectionSpec => ({
    key: 'workbench',
    glyph: GLYPH.prompt,
    label: 'WORKBENCH',
    open: '/workbench',
    rows: [{ kind: 'card', key: 'workbench:last', lines: workbenchRows, row: { kind: 'command', command: '/workbench', label: 'workbench:last' } }],
  })

  const nextSection = (): LanesSectionSpec | null => {
    if (!solo) return null
    const hints: Array<{ command: string; label: string }> = [
      { command: '/workflows', label: '/workflows — agent runs' },
      { command: '/health', label: '/health — health cert' },
      { command: '/memory', label: '/memory — memory' },
    ]
    if (mission === null) hints.push({ command: '/mission', label: '/mission — set a mission' })
    const rows: LanesRowSpec[] = hints.slice(0, hintCap).map(h => ({
      kind: 'rail',
      key: `hint:${h.command}`,
      glyph: GLYPH.dot,
      glyphColor: tok.textMuted,
      name: h.label,
      nameColor: tok.textMuted,
      row: { kind: 'command', command: h.command, label: `hint:${h.command}` },
    }))
    if (rows.length === 0) return null
    return { key: 'next', glyph: GLYPH.cursor, label: 'NEXT', open: '/help', rows }
  }

  const filesSection = (): LanesSectionSpec | null => {
    if (input.filesOff) return null
    return {
      key: 'files',
      glyph: '▤',
      label: 'FILES',
      count: input.filesFolder,
      open: 'files',
      rows: [
        {
          kind: 'rail',
          key: 'files:browse',
          glyph: '↵',
          glyphColor: tok.textMuted,
          name: 'or click · browse',
          nameColor: tok.textMuted,
          row: { kind: 'files', label: 'files:browse' },
        },
      ],
    }
  }

  const saturnSection = (): LanesSectionSpec | null => {
    if (input.wakeGlance === null) return null
    const words = saturnWakeGlanceWords(input.wakeGlance, nowMs)
    return {
      key: 'saturn',
      glyph: GLYPH.inProgress,
      label: 'SATURN',
      open: '/saturn',
      rows: [
        {
          kind: 'rail',
          key: 'wake:glance',
          glyph: GLYPH.inProgress,
          glyphColor: tok.success,
          name: words.name,
          nameColor: tok.textSecondary,
          verb: words.verb,
          verbColor: tok.textMuted,
          row: { kind: 'command', command: '/saturn', label: 'wake:glance' },
        },
      ],
    }
  }

  const glanceSection = (): LanesSectionSpec | null => {
    if (!input.mergedVitals || input.glance === null) return null
    const labels = glanceLabelsOf(input.glance, tok)
    const muted = (name: string, label: string, command: string): LanesRowSpec => ({
      kind: 'rail',
      key: label,
      glyph: GLYPH.dot,
      glyphColor: tok.textMuted,
      name,
      nameColor: tok.textSecondary,
      row: { kind: 'command', command, label },
    })
    return {
      key: 'vitals',
      glyph: '',
      label: 'VITALS',
      marginAlways: true,
      rows: [
        muted(labels.usage, 'tel:usage', '/usage'),
        muted(labels.ctx, 'tel:ctx', '/context'),
        {
          kind: 'rail',
          key: 'tel:health',
          glyph: labels.healthGlyph,
          glyphColor: labels.healthTone === tok.textSecondary ? tok.textMuted : labels.healthTone,
          name: labels.health,
          nameColor: labels.healthTone,
          row: { kind: 'command', command: '/health', label: 'tel:health' },
        },
      ],
    }
  }

  const ordered: Array<LanesSectionSpec | null> = solo
    ? [workSection(), recentSection(), missionSection(), workbenchSection(), nextSection(), filesSection(), saturnSection(), glanceSection()]
    : [crewSection(), workSection(), runsSection(), workbenchSection(), filesSection(), saturnSection(), glanceSection()]
  const built = ordered.filter((s): s is LanesSectionSpec => s !== null)

  const chrome = boxed ? 3 : 2
  const costOf = (s: LanesSectionSpec): number => s.rows.reduce((n, r) => n + (r.kind === 'card' ? (r.lines ? r.lines.length : 1) : 1), 0) + chrome
  const shedCeiling = input.availRows ?? Infinity
  const cursorSection = cursorSectionOf(built, input.cursorRow)
  const mustKeep = new Set<string>([...HELM_DENSITY_FLOOR, ...density.keep])
  if (cursorSection) mustKeep.add(cursorSection)
  const shedSet = new Set<string>()
  let spent = 1 + built.reduce((n, s) => n + costOf(s), 0)
  for (const k of density.shedOrder) {
    if (spent <= shedCeiling) break
    const s = built.find(x => x.key === k)
    if (mustKeep.has(k) || s === undefined) continue
    shedSet.add(k)
    spent -= costOf(s)
  }
  const sections = built.filter(s => !shedSet.has(s.key))
  const rows: HelmRow[] = []
  for (const s of sections) for (const r of s.rows) if (r.kind !== 'text' && r.row !== undefined) rows.push(r.row)
  const shed = [...shedSet]
  return {
    boxed,
    rowW,
    solo,
    density,
    sections,
    shed,
    pointer: shed.length > 0 ? shedPointerOf(shed) : null,
    rows,
    runsLive,
  }
}
