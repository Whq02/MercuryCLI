import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { SetAppState, Task, TaskStatus } from '../../Task.js'
import { createTaskStateBase } from '../../Task.js'
import type { AppState } from '../../state/AppState.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import { findToolByName, safeSearchOrReadClassification } from '../../Tool.js'
import { createAbortController, createChildAbortController } from '../../utils/abortController.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { sliceHeadAtGrapheme, sliceTailAtGrapheme } from '../../utils/intl.js'
import { calculateUSDCost, modelPricingBasis } from '../../utils/modelCost.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { getAgentTranscriptPath } from '../../utils/sessionStorage/paths.js'
import type { AgentId } from '../../types/ids.js'
import {
  evictTaskOutput,
  getTaskOutputPath,
  initTaskOutputAsSymlink,
} from '../../utils/task/diskOutput.js'
import { PANEL_GRACE_MS, registerTask, updateTaskState } from '../../utils/task/framework.js'
import { emitTaskProgress } from '../../utils/task/sdkProgress.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'

/**
 * Background-agent task lifecycle: registration (background and
 * foreground), progress tracking, foreground↔background transitions,
 * terminal notification composition, and disk/live transcript convergence.
 */

/** The agent type a definition-less agent runs as (contract data). */
const DEFAULT_AGENT_TYPE = 'general-purpose'

/** The main-session agent type (contract data) — panel filters exclude it. */
const MAIN_SESSION_AGENT_TYPE = 'main-session'

/** Bounded recent-activity window (contract data). */
const MAX_RECENT_ACTIVITIES = 5

/** The synthetic structured-output tool never appears in activity previews. */
const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput'

// ── progress tracking ────────────────────────────────────────────────────────

export type ToolActivity = {
  toolName: string
  input: unknown
  /** Resolved through the tool's own description provider at record time. */
  activityDescription?: string
  isSearch?: boolean
  isRead?: boolean
}

export type AgentProgress = {
  toolUseCount: number
  tokenCount: number
  /** Mirrored total for the detail dialogs. */
  totalTokens?: number
  totalToolUseCount?: number
  lastActivity?: ToolActivity
  recentActivities: ToolActivity[]
  /** The ledger fold (AgentLedger) — the facts the crew surfaces paint:
   *  absent until the first settled response, never a fabricated zero. */
  inputTokens?: number
  outputTokens?: number
  costUSD?: number
  unpricedTurns?: number
  /** The model the newest response was SERVED on (the served-model law). */
  model?: string
}

/**
 * The per-response fold of an agent's own settled responses, in the session
 * ledger's spelling: input counts the cached prefix read and written beside
 * the uncached input; USD is what the pricing owner could price at the
 * served model's rate, and `unpricedTurns` counts the responses it could
 * not (their tokens are in the counts, their USD is not — the usage-
 * neutrality law: honest absence, never a foreign rate, never free). One
 * row per response: a streamed response settles across several assistant
 * messages that share one id, so a later message REPLACES the earlier
 * contribution of the same id — the fold never double-counts a turn.
 */
export type AgentLedger = {
  inputTokens: number
  outputTokens: number
  costUSD: number
  unpricedTurns: number
  /** The model the newest response was served on. */
  servedModel?: string
  lastResponseId?: string
  lastResponse?: { input: number; output: number; cost: number; unpriced: number }
}

export type ProgressTracker = {
  /** Input tokens are cumulative per turn — the latest value replaces. */
  latestInputTokens: number
  /** Output tokens are per-message — they sum. */
  totalOutputTokens: number
  toolUseCount: number
  recentActivities: ToolActivity[]
  /** The per-response ledger fold (see AgentLedger). */
  ledger: AgentLedger
  /** The newest assistant message: the wire settles a response's usage
   *  onto the message object AFTER it was yielded (the stream's final
   *  usage lands on the last block's message), so the fold re-reads it at
   *  the next message and at every snapshot — replace-by-id keeps that
   *  idempotent. */
  lastAssistant?: AssistantMessage
}

export function createAgentLedger(): AgentLedger {
  return { inputTokens: 0, outputTokens: 0, costUSD: 0, unpricedTurns: 0 }
}

