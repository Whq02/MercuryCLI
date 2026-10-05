import * as React from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getProjectRoot } from '../bootstrap/state.js'
import { conversationIdHere, getFocusedSessionConnector, subscribeFocusedSessionConnector, subscribeThroughFocused } from '../services/engine-connector/focusedConnector.js'
import { promptRows } from './prompts-panel/rows.js'
import { filterResumableSessions } from '../commands/resume/resume.js'
import { Box, Text } from '../ink.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useAppState } from '../state/AppState.js'
import { useSessionCrew } from './tasks/useCrewLedger.js'
import { useFocusedWorkRoster } from './tasks/useFocusedWork.js'
import type { SessionListing } from '../types/logs.js'
import { saturnWakeGlanceOf, type SaturnWakeGlanceV1 } from '../daemon/saturn.js'
import { readSessionWorkers } from '../daemon/concourseWorkers.js'
import { getActiveMission, getActiveMissionVersion, subscribeActiveMission } from '../utils/hooks/missionHook.js'
import { isProjectSession, isSubstantiveSession } from '../utils/sessionFilter.js'
import { isSessionCleared } from '../utils/sessionStorage/clearedSessions.js'
import { isCrewSession } from '../utils/sessionClass.js'
import { boardHomedSessionIds } from '../daemon/concourseWorkers.js'
import { sessionIdOfListing, listSessionsAcrossProjects } from '../utils/sessionStorage.js'
import { getHelmCursor, getHelmFocus, getHelmLanesVersion, getHelmRows, helmRowSig, publishHelmRows, requestCommandDispatch, requestHelmRowActivation, requestHelmRowActivationBySig, setHelmCursor, setHelmCursorBySig, subscribeHelmFocus, type HelmRow } from '../utils/cockpit/helmFocus.js'
import { openFilesMenu } from '../utils/cockpit/filesMenu.js'
import { activeSourceUsage } from '../services/providers/providerUsage.js'
import { getLiveContextUsage, getLiveContextUsageVersion, subscribeLiveContextUsage } from '../utils/cockpit/contextUsageLive.js'
import { healthCertSnapshot } from '../utils/cockpit/healthCertSnapshot.js'
import { useNowTick } from './mercury-ui/components.js'
import { useProviderUsageOnShow } from '../hooks/useProviderUsageOnShow.js'
import { useFocusedWorkspaceCwd } from '../hooks/useFocusedWorkspaceCwd.js'
import { GLYPH, displayWidth, truncateToWidth } from './mercury-ui/glyphs.js'
import { ValueGlow, CURSOR_NUDGE_MS, AttentionPulse, WorkingGlyph } from './mercury-ui/LiveGlyphs.js'
import { RailPanel } from './mercury-ui/RailPanel.js'
import { useCockpitActivity } from '../utils/cockpit/cockpitActivity.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useTelemetry } from '../state/telemetryBus.js'
import { fluxMark, fluxWhy } from '../utils/flux/fluxProbe.js'
import { basename } from 'node:path'
import { getRunSnapshot, subscribeRuns } from '../services/run/runCoordinator.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import { isEnvDefinedFalsy } from '../utils/envUtils.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { buildLanesModel, planningObjectiveOf, soloOf, wrapRailRows, type LanesInput, type LanesRowSpec, type LanesSectionSpec } from '../utils/cockpit/helmLanesModel.js'

