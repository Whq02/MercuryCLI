import * as React from 'react'
import { useState, useSyncExternalStore } from 'react'
import { useLoad, usePublish, useTimer } from '../effects/effects.js'
import { getProjectRoot } from '../../boot/process-state/processState.js'
import { conversationIdHere, getFocusedSessionConnector, subscribeFocusedSessionConnector, subscribeThroughFocused } from '../../engine/connector/focusedConnector.js'
import { promptRows } from '../prompts-panel/rows.js'
import { listedSessionsOf } from '../../sessions/transcripts/listedSessions.js'
import { Box, Text } from '../themedRenderer.js'
import { InteractiveRow } from '../widgets/InteractiveRow.js'
import { useAppState } from '../app-state/AppState.js'
import { useSessionCrew } from '../tasks/useCrewLedger.js'
import { useFocusedWorkRoster } from '../tasks/useFocusedWork.js'
import type { SessionListing } from '../../sessions/transcripts/transcriptEntries.js'
import { saturnWakeGlanceOf, type SaturnWakeGlanceV1 } from '../../daemon/saturn/saturn.js'
import { boardHomedSessionIds, readSessionWorkers } from '../../daemon/concourse-workers/concourseWorkers.js'
import { subscribeConcourseWorkers } from '../../daemon/concourse-workers/store.js'
import { isProjectSession } from '../session-chooser/sessionFilter.js'
import { isSessionCleared } from '../../sessions/transcripts/clearedSessions.js'
import { sessionIdOfListing, listSessionsAcrossProjects } from '../../sessions/transcripts/sessionStorage.js'
import { getHelmCursor, getHelmFocus, getHelmLanesVersion, getHelmRows, helmRowSig, publishHelmRows, requestCommandDispatch, requestHelmRowActivation, requestHelmRowActivationBySig, setHelmCursor, setHelmCursorBySig, subscribeHelmFocus } from '../cockpit/helmFocus.js'
import { openFilesMenu } from '../cockpit/filesMenu.js'
import { activeSourceUsage } from '../../models/roads/providerUsage.js'
import { getLiveContextUsage, getLiveContextUsageVersion, subscribeLiveContextUsage } from '../cockpit-gauges/contextUsageLive.js'
import { healthCertSnapshot } from '../../platform/health/healthCertSnapshot.js'
import { useNowTick } from '../widgets/components.js'
import { useProviderUsageOnShow } from '../model-picker/useProviderUsageOnShow.js'
import { useFocusedWorkspaceCwd } from '../focused-session/useFocusedWorkspaceCwd.js'
import { GLYPH, displayWidth, truncateToWidth } from '../theme/glyphs.js'
import { ValueGlow, CURSOR_NUDGE_MS, AttentionPulse, WorkingGlyph } from '../widgets/LiveGlyphs.js'
import { RailPanel } from '../widgets/RailPanel.js'
import { useCockpitActivity } from '../cockpit/cockpitActivity.js'
import { subscribeUiClock } from '../cockpit/uiClock.js'
import { useSessionAccent } from '../widgets/sessionAccent.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { useVitals } from '../app-state/vitalsBus.js'
import { fluxMark, fluxWhy } from '../../integrations/media-flux/fluxProbe.js'
import { basename } from 'node:path'
import { getRunSnapshot, subscribeRuns } from '../../engine/run/runCoordinator.js'
import { processMainOwner } from '../../engine/run-owner/resolveOwner.js'
import { isEnvDefinedFalsy } from '../../platform/environment/envUtils.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { buildLanesModel, fitPointerRows, soloOf, wrapRailRows, type LanesInput, type LanesRowSpec, type LanesSectionSpec } from '../cockpit-gauges/helmLanesModel.js'

export { wrapRailRows }

export const RAIL_ROW_NAME_FLOOR = 12

