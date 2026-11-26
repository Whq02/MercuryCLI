import { basename } from 'node:path'
import type { TaskStatus } from '../../engine/tasks/taskBase.js'
import { isTerminalTaskStatus } from '../../engine/tasks/taskBase.js'
import type { TaskState } from '../../engine/tasks/taskState.js'
import { isCrewmateTask } from '../../engine/tasks/local-agent/crewmateTask.js'
import { isLocalShellTask } from '../../engine/tasks/local-shell/shellTaskState.js'
import type { WorkRosterV1 } from '../../engine/connector/types.js'
import { workRowRuns } from '../../engine/connector/workCounts.js'
import type { CrewLedgerRow } from '../app-state/crewLedger.js'
import { isTerminalLifecycle, type RunSnapshot } from '../../engine/run/runKernel.js'
import { getHelmCursorSig, getHelmRows, helmRowSig, type HelmRow } from '../cockpit/helmFocus.js'
import { densityPlan, hintBudget, HELM_DENSITY_FLOOR, type DensityPlan } from '../fullscreen-layout/helmDensity.js'
import { GLYPH, displayWidth, truncateToWidth } from '../theme/glyphs.js'
import { lerpHex } from '../theme/theme.js'
import { railPanelInnerWidth } from '../widgets/RailPanel.js'
import type { MercuryThemeTokens } from '../theme/mercuryTokens.js'
import { crewSection, workSection, runsSection, recentSection, missionSection, workbenchSection, nextSection, filesSection, saturnSection, glanceSection } from './helm-lanes-model/sections.js'
import type { CrewEntry, CrewRow, LanesInput, LanesSectionSpec, RunKind, RunRow, WorkDigest, WorkLedgerRow } from './helm-lanes-model/types.js'

export { recentLaneLabel } from './helm-lanes-model/sections.js'
export type { LanesInput, LanesRowSpec, LanesSectionSpec } from './helm-lanes-model/types.js'

const CREW_ROWS = 6
const RUNS_ROWS = 4

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


const POINTER_SEP_WORD = /^[—–·-]$/

function truncatePointerLine(line: string, budget: number): string {
  if (displayWidth(line) <= budget) return line
  const words = line.split(' ')
  for (let keep = words.length - 1; keep >= 1; keep--) {
    if (POINTER_SEP_WORD.test(words[keep - 1]!)) continue
    const kept = words.slice(0, keep).join(' ')
    if (displayWidth(kept) < budget) return `${kept}…`
  }
  return truncateToWidth(line, budget)
}

export function fitPointerRows(text: string, width: number, maxRows: number): string[] {
  const cap = Math.max(1, maxRows)
  if (displayWidth(text) <= width || cap === 1) return [truncatePointerLine(text, width)]
  const parts = text.split(' · ')
  if (parts.length <= 1) return [truncatePointerLine(text, width)]
  const lines: string[] = [parts[0]!]
  for (let i = 1; i < parts.length; i++) {
    const cur = lines[lines.length - 1]!
    const joined = `${cur} · ${parts[i]!}`
    if (displayWidth(joined) <= width) {
      lines[lines.length - 1] = joined
    } else if (lines.length < cap) {
      lines.push(`    · ${parts[i]!}`)
    } else {
      lines[lines.length - 1] = truncatePointerLine(joined, width)
      return lines.map(line => truncatePointerLine(line, width))
    }
  }
  return lines.map(line => truncatePointerLine(line, width))
}

function runKindOf(t: TaskState): RunKind {
  if (isLocalShellTask(t)) return t.kind === 'monitor' ? 'monitor' : 'shell'
  return t.type === 'monitor_mcp' ? 'monitor' : 'run'
}

function crewRowsOf(sessionCrew: readonly CrewLedgerRow[]): CrewRow[] {
  return sessionCrew.map(row => ({
    id: row.facts.id,
    label: row.facts.name,
    status: row.facts.status as TaskStatus,
    ...(row.hosted ? { hosted: true } : {}),
    facts: row.facts,
  }))
}

function orderCrew(crewRows: readonly CrewRow[], keptIds: readonly string[]): CrewRow[] {
  const crewAll = [...crewRows].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1))
  const keptBeyondCap = crewAll.filter((c, i) => i >= CREW_ROWS && keptIds.includes(c.id))
  if (keptBeyondCap.length === 0) return crewAll
  const rest = crewAll.filter(c => !keptBeyondCap.includes(c))
  rest.splice(Math.max(0, CREW_ROWS - keptBeyondCap.length), 0, ...keptBeyondCap)
  return rest
}

