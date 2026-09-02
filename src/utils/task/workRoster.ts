import type { AppState } from '../../state/AppState.js'
import type { TaskState } from '../../tasks/types.js'
import {
  isLocalWorkflowTask,
  type LocalWorkflowTaskState,
  type WorkflowProgressEvent,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { isDreamTask } from '../../tasks/DreamTask/DreamTask.js'
import {
  buildAgentSummaries,
  groupAgentsByPhase,
  type WorkflowPhaseEventLite,
} from '../../tools/WorkflowTool/runManifest.js'
import type { WorkPhaseV1, WorkRowV1 } from '../../services/engine-connector/types.js'


const MAX_NAME = 120
const MAX_ERROR = 200

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function endTimeOf(task: TaskState): number | undefined {
  const t = task as { endTime?: unknown }
  return typeof t.endTime === 'number' && Number.isFinite(t.endTime) ? t.endTime : undefined
}

export function workPhasesOf(task: LocalWorkflowTaskState): WorkPhaseV1[] {
  const events = (task.workflowProgress ?? []) as readonly WorkflowProgressEvent[]
  const phaseEvents: WorkflowPhaseEventLite[] = []
  for (const ev of events) {
    if (ev.type === 'workflow_phase') {
      phaseEvents.push({ index: ev.index, title: ev.title || `Phase ${ev.index + 1}` })
    }
  }
  const agents = buildAgentSummaries(events)
  return groupAgentsByPhase(task.phases, phaseEvents, agents).map(g => ({
    title: g.title,
    planned: g.planned,
    agents: g.agents.map(a => ({ index: a.index, label: clip(a.label, MAX_NAME), state: a.state })),
  }))
}

function workflowRow(task: LocalWorkflowTaskState): WorkRowV1 {
  const name =
    task.workflowName ?? task.title ?? task.summary ?? task.description ?? 'Dynamic workflow'
  const desc = task.summary ?? task.description
  return {
    id: task.id,
    kind: 'workflow',
    name: clip(name, MAX_NAME),
    status: task.status,
    startTime: task.startTime,
    ...(endTimeOf(task) !== undefined ? { endTime: endTimeOf(task) } : {}),
    ...(desc !== undefined && desc !== name ? { description: clip(desc, MAX_NAME) } : {}),
    ...(task.defaultModel !== undefined ? { model: task.defaultModel } : {}),
    ...(task.error !== undefined ? { error: clip(task.error, MAX_ERROR) } : {}),
    totalTokens: task.totalTokens,
    workflowRunId: task.workflowRunId,
    phases: workPhasesOf(task),
    agentCount: task.agentCount,
    ...(task.pendingPermissions !== undefined && task.pendingPermissions.size > 0
      ? { pendingAsks: task.pendingPermissions.size }
      : {}),
  }
}

function plainRow(task: TaskState, kind: WorkRowV1['kind'], name: string): WorkRowV1 {
  const t = task as { model?: unknown; error?: unknown }
  return {
    id: task.id,
    kind,
    name: clip(name, MAX_NAME),
    status: task.status,
    startTime: task.startTime,
    ...(endTimeOf(task) !== undefined ? { endTime: endTimeOf(task) } : {}),
    ...(typeof t.model === 'string' ? { model: t.model } : {}),
    ...(typeof t.error === 'string' ? { error: clip(t.error, MAX_ERROR) } : {}),
  }
}

export function projectWorkRoster(tasks: AppState['tasks']): WorkRowV1[] {
  const rows: WorkRowV1[] = []
  for (const task of Object.values(tasks ?? {})) {
    if (isLocalWorkflowTask(task)) {
      rows.push(workflowRow(task))
    } else if (isLocalAgentTask(task)) {
      if (task.agentType === 'main-session') continue
      rows.push({
        ...plainRow(task, 'agent', task.description),
        ...(task.agentType !== undefined ? { agentType: task.agentType } : {}),
      })
    } else if (isInProcessTeammateTask(task)) {
      rows.push({
        ...plainRow(task, 'teammate', task.identity.agentName),
        team: clip(task.identity.teamName, MAX_NAME),
      })
    } else if (isLocalShellTask(task)) {
      rows.push(plainRow(task, 'shell', task.command))
    } else if (isDreamTask(task)) {
      rows.push(plainRow(task, 'dream', task.description))
    } else {
      rows.push(plainRow(task, 'monitor', task.description))
    }
  }
  rows.sort((a, b) => b.startTime - a.startTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return rows
}