/**
 * Fold one assistant message's usage into the ledger. A message without
 * usage, or with nothing counted yet (a streamed block before its usage
 * settles), leaves the ledger untouched; a message carrying the SAME
 * response id as the last fold replaces that fold's contribution.
 */
export function foldResponseIntoLedger(ledger: AgentLedger, assistant: AssistantMessage): void {
  const usage = assistant.message.usage
  if (!usage) return
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  const output = usage.output_tokens ?? 0
  if (input <= 0 && output <= 0) return
  const rawModel = (assistant.message as { model?: unknown }).model
  const model = typeof rawModel === 'string' && rawModel.trim() !== '' ? rawModel : undefined
  const priced = model !== undefined && modelPricingBasis(model) !== 'unpriced'
  // The wire's nullable cache fields become the pricing owner's optional ones.
  const cost = priced
    ? calculateUSDCost(model, {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        ...(usage.cache_read_input_tokens != null ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
        ...(usage.cache_creation_input_tokens != null
          ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
          : {}),
        ...(usage.cache_creation ? { cache_creation: usage.cache_creation } : {}),
      })
    : 0
  const next = { input, output, cost, unpriced: priced ? 0 : 1 }
  const id = typeof assistant.message.id === 'string' ? assistant.message.id : undefined
  if (id !== undefined && ledger.lastResponseId === id && ledger.lastResponse !== undefined) {
    const prev = ledger.lastResponse
    ledger.inputTokens -= prev.input
    ledger.outputTokens -= prev.output
    ledger.costUSD -= prev.cost
    ledger.unpricedTurns -= prev.unpriced
  }
  ledger.inputTokens += next.input
  ledger.outputTokens += next.output
  ledger.costUSD += next.cost
  ledger.unpricedTurns += next.unpriced
  ledger.lastResponseId = id
  ledger.lastResponse = next
  if (model !== undefined) ledger.servedModel = model
}

export type ActivityDescriptionResolver = (
  toolName: string,
  input: unknown,
) => string | null

export function createProgressTracker(): ProgressTracker {
  return {
    latestInputTokens: 0,
    totalOutputTokens: 0,
    toolUseCount: 0,
    recentActivities: [],
    ledger: createAgentLedger(),
  }
}

export function getTokenCountFromTracker(tracker: ProgressTracker): number {
  return tracker.latestInputTokens + tracker.totalOutputTokens
}

/** A resolver backed by each tool's own activity-description provider. */
export function createActivityDescriptionResolver(
  tools: Tools,
): ActivityDescriptionResolver {
  return (toolName, input) => {
    const tool = findToolByName(tools, toolName)
    if (!tool) return null
    try {
      return tool.getActivityDescription?.(input as never) ?? null
    } catch {
      return null
    }
  }
}

/**
 * Fold one message into the tracker. Assistant messages only — every other
 * message type is ignored outright. The structured-output tool is excluded
 * from the activity preview but still counted (the counter increments
 * before that exclusion).
 */
export function updateProgressFromMessage(
  tracker: ProgressTracker,
  message: Message,
  resolveActivityDescription?: ActivityDescriptionResolver,
  tools?: Tools,
): void {
  if (message.type !== 'assistant') return
  const assistant = message as AssistantMessage
  if (tracker.lastAssistant !== undefined && tracker.lastAssistant !== assistant) {
    foldResponseIntoLedger(tracker.ledger, tracker.lastAssistant)
  }
  tracker.lastAssistant = assistant
  const usage = assistant.message.usage
  if (usage) {
    const latest =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
    if (latest > 0) tracker.latestInputTokens = latest
    tracker.totalOutputTokens += usage.output_tokens ?? 0
  }
  foldResponseIntoLedger(tracker.ledger, assistant)
  const content = assistant.message.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block.type !== 'tool_use') continue
    tracker.toolUseCount++
    if (block.name === STRUCTURED_OUTPUT_TOOL_NAME) continue
    const classification = tools
      ? safeSearchOrReadClassification(findToolByName(tools, block.name), block.input)
      : undefined
    const activity: ToolActivity = {
      toolName: block.name,
      input: block.input,
      activityDescription: resolveActivityDescription?.(block.name, block.input) ?? undefined,
      isSearch: classification?.isSearch,
      isRead: classification?.isRead,
    }
    tracker.recentActivities.push(activity)
    if (tracker.recentActivities.length > MAX_RECENT_ACTIVITIES) {
      tracker.recentActivities.shift()
    }
  }
}

