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
import { notBuilt } from '../../pi/holes.js'
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

export function BackgroundTasksDialog(arg0: {
  onDone: () => void
  toolUseContext: LocalJSXCommandContext
  initialDetailTaskId?: string
  entry?: 'tasks' | 'compact-summary'
  compactControls?: CompactWorkControls
}): React.ReactNode {
  return notBuilt('src/components/tasks/BackgroundTasksDialog.tsx:73')
}
