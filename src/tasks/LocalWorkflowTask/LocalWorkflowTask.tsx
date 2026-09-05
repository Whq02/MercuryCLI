
import { writeFile } from 'node:fs/promises'

import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, isTerminalTaskStatus } from '../../Task.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { logError } from '../../utils/log.js'
import { escapeXml } from '../../utils/xml.js'
import { ensureTaskOutputDir, evictTaskOutput, getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  PANEL_GRACE_MS,
  registerTask,
  updateTaskState,
} from '../../utils/task/framework.js'

const PROGRESS_LOG_TRIM = 500

export type WorkflowProgressEvent =
  | { type: 'workflow_log'; message: string }
  | {
      type: 'workflow_phase'
      index: number
      title: string
      kind?: 'phase' | 'child'
    }
  | {
      type: 'workflow_agent'
      index: number
      label: string
      state: 'start' | 'progress' | 'done' | 'error' | 'stopped' | 'skipped'
      phaseIndex?: number
      phaseTitle?: string
      tokens?: number
      toolCalls?: number
      durationMs?: number
      error?: string
      cached?: boolean
      [k: string]: unknown
    }

export type WorkflowPhase = {
  title: string
  detail?: string
  model?: string
}

export type PendingWorkflowPermission = {
  agentId?: string
  toolName: string
  askedAt: number
}

export type LocalWorkflowTaskState = Omit<TaskStateBase, 'status'> & {
  type: 'local_workflow'
  status: TaskStateBase['status'] | 'paused'
  script: string
  prompt: string
  scriptPath?: string
  args?: unknown
  summary?: string
  workflowName?: string
  title?: string
  phases?: WorkflowPhase[]
  defaultModel?: string
  workflowRunId: string
  workflowProgress: WorkflowProgressEvent[]
  progressVersion: number
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  logs: string[]
  result?: unknown
  error?: string
  abortController?: AbortController
  agentControllers?: Map<string, AbortController>
  pendingPermissions?: Map<string, PendingWorkflowPermission>
  retain: boolean
  evictAfter?: number
}

export function isLocalWorkflowTask(
  task: unknown,
): task is LocalWorkflowTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_workflow'
  )
}

function isTerminalWorkflowStatus(
  status: LocalWorkflowTaskState['status'],
): boolean {
  return status !== 'paused' && isTerminalTaskStatus(status)
}

export function registerWorkflowTask(opts: {
  taskId: string
  script: string
  scriptPath?: string
  args?: unknown
  summary?: string
  workflowName?: string
  title?: string
  phases?: WorkflowPhase[]
  defaultModel?: string
  workflowRunId: string
  setAppState: SetAppState
  toolUseId?: string
}): LocalWorkflowTaskState {
  const description = opts.summary ?? opts.workflowName ?? 'Dynamic workflow'
  const state: LocalWorkflowTaskState = {
    ...createTaskStateBase(
      opts.taskId,
      'local_workflow',
      description,
      opts.toolUseId,
    ),
    type: 'local_workflow',
    status: 'running',
    script: opts.script,
    prompt: opts.script,
    scriptPath: opts.scriptPath,
    args: opts.args,
    summary: opts.summary,
    workflowName: opts.workflowName,
    title: opts.title,
    phases: opts.phases,
    defaultModel: opts.defaultModel,
    workflowRunId: opts.workflowRunId,
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    abortController: new AbortController(),
    agentControllers: new Map<string, AbortController>(),
    pendingPermissions: new Map<string, PendingWorkflowPermission>(),
    retain: false,
  }
  registerTask(state, opts.setAppState)
  return state
}

export function updateWorkflowProgressBatch(
  taskId: string,
  events: WorkflowProgressEvent[],
  setAppState: SetAppState,
): void {
  if (events.length === 0) return
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task

    const merged = [...task.workflowProgress]
    const slotOf = new Map<string, number>()
    merged.forEach((row, slot) => {
      if (row.type !== 'workflow_log') {
        slotOf.set(`${row.type}:${row.index}`, slot)
      }
    })

    let appendedLog = false
    for (const event of events) {
      if (event.type === 'workflow_log') {
        merged.push(event)
        appendedLog = true
        continue
      }
      const key = `${event.type}:${event.index}`
      const slot = slotOf.get(key)
      if (slot === undefined) {
        slotOf.set(key, merged.length)
        merged.push(event)
      } else {
        merged[slot] = event
      }
    }

    let survivors = merged
    if (appendedLog && merged.length > PROGRESS_LOG_TRIM * 2) {
      let dropBudget = merged.length - PROGRESS_LOG_TRIM
      survivors = merged.filter(row => {
        if (dropBudget <= 0 || row.type !== 'workflow_log') return true
        dropBudget--
        return false
      })
    }

    const agentIndices = new Set<number>()
    let tokenSum = 0
    let toolCallSum = 0
    for (const row of survivors) {
      if (row.type !== 'workflow_agent') continue
      agentIndices.add(row.index)
      if (row.tokens) tokenSum += row.tokens
      if (row.toolCalls) toolCallSum += row.toolCalls
    }

    return {
      ...task,
      workflowProgress: survivors,
      progressVersion: task.progressVersion + events.length,
      agentCount: agentIndices.size,
      totalTokens: tokenSum,
      totalToolCalls: toolCallSum,
    }
  })
}