export function getProgressUpdate(tracker: ProgressTracker): AgentProgress {
  if (tracker.lastAssistant !== undefined) foldResponseIntoLedger(tracker.ledger, tracker.lastAssistant)
  const ledger = tracker.ledger
  const settled = ledger.inputTokens + ledger.outputTokens > 0
  return {
    toolUseCount: tracker.toolUseCount,
    tokenCount: getTokenCountFromTracker(tracker),
    totalTokens: getTokenCountFromTracker(tracker),
    totalToolUseCount: tracker.toolUseCount,
    lastActivity: tracker.recentActivities[tracker.recentActivities.length - 1],
    recentActivities: [...tracker.recentActivities],
    // The ledger rides only once a response settled — an absent counter
    // is the honest "nothing counted yet", never a zero that reads as fact.
    ...(settled
      ? {
          inputTokens: ledger.inputTokens,
          outputTokens: ledger.outputTokens,
          costUSD: ledger.costUSD,
          unpricedTurns: ledger.unpricedTurns,
        }
      : {}),
    ...(ledger.servedModel !== undefined ? { model: ledger.servedModel } : {}),
  }
}

// ── state ────────────────────────────────────────────────────────────────────

export type LocalAgentTaskState = ReturnType<typeof createTaskStateBase> & {
  type: 'local_agent'
  agentId: string
  prompt: string
  selectedAgent?: AgentDefinition
  agentType: string
  model?: string
  abortController?: AbortController
  cleanup?: () => void
  error?: string
  result?: any
  /** Progress snapshot (loosely typed: UI fallback-union access patterns). */
  progress?: any
  summary?: string
  /** The user has already retrieved this task's result. */
  retrieved?: boolean
  messages?: Message[]
  lastReportedToolCount?: number
  lastReportedTokenCount?: number
  isBackgrounded: boolean
  /** Messages queued mid-turn, drained at tool-round boundaries. */
  pendingMessages?: string[]
  /** The UI has claimed this task and will not let go of it. */
  retain?: boolean
  /** The durable transcript has been merged into messages (once per claim). */
  diskLoaded?: boolean
  /** When this task may disappear from the panel; absent = no deadline. */
  evictAfter?: number
}

export function isLocalAgentTask(task: unknown): task is LocalAgentTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_agent'
  )
}

/**
 * The ONE predicate deciding whether an agent task belongs to the
 * coordinator task panel rather than the background-task pill. Every
 * pill/panel filter must agree on it.
 */
export function isPanelAgentTask(task: unknown): task is LocalAgentTaskState {
  return isLocalAgentTask(task) && task.agentType !== MAIN_SESSION_AGENT_TYPE
}

/**
 * Disk↔live convergence (the one law): the disk-only prefix — entries whose
 * stable identity is absent from the live list — followed by the live list
 * unchanged. Sound because a message reaches disk before it is handed to
 * the live stream, so whatever is live is necessarily a tail of what is on
 * disk. Pure.
 */
export function mergeDiskPrefix<M extends { uuid: unknown }>(live: M[], disk: M[]): M[] {
  if (disk.length === 0) return live
  const liveIds = new Set(live.map(message => message.uuid))
  const diskOnly = disk.filter(message => !liveIds.has(message.uuid))
  if (diskOnly.length === 0) return live
  return [...diskOnly, ...live]
}

// ── registration ─────────────────────────────────────────────────────────────

/** Background-signal resolvers, process-wide, keyed by task id. Every path
 *  that resolves one also deletes it. */
const backgroundSignalResolvers = new Map<string, () => void>()

function resolveBackgroundSignal(taskId: string): void {
  const resolve = backgroundSignalResolvers.get(taskId)
  if (resolve) {
    backgroundSignalResolvers.delete(taskId)
    resolve()
  }
}

