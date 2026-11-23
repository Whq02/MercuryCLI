import { KeyboardEvent } from '../../renderer/events/keyboard-event.js'
import { clearMainChat, enterCrewmateView, exitCrewmateView } from '../../../crew/crewmates/crewmateView.js'
import { isLocalShellTask } from '../../../engine/tasks/local-shell/shellTaskState.js'
import { killTask } from '../../../engine/tasks/local-shell/killShellTasks.js'
import { killAsyncAgent, killAllRunningAgentTasks } from '../../../engine/tasks/local-agent/crewmateTask.js'
import { openSampleUrl } from '../../../integrations/samples/open.js'
import { getFocusedSessionConnector } from '../../../engine/connector/focusedConnector.js'
import { workRowRuns } from '../../../engine/connector/workCounts.js'
import { pressCrewStop } from '../../widgets/faces/crewStopChord.js'
import type { BoardItem } from './rows.js'
import type { BoardContext } from './context.js'

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
  const { setAppState, setStopArm, stopArm } = ctx
    const task = item.task
    if (task === undefined) {
      const work = item.work
      if (work === undefined || !workRowRuns(work)) return
      const press = pressCrewStop(stopArm, work.id, Date.now())
      if (!press.fire) {
        setStopArm(press.arm)
        return
      }
      setStopArm(null)
      void getFocusedSessionConnector().stopAgent(work.id)
      return
    }
    if (task.status !== 'running') return
    if (isLocalShellTask(task)) { void killTask(task.id, setAppState); return }
    switch (item.kind) {
      case 'shell':
        void killTask(task.id, setAppState)
        return
      case 'agent':
        killAsyncAgent(task.id, setAppState)
        return
      case 'monitor':
        ;(task as { abortController?: AbortController }).abortController?.abort()
        return
      default:
        return
    }
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
