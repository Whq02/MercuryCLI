import React, { useRef, useState, useSyncExternalStore } from 'react'
import { usePublish } from '../../hooks/effects.js'
import { useInput } from '../../ink.js'
import { usePopupListPaging } from '../CustomSelect/popup-list.js'
import { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useModalScrollRef } from '../../context/modalContext.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import type { CompactWorkControls } from './CompactWorkSummary.js'
import { focusedRunnerPresence, useFocusedWorkRoster } from './useFocusedWork.js'
import { getBootRecovery, subscribeBootRecovery } from '../../substrate/recoveryOrchestrator.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import { useNowTick } from '../mercury-ui/components.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import { type CrewAgentFacts, workRowOfCrewFacts } from '../../services/engine-connector/crewFacts.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { crewStopArmed, type CrewStopArm } from '../mercury-ui/screens/crewStopChord.js'
import { useSessionCrew } from './useCrewLedger.js'
import { isManageableTask } from './taskStatusUtils.js'
import { type BoardItem, type RowKind, WINDOW } from './backgroundTasks/rows.js'
import { taskDetailView, workDetailView, boardListView } from './backgroundTasks/views.js'
import { openDetailOf, stopSelectedOf, boardKeyDownOf } from './backgroundTasks/actions.js'
import type { BoardContext } from './backgroundTasks/context.js'
export { boardRowElapsedMs, RosterWorkDetail } from './backgroundTasks/rows.js'

const LEAD_ROW_ID = 'lead'

function kindOf(task: TaskState): RowKind {
  switch (task.type) {
    case 'local_bash':
      return task.kind === 'monitor' ? 'monitor' : 'shell'
    case 'local_agent':
      return 'agent'
    case 'monitor_mcp':
      return 'monitor'
  }
}

export function rosterRowsOf(
  rows: readonly WorkRowV1[],
  kind: WorkRowV1['kind'],
  excludeIds?: ReadonlySet<string>,
): WorkRowV1[] {
  return [...rows]
    .filter(w => w.kind === kind && !(excludeIds?.has(w.id) ?? false))
    .sort((a, b) => {
      const aRunning = a.status === 'running' ? 0 : 1
      const bRunning = b.status === 'running' ? 0 : 1
      if (aRunning !== bRunning) return aRunning - bRunning
      return b.startTime - a.startTime
    })
}

export function boardAgentRowsOf(
  rows: readonly WorkRowV1[],
  crew: readonly CrewAgentFacts[],
  excludeIds?: ReadonlySet<string>,
): WorkRowV1[] {
  const shown = new Set(crew.map(facts => facts.id))
  const listed = new Set(rows.map(w => w.id))
  const hidden = new Set([...(excludeIds ?? []), ...rows.filter(w => w.kind === 'agent' && !shown.has(w.id)).map(w => w.id)])
  const unlisted = crew.filter(facts => !listed.has(facts.id) && !(excludeIds?.has(facts.id) ?? false)).map(workRowOfCrewFacts)
  return rosterRowsOf([...rows, ...unlisted], 'agent', hidden)
}

