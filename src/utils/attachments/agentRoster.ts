
import type { AppState } from '../../state/AppState.js'
import type { TaskState } from '../../tasks/types.js'
import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import { crewAgentFactsOf, crewStateLabel, crewWaitLine } from '../../services/engine-connector/crewFacts.js'
import { workRowRuns } from '../../services/engine-connector/workCounts.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  buildResumePrompt,
  isLocalWorkflowTask,
  type WorkflowProgressEvent,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { agentPulse, agentPulseWord } from '../../tools/WorkflowTool/livePulse.js'
import { buildAgentSummaries } from '../../tools/WorkflowTool/runManifest.js'
import { TASK_ID_TAG } from '../../constants/xml.js'
import { getTaskOutputPath } from '../task/diskOutput.js'
import { projectWorkRoster } from '../task/workRoster.js'
import type { AgentRosterAttachment, AgentRosterRow } from './types.js'

export type AgentRosterInput = {
  tasks: AppState['tasks'] | undefined
  agentNameRegistry?: ReadonlyMap<string, string>
  excludeAgentId?: string
  queuedNoticeIds?: ReadonlySet<string>
  nowMs?: number
}

export function queuedNoticeTaskIds(
  queue: ReadonlyArray<{ mode?: string; value?: unknown }>,
): Set<string> {
  const ids = new Set<string>()
  const tag = new RegExp(`<${TASK_ID_TAG}>([^<]+)</${TASK_ID_TAG}>`, 'g')
  for (const command of queue) {
    if (command.mode !== 'task-notification' || typeof command.value !== 'string') continue
    for (const match of command.value.matchAll(tag)) ids.add((match[1] ?? '').trim())
  }
  return ids
}

const OWED_NOTICE_QUEUED =
  'its completion notice is already queued and arrives on the next turn — collect it there, never re-derive its result'
const OWED_NOTICE_PENDING = 'its completion reaches you as a task notification — never re-spawn it'

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const statusWordOf = (status: string): string => (status === 'killed' ? 'stopped' : status)

function owedLine(parts: Array<string | null>): string | null {
  const kept = parts.filter((p): p is string => p !== null && p !== '')
  return kept.length === 0 ? null : kept.join('; ')
}

function pendingFor(task: TaskState | undefined): string | null {
  if (task === undefined) return null
  if (isLocalAgentTask(task)) {
    const n = task.pendingMessages?.length ?? 0
    return n > 0 ? `${plural(n, 'message')} queued for its next tool round` : null
  }
  if (isInProcessTeammateTask(task)) {
    const n = task.pendingUserMessages?.length ?? 0
    return n > 0 ? `${plural(n, 'message')} pending delivery` : null
  }
  return null
}

function asksFor(row: WorkRowV1): string | null {
  const n = row.pendingAsks ?? 0
  return n > 0 ? `${plural(n, 'permission ask')} parked` : null
}

function workflowAgentsOf(task: TaskState, nowMs: number): AgentRosterRow['agents'] {
  if (!isLocalWorkflowTask(task)) return undefined
  const events = (task.workflowProgress ?? []) as readonly WorkflowProgressEvent[]
  const summaries = buildAgentSummaries(events)
  if (summaries.length === 0) return undefined
  return summaries.map(agent => ({ label: agent.label, state: agentPulseWord(agentPulse(agent, nowMs)) }))
}

function rowFor(
  row: WorkRowV1,
  task: TaskState | undefined,
  input: AgentRosterInput,
  nameOfId: ReadonlyMap<string, string>,
  nowMs: number,
): AgentRosterRow | null {
  const noticeQueued = input.queuedNoticeIds?.has(row.id) === true
  const running = workRowRuns(row)
  const outputFilePath = getTaskOutputPath(row.id)
  const description = task?.description ?? row.description ?? row.name
  if (row.kind === 'agent' || row.kind === 'teammate') {
    const facts = crewAgentFactsOf(row, null)
    if (facts === null) return null
    return {
      taskId: row.id,
      taskType: row.kind === 'agent' ? 'local_agent' : 'in_process_teammate',
      name: facts.name,
      address: row.kind === 'agent' ? (nameOfId.get(row.id) ?? row.id) : facts.name,
      status: crewStateLabel(facts),
      wait: crewWaitLine(facts),
      description: facts.description ?? description,
      owed: owedLine([
        running ? OWED_NOTICE_PENDING : noticeQueued ? OWED_NOTICE_QUEUED : null,
        pendingFor(task),
        asksFor(row),
      ]),
      error: facts.error,
      outputFilePath,
    }
  }
  if (row.kind === 'workflow') {
    const paused = row.status === 'paused'
    const resume =
      paused && isLocalWorkflowTask(task)
        ? buildResumePrompt({ args: task.args, scriptPath: task.scriptPath, workflowRunId: task.workflowRunId })
        : null
    return {
      taskId: row.id,
      taskType: 'local_workflow',
      name: row.name,
      address: null,
      status: statusWordOf(row.status),
      wait: null,
      description,
      owed: owedLine([
        running ? OWED_NOTICE_PENDING : noticeQueued ? OWED_NOTICE_QUEUED : null,
        resume,
        asksFor(row),
      ]),
      error: row.error ?? null,
      outputFilePath,
      ...(row.pulse?.phaseTitle !== undefined ? { phase: row.pulse.phaseTitle } : {}),
      ...(task !== undefined ? (() => { const agents = workflowAgentsOf(task, nowMs); return agents !== undefined ? { agents } : {} })() : {}),
    }
  }
  const taskType: AgentRosterRow['taskType'] =
    row.kind === 'shell' ? 'local_bash' : row.kind === 'dream' ? 'dream' : 'monitor_mcp'
  return {
    taskId: row.id,
    taskType,
    name: row.name,
    address: null,
    status: statusWordOf(row.status),
    wait: null,
    description,
    owed: owedLine([running ? OWED_NOTICE_PENDING : noticeQueued ? OWED_NOTICE_QUEUED : null, asksFor(row)]),
    error: row.error ?? null,
    outputFilePath,
  }
}

export function getAgentRosterAttachment(input: AgentRosterInput): AgentRosterAttachment[] {
  const tasks = input.tasks ?? {}
  const nowMs = input.nowMs ?? Date.now()
  const nameOfId = new Map<string, string>()
  for (const [name, id] of input.agentNameRegistry ?? []) nameOfId.set(String(id), name)
  const rows: AgentRosterRow[] = []
  for (const row of projectWorkRoster(tasks)) {
    const task = tasks[row.id]
    if (input.excludeAgentId !== undefined) {
      if (row.id === input.excludeAgentId) continue
      if (task !== undefined && isLocalAgentTask(task) && task.agentId === input.excludeAgentId) continue
    }
    const built = rowFor(row, task, input, nameOfId, nowMs)
    if (built !== null) rows.push(built)
  }
  if (rows.length === 0) return []
  const runningWord = (status: string): boolean => status === 'running' || status === 'waiting' || status === 'pending'
  rows.sort((a, b) => {
    const ra = runningWord(a.status)
    const rb = runningWord(b.status)
    if (ra !== rb) return ra ? -1 : 1
    return 0
  })
  return [{ type: 'agent_roster', rows }]
}
