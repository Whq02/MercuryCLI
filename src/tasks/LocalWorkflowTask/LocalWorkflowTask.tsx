// The `local_workflow` task type: state plumbing for dynamic workflow runs.
//
// Task state lives in AppState and is mutated only through the shared task
// framework (registerTask / updateTaskState), the same way the sibling task
// types do it. This module owns registration, the coalescing progress
// reducer, the atomic terminal/paused transitions, per-agent skip/retry
// signalling, the pause-resume prompt, and the <task-notification> block a
// finished run pushes at the model. The run engine itself (VM, agent
// fan-out, manifest writing) lives with the Workflow tool — nothing here
// touches the VM boundary.

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
import { evictTaskOutput, getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  PANEL_GRACE_MS,
  registerTask,
  updateTaskState,
} from '../../utils/task/framework.js'

// Progress-buffer trim threshold: once the buffer exceeds twice this, the
// oldest workflow_log rows are dropped back down to it. Agent/phase rows are
// never dropped — they coalesce in place by index instead of accumulating.
const PROGRESS_LOG_TRIM = 500

/**
 * One progress event applied to a running workflow task. workflow_agent and
 * workflow_phase events coalesce by `${type}:${index}` (last write wins, in
 * place); workflow_log events append. The rollup counters are recomputed from
 * the surviving rows on every batch — agentCount counts DISTINCT agent
 * indices, so the display stays honest whichever index base the producer
 * uses, and the token/tool totals can never double-count a replaced row.
 */