export function railRowBudgets(available: number, nameW: number, verbW: number, sepW: number): { name: number; verb: number } {
  if (verbW === 0) return { name: Math.max(3, available), verb: 0 }
  const verbCap = Math.min(12, verbW)
  const natural = available - sepW - verbCap
  const name = Math.max(3, Math.max(natural, Math.min(nameW, RAIL_ROW_NAME_FLOOR)))
  const verb = Math.min(verbCap, available - name - sepW)
  return verb < 4 ? { name: Math.max(3, available), verb: 0 } : { name, verb }
}

const RAIL_AGE_WORD = /^\d+(?:\.\d+)?[smhd]$/

export function fitRailVerb(verb: string, budget: number): string {
  if (displayWidth(verb) <= budget) return verb
  const words = verb.split(' ')
  const ageLast = words.length > 1 && RAIL_AGE_WORD.test(words[words.length - 1]!)
  for (let keep = words.length - 1; keep >= 1; keep--) {
    const kept = (ageLast ? words.slice(words.length - keep) : words.slice(0, keep)).join(' ')
    if (displayWidth(kept) <= budget) return kept
  }
  return truncateToWidth(verb, budget)
}

const RAIL_SEPARATOR_WORD = /^[—–·-]$/

export function fitRailName(name: string, budget: number): string {
  if (displayWidth(name) <= budget) return name
  const words = name.split(' ')
  for (let keep = words.length - 1; keep >= 1; keep--) {
    if (RAIL_SEPARATOR_WORD.test(words[keep - 1]!)) continue
    const kept = words.slice(0, keep).join(' ')
    if (displayWidth(kept) < budget) return `${kept}…`
  }
  return truncateToWidth(name, budget)
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
  const budgets = railRowBudgets(width - indentW - dotW, displayWidth(name), verb !== undefined && verb !== '' ? displayWidth(verb) : 0, displayWidth(sep))
  const verbT = verb !== undefined && budgets.verb > 0 ? fitRailVerb(verb, budgets.verb) : ''
  const nameT = fitRailName(name, budgets.name)

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

function useRecentSessions(solo: boolean): SessionListing[] | null {
  const conversationId = useSyncExternalStore(subscribeFocusedSessionConnector, conversationIdHere, conversationIdHere)
  const recentScopeKey = `${getProjectRoot() || ''}::${conversationId}`
  const [recentSnap, setRecentSnap] = useState<{ key: string; rows: SessionListing[] | null }>(() => ({
    key: recentScopeKey,
    rows: lastKnownRecent.get(recentScopeKey) ?? null,
  }))
  useLoad(signal => {
    if (!solo) return
    void (async () => {
      try {
        const all = await listSessionsAcrossProjects()
        const boardHomed = boardHomedSessionIds()
        const resumable = listedSessionsOf(all, conversationId)
          .filter(l => !boardHomed.has(sessionIdOfListing(l) ?? ''))
          .filter(l => isProjectSession(l, getProjectRoot() || ''))
          .filter(l => !isSessionCleared(sessionIdOfListing(l)))
        resumable.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
        if (!signal.aborted) {
          const rows = resumable.slice(0, 3)
          lastKnownRecent.set(recentScopeKey, rows)
          setRecentSnap({ key: recentScopeKey, rows })
        }
      } catch {
        if (!signal.aborted) setRecentSnap({ key: recentScopeKey, rows: [] })
      }
    })()
  }, [solo, recentScopeKey])
  return recentSnap.key === recentScopeKey ? recentSnap.rows : lastKnownRecent.get(recentScopeKey) ?? null
}

function useWakeGlance(): SaturnWakeGlanceV1 | null {
  const [wakeGlance, setWakeGlance] = useState<SaturnWakeGlanceV1 | null>(() => lastKnownWakeGlance)
  useTimer(signal => {
    const probe = () => {
      try {
        const records = Object.values(readSessionWorkers()).filter(r => r.endedAt === undefined)
        const s = saturnWakeGlanceOf(records)
        const next = s.count > 0 ? s : null
        lastKnownWakeGlance = next
        if (!signal.aborted) setWakeGlance(next)
      } catch {
        if (!signal.aborted) setWakeGlance(null)
      }
    }
    probe()
    const unsubscribe = subscribeConcourseWorkers(probe)
    const stopFloor = subscribeUiClock(15_000, probe)
    return () => {
      unsubscribe()
      stopFloor()
    }
  }, [])
  return wakeGlance
}

export const HelmLanesRail = React.memo(HelmLanesRailImpl)

function HelmLanesRailImpl({ width, mergedVitals = false, availRows }: { width: number; mergedVitals?: boolean; availRows?: number }): React.ReactNode {
  fluxMark('render:rail-lanes')
  const tok = useMercuryTokens()
  const { accent } = useSessionAccent()
  const activity = useCockpitActivity()
  const ctxUsageVersion = useSyncExternalStore(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion)
  const lanesVersion = useSyncExternalStore(subscribeHelmFocus, getHelmLanesVersion, getHelmLanesVersion)
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
  const tasks = useAppState(s => s.tasks)
  const viewingCrewmateTaskId = useAppState(s => s.viewingAgentTaskId)
  const mainChatTaskId = useAppState(s => s.mainChatTaskId)
  const roster = useFocusedWorkRoster()
  const sessionCrew = useSessionCrew()
  const ledger = useVitals(s => s.tasks)
  const filesOff = useAppState(s => s.settings.view?.files === false)
  const filesFolder = basename(useFocusedWorkspaceCwd())
  const missionCard = roster.missionCard ?? null
  const mission = missionCard !== null && (missionCard.state === 'armed' || missionCard.state === 'paused') ? missionCard : null
  const wakeGlance = useWakeGlance()
  const solo = soloOf({ sessionCrew, viewingAgentTaskId: viewingCrewmateTaskId, mainChatTaskId, tasks, roster })
  const recent = useRecentSessions(solo)
  const railWhyRef = React.useRef<Record<string, unknown> | null>(null)
  fluxWhy('rail-lanes', railWhyRef, () => ({
    width,
    mergedVitals,
    availRows,
    tok,
    activity,
    ctxUsageVersion,
    lanesVersion,
    missionCard,
    accent,
    focusedRecords,
    workRunSnap,
    tasks,
    roster,
    viewingAgentTaskId: viewingCrewmateTaskId,
    mainChatTaskId,
    vitals: ledger,
  }))
  const nowMs = Date.now()
  const published = getHelmRows('lanes')
  const input: LanesInput = {
    width,
    mergedVitals,
    availRows,
    activity,
    cursorRow: published[getHelmCursor('lanes')],
    sessionCrew,
    viewingAgentTaskId: viewingCrewmateTaskId,
    mainChatTaskId,
    tasks,
    roster,
    workRunSnap: workLaneOff ? null : workRunSnap,
    ledger,
    lastSentPrompt,
    filesOff,
    filesFolder,
    recent,
    missionCondition: mission ? mission.goal : null,
    wakeGlance,
    glance: mergedVitals
      ? (() => {
          const focusedUsage = getFocusedSessionConnector().usage()
          return {
            sessionModel: getFocusedSessionConnector().modelFacts().effective,
            usage: activeSourceUsage({ model: getFocusedSessionConnector().modelFacts().effective }),
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
  useNowTick(mergedVitals || model.runsLive > 0 ? 15_000 : null)
  useProviderUsageOnShow(mergedVitals)

  const rowsSig = model.rows.map(helmRowSig).join('|')
  usePublish(() => {
    publishHelmRows('lanes', model.rows)
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
        model.boxed ? (
          fitPointerRows(model.pointer, width, availRows !== undefined ? availRows - model.paintedRows : Infinity).map((line, idx) => (
            <Box key={idx} width={width} height={1} flexShrink={0}>
              <Text wrap="truncate-end">
                <Text color={tok.textMuted}>{line}</Text>
              </Text>
            </Box>
          ))
        ) : (
          <Box width={width} height={1} flexShrink={0}>
            <Text wrap="truncate-end">
              <Text color={tok.textMuted}>{model.pointer}</Text>
            </Text>
          </Box>
        )
      ) : null}
    </Box>
  )
}
