import * as React from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getOriginalCwd, getProjectRoot, getSessionId } from '../bootstrap/state.js'
import { formatSessionCost } from '../cost-tracker.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../services/engine-connector/focusedConnector.js'
import { crewAgentsOf, crewStateLabel, crewTokensLabel, type CrewAgentFacts } from '../services/engine-connector/crewFacts.js'
import { workRowRuns } from '../services/engine-connector/workCounts.js'
import { projectWorkRoster } from '../utils/task/workRoster.js'
import { promptRows } from './prompts-panel/rows.js'
import { filterResumableSessions } from '../commands/resume/resume.js'
import { Box, Text } from '../ink.js'
import { TERRA } from './mercuryPalette.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { isTerminalTaskStatus, type TaskStatus } from '../Task.js'
import { useAppState } from '../state/AppState.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { isLocalAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { focusedSessionIdOrNull, useFocusedWorkRoster } from './tasks/useFocusedWork.js'
import { MAIN_CONVERSATION_ID } from '../services/crew/conversations.js'
import { isLocalShellTask } from '../tasks/LocalShellTask/guards.js'
import type { TaskState } from '../tasks/types.js'
import type { LogOption } from '../types/logs.js'
import { saturnWakeGlanceOf } from '../daemon/saturn.js'
import { readSessionWorkers } from '../daemon/concourseSupervisor.js'