export function registerAsyncAgent(args: {
  agentId: string
  description: string
  prompt: string
  setAppState: SetAppState
  selectedAgent?: AgentDefinition
  model?: string
  toolUseId?: string
  parentAbortController?: AbortController
}): LocalAgentTaskState {
  const taskId = args.agentId
  // The task's output is the agent's isolated transcript.
  void initTaskOutputAsSymlink(taskId, getAgentTranscriptPath(taskId as AgentId))
  const abortController = args.parentAbortController
    ? createChildAbortController(args.parentAbortController)
    : createAbortController()
  const cleanup = registerCleanup(async () => {
    killAsyncAgent(taskId, args.setAppState)
  })
  const state: LocalAgentTaskState = {
    ...createTaskStateBase(taskId, 'local_agent', args.description, args.toolUseId),
    type: 'local_agent',
    status: 'running',
    agentId: args.agentId,
    prompt: args.prompt,
    selectedAgent: args.selectedAgent,
    agentType: args.selectedAgent?.agentType ?? DEFAULT_AGENT_TYPE,
    model: args.model,
    abortController,
    cleanup,
    isBackgrounded: true,
    // Fresh registrations carry an explicit retain=false: the S18 framework
    // merge keys on the field's PRESENCE to preserve a viewed transcript
    // across a resume re-register.
    retain: false,
  }
  registerTask(state, args.setAppState)
  return state
}

export function registerAgentForeground(args: {
  agentId: string
  description: string
  prompt: string
  setAppState: SetAppState
  selectedAgent?: AgentDefinition
  model?: string
  toolUseId?: string
  parentAbortController?: AbortController
  /** Auto-background after this many milliseconds (armed only when > 0). */
  autoBackgroundMs?: number
}): { taskId: string; backgroundSignal: Promise<void>; cancelAutoBackground?: () => void } {
  const taskId = args.agentId
  void initTaskOutputAsSymlink(taskId, getAgentTranscriptPath(taskId as AgentId))
  const abortController = args.parentAbortController
    ? createChildAbortController(args.parentAbortController)
    : createAbortController()
  const cleanup = registerCleanup(async () => {
    killAsyncAgent(taskId, args.setAppState)
  })
  const state: LocalAgentTaskState = {
    ...createTaskStateBase(taskId, 'local_agent', args.description, args.toolUseId),
    type: 'local_agent',
    status: 'running',
    agentId: args.agentId,
    prompt: args.prompt,
    selectedAgent: args.selectedAgent,
    agentType: args.selectedAgent?.agentType ?? DEFAULT_AGENT_TYPE,
    model: args.model,
    abortController,
    cleanup,
    isBackgrounded: false,
  }
  registerTask(state, args.setAppState)

  const backgroundSignal = new Promise<void>(resolve => {
    backgroundSignalResolvers.set(taskId, resolve)
  })

  let cancelAutoBackground: (() => void) | undefined
  if (args.autoBackgroundMs !== undefined && args.autoBackgroundMs > 0) {
    // Deliberately NOT unreferenced: the pending auto-background may hold
    // the process open until it fires or is cancelled.
    const timer = setTimeout(() => {
      updateTaskState<LocalAgentTaskState>(taskId, args.setAppState, task =>
        task.isBackgrounded ? task : { ...task, isBackgrounded: true },
      )
      resolveBackgroundSignal(taskId)
    }, args.autoBackgroundMs)
    cancelAutoBackground = () => clearTimeout(timer)
  }

  return { taskId, backgroundSignal, cancelAutoBackground }
}

/**
 * Flip a foreground agent task to backgrounded, resolving (and discarding)
 * its background signal so the agent loop is interrupted. Refuses when the
 * task is missing or already backgrounded.
 */
export function backgroundAgentTask(
  taskId: string,
  getAppState: () => AppState,
  setAppState: SetAppState,
): boolean {
  const task = getAppState().tasks?.[taskId]
  if (!task || !isLocalAgentTask(task)) return false
  if (task.isBackgrounded) return false
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, current =>
    current.isBackgrounded ? current : { ...current, isBackgrounded: true },
  )
  resolveBackgroundSignal(taskId)
  return true
}

/**
 * Remove a still-foreground agent task from state entirely, discard its
 * background-signal resolver, and run its cleanup outside the updater.
 */
export function unregisterAgentForeground(taskId: string, setAppState: SetAppState): void {
  let cleanupToRun: (() => void) | undefined
  setAppState(prevState => {
    const task = prevState.tasks?.[taskId]
    if (!task || !isLocalAgentTask(task)) return prevState
    if (task.isBackgrounded) return prevState
    cleanupToRun = task.cleanup
    const tasks = { ...prevState.tasks }
    delete tasks[taskId]
    return { ...prevState, tasks }
  })
  backgroundSignalResolvers.delete(taskId)
  cleanupToRun?.()
}