export { wrapRailRows }

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
  marked = false,
  nameBold = false,
  directActivate = false,
  tint,
  rowIndex,
  rowSig,
}: {
  width: number
  glyph: string
  glyphColor: string
  marked?: boolean
  nameBold?: boolean
  directActivate?: boolean
  tint?: string
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
      tint={tint}
      onSelect={
        clickable
          ? () => {
              if (rowSig) setHelmCursorBySig('lanes', rowSig)
              else setHelmCursor('lanes', rowIndex)
              if (directActivate) {
                if (rowSig) requestHelmRowActivationBySig('lanes', rowSig)
                else requestHelmRowActivation('lanes', rowIndex)
              }
            }
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
        <Text color={selected ? accent : tok.textSecondary}>{selected ? `${GLYPH.prompt} ` : marked ? `${GLYPH.chevronRight} ` : '  '}</Text>
        {glyphLive ? (
          <WorkingGlyph color={glyphColor} active />
        ) : (
          <Text color={glyphColor}>{glyph}</Text>
        )}
        <Text> </Text>
        <Text color={nameColor} bold={nameBold}>{nameT}</Text>
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

const lastKnownRecent = new Map<string, SessionListing[]>()
let lastKnownWakeGlance: SaturnWakeGlanceV1 | null = null
const lastKnownWorkShape = new Map<string, string>()

function useRecentSessions(solo: boolean): SessionListing[] | null {
  const conversationId = useSyncExternalStore(subscribeFocusedSessionConnector, conversationIdHere, conversationIdHere)
  const recentScopeKey = `${getProjectRoot() || ''}::${conversationId}`
  const [recentSnap, setRecentSnap] = useState<{ key: string; rows: SessionListing[] | null }>(() => ({
    key: recentScopeKey,
    rows: lastKnownRecent.get(recentScopeKey) ?? null,
  }))
  useEffect(() => {
    if (!solo) return
    let alive = true
    void (async () => {
      try {
        const all = await listSessionsAcrossProjects()
        const boardHomed = boardHomedSessionIds()
        const resumable = filterResumableSessions(all, conversationId)
          .filter(isSubstantiveSession)
          .filter(l => !boardHomed.has(sessionIdOfListing(l) ?? ''))
          .filter(l => !isCrewSession(l))
          .filter(l => isProjectSession(l, getProjectRoot() || ''))
          .filter(l => !isSessionCleared(sessionIdOfListing(l)))
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
  return recentSnap.key === recentScopeKey ? recentSnap.rows : lastKnownRecent.get(recentScopeKey) ?? null
}

function useWakeGlance(): SaturnWakeGlanceV1 | null {
  const [wakeGlance, setWakeGlance] = useState<SaturnWakeGlanceV1 | null>(() => lastKnownWakeGlance)
  useEffect(() => {
    let alive = true
    const probe = () => {
      try {
        const records = Object.values(readSessionWorkers()).filter(r => r.endedAt === undefined)
        const s = saturnWakeGlanceOf(records)
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
  return wakeGlance
}

function useWorkShape(planningObjective: string | null): string | null {
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
  return workShape
}

export const HelmLanesRail = React.memo(HelmLanesRailImpl)

function HelmLanesRailImpl({ width, mergedTelemetry = false, availRows }: { width: number; mergedTelemetry?: boolean; availRows?: number }): React.ReactNode {
  fluxMark('render:rail-lanes')
  const tok = useMercuryTokens()
  const { accent } = useSessionAccent()
  const activity = useCockpitActivity()
  const ctxUsageVersion = useSyncExternalStore(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion)
  const lanesVersion = useSyncExternalStore(subscribeHelmFocus, getHelmLanesVersion, getHelmLanesVersion)
  const missionVersion = useSyncExternalStore(subscribeActiveMission, getActiveMissionVersion, getActiveMissionVersion)
  const focused = getHelmFocus() === 'lanes'
  const cur = getHelmCursor('lanes')
  const focusedRecords = useSyncExternalStore(
    subscribeFocusedRecords,
    () => getFocusedSessionConnector().records(),
    () => getFocusedSessionConnector().records(),
  )
  const lastSentPrompt = React.useMemo(() => {
    const rows = promptRows(focusedRecords)
    return rows.length > 0 ? rows[rows.length - 1]!.text : null
  }, [focusedRecords])
  const workRunSnap = useSyncExternalStore(subscribeRuns, () => getRunSnapshot(processMainOwner()), () => null)
  const workLaneOff = isEnvDefinedFalsy(flagEnv('MERCURY_WORK_LANE'))
  const planningObjective = planningObjectiveOf(workRunSnap)
  const workShape = useWorkShape(planningObjective)
  const tasks = useAppState(s => s.tasks)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const mainChatTaskId = useAppState(s => s.mainChatTaskId)
  const roster = useFocusedWorkRoster()
  const sessionCrew = useSessionCrew()
  const telemetry = useTelemetry()
  const filesOff = useAppState(s => s.settings.view?.files === false)
  const filesFolder = basename(useFocusedWorkspaceCwd())
  const mission = getActiveMission()
  const wakeGlance = useWakeGlance()
  const daemonCrew = telemetry.crew ?? []
  const solo = soloOf({ sessionCrew, daemonCrew, viewingAgentTaskId, mainChatTaskId, tasks, roster })
  const recent = useRecentSessions(solo)
  const railWhyRef = React.useRef<Record<string, unknown> | null>(null)
  fluxWhy('rail-lanes', railWhyRef, () => ({
    width,
    mergedTelemetry,
    availRows,
    tok,
    activity,
    ctxUsageVersion,
    lanesVersion,
    missionVersion,
    accent,
    focusedRecords,
    workRunSnap,
    workShape,
    tasks,
    roster,
    viewingAgentTaskId,
    mainChatTaskId,
    telemetry,
  }))
  const nowMs = Date.now()
  const published = getHelmRows('lanes')
  const input: LanesInput = {
    width,
    mergedTelemetry,
    availRows,
    activity,
    cursorRow: published[getHelmCursor('lanes')],
    sessionCrew,
    daemonCrew,
    viewingAgentTaskId,
    mainChatTaskId,
    tasks,
    roster,
    workRunSnap: workLaneOff ? null : workRunSnap,
    workShape,
    ledger: telemetry.tasks,
    lastSentPrompt,
    filesOff,
    filesFolder,
    recent,
    missionCondition: mission ? mission.condition : null,
    wakeGlance,
    glance: mergedTelemetry
      ? (() => {
          const focusedUsage = getFocusedSessionConnector().usage()
          return {
            usage: activeSourceUsage(),
            focusedSpendUSD: focusedUsage.totalCostUSD,
            focusedUnpriced: focusedUsage.unpricedTurns ?? 0,
            ctx: getLiveContextUsage(),
            chip: healthCertSnapshot().data,
            nowMs,
          }
        })()
      : null,
    nowMs,
    tok,
    accent,
  }
  const model = buildLanesModel(input)
  useNowTick(mergedTelemetry || model.runsLive > 0 ? 15_000 : null)
  useProviderUsageOnShow(mergedTelemetry)

  const rowsSig = model.rows.map(helmRowSig).join('|')
  useEffect(() => {
    publishHelmRows('lanes', model.rows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsSig])

  const isOn = (i: number): boolean => focused && cur === i
  let index = 0
  const paintRow = (spec: LanesRowSpec): React.ReactNode => {
    if (spec.kind === 'text') {
      return (
        <Box key={spec.key} width={model.rowW}>
          <Text color={spec.color} wrap="truncate-end">
            {spec.text}
          </Text>
        </Box>
      )
    }
    const i = spec.row === undefined ? undefined : index++
    const selected = i === undefined ? false : isOn(i)
    const sig = spec.row === undefined ? undefined : helmRowSig(spec.row)
    if (spec.kind === 'card') return <WorkbenchCardRow key={spec.key} width={model.rowW} lines={spec.lines} selected={selected} rowIndex={i} rowSig={sig} />
    if (spec.kind === 'more') return <MoreRow key={spec.key} n={spec.n} width={model.rowW} selected={selected} rowIndex={i} rowSig={sig} />
    return (
      <RailRow
        key={spec.key}
        width={model.rowW}
        glyph={spec.glyph}
        glyphColor={spec.glyphColor}
        glyphLive={spec.glyphLive}
        name={spec.name}
        nameColor={spec.nameColor}
        nameBold={spec.nameBold}
        verb={spec.verb}
        verbColor={spec.verbColor}
        verbPulse={spec.verbPulse}
        marked={spec.marked}
        directActivate={spec.directActivate}
        tint={spec.tint}
        selected={selected}
        rowIndex={i}
        rowSig={sig}
      />
    )
  }
  let painted = 0
  const paintSection = (s: LanesSectionSpec): React.ReactNode => {
    const body = s.rows.map(paintRow)
    if (model.boxed) {
      const open = s.open
      return (
        <RailPanel
          key={s.key}
          glyph={s.glyph}
          label={s.label}
          count={s.count}
          width={width}
          headerAction={open ? { id: `helm:lane:${s.key}`, run: open === 'files' ? openFilesMenu : () => requestCommandDispatch(open) } : undefined}
        >
          {body}
        </RailPanel>
      )
    }
    const first = painted++ === 0
    return (
      <Box key={s.key} flexDirection="column" flexShrink={0}>
        <Box marginTop={first && !s.marginAlways ? 0 : 1}>
          <SectionHeader label={s.count ? `${s.label} · ${s.count}` : s.label} width={model.rowW} />
        </Box>
        {body}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      <Box width={width} height={1} flexShrink={0}>
        <Text wrap="truncate-end">
          <ValueGlow value={focused} color={focused ? accent : tok.textMuted} ms={CURSOR_NUDGE_MS}>
            {focused ? <Text bold>{`${GLYPH.prompt} `}</Text> : '  '}
          </ValueGlow>
          {!focused ? (
            <Text color={tok.textMuted}>{'lanes'}</Text>
          ) : (
            <>
              <Text color={accent} bold>{'lanes'}</Text>
              <Text color={tok.textMuted}>{' · ↑↓ ↵ tab esc'}</Text>
            </>
          )}
        </Text>
      </Box>
      {model.sections.map(paintSection)}
      {model.pointer !== null ? (
        <Box width={width} height={1} flexShrink={0}>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>{model.pointer}</Text>
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