function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = s / 60
  if (m < 90) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`
  return `${Math.round(h / 24)}d`
}
import { getActiveMission } from '../utils/hooks/missionHook.js'
import { isTabulaEnabled, tabulaProjectDir } from '../utils/tabula/tabulaGates.js'
import { readNotesAsync, type TabulaNote } from '../utils/tabula/tabulaStore.js'
import {
  getMinervaBuffer,
  getMinervaCursor,
  getMinervaLastExchange,
  getMinervaPending,
  getMinervaReplVersion,
  isMinervaComposing,
  minervaReplEnabled,
  subscribeMinervaRepl,
} from '../utils/cockpit/minervaRepl.js'
import { isProjectSession, isSubstantiveSession } from '../utils/sessionFilter.js'
import { isSessionCleared } from '../utils/sessionStorage/clearedSessions.js'
import { isCrewSession } from '../utils/sessionClass.js'
import { boardHomedSessionIds } from '../daemon/concourseSupervisor.js'
import { getSessionIdFromLog, loadAllProjectsMessageLogs } from '../utils/sessionStorage.js'
import { getHelmCursor, getHelmFocus, getHelmLanesVersion, getHelmRows, helmRowSig, publishHelmRows, requestCommandDispatch, requestHelmRowActivation, requestHelmRowActivationBySig, setHelmCursor, setHelmCursorBySig, subscribeHelmFocus, type HelmRow } from '../utils/cockpit/helmFocus.js'
import {
  getLivePresence,
  getOperatorName,
  getPresenceVersion,
  subscribePresence,
  type PresenceSeat,
} from '../utils/cockpit/presenceLive.js'
import { formatCountdown } from '../utils/cockpit/quota.js'
import { activeSourceUsage } from '../services/providers/providerUsage.js'
import { usageAgeTail } from '../services/providers/usageFreshness.js'
import {
  getLiveContextUsage,
  getLiveContextUsageVersion,
  subscribeLiveContextUsage,
} from '../utils/cockpit/contextUsageLive.js'
import { contextPercentLabel, contextWindowLabel } from '../utils/contextFill.js'
import { healthCertSnapshot } from '../utils/cockpit/healthCertSnapshot.js'
import { useNowTick } from './mercury-ui/components.js'
import { GLYPH, displayWidth, truncateToWidth } from './mercury-ui/glyphs.js'
import { ValueGlow, CURSOR_NUDGE_MS, AttentionPulse, WorkingGlyph } from './mercury-ui/LiveGlyphs.js'
import { RailPanel, railPanelInnerWidth } from './mercury-ui/RailPanel.js'
import { densityPlan, hintBudget, HELM_DENSITY_FLOOR } from '../utils/helmDensity.js'
import { useCockpitActivity } from '../utils/cockpit/cockpitActivity.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import type { MercuryThemeTokens } from '../utils/mercuryTokens.js'
import { tabLabel } from './mercury-ui/SessionTabs.js'
import { useTelemetry } from '../state/telemetryBus.js'
import { fluxMark, fluxWhy } from '../utils/flux/fluxProbe.js'
import { basename } from 'node:path'
import { getRunSnapshot, subscribeRuns } from '../services/run/runCoordinator.js'
import { isTerminalLifecycle } from '../services/run/runKernel.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import { isEnvDefinedFalsy } from '../utils/envUtils.js'
import { flagEnv } from '../substrate/flagRegistry.js'


type CrewRow = { id: string; label: string; status: TaskStatus; hosted?: boolean; facts?: CrewAgentFacts }

type CrewEntry =
  | { kind: 'task'; row: CrewRow }
  | { kind: 'daemon'; name: string; online: boolean; unread: number; model?: string }

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

type RunKind = 'shell' | 'monitor' | 'workflow' | 'cloud' | 'dream' | 'run'
type RunRow = { id: string; title: string; status: TaskStatus; kind: RunKind; startedAtMs: number }

function runKindOf(t: TaskState): RunKind {
  if (isLocalShellTask(t)) return t.kind === 'monitor' ? 'monitor' : 'shell'
  switch (t.type) {
    case 'local_workflow':
      return 'workflow'
    case 'remote_agent':
      return 'cloud'
    case 'monitor_mcp':
      return 'monitor'
    case 'dream':
      return 'dream'
    default:
      return 'run'
  }
}

function statusTone(status: TaskStatus, tok: MercuryThemeTokens): { label: string; tone: string } {
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

function RailRow({
  width,
  glyph,
  glyphColor,
  glyphLive = false,
  name,
  nameColor,
  verb,
  verbColor,
  verbPulse = false,
  selected = false,
  rowIndex,
  rowSig,
}: {
  width: number
  glyph: string
  glyphColor: string
  glyphLive?: boolean
  name: string
  nameColor: string
  verb?: string
  verbColor?: string
  verbPulse?: boolean
  selected?: boolean
  rowIndex?: number
  rowSig?: string
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const tok = useMercuryTokens()
  const indentW = 2
  const dotW = 2
  const sep = ' · '
  const sepW = verb ? displayWidth(sep) : 0
  const verbBudget = verb
    ? Math.min(12, Math.max(0, width - indentW - dotW - sepW - 4))
    : 0
  const verbT = verb ? truncateToWidth(verb, verbBudget) : ''
  const nameBudget = Math.max(
    3,
    width - indentW - dotW - (verbT ? sepW + displayWidth(verbT) : 0),
  )
  const nameT = truncateToWidth(name, nameBudget)

  const clickable = rowIndex != null
  return (
    <InteractiveRow
      id={`helm:lanes:${rowSig ?? rowIndex ?? 'static'}`}
      selected={selected}
      unavailable={!clickable}
      onSelect={
        clickable
          ? () => (rowSig ? setHelmCursorBySig('lanes', rowSig) : setHelmCursor('lanes', rowIndex))
          : undefined
      }
      onActivate={
        clickable
          ? () =>
              rowSig
                ? requestHelmRowActivationBySig('lanes', rowSig)
                : requestHelmRowActivation('lanes', rowIndex)
          : undefined
      }
      width={width}
    >
      <Text wrap="truncate-end">
        <Text color={accent}>{selected ? `${GLYPH.prompt} ` : '  '}</Text>
        {glyphLive ? (
          <WorkingGlyph color={glyphColor} active />
        ) : (
          <Text color={glyphColor}>{glyph}</Text>
        )}
        <Text> </Text>
        <Text color={nameColor}>{nameT}</Text>
        {verbT ? (
          <Text>
            <Text color={tok.textMuted}>{sep}</Text>
            {verbPulse ? (
              <AttentionPulse>{verbT}</AttentionPulse>
            ) : (
              <Text color={verbColor ?? tok.textMuted}>{verbT}</Text>
            )}
          </Text>
        ) : null}
      </Text>
    </InteractiveRow>
  )
}


function railRowProps(
  isOn: (i: number) => boolean,
  sel: (r: HelmRow) => number,
  row: HelmRow,
): { selected: boolean; rowIndex: number; rowSig: string } {
  const i = sel(row)
  return { selected: isOn(i), rowIndex: i, rowSig: helmRowSig(row) }
}

const lastKnownRecent = new Map<string, LogOption[]>()
let lastKnownWakeGlance: { count: number; nextFireMs: number | null } | null = null
const lastKnownTabulaOpenByDir = new Map<string, TabulaNote[]>()
const lastKnownWorkShape = new Map<string, string>()

const subscribeFocusedRecords = subscribeThroughFocused((c, l) => c.subscribeRecords(l))

function WorkbenchCardRow({
  width,
  lines,
  selected = false,
  rowIndex,
  rowSig,
}: {
  width: number
  lines: string[] | null
  selected?: boolean
  rowIndex?: number
  rowSig?: string
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const tok = useMercuryTokens()
  const clickable = rowIndex != null
  return (
    <InteractiveRow
      id={`helm:lanes:workbench:${rowSig ?? rowIndex ?? 'static'}`}
      selected={selected}
      unavailable={!clickable}
      onSelect={
        clickable
          ? () => (rowSig ? setHelmCursorBySig('lanes', rowSig) : setHelmCursor('lanes', rowIndex))
          : undefined
      }
      onActivate={
        clickable
          ? () =>
              rowSig
                ? requestHelmRowActivationBySig('lanes', rowSig)
                : requestHelmRowActivation('lanes', rowIndex)
          : undefined
      }
      width={width}
      flexDirection="column"
    >
      {lines === null ? (
        <Text wrap="truncate-end">
          <Text color={accent}>{selected ? `${GLYPH.prompt} ` : '  '}</Text>
          <Text color={tok.textMuted}>no prompts sent yet</Text>
        </Text>
      ) : (
        lines.map((l, i) => (
          <Text key={i} wrap="truncate-end">
            <Text color={accent}>{i === 0 && selected ? `${GLYPH.prompt} ` : '  '}</Text>
            <Text color={tok.textPrimary}>{l}</Text>
          </Text>
        ))
      )}
    </InteractiveRow>
  )
}

function MoreRow({
  n,
  width,
  selected = false,
  rowIndex,
  rowSig,
}: {
  n: number
  width: number
  selected?: boolean
  rowIndex?: number
  rowSig?: string
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const tok = useMercuryTokens()
  const clickable = rowIndex != null
  return (
    <InteractiveRow
      id={`helm:lanes:more:${rowSig ?? rowIndex ?? 'static'}`}
      selected={selected}
      unavailable={!clickable}
      onSelect={
        clickable
          ? () => (rowSig ? setHelmCursorBySig('lanes', rowSig) : setHelmCursor('lanes', rowIndex))
          : undefined
      }
      onActivate={
        clickable
          ? () =>
              rowSig
                ? requestHelmRowActivationBySig('lanes', rowSig)
                : requestHelmRowActivation('lanes', rowIndex)
          : undefined
      }
      width={width}
    >
      <Text wrap="truncate-end">
        <Text color={accent}>{selected ? `${GLYPH.prompt} ` : '  '}</Text>
        <Text color={tok.textMuted}>{`+${n} more`}</Text>
      </Text>
    </InteractiveRow>
  )
}

function SectionHeader({ label, width }: { label: string; width: number }): React.ReactNode {
  const { info, textMuted } = useMercuryTokens()
  const sep = label.indexOf(' · ')
  const name = sep >= 0 ? label.slice(0, sep) : label
  const tail = sep >= 0 ? label.slice(sep) : ''
  return (
    <Box width={width}>
      <Text wrap="truncate-end">
        <Text color={info} bold>
          {name}
        </Text>
        {tail ? <Text color={textMuted}>{tail}</Text> : null}
      </Text>
    </Box>
  )
}

const CREW_ROWS = 6
const PEER_ROWS = 4
const RUNS_ROWS = 4

export const HelmLanesRail = React.memo(HelmLanesRailImpl)

function HelmLanesRailImpl({ width, mergedTelemetry = false, availRows }: { width: number; mergedTelemetry?: boolean; availRows?: number }): React.ReactNode {
  fluxMark('render:rail-lanes')
  const tok = useMercuryTokens()
  const activity = useCockpitActivity()
  const presenceVersion = useSyncExternalStore(subscribePresence, getPresenceVersion, getPresenceVersion)
  const ctxUsageVersion = useSyncExternalStore(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion)
  const peers: PresenceSeat[] = getLivePresence()
  const lanesVersion = useSyncExternalStore(subscribeHelmFocus, getHelmLanesVersion, getHelmLanesVersion)
  const minervaVersion = useSyncExternalStore(subscribeMinervaRepl, getMinervaReplVersion, getMinervaReplVersion)
  const focused = getHelmFocus() === 'lanes'
  const cur = getHelmCursor('lanes')
  const { accent } = useSessionAccent()

  const focusedRecords = useSyncExternalStore(
    subscribeFocusedRecords,
    () => getFocusedSessionConnector().records(),
    () => getFocusedSessionConnector().records(),
  )
  const lastSentPrompt = React.useMemo(() => {
    const rows = promptRows(focusedRecords)
    return rows.length > 0 ? rows[rows.length - 1]! : null
  }, [focusedRecords])

  const workRunSnap = useSyncExternalStore(
    subscribeRuns,
    () => getRunSnapshot(processMainOwner()),
    () => null,
  )
  const planningObjective =
    workRunSnap &&
    workRunSnap.substantive &&
    !isTerminalLifecycle(workRunSnap.lifecycle) &&
    workRunSnap.deliverables.length >= 2 &&
    workRunSnap.deliverables.every(d => d.state !== 'done')
      ? workRunSnap.objective
      : null
  const [workShape, setWorkShape] = useState<string | null>(() =>
    planningObjective ? (lastKnownWorkShape.get(planningObjective) ?? null) : null,
  )
  useEffect(() => {
    if (!planningObjective) return
    let alive = true
    void import('../services/mission/projection.js')
      .then(async m => {
        const d = await m.gatherPolicyDecision(planningObjective, 0)
        if (alive && d) {
          if (lastKnownWorkShape.size > 8) lastKnownWorkShape.clear()
          lastKnownWorkShape.set(planningObjective, d.profile.id)
          setWorkShape(d.profile.id)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [planningObjective])

  const boxed = !mergedTelemetry
  const rowW = boxed ? railPanelInnerWidth(width) : width

  const tasks = useAppState(s => s.tasks)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const roster = useFocusedWorkRoster()

  const sessionId = focusedSessionIdOrNull()
  const localRows: CrewRow[] = crewAgentsOf(projectWorkRoster(tasks), sessionId).map(f => ({
    id: f.id,
    label: f.name,
    status: tasks[f.id]?.status ?? (f.status as TaskStatus),
    facts: f,
  }))
  const hostedRows: CrewRow[] = crewAgentsOf(roster.rows, sessionId)
    .filter(f => f.running)
    .map(f => ({ id: f.id, label: f.name, status: f.status === 'pending' ? 'pending' : 'running', hosted: true, facts: f }))
  const crewById = new Map<string, CrewRow>()
  for (const r of [...localRows, ...hostedRows]) {
    if (!crewById.has(r.id)) crewById.set(r.id, r)
  }
  const crewAll = [...crewById.values()].sort((a, b) => {
    const score = (c: CrewRow) =>
      (c.status === 'running' ? 0 : 2) + (c.id === viewingAgentTaskId ? -1 : 0)
    return score(a) - score(b)
  })
  const telemetry = useTelemetry()
  const railWhyRef = React.useRef<Record<string, unknown> | null>(null)
  fluxWhy('rail-lanes', railWhyRef, () => ({
    width,
    mergedTelemetry,
    availRows,
    tok,
    activity,
    presenceVersion,
    ctxUsageVersion,
    lanesVersion,
    minervaVersion,
    accent,
    focusedRecords,
    workRunSnap,
    workShape,
    tasks,
    roster,
    viewingAgentTaskId,
    telemetry,
  }))

  const daemonCrewRaw = telemetry.crew ?? []
  const daemonCrew = [...daemonCrewRaw].sort(
    (a, b) =>
      b.unread - a.unread ||
      Number(b.online) - Number(a.online) ||
      a.name.localeCompare(b.name),
  )

  const crewEntries: CrewEntry[] = [
    ...crewAll.map(row => ({ kind: 'task' as const, row })),
    ...daemonCrew.map(m => ({ kind: 'daemon' as const, ...m })),
  ]
  const crewShown = crewEntries.slice(0, CREW_ROWS)
  const crewMore = crewEntries.length - crewShown.length

  const localRuns: RunRow[] = Object.values(tasks)
    .filter(t => !isLocalAgentTask(t) && !isInProcessTeammateTask(t))
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
    .filter(row => !localRunIds.has(row.id) && row.kind !== 'agent' && row.kind !== 'teammate' && workRowRuns(row))
    .map(row => ({
      id: row.id,
      title: row.name,
      status: row.status === 'pending' ? 'pending' : 'running',
      kind: row.kind === 'workflow' ? 'workflow' : row.kind === 'monitor' ? 'monitor' : row.kind === 'dream' ? 'dream' : 'shell',
      startedAtMs: row.startTime,
    }))
  const runsAll: RunRow[] = [...localRuns, ...hostedRuns]
    .sort(
      (a, b) =>
        (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) ||
        a.startedAtMs - b.startedAtMs,
    )
  const runsShown = runsAll.slice(0, RUNS_ROWS)
  const runsMore = runsAll.length - runsShown.length
  const runsLive = runsAll.reduce((n, r) => n + (r.status === 'running' ? 1 : 0), 0)

  const ledger = telemetry.tasks
  const ledgerActive = ledger.filter(t => t.status === 'in_progress')
  const ledgerPending = ledger.filter(t => t.status === 'pending')
  const ledgerDone = ledger.filter(t => t.status === 'completed').length
  const ledgerOpen = ledgerActive.length + ledgerPending.length

  const work = (() => {
    if (isEnvDefinedFalsy(flagEnv('MERCURY_WORK_LANE'))) return null
    const snap = workRunSnap
    if (!snap || !snap.substantive) return null
    if (snap.lifecycle === 'cancelled') return null
    const w = Math.max(8, rowW - 2)
    const cont = Math.max(6, w - 2)
    const rows: Array<{ text: string; color: string }> = []
    const pushWrapped = (prefix: string, text: string, color: string, maxRows: number): void => {
      const parts = wrapRailRows(text, cont, maxRows)
      parts.forEach((p, i) =>
        rows.push({ text: i === 0 ? `${prefix}${p}` : `  ${p}`, color }),
      )
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
      pushWrapped('', 'plan: edit /tasks · steer by typing', tok.textMuted, 2)
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
    const isDepBlocked = (id: string): boolean =>
      (ledgerById.get(id)?.blockedBy ?? []).some(b => openIds.has(b))
    if (!terminal) {
      const queued = snap.deliverables.find(d => d.state === 'open' && !isDepBlocked(d.id))
      if (queued) pushWrapped(`${GLYPH.pending} `, queued.title || queued.id, tok.textSecondary, 2)
      const depBlocked = snap.deliverables.find(
        d => (d.state === 'open' || d.state === 'in-progress') && d.id !== active?.id && isDepBlocked(d.id),
      )
      if (depBlocked) pushWrapped(`${GLYPH.circledBullet} `, depBlocked.title || depBlocked.id, tok.warning, 2)
    }
    if (terminal && !snap.nextAction) {
      rows.push({ text: truncateToWidth('review: /diff', w), color: tok.success })
    }
    return { rows, doneCount, total: snap.deliverables.length, terminal }
  })()

  const workbenchRows: string[] | null = lastSentPrompt
    ? wrapRailRows(lastSentPrompt.text.replace(/\s+/g, ' ').trim(), Math.max(6, rowW - 2), 2)
    : null

  const solo =
    peers.length === 0 &&
    crewAll.length === 0 &&
    daemonCrew.length === 0 &&
    runsAll.length === 0 &&
    ledgerOpen === 0

  const recentScopeKey = `${getProjectRoot() || ''}::${getSessionId()}`
  const [recentSnap, setRecentSnap] = useState<{ key: string; rows: LogOption[] | null }>(
    () => ({ key: recentScopeKey, rows: lastKnownRecent.get(recentScopeKey) ?? null }),
  )
  if (recentSnap.key !== recentScopeKey) {
    setRecentSnap({ key: recentScopeKey, rows: lastKnownRecent.get(recentScopeKey) ?? null })
  }
  const recent = recentSnap.key === recentScopeKey ? recentSnap.rows : lastKnownRecent.get(recentScopeKey) ?? null
  useEffect(() => {
    if (!solo) return
    let alive = true
    void (async () => {
      try {
        const all = await loadAllProjectsMessageLogs()
        const boardHomed = boardHomedSessionIds()
        const resumable = filterResumableSessions(all, getSessionId())
          .filter(isSubstantiveSession)
          .filter(l => !boardHomed.has(getSessionIdFromLog(l) ?? ''))
          .filter(l => !isCrewSession(l))
          .filter(l => isProjectSession(l, getProjectRoot() || ''))
          .filter(l => !isSessionCleared(getSessionIdFromLog(l)))
        resumable.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
        if (alive) {
          const rows = resumable.slice(0, 3)
          lastKnownRecent.set(recentScopeKey, rows)
          setRecentSnap({ key: recentScopeKey, rows })
        }
      } catch {
        if (alive) setRecentSnap({ key: recentScopeKey, rows: [] })
      }
    })()
    return () => {
      alive = false
    }
  }, [solo, recentScopeKey])
  const mission = getActiveMission()

  const [wakeGlance, setWakeGlance] = useState<{ count: number; nextFireMs: number | null } | null>(
    () => lastKnownWakeGlance,
  )
  useEffect(() => {
    let alive = true
    const probe = () => {
      try {
        const records = Object.values(readSessionWorkers()).filter(r => r.endedAt === undefined)
        const s = saturnWakeGlanceOf(records, Date.now())
        const next = s.count > 0 ? s : null
        lastKnownWakeGlance = next
        if (alive) setWakeGlance(next)
      } catch {
        if (alive) setWakeGlance(null)
      }
    }
    probe()
    const t = setInterval(probe, 15_000)
    t.unref?.()
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const tabulaVersion = getHelmLanesVersion()
  const tabulaDir = tabulaProjectDir(getOriginalCwd())
  const [tabulaOpen, setTabulaOpen] = React.useState<TabulaNote[]>(() => lastKnownTabulaOpenByDir.get(tabulaDir) ?? [])
  React.useEffect(() => {
    if (!isTabulaEnabled()) return
    let alive = true
    setTabulaOpen(lastKnownTabulaOpenByDir.get(tabulaDir) ?? [])
    void readNotesAsync(tabulaDir)
      .then(r => {
        if (!alive) return
        const open = r.notes.filter(n => !n.done)
        lastKnownTabulaOpenByDir.set(tabulaDir, open)
        setTabulaOpen(open)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [tabulaVersion, tabulaDir])
  const selfName = getOperatorName()
  const peersShown = peers.slice(0, PEER_ROWS)
  const peersMore = peers.length - peersShown.length
  const minervaPendingEarly = getMinervaPending()
  const minervaComposingEarly = isMinervaComposing()
  const minervaLastExEarly = getMinervaLastExchange()

  const SECTION_CHROME = boxed ? 3 : 2
  const shedCeiling = availRows ?? Infinity
  const density = densityPlan(activity, availRows ?? Infinity)
  const hintCap = hintBudget(density)
  const intentTabula = !isTabulaEnabled()
    ? 0
    : (tabulaOpen.length === 0 ? 1 : Math.min(3, tabulaOpen.length) + (tabulaOpen.length > 3 ? 1 : 0)) +
      1 +
      (minervaLastExEarly && !minervaPendingEarly ? 1 : 0)
  const tasksIntent =
    Math.min(2, ledgerActive.length) + (ledgerActive.length > 2 ? 1 : 0) +
    Math.min(3, ledgerPending.length) + (ledgerPending.length > 3 ? 1 : 0)
  const seatGlanceRows = 1 + peersShown.length + (peersMore > 0 ? 1 : 0)
  const intents: Record<string, number> = {
    seat: 0,
    crew: solo ? 0 : Math.max(1, 1 + crewShown.length + (crewMore > 0 ? 1 : 0)),
    work: work ? work.rows.length : 0,
    tasks: work ? 0 : solo ? (ledger.length > 0 ? tasksIntent : 0) : Math.max(1, tasksIntent),
    runs: solo ? 0 : runsShown.length + (runsMore > 0 ? 1 : 0),
    recent: solo ? (recent == null ? 1 : recent.length) : 0,
    mission: solo && mission ? 1 : 0,
    tabula: intentTabula,
    workbench: workbenchRows ? workbenchRows.length : 1,
    next: solo ? Math.min(5 + (mission ? 0 : 1), hintCap) : 0,
    saturn: 0,
  }
  const sectionCost = (key: string): number => (intents[key] ?? 0) > 0 ? (intents[key] ?? 0) + SECTION_CHROME : 0
  const publishedRows = getHelmRows('lanes')
  const cursorLabel = publishedRows[getHelmCursor('lanes')]?.label ?? ''
  const cursorSection =
    cursorLabel.startsWith('crew') ? 'crew'
    : cursorLabel.startsWith('recent') ? 'recent'
    : cursorLabel.startsWith('tabula') ? 'tabula'
    : cursorLabel.startsWith('workbench') ? 'workbench'
    : cursorLabel.startsWith('hint') ? 'next'
    : null
  const shedSet = new Set<string>()
  {
    const mustKeep = new Set<string>([...HELM_DENSITY_FLOOR, ...density.keep])
    if (cursorSection) mustKeep.add(cursorSection)
    let spent =
      1 +
      (['seat', 'crew', 'work', 'tasks', 'runs', 'recent', 'mission', 'tabula', 'workbench', 'next'] as const)
        .reduce((n, k) => n + sectionCost(k), 0) +
      (seatGlanceRows + SECTION_CHROME) +
      (mergedTelemetry ? 4 + SECTION_CHROME : 0) +
      (wakeGlance ? 1 + SECTION_CHROME : 0)
    for (const k of density.shedOrder) {
      if (spent <= shedCeiling) break
      if (mustKeep.has(k) || sectionCost(k) === 0) continue
      shedSet.add(k)
      spent -= sectionCost(k)
    }
  }

  const rowsModel: HelmRow[] = []
  const sel = (row: HelmRow): number => {
    rowsModel.push(row)
    return rowsModel.length - 1
  }
  const isOn = (i: number): boolean => focused && cur === i


  const seatNodes: React.ReactNode[] = []
  seatNodes.push(
    <RailRow
      key="seat:self"
      width={rowW}
      glyph={GLYPH.done}
      glyphColor={tok.success}
      name={`${selfName} (you)`}
      nameColor={tok.textPrimary}
      verb="active"
      verbColor={tok.textSecondary}
    />,
  )
  for (const p of peersShown) {
    seatNodes.push(
      <RailRow
        key={`seat:${p.seat}`}
        width={rowW}
        glyph={GLYPH.done}
        glyphColor={tok.success}
        name={p.seat}
        nameColor={tok.textPrimary}
        verb={p.verb || undefined}
        verbColor={tok.textPrimary}
      />,
    )
  }
  if (peersMore > 0)
    seatNodes.push(
      <MoreRow
        key="seat:more"
        n={peersMore}
        width={rowW}
      />,
    )

  const viewingChild = viewingAgentTaskId != null
  const crewShed = shedSet.has('crew')
  const rootNode: React.ReactNode = crewShed ? null : (
    <RailRow
      key={`crewroot:${MAIN_CONVERSATION_ID}`}
      width={rowW}
      glyph={GLYPH.spark}
      glyphColor={viewingChild ? tok.textMuted : accent}
      name="Mercury"
      nameColor={viewingChild ? tok.textPrimary : accent}
      verb={viewingChild ? '‹ main' : 'lead'}
      verbColor={viewingChild ? accent : tok.textMuted}
      {...railRowProps(isOn, sel, { kind: 'main', label: 'crew:root' })}
    />
  )
  const crewChildNodes: React.ReactNode[] = crewShed ? [] : crewShown.map(entry => {
    if (entry.kind === 'daemon') {
      const unreadVerb = entry.unread > 0 ? `${entry.unread} new` : entry.online ? 'online' : 'offline'
      return (
        <RailRow
          key={`crewd:${entry.name}`}
          width={rowW}
          glyph={entry.online ? GLYPH.busy : GLYPH.idle}
          glyphColor={entry.online ? tok.success : tok.textMuted}
          name={`@${entry.name}`}
          nameColor={tok.textPrimary}
          verb={unreadVerb}
          verbColor={entry.unread > 0 ? tok.warning : entry.online ? tok.textSecondary : tok.textMuted}
          verbPulse={entry.unread > 0}
          {...railRowProps(isOn, sel, { kind: 'command', command: `/teammates ${entry.name}`, label: `crew:d:${entry.name}` })}
        />
      )
    }
    const c = entry.row
    const isViewing = viewingAgentTaskId != null && c.id === viewingAgentTaskId
    const base = statusTone(c.status, tok)
    const tokensVerb = c.status === 'running' && c.facts !== undefined ? crewTokensLabel(c.facts) : null
    const verbLabel = isViewing ? 'viewing' : (tokensVerb ?? (c.facts !== undefined ? crewStateLabel(c.facts) : base.label))
    const tone = isViewing ? accent : base.tone
    const g = c.status === 'running' ? GLYPH.busy : GLYPH.idle
    const gColor = isViewing ? accent : c.status === 'running' ? tok.success : tok.textMuted
    return (
      <RailRow
        key={`crew:${c.id}`}
        width={rowW}
        glyph={g}
        glyphColor={gColor}
        glyphLive={c.status === 'running'}
        name={c.label}
        nameColor={isViewing ? accent : tok.textPrimary}
        verb={verbLabel}
        verbColor={tone}
        {...railRowProps(
          isOn,
          sel,
          c.hosted
            ? { kind: 'command', command: `/tasks ${c.id}`, label: `crew:h:${c.id}` }
            : { kind: 'teammate', id: c.id, label: c.label },
        )}
      />
    )
  })
  const crewNodes: React.ReactNode[] = crewShed ? [] : [rootNode, ...crewChildNodes]
  if (crewMore > 0 && !crewShed)
    crewNodes.push(
      <MoreRow
        key="crew:more"
        n={crewMore}
        width={rowW}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/teammates', label: 'crew:more' })}
      />,
    )

  const workNodes: React.ReactNode[] = work
    ? work.rows.map((r, i) => (
        <Box key={`work:${i}`} width={rowW}>
          <Text color={r.color} wrap="truncate-end">
            {`  ${r.text}`}
          </Text>
        </Box>
      ))
    : []

  const MISSION_ACTIVE_ROWS = 2
  const MISSION_QUEUE_ROWS = 3
  const missionNodes: React.ReactNode[] = []
  for (const t of ledgerActive.slice(0, MISSION_ACTIVE_ROWS)) {
    missionNodes.push(
      <RailRow
        key={`mission:a:${t.id}`}
        width={rowW}
        glyph={GLYPH.busy}
        glyphColor={tok.success}
        glyphLive
        name={t.activeForm ?? t.subject}
        nameColor={tok.textPrimary}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/tasks', label: `mission:a:${t.id}` })}
      />,
    )
  }
  if (ledgerActive.length > MISSION_ACTIVE_ROWS) {
    missionNodes.push(
      <RailRow
        key="mission:a:more"
        width={rowW}
        glyph={GLYPH.dot}
        glyphColor={tok.textMuted}
        name={`+${ledgerActive.length - MISSION_ACTIVE_ROWS} also in progress`}
        nameColor={tok.textMuted}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/tasks', label: 'mission:a:more' })}
      />,
    )
  }
  for (const t of ledgerPending.slice(0, MISSION_QUEUE_ROWS)) {
    missionNodes.push(
      <RailRow
        key={`mission:q:${t.id}`}
        width={rowW}
        glyph={GLYPH.pending}
        glyphColor={tok.textMuted}
        name={t.subject}
        nameColor={tok.textSecondary}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/tasks', label: `mission:q:${t.id}` })}
      />,
    )
  }
  if (ledgerPending.length > MISSION_QUEUE_ROWS) {
    missionNodes.push(
      <RailRow
        key="mission:q:more"
        width={rowW}
        glyph={GLYPH.dot}
        glyphColor={tok.textMuted}
        name={`+${ledgerPending.length - MISSION_QUEUE_ROWS} queued`}
        nameColor={tok.textMuted}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/tasks', label: 'mission:q:more' })}
      />,
    )
  }

  const runNodes: React.ReactNode[] = runsShown.map(r => {
    const live = r.status === 'running'
    const verb = live && r.startedAtMs > 0 ? `${r.kind} ${formatSpan(Date.now() - r.startedAtMs)}` : r.kind
    return (
      <RailRow
        key={`run:${r.id}`}
        width={rowW}
        glyph={live ? GLYPH.busy : GLYPH.pending}
        glyphColor={live ? tok.success : tok.textMuted}
        glyphLive={live}
        name={r.title}
        nameColor={live ? tok.textPrimary : tok.textSecondary}
        verb={verb}
        verbColor={live ? tok.textSecondary : tok.textMuted}
        {...railRowProps(isOn, sel, {
          kind: 'command',
          command: `/tasks ${r.id}`,
          label: `run:${r.id}`,
        })}
      />
    )
  })
  if (runsMore > 0)
    runNodes.push(
      <MoreRow
        key="runs:more"
        n={runsMore}
        width={rowW}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/tasks', label: 'runs:more' })}
      />,
    )

  const soloNodes: React.ReactNode[] = []
  if (solo && !shedSet.has('recent')) {
    for (const log of recent ?? []) {
      const label = tabLabel(log)
      soloNodes.push(
        <RailRow
          key={`recent:${log.value}`}
          width={rowW}
          glyph={GLYPH.pending}
          glyphColor={tok.textMuted}
          name={label}
          nameColor={tok.textSecondary}
          selected={isOn(sel({ kind: 'command', command: '/sessions', label: `recent:${label}` }))}
        />,
      )
    }
    if (recent == null) {
      soloNodes.push(
        <Box key="recent:scanning" width={rowW}>
          <Text color={tok.textMuted} wrap="truncate-end">
            {'  scanning…'}
          </Text>
        </Box>,
      )
    }
  }
  const missionNode: React.ReactNode =
    solo && mission ? (
      <RailRow
        key="mission"
        width={rowW}
        glyph={GLYPH.mission}
        glyphColor={tok.success}
        name={mission ? mission.condition : ''}
        nameColor={tok.textPrimary}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/mission', label: 'mission' })}
      />
    ) : null
  const tabulaNodes: React.ReactNode[] = []
  if (isTabulaEnabled() && !shedSet.has('tabula')) {
    if (tabulaOpen.length === 0) {
      tabulaNodes.push(
        <RailRow
          key="tabula:empty"
          width={rowW}
          glyph={GLYPH.sparkFaint}
          glyphColor={tok.textMuted}
          name="no notes — /note"
          nameColor={tok.textMuted}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/tabula', label: 'tabula:empty' })}
        />,
      )
    }
    for (const n of tabulaOpen.slice(0, 3)) {
      tabulaNodes.push(
        <RailRow
          key={`tabula:${n.id}`}
          width={rowW}
          glyph={n.firedAt ? GLYPH.busy : n.pri === 'now' ? GLYPH.spark : GLYPH.sparkFaint}
          glyphColor={n.firedAt ? tok.success : n.pri === 'now' ? tok.warning : tok.textMuted}
          name={n.refinedText ?? n.text}
          nameColor={tok.textPrimary}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/tabula', label: `tabula:${n.id}` })}
        />,
      )
    }
    if (tabulaOpen.length > 3) {
      tabulaNodes.push(
        <RailRow
          key="tabula:more"
          width={rowW}
          glyph={GLYPH.dot}
          glyphColor={tok.textMuted}
          name={`+${tabulaOpen.length - 3} more`}
          nameColor={tok.textMuted}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/tabula', label: 'tabula:more' })}
        />,
      )
    }
    const minervaPending = minervaPendingEarly
    if (minervaPending) {
      tabulaNodes.push(
        <RailRow
          key="tabula:ask"
          width={rowW}
          glyph={GLYPH.busy}
          glyphColor={tok.success}
          glyphLive
          name={`minerva · ${Math.max(1, Math.round((Date.now() - minervaPending.startedAt) / 1000))}s`}
          nameColor={tok.textSecondary}
          {...railRowProps(isOn, sel, { kind: 'minerva', label: 'tabula:ask' })}
        />,
      )
    } else if (minervaComposingEarly) {
      const askIdx = sel({ kind: 'minerva', label: 'tabula:ask' })
      const buf = getMinervaBuffer()
      const at = getMinervaCursor()
      tabulaNodes.push(
        <Box key="tabula:ask" width={rowW}>
          {}
          <Text wrap="truncate-start">
            <Text color={accent}>{isOn(askIdx) ? `${GLYPH.prompt} ` : '  '}</Text>
            <Text color={tok.textPrimary}>{buf.slice(0, at)}</Text>
            <Text color={accent}>{GLYPH.caretBlock}</Text>
            <Text color={tok.textPrimary}>{buf.slice(at)}</Text>
          </Text>
        </Box>,
      )
    } else {
      tabulaNodes.push(
        <RailRow
          key="tabula:ask"
          width={rowW}
          glyph={GLYPH.prompt}
          glyphColor={TERRA}
          name="ask minerva"
          nameColor={tok.textMuted}
          {...railRowProps(isOn, sel, { kind: 'minerva', label: 'tabula:ask' })}
        />,
      )
    }
    const lastEx = minervaLastExEarly
    if (lastEx && !minervaPending) {
      tabulaNodes.push(
        <Box key="tabula:receipt" width={rowW}>
          <Text wrap="truncate-end">
            <Text>{'  '}</Text>
            {lastEx.error ? (
              <Text color={tok.failure}>{`${GLYPH.fail} ${lastEx.error}`}</Text>
            ) : (
              <>
                <Text color={tok.textSecondary}>{`${GLYPH.sparkBright} ${lastEx.reply ?? ''}`}</Text>
                {(lastEx.counts?.refined ?? 0) > 0 ? (
                  <Text color={tok.accent}>{' · /workbench MINERVA sends it'}</Text>
                ) : null}
              </>
            )}
          </Text>
        </Box>,
      )
    }
  }
  const workbenchNodes: React.ReactNode[] = []
  if (!shedSet.has('workbench')) {
    workbenchNodes.push(
      <WorkbenchCardRow
        key="workbench:last"
        width={rowW}
        lines={workbenchRows}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/workbench', label: 'workbench:last' })}
      />,
    )
  }
  const hintNodes: React.ReactNode[] = []
  if (solo && !shedSet.has('next')) {
    const hints: Array<{ command: string; label: string }> = [
      { command: '/workflows', label: '/workflows — agent runs' },
      { command: '/health', label: '/health — health cert' },
      { command: '/cards', label: '/cards — memory' },
    ]
    if (!mission) hints.push({ command: '/mission', label: '/mission — set a mission' })
    for (const h of hints.slice(0, hintCap)) {
      hintNodes.push(
        <RailRow
          key={`hint:${h.command}`}
          width={rowW}
          glyph={GLYPH.dot}
          glyphColor={tok.textMuted}
          name={h.label}
          nameColor={tok.textMuted}
          selected={isOn(sel({ kind: 'command', command: h.command, label: `hint:${h.command}` }))}
        />,
      )
    }
  }


  const wakeBody = wakeGlance ? (
    <RailRow
      width={rowW}
      glyph={GLYPH.inProgress}
      glyphColor={tok.success}
      name={`${wakeGlance.count} scheduled`}
      nameColor={tok.textSecondary}
      verb={
        wakeGlance.nextFireMs === null
          ? 'no next fire'
          : wakeGlance.nextFireMs <= Date.now()
            ? 'due now'
            : `in ${formatSpan(wakeGlance.nextFireMs - Date.now())}`
      }
      verbColor={tok.textMuted}
      {...railRowProps(isOn, sel, { kind: 'command', command: '/saturn', label: 'wake:glance' })}
    />
  ) : null

  useNowTick(
    getMinervaPending() ? 1_000 : mergedTelemetry || runsLive > 0 ? 15_000 : null,
  )
  let glanceSection: React.ReactNode = null
  if (mergedTelemetry) {
    const glanceUsage = activeSourceUsage()
    const lead = glanceUsage.windows.find(w => w.state === 'live' && w.usedPct != null)
    const focusedUsage = getFocusedSessionConnector().usage()
    const focusedSpendUSD = focusedUsage.totalCostUSD
    const focusedUnpriced = focusedUsage.unpricedTurns ?? 0
    const leadAge = lead !== undefined ? usageAgeTail(lead, Date.now()) : undefined
    const usageLabel =
      lead !== undefined
        ? `${lead.label} ${Math.round(lead.usedPct!)}%${
            lead.resetsAtMs != null ? ` · ${formatCountdown(lead.resetsAtMs - Date.now())}` : ''
          }${leadAge !== undefined ? ` · ${leadAge}` : ''}`
        : glanceUsage.shape === 'api-spend'
          ? `spend ${
              focusedUnpriced > 0
                ? formatSessionCost(focusedSpendUSD, focusedUnpriced)
                : focusedSpendUSD > 0
                  ? `$${focusedSpendUSD.toFixed(2)}`
                  : '—'
            }`
          : 'usage — after first reply'
    const ctxLive = getLiveContextUsage()
    const ctxLabel = `ctx ${contextPercentLabel(ctxLive.usedPct, ctxLive.fillSource)} · ${contextWindowLabel(ctxLive.window, ctxLive.windowSource)}`
    const chip = healthCertSnapshot().data
    const verdictUp = chip.verdict != null ? String(chip.verdict).toUpperCase() : null
    const healthLabel =
      chip.verdict != null
        ? `${String(chip.verdict).toLowerCase()}${chip.ageMs != null ? ` · ${formatCountdown(chip.ageMs)} old` : ''}`
        : 'health — run /health'
    const healthTone =
      verdictUp === 'FAULT' ? tok.failure : verdictUp === 'CAUTION' ? tok.warning : tok.textSecondary
    glanceSection = (
      <Box flexDirection="column" flexShrink={0}>
        <Box marginTop={1}>
          <SectionHeader label="TELEMETRY" width={rowW} />
        </Box>
        <RailRow
          width={rowW}
          glyph={GLYPH.dot}
          glyphColor={tok.textMuted}
          name={usageLabel}
          nameColor={tok.textSecondary}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/deck', label: 'tel:usage' })}
        />
        <RailRow
          width={rowW}
          glyph={GLYPH.dot}
          glyphColor={tok.textMuted}
          name={ctxLabel}
          nameColor={tok.textSecondary}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/deck', label: 'tel:ctx' })}
        />
        <RailRow
          width={rowW}
          glyph={verdictUp === 'FAULT' ? GLYPH.fail : verdictUp === 'CAUTION' ? GLYPH.warn : GLYPH.dot}
          glyphColor={healthTone === tok.textSecondary ? tok.textMuted : healthTone}
          name={healthLabel}
          nameColor={healthTone}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/health', label: 'tel:health' })}
        />
      </Box>
    )
  }

  const totalPeers = peers.length
  const peerWord = totalPeers === 1 ? 'peer' : 'peers'
  const crewWord = crewEntries.length === 1 ? 'agent' : 'agents'

  const rowsSig = rowsModel.map(helmRowSig).join('|')
  useEffect(() => {
    publishHelmRows('lanes', rowsModel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsSig])

  const section = (
    key: string,
    glyph: string,
    label: string,
    count: string | undefined,
    body: React.ReactNode,
    opts?: { first?: boolean; open?: string },
  ): React.ReactNode => {
    const open = opts?.open
    return boxed ? (
      <RailPanel
        key={key}
        glyph={glyph}
        label={label}
        count={count}
        width={width}
        headerAction={open ? { id: `helm:lane:${key}`, run: () => requestCommandDispatch(open) } : undefined}
      >
        {body}
      </RailPanel>
    ) : (
      <Box key={key} flexDirection="column" flexShrink={0}>
        <Box marginTop={opts?.first ? 0 : 1}>
          <SectionHeader label={count ? `${label} · ${count}` : label} width={rowW} />
        </Box>
        {body}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      {
}
      <Box width={width} height={1} flexShrink={0}>
        <Text wrap="truncate-end">
          {
}
          <ValueGlow value={focused} color={focused ? accent : tok.textMuted} ms={CURSOR_NUDGE_MS}>
            {focused ? <Text bold>{`${GLYPH.prompt} `}</Text> : '  '}
          </ValueGlow>
          {!focused ? (
            <Text color={tok.textMuted}>{'lanes'}</Text>
          ) : isMinervaComposing() ? (
            <>
              <Text color={accent} bold>{'minerva'}</Text>
              <Text color={tok.textMuted}>{getMinervaPending() ? ' · esc abort' : ' · ↵ send · esc · ^u'}</Text>
            </>
          ) : (
            <>
              <Text color={accent} bold>{'lanes'}</Text>
              <Text color={tok.textMuted}>{' · ↑↓ ↵ tab esc'}</Text>
            </>
          )}
        </Text>
      </Box>

      {}
      {section('seat', GLYPH.ownHybrid, 'SEAT', `${totalPeers} ${peerWord}`, seatNodes, {
        first: true,
      })}

      {solo ? (
        <>
          {
}
          {work
            ? section(
                'work',
                work.terminal ? GLYPH.done : GLYPH.busy,
                'WORK',
                work.total > 0 ? `${work.doneCount}/${work.total}` : undefined,
                workNodes,
                { open: '/workbench' },
              )
            : null}

          {
}
          {!work && ledger.length > 0
            ? section('tasks', GLYPH.mission, 'TASKS', `${ledgerDone}/${ledger.length}`, missionNodes, { open: '/tasks' })
            : null}

          {}
          {soloNodes.length > 0 ? section('recent', GLYPH.read, 'RECENT', undefined, soloNodes, { open: '/sessions' }) : null}

          {}
          {missionNode ? section('mission', GLYPH.mission, 'MISSION', undefined, missionNode, { open: '/mission' }) : null}

          {
}
          {tabulaNodes.length > 0
            ? section('tabula', GLYPH.leaseHeld, 'MINERVA', String(tabulaOpen.length), tabulaNodes, { open: '/tabula' })
            : null}

          {
}
          {workbenchNodes.length > 0
            ? section('workbench', GLYPH.prompt, 'WORKBENCH', undefined, workbenchNodes, { open: '/workbench' })
            : null}

          {}
          {hintNodes.length > 0 ? section('next', GLYPH.cursor, 'NEXT', undefined, hintNodes, { open: '/help' }) : null}
        </>
      ) : (
        <>
          {
}
          {shedSet.has('crew') || crewEntries.length === 0 ? null : section(
            'crew',
            GLYPH.fisheye,
            'CREW',
            `${crewEntries.length} ${crewWord}`,
            crewNodes,
            { open: '/teammates' },
          )}

          {
}
          {work
            ? section(
                'work',
                work.terminal ? GLYPH.done : GLYPH.busy,
                'WORK',
                work.total > 0 ? `${work.doneCount}/${work.total}` : undefined,
                workNodes,
                { open: '/workbench' },
              )
            : null}

          {
}
          {work ? null : section(
            'tasks',
            GLYPH.mission,
            'TASKS',
            ledger.length > 0 ? `${ledgerDone}/${ledger.length}` : undefined,
            missionNodes.length === 0 ? (
              <Box width={rowW}>
                <Text color={tok.textMuted} wrap="truncate-end">
                  {'  no open tasks'}
                </Text>
              </Box>
            ) : (
              missionNodes
            ),
            { open: '/tasks' },
          )}

          {
}
          {runsShown.length > 0
            ? section('runs', GLYPH.turns, 'RUNS', `${runsLive} live`, runNodes, { open: '/tasks' })
            : null}

          {
}
          {tabulaNodes.length > 0
            ? section('tabula', GLYPH.leaseHeld, 'MINERVA', String(tabulaOpen.length), tabulaNodes, { open: '/tabula' })
            : null}

          {
}
          {workbenchNodes.length > 0
            ? section('workbench', GLYPH.prompt, 'WORKBENCH', undefined, workbenchNodes, { open: '/workbench' })
            : null}

        </>
      )}

      {
}
      {wakeGlance ? section('saturn', GLYPH.inProgress, 'SATURN', undefined, wakeBody, { open: '/saturn' }) : null}

      {
}
      {mergedTelemetry ? glanceSection : null}

      {
}
      {shedSet.size > 0 ? (
        <Box width={width} height={1} flexShrink={0}>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>
              {'  more: ' +
                [...shedSet]
                  .map(k => (k === 'next' ? '/help' : k === 'recent' ? '/sessions' : `/${k}`))
                  .join(' · ')}
            </Text>
          </Text>
        </Box>
      ) : null}

      {
}
    </Box>
  )
}