/**
 * Settle a foreground agent's record in place of removing it: the status
 * word the SDK bookend derives (completed · failed · stopped — the store's
 * own word for a stop is killed), so the crew record stays readable through
 * the panel grace with its fold intact. A landed agent is a fact until the
 * runner evicts it; removing the record at the settle left every crew
 * surface reading "no sub-agents" the instant the agents landed.
 */
export function settleAgentForeground(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  setAppState: SetAppState,
  /** The tracker's final snapshot — the wire settles a response's usage
   *  onto its message after the yield, so the last fold lands HERE, and it
   *  lands even on a record an interrupt already marked killed. */
  progress?: AgentProgress,
): void {
  let settled = false
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.isBackgrounded) return task
    if (task.status !== 'running') return progress !== undefined ? { ...task, progress } : task
    settled = true
    return terminalPatch(task, status === 'stopped' ? 'killed' : status, progress !== undefined ? { progress } : {})
  })
  backgroundSignalResolvers.delete(taskId)
  if (settled) void evictTaskOutput(taskId)
}

// ── terminal transitions ─────────────────────────────────────────────────────

function terminalPatch(
  task: LocalAgentTaskState,
  status: TaskStatus,
  patch: Partial<LocalAgentTaskState>,
): LocalAgentTaskState {
  // Unlike the shell foreground paths, the unregister-cleanup runs from
  // inside the state updater here.
  task.cleanup?.()
  return {
    ...task,
    ...patch,
    status,
    endTime: Date.now(),
    ...(task.retain ? {} : { evictAfter: Date.now() + PANEL_GRACE_MS }),
    abortController: undefined,
    cleanup: undefined,
    selectedAgent: undefined,
  }
}

/**
 * Complete an agent task with its whole result object (the task id is the
 * agent id inside it). No-op unless running; releases the output writer
 * unconditionally.
 */
export function completeAgentTask(
  result: { agentId: string; [key: string]: unknown },
  setAppState: SetAppState,
): void {
  const taskId = result.agentId
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return terminalPatch(task, 'completed', { result })
  })
  void evictTaskOutput(taskId)
}

/** Fail an agent task, storing the error string. */
export function failAgentTask(taskId: string, error: string, setAppState: SetAppState): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return terminalPatch(task, 'failed', { error })
  })
  void evictTaskOutput(taskId)
}

/**
 * Kill a running agent task: abort its controller BEFORE clearing it, and
 * release the output writer only when something was actually killed.
 */
export function killAsyncAgent(taskId: string, setAppState: SetAppState): void {
  let killed = false
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    killed = true
    task.abortController?.abort()
    return terminalPatch(task, 'killed', {})
  })
  if (killed) void evictTaskOutput(taskId)
}

/** Kill every running agent task (cancel in coordinator mode). */
export function killAllRunningAgentTasks(
  tasks: Record<string, unknown>,
  setAppState: SetAppState,
): void {
  for (const task of Object.values(tasks ?? {})) {
    if (!isLocalAgentTask(task)) continue
    if (task.status !== 'running') continue
    killAsyncAgent(task.id, setAppState)
  }
}

/**
 * THE OPERATOR'S STOP of every running background agent — the one road the
 * chat's kill chord and a hosted session's interrupt share: each running
 * agent's controller aborts (its own query tears down), the task settles
 * killed, it is marked notified (one aggregate word, never per-agent noise)
 * and its termination rides the SDK stream as `stopped`, so every reader of
 * the task rows — the transcript, a daemon's seat — learns the same fact.
 * Returns the agents that were running, in task order; the caller decides
 * whether the model hears about it (the chat queues one notification, an
 * interrupt says nothing — the interruption row is the whole story).
 */