export function BackgroundTasksDialog({
  onDone,
  toolUseContext: _toolUseContext,
  initialDetailTaskId,
  entry = 'tasks',
  compactControls,
}: {
  onDone: () => void
  toolUseContext: LocalJSXCommandContext
  initialDetailTaskId?: string
  entry?: 'tasks' | 'compact-summary'
  compactControls?: CompactWorkControls
}): React.ReactNode {
  const summaryEntry = entry === 'compact-summary'
  const tasks = useAppState((state: AppState) => state.tasks)
  const viewingAgentTaskId = useAppState((state: AppState) => state.viewingAgentTaskId)
  const setAppState = useSetAppState()
  const roster = useFocusedWorkRoster()
  const sessionCrew = useSessionCrew()
  const bootRecovery = useSyncExternalStore(
    subscribeBootRecovery,
    getBootRecovery,
    getBootRecovery,
  )
  const presence = focusedRunnerPresence()
  const { columns } = useTerminalSize()
  const tokens = useMercuryTokens()
  const { accent } = useSessionAccent()
  const now = useNowTick()
  const modalScrollRef = useModalScrollRef()
  const pastOpen = useOpenEventGate()

  const overlayToken = useRegisterOverlay('compact-work', summaryEntry, {
    ownsPageKeys: true,
  })
  const overlayTokenRef = useRef(overlayToken)
  overlayTokenRef.current = overlayToken
  const ownsInputNow = (): boolean => {
    if (!summaryEntry) return true
    const token = overlayTokenRef.current
    return token !== null && isTopOverlayNow(token)
  }

  const carrier = getFocusedSessionConnector().carrier
  const useScreenTasks = !(summaryEntry && carrier === 'daemon')

  const sortedTasks = useScreenTasks
    ? Object.values(tasks ?? {})
        .filter(isManageableTask)
        .filter(task => task.id !== viewingAgentTaskId)
        .sort((a, b) => {
          const aRunning = a.status === 'running' ? 0 : 1
          const bRunning = b.status === 'running' ? 0 : 1
          if (aRunning !== bRunning) return aRunning - bRunning
          return b.startTime - a.startTime
        })
    : []

  const shellTasks = sortedTasks.filter(task => kindOf(task) === 'shell')
  const monitorTasks = sortedTasks.filter(task => kindOf(task) === 'monitor')
  const agentTasks = sortedTasks.filter(task => kindOf(task) === 'agent')

  const excludeIds = new Set<string>(sortedTasks.map(task => task.id))
  if (viewingAgentTaskId !== undefined) excludeIds.add(viewingAgentTaskId)

  const otherShells = rosterRowsOf(roster.rows, 'shell', excludeIds)
  const otherMonitors = rosterRowsOf(roster.rows, 'monitor', excludeIds)
  const crewFacts: CrewAgentFacts[] = sessionCrew.map(row => row.facts)
  const otherAgents = boardAgentRowsOf(roster.rows, crewFacts, excludeIds)

  const leadItems: BoardItem[] =
    viewingAgentTaskId !== undefined ? [{ id: LEAD_ROW_ID, kind: 'lead' }] : []
  const sampleItems: BoardItem[] = (roster.samples ?? []).map(sample => ({
    id: `sample:${sample.id}`,
    kind: 'sample',
    sample,
  }))

  const flat: BoardItem[] = [
    ...shellTasks.map(task => ({ id: task.id, kind: 'shell' as const, task })),
    ...otherShells.map(work => ({ id: work.id, kind: 'shell' as const, work })),
    ...monitorTasks.map(task => ({ id: task.id, kind: 'monitor' as const, task })),
    ...otherMonitors.map(work => ({ id: work.id, kind: 'monitor' as const, work })),
    ...leadItems,
    ...agentTasks.map(task => ({ id: task.id, kind: 'agent' as const, task })),
    ...otherAgents.map(work => ({ id: work.id, kind: 'agent' as const, work })),
    ...sampleItems,
  ]

  const indexById = new Map<string, number>()
  flat.forEach((item, index) => indexById.set(item.id, index))

  const missionTasks = roster.mission
  const inProgress = missionTasks.filter(task => task.status === 'in_progress')
  const pendingMission = missionTasks.filter(task => task.status === 'pending')
  const doneMission = missionTasks.filter(task => task.status === 'completed')
  const ledgerOpenCount = inProgress.length + pendingMission.length

  const nonSampleItems = flat.filter(item => item.kind !== 'sample')
  const [detailTaskId, setDetailTaskId] = useState<string | undefined>(() => {
    if (compactControls?.detailState.detailTaskId !== undefined) {
      return compactControls.detailState.detailTaskId
    }
    if (initialDetailTaskId !== undefined) return initialDetailTaskId
    if (!summaryEntry && nonSampleItems.length === 1) return nonSampleItems[0]!.id
    return undefined
  })
  const skippedListRef = useRef(
    compactControls?.detailState.detailTaskId === undefined &&
      initialDetailTaskId === undefined &&
      !summaryEntry &&
      nonSampleItems.length === 1,
  )

  const [rawSelectedIndex, setRawSelectedIndex] = useState(0)
  const selectedIdRef = useRef<string | null>(
    compactControls?.detailState.selectedId ?? null,
  )

  const selectedIndex = (() => {
    if (flat.length === 0) return 0
    if (selectedIdRef.current !== null) {
      const byId = indexById.get(selectedIdRef.current)
      if (byId !== undefined) return byId
    }
    return Math.max(0, Math.min(rawSelectedIndex, flat.length - 1))
  })()

  const selected = flat[selectedIndex]
  selectedIdRef.current = selected?.id ?? null

  const selectIndex = (nextIndex: number): void => {
    if (flat.length === 0) return
    const clamped = Math.max(0, Math.min(nextIndex, flat.length - 1))
    selectedIdRef.current = flat[clamped]?.id ?? null
    setRawSelectedIndex(clamped)
  }

  const [stopArm, setStopArm] = useState<CrewStopArm | null>(null)
  const armedWork =
    selected?.work !== undefined && crewStopArmed(stopArm, selected.work.id, now)
      ? selected.work
      : null

  const detailTask =
    detailTaskId !== undefined && useScreenTasks ? tasks?.[detailTaskId] : undefined
  const detailWork =
    detailTaskId !== undefined
      ? roster.rows.find(w => w.id === detailTaskId) ??
        otherAgents.find(w => w.id === detailTaskId)
      : undefined
  const hasTaskDetail =
    detailTask !== undefined &&
    (isLocalAgentTask(detailTask) || isLocalShellTask(detailTask))
  const inDetail = hasTaskDetail || detailWork !== undefined
  const listActive = !inDetail

  usePublish(() => {
    if (detailTaskId !== undefined && !inDetail) {
      if (skippedListRef.current && flat.length <= 1 && ledgerOpenCount === 0) {
        onDone()
      } else {
        skippedListRef.current = false
        setDetailTaskId(undefined)
      }
    }
  }, [detailTaskId, inDetail, flat.length, ledgerOpenCount, onDone])

  usePublish(() => {
    if (compactControls) {
      compactControls.detailState.detailTaskId = detailTaskId
      compactControls.detailState.selectedId = selectedIdRef.current
    }
  }, [compactControls, detailTaskId, selectedIndex])

  const backFromDetail = (): void => {
    if (skippedListRef.current && flat.length <= 1 && ledgerOpenCount === 0) {
      onDone()
      return
    }
    skippedListRef.current = false
    setDetailTaskId(undefined)
  }

  const boardContext: BoardContext = {
    onDone,
    setAppState,
    setDetailTaskId,
    stopArm,
    setStopArm,
    ownsInputNow,
    pastOpen,
    selected,
    stopSelected: item => stopSelectedOf(boardContext, item),
    summaryEntry,
    tasks,
  }

  usePopupListPaging(
    selectedIndex,
    flat.length,
    WINDOW,
    nextIndex => {
      if (!ownsInputNow()) return
      selectIndex(nextIndex)
    },
    listActive,
  )

  useKeybindings(
    {
      'confirm:no': () => {
        if (!ownsInputNow()) return false
        onDone()
      },
      'confirm:previous': () => {
        if (!ownsInputNow()) return false
        if (flat.length === 0 || selectedIndex <= 0) {
          modalScrollRef?.current?.scrollBy(-1)
          return
        }
        selectIndex(selectedIndex - 1)
      },
      'confirm:next': () => {
        if (!ownsInputNow()) return false
        if (flat.length === 0 || selectedIndex >= flat.length - 1) {
          modalScrollRef?.current?.scrollBy(1)
          return
        }
        selectIndex(selectedIndex + 1)
      },
      'confirm:yes': () => {
        if (!ownsInputNow()) return false
        if (!pastOpen()) return false
        if (selected !== undefined) openDetailOf(boardContext, selected)
      },
    },
    { context: 'Confirmation', isActive: listActive },
  )

  useInput(
    (_input, _key, event) => {
      const ke = new KeyboardEvent(event.keypress)
      boardKeyDownOf(boardContext, ke)
      if (ke.isImmediatePropagationStopped()) {
        event.stopImmediatePropagation()
      }
    },
    { isActive: listActive },
  )

  if (hasTaskDetail && detailTask !== undefined) {
    const view = taskDetailView({ backFromDetail, detailTask, onDone, setAppState })
    if (view !== undefined) return view
  }

  if (detailWork !== undefined) {
    return workDetailView({ backFromDetail, detailWork, now, onDone })
  }

  return boardListView({
    accent,
    agentTasks,
    armedWork,
    bootRecovery,
    columns,
    doneMission,
    flat,
    inProgress,
    indexById,
    leadItems,
    ledgerOpenCount,
    missionTasks,
    now,
    onDone,
    pendingMission,
    presence,
    selected,
    selectedIdRef,
    selectedIndex,
    summaryEntry,
    tokens,
  })
}