export function settleInFlightAgentRows(
  rows: WorkflowProgressEvent[],
  now: number,
): WorkflowProgressEvent[] {
  const inFlight = (row: WorkflowProgressEvent): boolean =>
    row.type === 'workflow_agent' &&
    (row.state === 'start' || row.state === 'progress')
  if (!rows.some(inFlight)) return rows
  return rows.map(row =>
    inFlight(row) ? { ...row, state: 'stopped' as const, lastProgressAt: now } : row,
  )
}

function transitionWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
  status: LocalWorkflowTaskState['status'],
  patch: Partial<LocalWorkflowTaskState>,
): LocalWorkflowTaskState | null {
  let snapshot: LocalWorkflowTaskState | null = null
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    snapshot = task
    task.abortController?.abort()
    const now = Date.now()

    const workflowProgress = settleInFlightAgentRows(task.workflowProgress, now)
    const anyInFlight = workflowProgress !== task.workflowProgress

    const next: LocalWorkflowTaskState = {
      ...task,
      ...patch,
      workflowProgress,
      status,
      endTime: now,
      abortController: undefined,
      agentControllers: undefined,
      pendingPermissions: undefined,
    }
    if (anyInFlight) next.progressVersion = task.progressVersion + 1
    if (isTerminalWorkflowStatus(status)) next.evictAfter = now + PANEL_GRACE_MS
    return next
  })
  return snapshot
}

export function completeWorkflowTask(
  taskId: string,
  result: unknown,
  agentCount: number,
  logs: string[],
  setAppState: SetAppState,
): Promise<string | null> {
  const snapshot = transitionWorkflowTask(taskId, setAppState, 'completed', {
    result,
    agentCount,
    logs,
  })
  if (snapshot === null) return Promise.resolve(null)
  void evictTaskOutput(taskId)
  const payload = JSON.stringify(
    { summary: snapshot.summary ?? snapshot.description, agentCount, logs, result },
    null,
    2,
  )
  return ensureTaskOutputDir()
    .then(() => writeFile(snapshot.outputFile, payload))
    .then(
    () => null,
    (e: unknown) => {
      const msg = `Failed to write workflow output for ${taskId}: ${
        e instanceof Error ? e.message : String(e)
      }`
      logError(msg)
      return msg
    },
  )
}

export function failWorkflowTask(
  taskId: string,
  error: string,
  agentCount: number,
  logs: string[],
  setAppState: SetAppState,
): void {
  const settled = transitionWorkflowTask(taskId, setAppState, 'failed', {
    error,
    agentCount,
    logs,
  })
  if (settled !== null) void evictTaskOutput(taskId)
}

export type WorkflowActionReceipt = 'applied' | 'run-settled' | 'not-in-flight'

export function pauseWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): WorkflowActionReceipt {
  return transitionWorkflowTask(taskId, setAppState, 'paused', {
    notified: true,
  }) !== null
    ? 'applied'
    : 'run-settled'
}

export function killWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): WorkflowActionReceipt {
  const snapshot = transitionWorkflowTask(taskId, setAppState, 'killed', {})
  if (snapshot) {
    abortSpeculation(setAppState)
    void evictTaskOutput(taskId)
  }
  return snapshot !== null ? 'applied' : 'run-settled'
}

function signalOneAgent(
  taskId: string,
  agentId: string,
  reason: 'user-skip' | 'user-retry',
  setAppState: SetAppState,
): WorkflowActionReceipt {
  let receipt: WorkflowActionReceipt = 'run-settled'
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    const controller = task.agentControllers?.get(agentId)
    if (controller !== undefined && !controller.signal.aborted) {
      controller.abort(reason)
      receipt = 'applied'
    } else {
      receipt = 'not-in-flight'
    }
    return task
  })
  return receipt
}

export function skipWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): WorkflowActionReceipt {
  return signalOneAgent(taskId, agentId, 'user-skip', setAppState)
}

export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): WorkflowActionReceipt {
  return signalOneAgent(taskId, agentId, 'user-retry', setAppState)
}

export function buildResumePrompt(task: {
  args?: unknown
  scriptPath?: string
  workflowRunId: string
}): string {
  const argsPart =
    task.args === undefined ? '' : `, args: ${JSON.stringify(task.args)}`
  return `Resume the paused workflow by calling: Workflow({scriptPath: '${task.scriptPath}', resumeFromRunId: '${task.workflowRunId}'${argsPart}}) — completed agents return cached results.`
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId, setAppState) {
    killWorkflowTask(taskId, setAppState)
  },
}


