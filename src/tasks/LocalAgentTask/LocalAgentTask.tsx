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


const DEFAULT_AGENT_TYPE = 'general-purpose'

const MAIN_SESSION_AGENT_TYPE = 'main-session'

const MAX_RECENT_ACTIVITIES = 5

const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput'


export type ToolActivity = {
  toolName: string
  input: unknown
  activityDescription?: string
  isSearch?: boolean
  isRead?: boolean
}

export type AgentProgress = {
  toolUseCount: number
  tokenCount: number
  totalTokens?: number
  totalToolUseCount?: number
  lastActivity?: ToolActivity
  recentActivities: ToolActivity[]
  inputTokens?: number
  outputTokens?: number
  costUSD?: number
  unpricedTurns?: number
  model?: string
}

export type AgentLedger = {
  inputTokens: number
  outputTokens: number
  costUSD: number
  unpricedTurns: number
  servedModel?: string
  lastResponseId?: string
  lastResponse?: { input: number; output: number; cost: number; unpriced: number }
}

export type ProgressTracker = {
  latestInputTokens: number
  totalOutputTokens: number
  toolUseCount: number
  recentActivities: ToolActivity[]
  ledger: AgentLedger
  lastAssistant?: AssistantMessage
}

export function createAgentLedger(): AgentLedger {
  return { inputTokens: 0, outputTokens: 0, costUSD: 0, unpricedTurns: 0 }
}

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
  progress?: any
  summary?: string
  retrieved?: boolean
  messages?: Message[]
  lastReportedToolCount?: number
  lastReportedTokenCount?: number
  isBackgrounded: boolean
  pendingMessages?: string[]
  retain?: boolean
  diskLoaded?: boolean
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

export function isPanelAgentTask(task: unknown): task is LocalAgentTaskState {
  return isLocalAgentTask(task) && task.agentType !== MAIN_SESSION_AGENT_TYPE
}

export function mergeDiskPrefix<M extends { uuid: unknown }>(live: M[], disk: M[]): M[] {
  if (disk.length === 0) return live
  const liveIds = new Set(live.map(message => message.uuid))
  const diskOnly = disk.filter(message => !liveIds.has(message.uuid))
  if (diskOnly.length === 0) return live
  return [...diskOnly, ...live]
}


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

export function settleAgentForeground(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  setAppState: SetAppState,
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


function terminalPatch(
  task: LocalAgentTaskState,
  status: TaskStatus,
  patch: Partial<LocalAgentTaskState>,
): LocalAgentTaskState {
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

export function failAgentTask(taskId: string, error: string, setAppState: SetAppState): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return terminalPatch(task, 'failed', { error })
  })
  void evictTaskOutput(taskId)
}

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

export function markAgentsNotified(taskId: string, setAppState: SetAppState): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task =>
    task.notified ? task : { ...task, notified: true },
  )
}


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

const deferredPublishes = new Map<string, ReturnType<typeof setTimeout>>()

const USAGE_SETTLE_GRACE_MS = 750

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
  envelopeBlock?: string
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


export const LocalAgentTask: Task = {
  name: 'LocalAgentTask',
  type: 'local_agent',
  async kill(taskId, setAppState) {
    logForDebugging(`killing agent task ${taskId}`)
    killAsyncAgent(taskId, setAppState)
  },
}
