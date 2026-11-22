import { KeyboardEvent } from '../../../ink/events/keyboard-event.js'
import { clearMainChat, enterCrewmateView, exitCrewmateView } from '../../../state/crewmateViewHelpers.js'
import { isLocalShellTask } from '../../../tasks/LocalShellTask/guards.js'
import { killTask } from '../../../tasks/LocalShellTask/killShellTasks.js'
import { killAsyncAgent, killAllRunningAgentTasks } from '../../../tasks/LocalAgentTask/LocalAgentTask.js'
import { openSampleUrl } from '../../../services/samples/open.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { workRowRuns } from '../../../services/engine-connector/workCounts.js'
import { pressCrewStop } from '../../mercury-ui/screens/crewStopChord.js'
import type { BoardItem } from './rows.js'
import type { BoardContext } from './context.js'
import { notBuilt } from '../../../pi/holes.js'

export function openDetailOf(ctx: BoardContext, item: BoardItem): void {
  const { onDone, setAppState, setDetailTaskId } = ctx
    if (item.kind === 'sample') {
      if (item.sample?.url !== undefined) void openSampleUrl(item.sample.url)
      return
    }
    if (item.kind === 'lead') {
      exitCrewmateView(setAppState)
      onDone()
      return
    }
    if (item.kind === 'agent') {
      enterCrewmateView(item.id, setAppState)
      onDone()
      return
    }
    setDetailTaskId(item.id)
}

export function stopSelectedOf(ctx: BoardContext, item: BoardItem): void {
  return notBuilt('src/components/tasks/backgroundTasks/actions.ts:32')
}

export function boardKeyDownOf(ctx: BoardContext, e: KeyboardEvent): void {
  const { onDone, ownsInputNow, pastOpen, selected, setAppState, stopSelected, summaryEntry, tasks } = ctx
    if (!ownsInputNow() || (summaryEntry && e.key !== 'left' && !pastOpen())) return
    if (e.key === 'left') {
      e.stopImmediatePropagation()
      onDone()
      return
    }
    if (e.key === 'x' && selected !== undefined) {
      e.stopImmediatePropagation()
      stopSelected(selected)
      return
    }
    if (e.key === 'r' && selected?.work !== undefined && selected.kind === 'agent' && !workRowRuns(selected.work)) {
      e.stopImmediatePropagation()
      void getFocusedSessionConnector().resumeAgent(selected.work.id)
      return
    }
    if (e.key === 'X') {
      e.stopImmediatePropagation()
      killAllRunningAgentTasks(tasks, setAppState)
      return
    }
    if (e.key === 'f' || e.key === 'm') {
      e.stopImmediatePropagation()
      if (selected === undefined) return
      if (e.key === 'm' && selected.kind === 'lead') {
        clearMainChat(setAppState)
        onDone()
        return
      }
      const task = selected.task
      if (task === undefined) return
      if (task.type === 'local_agent') {
        enterCrewmateView(task.id, setAppState)
        onDone()
      }
    }
}