export type WorkflowNotificationArgs = {
  taskId: string
  summary?: string
  status: 'completed' | 'completed_with_failures' | 'failed' | 'killed'
  result?: unknown
  failures?: string[]
  error?: string
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  durationMs: number
  setAppState: SetAppState
  toolUseId?: string
  transcriptDir?: string
  scriptPath?: string
  workflowRunId?: string
  args?: unknown
  outputWriteError?: string
  agents?: ReadonlyArray<{
    index: number
    label: string
    state: string
    agentId?: string
    model?: string
    tokens?: number
    error?: string
  }>
}

const WORKFLOW_RESULT_MAX_CHARS = 8000

const AGENT_INDEX_MAX_ROWS = 24

export function enqueueWorkflowNotification(args: WorkflowNotificationArgs): void {
  const { taskId, status, setAppState } = args

  let firstNotice = false
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.notified) return task
    firstNotice = true
    return { ...task, notified: true }
  })
  if (!firstNotice) return

  abortSpeculation(setAppState)

  const name = args.summary ?? 'Dynamic workflow'
  const outputFile = getTaskOutputPath(taskId)

  const describeSettled = (): string => {
    switch (status) {
      case 'completed':
        return `Dynamic workflow "${name}" completed`
      case 'completed_with_failures':
        return `Dynamic workflow "${name}" completed WITH ${args.failures?.length ?? 0} agent failure(s) — the result is partial; read <failures> before trusting it`
      case 'failed':
        return `Dynamic workflow "${name}" failed: ${args.error || 'Unknown error'}`
      case 'killed':
        return `Dynamic workflow "${name}" was stopped`
    }
  }
  let summaryText = describeSettled()
  if (args.outputWriteError) {
    summaryText += ` (warning: the output file could not be written — ${args.outputWriteError}; use the <result> section, not the output file)`
  }

  let recoverySection = ''
  if (status === 'failed' || status === 'killed' || status === 'completed_with_failures') {
    const lines: string[] = []
    if (args.scriptPath && args.workflowRunId) {
      const argsPart =
        args.args === undefined ? '' : `, args: ${JSON.stringify(args.args)}`
      lines.push(
        `To resume after editing the script, call: Workflow({scriptPath: '${args.scriptPath}', resumeFromRunId: '${args.workflowRunId}'${argsPart}})`,
      )
    }
    if (args.transcriptDir) lines.push(`Agent transcripts: ${args.transcriptDir}`)
    if (lines.length > 0) {
      recoverySection = `\n<recovery>${lines.join('\n')}</recovery>`
    }
  }

  let resultSection = ''
  const carriesResult =
    (status === 'completed' || status === 'completed_with_failures') &&
    args.result !== undefined
  if (carriesResult) {
    const escaped = escapeXml(JSON.stringify(args.result))
    const overrun = escaped.length - WORKFLOW_RESULT_MAX_CHARS
    resultSection =
      overrun > 0
        ? `\n<result>${escaped.slice(0, WORKFLOW_RESULT_MAX_CHARS)}\n... (truncated ${overrun} chars, full result in ${outputFile})</result>`
        : `\n<result>${escaped}</result>`
  }

  const failuresSection = args.failures?.length
    ? `\n<failures>${escapeXml(args.failures.join('\n'))}</failures>`
    : ''

  let agentsSection = ''
  const roster = args.agents
  if (roster?.length && args.transcriptDir) {
    const rows = roster.slice(0, AGENT_INDEX_MAX_ROWS).map(agent => {
      const bits: string[] = [`#${agent.index} ${agent.label}`, agent.state]
      if (agent.model) bits.push(agent.model)
      if (typeof agent.tokens === 'number' && agent.tokens > 0) {
        bits.push(`${agent.tokens} tok`)
      }
      bits.push(
        agent.agentId ? `agent-${agent.agentId}.jsonl` : '(no transcript id)',
      )
      if (agent.error) bits.push(`error: ${agent.error.slice(0, 120)}`)
      return escapeXml(bits.join(' · '))
    })
    const hidden = roster.length - AGENT_INDEX_MAX_ROWS
    const overflow =
      hidden > 0 ? `\n(+${hidden} more — full list in run.json)` : ''
    agentsSection = `\n<agents>\ntranscripts: ${escapeXml(args.transcriptDir)}\n${rows.join('\n')}${overflow}\n</agents>`
  }

  const usageSection = `\n<usage><agent_count>${args.agentCount}</agent_count><subagent_tokens>${args.totalTokens}</subagent_tokens><tool_uses>${args.totalToolCalls}</tool_uses><duration_ms>${args.durationMs}</duration_ms></usage>`

  const toolUseIdLine = args.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${args.toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''

  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputFile}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summaryText)}</${SUMMARY_TAG}>${recoverySection}${resultSection}${failuresSection}${agentsSection}${usageSection}
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',
  })
}