export type WorkflowProgressEvent =
  | { type: 'workflow_log'; message: string }
  | {
      type: 'workflow_phase'
      /** Coalesce key (last write wins); doubles as the array position. */
      index: number
      title: string
      kind?: 'phase' | 'child'
    }
  | {
      type: 'workflow_agent'
      /**
       * Coalesce key (last write wins) AND the agent's array position. The
       * reducer counts distinct values here rather than tracking a running
       * max, so 0- and 1-based producers both read correctly.
       */
      index: number
      label: string
      /** 'stopped' — the parent run settled while this agent was in flight
       *  (stamped by the terminal transition; no later frames are accepted).
       *  'skipped' — the operator skipped this one agent; not an error. */
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

/** A planned or executing phase, as the UI shows it. */
export type WorkflowPhase = {
  title: string
  detail?: string
  model?: string
}

/**
 * One background subagent permission ask awaiting an operator decision.
 * Keyed by toolUseID on the task; written and cleared by the run's wrapped
 * canUseTool (WorkflowTool/workflowPermissionChannel.ts). The UI reads the
 * map's size as the honest "waiting on N asks" signal — the decision itself
 * still travels the session's normal permission dialog queue.
 */
export type PendingWorkflowPermission = {
  agentId?: string
  toolName: string
  askedAt: number
}

// The base TaskStatus has no 'paused' member — suspension-with-resume is
// unique to workflows (a paused run relaunches from its run id with cached
// agent results). Widen the status locally; everything else of the base
// contract is preserved so the state stays assignable where TaskState flows.
export type LocalWorkflowTaskState = Omit<TaskStateBase, 'status'> & {
  type: 'local_workflow'
  status: TaskStateBase['status'] | 'paused'
  /** The workflow script source; `prompt` mirrors it for SDK consumers. */
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
  /** Monotonic; bumped once per applied batch so renderers can gate cheaply. */
  progressVersion: number
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  logs: string[]
  result?: unknown
  error?: string
  /** Run-level controller; aborted by the terminal/paused transition. */
  abortController?: AbortController
  /** One controller per agent id — lets skip/retry hit a single agent. */
  agentControllers?: Map<string, AbortController>
  /** Subagent permission asks still awaiting a decision, keyed by toolUseID. */
  pendingPermissions?: Map<string, PendingWorkflowPermission>
  /**
   * Always false — run.json is the durable record. The field must EXIST all
   * the same: the shared eviction gate honors `evictAfter` only on tasks
   * that carry a `retain` member, and a workflow task without one would be
   * dropped from AppState on the next attachment pass — the /workflows
   * Recent section would lose a just-finished run before the disk poll sees
   * it. Presence buys the PANEL_GRACE_MS window; the value stays false.
   */
  retain: boolean
  /** Eviction deadline once terminal (same convention as sibling tasks). */
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

/** Terminal workflow statuses. 'paused' is deliberately NOT terminal. */
function isTerminalWorkflowStatus(
  status: LocalWorkflowTaskState['status'],
): boolean {
  return status !== 'paused' && isTerminalTaskStatus(status)
}

/**
 * Register a freshly-launched workflow run into AppState as a running
 * `local_workflow` task. Seeds the common task base, the workflow fields,
 * a fresh run-level AbortController, and empty per-agent controller and
 * pending-permission maps. Returns the state object — the caller keeps
 * direct references to the two maps (the hooks layer populates
 * agentControllers; the permission channel writes pendingPermissions).
 */
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

/**
 * Apply one batch of progress events. Coalesces agent/phase events by
 * `${type}:${index}` (replacing in place), appends log events, trims the
 * oldest logs past the buffer ceiling, recomputes the rollup counters from
 * the surviving rows, and bumps progressVersion. Runs entirely inside one
 * updateTaskState closure; a task that is not 'running' ignores the
 * batch — that is what makes the terminal settle final.
 */
export function updateWorkflowProgressBatch(
  taskId: string,
  events: WorkflowProgressEvent[],
  setAppState: SetAppState,
): void {
  if (events.length === 0) return
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task

    // Merge the batch over the existing rows. Agent/phase rows land in the
    // slot their key already owns (position preserved, last write wins) —
    // rows arriving in this very batch coalesce the same way.
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

    // Trim only when this batch grew the log and the buffer passed twice the
    // ceiling: shed the OLDEST workflow_log rows, at most enough to get back
    // to the ceiling. Agent/phase rows are untouchable, so the result may
    // legitimately stay oversized once the logs run out.
    let survivors = merged
    if (appendedLog && merged.length > PROGRESS_LOG_TRIM * 2) {
      let dropBudget = merged.length - PROGRESS_LOG_TRIM
      survivors = merged.filter(row => {
        if (dropBudget <= 0 || row.type !== 'workflow_log') return true
        dropBudget--
        return false
      })
    }

    // Rollups derive from what SURVIVED, never from a carried running max:
    // coalesced rows replace, so accumulating across batches would double
    // count, and distinct-index counting keeps "<N> agents" honest for both
    // 0- and 1-based producer indexing.
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

/**
 * Atomically move a running task to a terminal or paused state: abort the
 * run controller, stamp endTime (+ evictAfter when terminal), drop the
 * controller/permission maps, and settle any still-in-flight agent rows.
 * Returns the pre-transition snapshot so the caller can persist its output;
 * null when the task was not running (nothing changed).
 */
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

    // The batch reducer accepts no frames after this transition, so an agent
    // row still reading 'start'/'progress' would wear that in-flight word
    // forever — in AppState AND in run.json, which projects this array.
    // Settle stragglers to 'stopped' inside the same atomic update; when
    // nothing is in flight the array keeps its identity and the version is
    // not bumped, so nothing re-renders for a no-op.
    const inFlight = (row: WorkflowProgressEvent): boolean =>
      row.type === 'workflow_agent' &&
      (row.state === 'start' || row.state === 'progress')
    const anyInFlight = task.workflowProgress.some(inFlight)
    const workflowProgress = anyInFlight
      ? task.workflowProgress.map(row =>
          inFlight(row)
            ? { ...row, state: 'stopped' as const, lastProgressAt: now }
            : row,
        )
      : task.workflowProgress

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

/**
 * Mark a workflow task completed and persist its output file. The write is
 * awaitable ON PURPOSE: the completion notification carries an <output-file>
 * pointer, so the caller must be able to sequence the notification strictly
 * after the bytes are on disk — and a failed write must reach the
 * notification text instead of dying in a log line. Resolves null on
 * success, the error text on failure; never rejects.
 */
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
  // Top-level key order is a consumed on-disk format — keep it stable.
  const payload = JSON.stringify(
    { summary: snapshot.summary ?? snapshot.description, agentCount, logs, result },
    null,
    2,
  )
  return writeFile(snapshot.outputFile, payload).then(
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

/** Mark a workflow task failed. */
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

/**
 * The typed receipt for an operator action on a workflow:
 *   'applied'       — the action landed on an in-flight target;
 *   'run-settled'   — the run settled (or was evicted) between render and
 *                     keypress, so nothing was touched;
 *   'not-in-flight' — the run is live but THIS agent has already settled.
 * The render-to-keypress window is structural, not a rare race — surfaces
 * print the receipt instead of claiming success unconditionally.
 */
export type WorkflowActionReceipt = 'applied' | 'run-settled' | 'not-in-flight'

/** Pause a running workflow (notified is set so resume does not re-ping). */
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

/** Kill a running workflow (LocalWorkflowTask.kill delegates here).
 *  `notified` is deliberately NOT pre-set: killed is a terminal state, and
 *  the launching agent hears about every terminal state through the run
 *  loop's kill-path notification (WorkflowTool.driveRun) — pre-latching
 *  here silently suppressed it, so the launcher sat waiting on a corpse
 *  (the operator's evening). */
export function killWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): WorkflowActionReceipt {
  const snapshot = transitionWorkflowTask(taskId, setAppState, 'killed', {})
  if (snapshot) {
    // Background task state changed: a speculated result may reference the
    // now-stale workflow output, so it is discarded (same call the sibling
    // task notifications make).
    abortSpeculation(setAppState)
    void evictTaskOutput(taskId)
  }
  return snapshot !== null ? 'applied' : 'run-settled'
}

/**
 * Signal a SINGLE in-flight agent by aborting its per-agent controller with
 * a reason the agent loop recognizes. The workflow itself keeps running —
 * only the one agent's controller fires.
 */
function signalOneAgent(
  taskId: string,
  agentId: string,
  reason: 'user-skip' | 'user-retry',
  setAppState: SetAppState,
): WorkflowActionReceipt {
  // Stays 'run-settled' when the task is missing or already evicted — the
  // updater simply never runs for those.
  let receipt: WorkflowActionReceipt = 'run-settled'
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    const controller = task.agentControllers?.get(agentId)
    if (controller !== undefined && !controller.signal.aborted) {
      controller.abort(reason)
      receipt = 'applied'
    } else {
      // The run is live, but this agent already settled or never registered.
      receipt = 'not-in-flight'
    }
    // Same reference back: the abort IS the whole effect. No state shape
    // changed, so updateTaskState skips the re-render.
    return task
  })
  return receipt
}

/** Skip the given in-flight agent. */
export function skipWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): WorkflowActionReceipt {
  return signalOneAgent(taskId, agentId, 'user-skip', setAppState)
}

