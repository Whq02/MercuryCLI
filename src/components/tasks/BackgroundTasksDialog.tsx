
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useInput } from '../../ink.js'
import { usePopupListPaging } from '../CustomSelect/popup-list.js'
import { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import '../../state/crewmateViewHelpers.js'
import '../../utils/cockpit/crewmateWords.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import '../../state/vitalsBus.js'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useModalScrollRef } from '../../context/modalContext.js'
import '../mercury-ui/CursorRow.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import type { CompactWorkControls } from './CompactWorkSummary.js'
import { focusedRunnerPresence, useFocusedWorkRoster } from './useFocusedWork.js'
import '../../utils/messages/operatorTurns.js'
import '../../utils/spendSpelling.js'
import '../../utils/contextFill.js'
import '../../utils/model/model.js'
import '../../services/engine-connector/seatLive.js'
import '../SwitchboardTagBar.js'
import { getBootRecovery, subscribeBootRecovery } from '../../substrate/recoveryOrchestrator.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import '../../tasks/LocalShellTask/killShellTasks.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import '../../utils/format.js'
import '../design-system/KeyboardShortcutHint.js'
import { useNowTick } from '../mercury-ui/components.js'
import '../mercury-ui/LiveGlyphs.js'
import '../mercury-ui/screens/SessionManagerView.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import '../../services/samples/contracts.js'
import '../../services/samples/open.js'
import { type CrewAgentFacts, workRowOfCrewFacts } from '../../services/engine-connector/crewFacts.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import '../../services/engine-connector/workCounts.js'
import { crewStopArmed, type CrewStopArm } from '../mercury-ui/screens/crewStopChord.js'
import '../mercury-ui/glyphs.js'
import './AsyncAgentDetailDialog.js'
import { useSessionCrew } from './useCrewLedger.js'
import './BackgroundTask.js'
import './ShellDetailDialog.js'
import { isManageableTask } from './taskStatusUtils.js'
import { type BoardItem, type RowKind, WINDOW } from './backgroundTasks/rows.js'
import { taskDetailView, workDetailView, boardListView } from './backgroundTasks/views.js'
import { openDetailOf, stopSelectedOf, boardKeyDownOf } from './backgroundTasks/actions.js'
import type { BoardContext } from './backgroundTasks/context.js'
export { boardRowElapsedMs, RosterWorkDetail } from './backgroundTasks/rows.js'

const LEAD_ROW_ID = 'lead'

function kindOf(task: TaskState): RowKind {
  if (isLocalShellTask(task)) return task.kind === 'monitor' ? 'monitor' : 'shell'
  if (isLocalAgentTask(task)) return 'agent'
  if ((task as { type?: string }).type === 'monitor_mcp') return 'monitor'
  throw new Error(
    `BackgroundTasksDialog: unrecognised task kind ${(task as { type?: string }).type}`,
  )
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
  toolUseContext,
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
  void toolUseContext
  const tokens = useMercuryTokens()
  const { accent } = useSessionAccent()
  const { columns } = useTerminalSize()
  const now = useNowTick()
  const allTasks = useAppState((state: AppState) => state.tasks)
  const summaryEntry = entry === 'compact-summary'
  const connector = getFocusedSessionConnector()
  const tasks = summaryEntry && connector.carrier === 'daemon' ? {} : allTasks
  const overlayToken = useRegisterOverlay('compact-work', summaryEntry, { ownsPageKeys: true })
  const pastOpen = useOpenEventGate()
  const ownsInputNow = (): boolean => !summaryEntry || (compactControls?.read() === 'detail' && overlayToken !== null && isTopOverlayNow(overlayToken))
  const roster = useFocusedWorkRoster()
  const sessionCrew = useSessionCrew()
  const presence = React.useMemo(() => focusedRunnerPresence(), [roster])
  const viewingAgentTaskId = useAppState(
    (state: AppState) => state.viewingAgentTaskId,
  )
  const setAppState = useSetAppState()
  const missionTasks: ReadonlyArray<{ id: string; subject: string; activeForm?: string; status: string }> = roster.mission
  const bootRecovery = useSyncExternalStore(
    subscribeBootRecovery,
    getBootRecovery,
    getBootRecovery,
  )

  const manageable = Object.values(tasks)
    .filter(isManageableTask)
    .filter(task => {
      if (isLocalAgentTask(task) && task.id === viewingAgentTaskId) return false
      return true
    })
    .sort((a, b) => {
      const aRunning = a.status === 'running' ? 0 : 1
      const bRunning = b.status === 'running' ? 0 : 1
      if (aRunning !== bRunning) return aRunning - bRunning
      return b.startTime - a.startTime
    })

  const byKind = new Map<RowKind, TaskState[]>()
  for (const task of manageable) {
    const kind = kindOf(task)
    byKind.set(kind, [...(byKind.get(kind) ?? []), task])
  }
  const shellTasks = byKind.get('shell') ?? []
  const monitorTasks = byKind.get('monitor') ?? []
  const agentTasks = byKind.get('agent') ?? []

  const screenIds = new Set(manageable.map(task => task.id))
  const rosterOf = (kind: 'shell' | 'monitor'): BoardItem[] =>
    rosterRowsOf(roster.rows, kind, screenIds).map(
      (w): BoardItem => ({ id: w.id, kind, work: w }),
    )
  const crewAgentItems: BoardItem[] = boardAgentRowsOf(roster.rows, sessionCrew.map(row => row.facts), screenIds).map(
    (w): BoardItem => ({ id: w.id, kind: 'agent', work: w }),
  )
  const leadItems: BoardItem[] = viewingAgentTaskId !== undefined ? [{ id: LEAD_ROW_ID, kind: 'lead' }] : []
  const flat: BoardItem[] = [
    ...shellTasks.map((task): BoardItem => ({ id: task.id, kind: 'shell', task })),
    ...rosterOf('shell'),
    ...monitorTasks.map((task): BoardItem => ({ id: task.id, kind: 'monitor', task })),
    ...rosterOf('monitor'),
    ...leadItems,
    ...agentTasks.map((task): BoardItem => ({ id: task.id, kind: 'agent', task })),
    ...crewAgentItems,
    ...(roster.samples ?? []).map((sample): BoardItem => ({ id: `sample:${sample.id}`, kind: 'sample', sample })),
  ]
  const indexById = new Map(flat.map((item, index) => [item.id, index]))

  const inProgress = missionTasks.filter(task => task.status === 'in_progress')
  const pendingMission = missionTasks.filter(task => task.status === 'pending')
  const doneMission = missionTasks.filter(task => task.status === 'completed')
  const ledgerOpenCount = inProgress.length + pendingMission.length

  const selectedIdRef = useRef<string | null>(compactControls?.detailState.selectedId ?? null)
  const [cursor, setCursor] = useState(0)
  const stableId = selectedIdRef.current
  let selectedIndex = flat.findIndex(i => i.id === stableId)
  if (selectedIndex < 0) {
    selectedIndex = Math.max(0, Math.min(cursor, flat.length - 1))
  }
  selectedIdRef.current = flat[selectedIndex]?.id ?? null
  const selected: BoardItem | undefined = flat[selectedIndex]

  const modalScrollRef = useModalScrollRef()
  const moveSelection = (delta: number): void => {
    const next = Math.max(0, Math.min(flat.length - 1, selectedIndex + delta))
    if (flat.length === 0 || next === selectedIndex) {
      modalScrollRef?.current?.scrollBy(delta)
      return
    }
    selectedIdRef.current = flat[next]?.id ?? null
    setCursor(next)
  }

  const skippedListRef = useRef(false)
  const [detailTaskId, setDetailTaskId] = useState<string | undefined>(() => {
    if (compactControls?.detailState.detailTaskId !== undefined) return compactControls.detailState.detailTaskId
    if (initialDetailTaskId !== undefined) return initialDetailTaskId
    if (!summaryEntry && flat.length === 1 && flat[0]?.kind !== 'sample') {
      skippedListRef.current = true
      return flat[0]?.id
    }
    return undefined
  })
  const detailTask =
    detailTaskId !== undefined ? tasks[detailTaskId] : undefined
  const detailWork =
    detailTaskId !== undefined && detailTask === undefined
      ? roster.rows.find(w => w.id === detailTaskId)
      : undefined
  const inDetail = detailTaskId !== undefined
  if (compactControls !== undefined) { compactControls.detailState.selectedId = selectedIdRef.current; compactControls.detailState.detailTaskId = detailTaskId }

  const backFromDetail = (): void => {
    if (skippedListRef.current && flat.length <= 1 && ledgerOpenCount === 0) {
      onDone()
      return
    }
    setDetailTaskId(undefined)
  }

  useEffect(() => {
    if (detailTaskId === undefined) return
    const task = tasks[detailTaskId]
    if (task !== undefined && (isManageableTask(task) || isLocalShellTask(task))) return
    if (task === undefined && roster.rows.some(w => w.id === detailTaskId)) return
    if (skippedListRef.current) onDone()
    else setDetailTaskId(undefined)
  }, [detailTaskId, tasks, roster, onDone])

  const openDetail = (item: BoardItem): void => openDetailOf(ctx, item)

  const [stopArm, setStopArm] = useState<CrewStopArm | null>(null)
  const armedWork = stopArm !== null && crewStopArmed(stopArm, stopArm.id, now) ? (roster.rows.find(w => w.id === stopArm.id) ?? null) : null

  const stopSelected = (item: BoardItem): void => stopSelectedOf(ctx, item)
  const ctx: BoardContext = { onDone, setAppState, setDetailTaskId, stopArm, setStopArm, ownsInputNow, pastOpen, selected, stopSelected, summaryEntry, tasks }

  usePopupListPaging(selectedIndex, flat.length, WINDOW, next => { if (ownsInputNow()) moveSelection(next - selectedIndex) }, !inDetail)
  useKeybindings(
    {
      'confirm:no': () => {
        if (!ownsInputNow()) return false
        onDone()
      },
      'confirm:previous': () => {
        if (!ownsInputNow()) return false
        moveSelection(-1)
      },
      'confirm:next': () => {
        if (!ownsInputNow()) return false
        moveSelection(1)
      },
      'confirm:yes': () => {
        if (!ownsInputNow() || (summaryEntry && !pastOpen())) return false
        if (selected !== undefined) openDetail(selected)
      },
    },
    { context: 'Confirmation', isActive: !inDetail },
  )

  const handleKeyDown = (e: KeyboardEvent): void => boardKeyDownOf(ctx, e)
  useInput(
    (_input, _key, event) => {
      handleKeyDown(new KeyboardEvent(event.keypress))
    },
    { isActive: !inDetail },
  )

  if (inDetail && detailTask !== undefined) {
    const detailView = taskDetailView({ backFromDetail, detailTask, onDone, setAppState })
    if (detailView !== undefined) return detailView
  }
  if (inDetail && detailTask === undefined && detailWork !== undefined) {
    return workDetailView({ backFromDetail, detailWork, now, onDone })
  }

  return boardListView({ accent, agentTasks, armedWork, bootRecovery, columns, doneMission, flat, inProgress, indexById, leadItems, ledgerOpenCount, missionTasks, now, onDone, pendingMission, presence, selected, selectedIdRef, selectedIndex, summaryEntry, tokens })
}