export function stopRunningAgentTasks(
  tasks: Record<string, unknown>,
  setAppState: SetAppState,
): LocalAgentTaskState[] {
  const running = Object.values(tasks ?? {}).filter(
    (task): task is LocalAgentTaskState => isLocalAgentTask(task) && task.status === 'running',
  )
  if (running.length === 0) return running
  killAllRunningAgentTasks(tasks, setAppState)
  for (const task of running) {
    markAgentsNotified(task.id, setAppState)
    emitTaskTerminatedSdk(task.id, 'stopped', {
      ...(task.toolUseId !== undefined ? { toolUseId: task.toolUseId } : {}),
      summary: task.description,
    })
  }
  return running
}

/** Mark an agent task notified without enqueueing (a bulk kill sends one
 *  aggregate message instead of per-agent notifications). */
export function markAgentsNotified(taskId: string, setAppState: SetAppState): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task =>
    task.notified ? task : { ...task, notified: true },
  )
}

// ── progress and summary updates ─────────────────────────────────────────────

/**
 * Apply a progress update to a running task. Progress recomputed from
 * assistant messages has no summary of its own — the summarisation service
 * races this writer — so any existing summary is carried through, never
 * overwritten with nothing.
 */
export function updateAgentProgress(
  taskId: string,
  progress: AgentProgress,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return {
      ...task,
      progress,
      lastReportedToolCount: progress.toolUseCount,
      lastReportedTokenCount: progress.tokenCount,
    }
  })
}

/** One pending deferred re-publish per task (coalesced). */
const deferredPublishes = new Map<string, ReturnType<typeof setTimeout>>()

/** The wire settles a response's usage onto its message AFTER the yield —
 *  Anthropic's message_delta, the Responses completion — so a snapshot
 *  taken at the yield carries the start usage or none. This grace period
 *  covers every wire's settle: a tool_use turn's tokens reach the record
 *  while the tool still runs, not at the next message. */
const USAGE_SETTLE_GRACE_MS = 750

/**
 * Publish the tracker's snapshot now, and once more after the usage-settle
 * grace (the re-read folds the message's settled usage) — the record
 * carries the wire's final numbers while the agent still runs.
 */
export function publishAgentProgressSoon(
  taskId: string,
  tracker: ProgressTracker,
  setAppState: SetAppState,
): void {
  updateAgentProgress(taskId, getProgressUpdate(tracker), setAppState)
  const pending = deferredPublishes.get(taskId)
  if (pending !== undefined) clearTimeout(pending)
  const timer = setTimeout(() => {
    deferredPublishes.delete(taskId)
    updateAgentProgress(taskId, getProgressUpdate(tracker), setAppState)
  }, USAGE_SETTLE_GRACE_MS)
  timer.unref?.()
  deferredPublishes.set(taskId, timer)
}

/**
 * Apply a prose summary to a running task, defaulting the counters. The SDK
 * task-progress event is emitted only when the caller opted in — otherwise
 * coordinator sessions would leak summary events to consumers who never
 * asked for them.
 */
export function updateAgentSummary(
  taskId: string,
  summary: string,
  setAppState: SetAppState,
  options?: { emitSdkProgressEvent?: boolean },
): void {
  let snapshot: LocalAgentTaskState | undefined
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    const updated: LocalAgentTaskState = { ...task, summary }
    snapshot = updated
    return updated
  })
  if (snapshot && options?.emitSdkProgressEvent) {
    emitTaskProgress({
      taskId,
      toolUseId: snapshot.toolUseId,
      description: summary,
      startTime: snapshot.startTime,
      totalTokens: snapshot.progress?.tokenCount ?? 0,
      toolUses: snapshot.progress?.toolUseCount ?? 0,
      summary,
    })
  }
}

// ── pending and displayed messages ───────────────────────────────────────────

/** Queue a message typed at a running agent, delivered at the next
 *  tool-round boundary. */
export function queuePendingMessage(
  taskId: string,
  message: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (!isLocalAgentTask(task)) return task
    return { ...task, pendingMessages: [...(task.pendingMessages ?? []), message] }
  })
}

/** Drain the queued messages, returning them and emptying the queue. */
export function drainPendingMessages(
  taskId: string,
  getAppState: () => AppState,
  setAppState: SetAppState,
): string[] {
  const task = getAppState().tasks?.[taskId]
  if (!task || !isLocalAgentTask(task)) return []
  const pending = task.pendingMessages ?? []
  if (pending.length === 0) return []
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, current => ({
    ...current,
    pendingMessages: [],
  }))
  return pending
}