/** Retry the given in-flight agent. */
export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): WorkflowActionReceipt {
  return signalOneAgent(taskId, agentId, 'user-retry', setAppState)
}

/** The resume instruction surfaced when a workflow is paused. Pure string. */
export function buildResumePrompt(task: {
  args?: unknown
  scriptPath?: string
  workflowRunId: string
}): string {
  const argsPart =
    task.args === undefined ? '' : `, args: ${JSON.stringify(task.args)}`
  return `Resume the paused workflow by calling: Workflow({scriptPath: '${task.scriptPath}', resumeFromRunId: '${task.workflowRunId}'${argsPart}}) — completed agents return cached results.`
}

/** The task descriptor registered with the task system. */
export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId, setAppState) {
    killWorkflowTask(taskId, setAppState)
  },
}

// ─── the completion notification ─────────────────────────────────────────────
// Builds the <task-notification> wire block for a settled workflow and pushes
// it as a 'next'-priority pending message — the same mechanism the sibling
// task types use. Wire-format notes that are easy to get wrong:
//   • There is NO standalone <error> tag: the error folds into <summary>
//     ("… failed: <error>"). Consumers parse the summary.
//   • <output-file> is getTaskOutputPath(taskId) — by construction the same
//     path createTaskStateBase seeded onto the task; only the taskId reaches
//     this function.
//   • The failed/killed <recovery> resume line uses its own "To resume after
//     editing the script…" phrasing — deliberately DIFFERENT from the pause
//     path's buildResumePrompt wording. The args suffix matches it.

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
  /** Set when the output-file write FAILED — the notification must not
   *  advertise a file that is not there. */
  outputWriteError?: string
  /** Per-agent rollups for the <agents> trace index. Declared inline (a
   *  structural subset of the run manifest's per-agent summary) because the
   *  manifest module imports types FROM this file — importing back would be
   *  a cycle. Callers pass it only when the evolution-ledger gate is live,
   *  so absent ⇒ the message is unchanged. */
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

/** Chars of serialized result inlined in the notification before truncating
 *  to a pointer at the full output file. */
const WORKFLOW_RESULT_MAX_CHARS = 8000

/** Row cap for the <agents> trace index; the full list stays in run.json. */
const AGENT_INDEX_MAX_ROWS = 24

export function enqueueWorkflowNotification(args: WorkflowNotificationArgs): void {
  const { taskId, status, setAppState } = args

  // The notified latch, checked and set in one atomic updater. Pause/kill
  // (and any earlier notification) already set it, so one task pings the
  // model at most once.
  let firstNotice = false
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.notified) return task
    firstNotice = true
    return { ...task, notified: true }
  })
  if (!firstNotice) return

  // Background task state changed — drop any speculated result that may
  // reference stale workflow output.
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
  // The <output-file> pointer below is only honest when the write landed —
  // on failure, say so in the text the model actually reads.
  if (args.outputWriteError) {
    summaryText += ` (warning: the output file could not be written — ${args.outputWriteError}; use the <result> section, not the output file)`
  }

  // <recovery> — failed/killed/partial paths only: the resume call when the
  // script + run id are known, plus the transcript pointer when present.
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

  // <result> — completed paths only. Serialized, XML-escaped, truncated past
  // the threshold with a pointer at the full file.
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

  // <failures> — present only when per-agent failures were reported.
  const failuresSection = args.failures?.length
    ? `\n<failures>${escapeXml(args.failures.join('\n'))}</failures>`
    : ''

  // <agents> — the per-agent trace index, so a follow-up turn can deep-read
  // the raw transcripts instead of re-running work or trusting a summary.
  // Bounded to a fixed row cap; the full list stays in run.json.
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

  // <usage> — always present.
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

  // 'next' priority is explicit — the queue helper would otherwise file the
  // notification under 'later'. Main-thread notifications carry no task or
  // agent identity on the queued command, matching the sibling task types.
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',
  })
}