function runsOf(tasks: Record<string, TaskState>, roster: Pick<WorkRosterV1, 'rows'>): RunRow[] {
  const localRuns: RunRow[] = Object.values(tasks)
    .filter(t => !isCrewmateTask(t))
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
    .filter(row => !localRunIds.has(row.id) && (row.kind === 'shell' || row.kind === 'monitor') && workRowRuns(row))
    .map(row => ({
      id: row.id,
      title: row.name,
      status: row.status === 'pending' ? 'pending' : 'running',
      kind: row.kind === 'monitor' ? 'monitor' : 'shell',
      startedAtMs: row.startTime,
    }))
  return [...localRuns, ...hostedRuns].sort(
    (a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || a.startedAtMs - b.startedAtMs,
  )
}

function planningObjectiveOf(snap: RunSnapshot | null): string | null {
  return snap &&
    snap.substantive &&
    !isTerminalLifecycle(snap.lifecycle) &&
    snap.deliverables.length >= 2 &&
    snap.deliverables.every(d => d.state !== 'done')
    ? snap.objective
    : null
}

function workDigestOf(
  snap: RunSnapshot | null,
  ledger: readonly WorkLedgerRow[],
  rowW: number,
  planningObjective: string | null,
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

type LanesModel = {
  boxed: boolean
  rowW: number
  solo: boolean
  density: DensityPlan
  sections: LanesSectionSpec[]
  shed: string[]
  paintedRows: number
  pointer: string | null
  rows: HelmRow[]
  runsLive: number
}

export function soloOf(input: Pick<LanesInput, 'sessionCrew' | 'viewingCrewmateTaskId' | 'mainChatTaskId' | 'tasks' | 'roster'>): boolean {
  const keptIds = [input.viewingCrewmateTaskId, input.mainChatTaskId].filter((id): id is string => id != null)
  return input.sessionCrew.length === 0 && keptIds.length === 0 && runsOf(input.tasks, input.roster).length === 0
}

function cursorSectionOf(sections: readonly LanesSectionSpec[], cursorRow: HelmRow | undefined): string | null {
  const sig = cursorRow !== undefined ? helmRowSig(cursorRow) : getHelmRows('lanes').length === 0 ? getHelmCursorSig('lanes') : ''
  if (!sig) return null
  for (const s of sections) {
    for (const r of s.rows) {
      if (r.kind !== 'text' && r.row !== undefined && helmRowSig(r.row) === sig) return s.key
    }
  }
  return null
}

function shedCommandOf(key: string): string {
  if (key === 'next') return '/help'
  if (key === 'recent') return '/sessions'
  if (key === 'work') return '/workbench'
  if (key === 'files') return '/browse'
  if (key === 'mission') return '/goal'
  if (key === 'saturn') return '/schedule'
  return `/${key}`
}

function shedPointerOf(shed: readonly string[]): string {
  return '  more: ' + [...new Set(shed.map(shedCommandOf))].join(' · ')
}

export function buildLanesModel(input: LanesInput): LanesModel {
  const { tok, accent, nowMs } = input
  const boxed = !input.mergedVitals
  const rowW = boxed ? railPanelInnerWidth(input.width) : input.width

  const keptIds = [input.viewingCrewmateTaskId, input.mainChatTaskId].filter((id): id is string => id != null)
  const crewAll = orderCrew(crewRowsOf(input.sessionCrew), keptIds)
  const crewEntries: CrewEntry[] = crewAll.map(row => ({ kind: 'task' as const, row }))
  const crewShown = crewEntries.slice(0, CREW_ROWS)
  const crewMore = crewEntries.length - crewShown.length

  const runsAll = runsOf(input.tasks, input.roster)
  const runsShown = runsAll.slice(0, RUNS_ROWS)
  const runsMore = runsAll.length - runsShown.length
  const runsLive = runsAll.reduce((n, r) => n + (r.status === 'running' ? 1 : 0), 0)

  const planningObjective = planningObjectiveOf(input.workRunSnap)
  const work = workDigestOf(input.workRunSnap, input.ledger, rowW, planningObjective, tok)

  const workbenchRows: string[] | null = input.lastSentPrompt !== null
    ? wrapRailRows(input.lastSentPrompt.replace(/\s+/g, ' ').trim(), Math.max(6, rowW - 2), 2)
    : null

  const solo = soloOf(input)
  const mission = input.missionCondition
  const density = densityPlan(input.activity, input.availRows ?? Infinity)
  const hintCap = hintBudget(density)

  const viewingChild = input.viewingCrewmateTaskId != null
  const mainChatTint = lerpHex(tok.success, tok.surface1, 0.78)

  const facts = { input, tok, accent, nowMs, keptIds, crewEntries, crewShown, crewMore, runsShown, runsMore, runsLive, work, workbenchRows, solo, mission, hintCap, viewingChild, mainChatTint }

  const ordered: Array<LanesSectionSpec | null> = solo
    ? [workSection(facts), recentSection(facts), missionSection(facts), workbenchSection(facts), nextSection(facts), filesSection(facts), saturnSection(facts), glanceSection(facts)]
    : [crewSection(facts), workSection(facts), runsSection(facts), workbenchSection(facts), filesSection(facts), saturnSection(facts), glanceSection(facts)]
  const built = ordered.filter((s): s is LanesSectionSpec => s !== null)

  const chrome = boxed ? 3 : 2
  const costOf = (s: LanesSectionSpec): number => s.rows.reduce((n, r) => n + (r.kind === 'card' ? (r.lines ? r.lines.length : 1) : 1), 0) + chrome
  const shedCeiling = input.availRows ?? Infinity
  const cursorSection = cursorSectionOf(built, input.cursorRow)
  const mustKeep = new Set<string>([...HELM_DENSITY_FLOOR, ...density.keep])
  if (cursorSection) mustKeep.add(cursorSection)
  const shedSet = new Set<string>()
  let spent = built.reduce((n, s) => n + costOf(s), 0)
  for (const k of density.shedOrder) {
    if (spent <= shedCeiling) break
    const s = built.find(x => x.key === k)
    if (mustKeep.has(k) || s === undefined) continue
    shedSet.add(k)
    spent -= costOf(s)
  }
  const sections = built.filter(s => !shedSet.has(s.key))
  let paintedRows = 0
  if (boxed) {
    const firstClipped = sections.findIndex(section => {
      const cost = costOf(section)
      if (paintedRows + cost > shedCeiling) return true
      paintedRows += cost
      return false
    })
    if (firstClipped >= 0) {
      for (const dropped of sections.splice(firstClipped)) shedSet.add(dropped.key)
    }
  }
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
    paintedRows,
    pointer: shed.length > 0 && (!boxed || paintedRows < shedCeiling) ? shedPointerOf(shed) : null,
    rows,
    runsLive,
  }
}