/**
 * Append an already-constructed message to the task's displayed list, so
 * text a user types at a running agent shows up in the viewed transcript
 * straight away (queuing feeds the agent's model input and leaves the
 * display untouched — without this the user would type into silence).
 */
export function appendMessageToLocalAgent(
  taskId: string,
  message: Message,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (!isLocalAgentTask(task)) return task
    return { ...task, messages: [...(task.messages ?? []), message] }
  })
}

// ── terminal notification ────────────────────────────────────────────────────

/**
 * Compose and enqueue the terminal agent notification, guarded by the
 * atomic notified check-and-set. Two deliberate asymmetries with the shell
 * notification: the summary is NOT XML-escaped, and the notification is
 * enqueued WITHOUT an owning agent id. Every optional section is omitted
 * entirely when its input is absent. Priority is `next` — the default level
 * is held back mid-turn by the sleep path, and an agent-failure notice must
 * not sit undelivered while the model reasons from a stale world.
 */
/** The per-notification inline-result bound (sweep #2, B5.11): a
 *  wave of agents settling together delivers every final message into ONE
 *  parent turn, so each inline copy is capped — the complete text is
 *  already durable at the notification's own output-file path, which the
 *  marker points back to. Exported for the parity prover. */
export const NOTIFICATION_RESULT_CAP_CHARS = 16_000
export function boundNotificationResult(finalMessage: string, cap: number = NOTIFICATION_RESULT_CAP_CHARS): string {
  if (finalMessage.length <= cap) return finalMessage
  const head = sliceHeadAtGrapheme(finalMessage, Math.floor(cap * 0.8))
  const tail = sliceTailAtGrapheme(finalMessage, cap - head.length)
  const omitted = finalMessage.length - head.length - tail.length
  return `${head}\n[... ${omitted.toLocaleString()} characters omitted — the complete final message is in the output file named above ...]\n${tail}`
}

export function enqueueAgentNotification(args: {
  taskId: string
  description: string
  status: TaskStatus
  error?: string
  setAppState: SetAppState
  finalMessage?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  toolUseId?: string
  worktreePath?: string
  worktreeBranch?: string
  /** A pre-built result-envelope block supplied by the caller. */
  envelopeBlock?: string
  /** The summary line, when the caller's word is truer than the status's
   *  own (a launch a runner restart orphaned names the restart). */
  summary?: string
}): void {
  let shouldEnqueue = false
  updateTaskState<LocalAgentTaskState>(args.taskId, args.setAppState, task => {
    if (task.notified) return task
    shouldEnqueue = true
    return { ...task, notified: true }
  })
  if (!shouldEnqueue) return

  abortSpeculation(args.setAppState)

  const summary =
    args.summary ??
    (args.status === 'completed'
      ? `Agent "${args.description}" completed`
      : args.status === 'failed'
        ? `Agent "${args.description}" failed: ${args.error || 'unknown error'}`
        : `Agent "${args.description}" was stopped`)

  const toolUseIdLine = args.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${args.toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const resultSection = args.finalMessage
    ? `\n<result>${boundNotificationResult(args.finalMessage)}</result>`
    : ''
  const usageSection = args.usage
    ? `\n<usage><total_tokens>${args.usage.totalTokens}</total_tokens><tool_uses>${args.usage.toolUses}</tool_uses><duration_ms>${args.usage.durationMs}</duration_ms></usage>`
    : ''
  const worktreeSection = args.worktreePath
    ? `\n<worktree><worktreePath>${args.worktreePath}</worktreePath>${
        args.worktreeBranch ? `<worktreeBranch>${args.worktreeBranch}</worktreeBranch>` : ''
      }</worktree>`
    : ''
  const envelopeSection = args.envelopeBlock ? `\n${args.envelopeBlock}` : ''

  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${args.taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${getTaskOutputPath(args.taskId)}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${args.status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>${resultSection}${usageSection}${worktreeSection}${envelopeSection}
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',
  })
}

// ── the task implementation ──────────────────────────────────────────────────

export const LocalAgentTask: Task = {
  name: 'LocalAgentTask',
  type: 'local_agent',
  async kill(taskId, setAppState) {
    logForDebugging(`killing agent task ${taskId}`)
    killAsyncAgent(taskId, setAppState)
  },
}
