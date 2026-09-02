import { randomBytes } from 'node:crypto'

import type { SetAppState } from '../Task.js'
import { createTaskStateBase } from '../Task.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../types/message.js'
import type { AgentId } from '../types/ids.js'
import type { QueryParams } from '../run-core/turn-machine.js'
import { query } from '../query.js'
import { runWithAgentContext } from '../utils/agentContext.js'
import { createAbortController } from '../utils/abortController.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logError } from '../utils/log.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import { getAgentTranscriptPath } from '../utils/sessionStorage/paths.js'
import { recordSidechainTranscript } from '../utils/sessionStorage/writer.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import {
  evictTaskOutput,
  getTaskOutputPath,
  initTaskOutputAsSymlink,
} from '../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../utils/task/framework.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../constants/xml.js'
import { escapeXml } from '../utils/xml.js'
import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import { isLocalAgentTask } from './LocalAgentTask/LocalAgentTask.js'

/**
 * Backgrounding the main session's query as a task, and starting a fresh
 * detached background session. There is no separate state shape — this
 * reuses the background-agent state with the main-session agent type.
 */

/** The main-session agent type (contract data). */
const MAIN_SESSION_AGENT_TYPE = 'main-session'

/** Main-session task ids use the `s` prefix (contract data) so they stay
 *  distinguishable from agent tasks — a separate generator over the same
 *  alphabet and length, not a row in the kind→prefix table. */
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function generateMainSessionTaskId(): string {
  const bytes = randomBytes(8)
  let suffix = ''
  for (const byte of bytes) {
    suffix += TASK_ID_ALPHABET[byte % TASK_ID_ALPHABET.length]
  }
  return `s${suffix}`
}

/** Bounded recent-activity window (contract data). */
const MAX_RECENT_ACTIVITIES = 5

export type LocalMainSessionTaskState = LocalAgentTaskState & {
  agentType: typeof MAIN_SESSION_AGENT_TYPE
}

/** A main-session task is an agent task whose agent type is main-session. */
export function isMainSessionTask(task: unknown): task is LocalMainSessionTaskState {
  return isLocalAgentTask(task) && task.agentType === MAIN_SESSION_AGENT_TYPE
}

/** The previously-foregrounded main-session task, if any. */
let foregroundedTaskId: string | undefined

/** The default definition for a session not started with an explicit agent. */
function defaultMainSessionDefinition(): AgentDefinition {
  return {
    agentType: MAIN_SESSION_AGENT_TYPE,
    whenToUse: 'main session query',
    source: 'userSettings',
    systemPrompt: '',
  } as unknown as AgentDefinition
}

/**
 * Register the current session's query as a backgrounded task. The output
 * file is linked to an isolated per-task transcript path — never the main
 * session's own transcript file (a detached query still writing after a
 * clear would otherwise append into a different, fresh conversation; its
 * own file also lets it outlive the clear, which re-points the link when
 * the session identifier changes).
 *
 * A supplied abort controller is REUSED, never replaced: only the
 * controller an already-running query is listening to can stop it.
 */
export function registerMainSessionTask(
  description: string,
  setAppState: SetAppState,
  mainThreadAgentDefinition?: AgentDefinition,
  existingAbortController?: AbortController,
): { taskId: string; abortSignal: AbortSignal } {
  const taskId = generateMainSessionTaskId()
  void initTaskOutputAsSymlink(taskId, getAgentTranscriptPath(taskId as AgentId))
  const abortController = existingAbortController ?? createAbortController()
  const cleanup = registerCleanup(async () => {
    setAppState(prevState => {
      if (!prevState.tasks?.[taskId]) return prevState
      const tasks = { ...prevState.tasks }
      delete tasks[taskId]
      return { ...prevState, tasks }
    })
  })
  const definition = mainThreadAgentDefinition ?? defaultMainSessionDefinition()
  const state: LocalMainSessionTaskState = {
    ...createTaskStateBase(taskId, 'local_agent', description),
    type: 'local_agent',
    status: 'running',
    agentId: taskId,
    prompt: description,
    selectedAgent: definition,
    agentType: MAIN_SESSION_AGENT_TYPE,
    abortController,
    cleanup,
    isBackgrounded: true,
  }
  registerTask(state, setAppState)
  return { taskId, abortSignal: abortController.signal }
}

/**
 * Complete a backgrounded main-session task. Ignored unless running. The
 * retained message list is truncated to its last element (memory). A
 * still-backgrounded task enqueues the notification (fixed label — two
 * different backgrounded sessions produce identically-worded summaries) at
 * the queue's default priority; a foregrounded one emits no XML
 * notification (the user is watching) but is still marked notified and
 * still emits the SDK task-terminated event, so the started bookend closes
 * and the eviction guards pass.
 */
export function completeMainSessionTask(
  taskId: string,
  success: boolean,
  setAppState: SetAppState,
): void {
  let wasRunning = false
  let wasBackgrounded = false
  let toolUseId: string | undefined
  updateTaskState<LocalMainSessionTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    wasRunning = true
    wasBackgrounded = task.isBackgrounded
    toolUseId = task.toolUseId
    task.cleanup?.()
    return {
      ...task,
      status: success ? 'completed' : 'failed',
      endTime: Date.now(),
      messages: task.messages?.length ? [task.messages[task.messages.length - 1]!] : task.messages,
      abortController: undefined,
      cleanup: undefined,
    }
  })
  if (!wasRunning) return
  void evictTaskOutput(taskId)

  if (wasBackgrounded) {
    let shouldEnqueue = false
    updateTaskState<LocalMainSessionTaskState>(taskId, setAppState, task => {
      if (task.notified) return task
      shouldEnqueue = true
      return { ...task, notified: true }
    })
    if (!shouldEnqueue) return
    const summary = success ? 'Background session completed' : 'Background session failed'
    const toolUseIdLine = toolUseId
      ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
      : ''
    enqueuePendingNotification({
      value: `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${getTaskOutputPath(taskId)}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${success ? 'completed' : 'failed'}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`,
      mode: 'task-notification',
    })
  } else {
    let flipped = false
    updateTaskState<LocalMainSessionTaskState>(taskId, setAppState, task => {
      if (task.notified) return task
      flipped = true
      return { ...task, notified: true }
    })
    if (flipped) {
      emitTaskTerminatedSdk(taskId, success ? 'completed' : 'failed', {
        toolUseId,
        outputFile: getTaskOutputPath(taskId),
      })
    }
  }
}

/**
 * Foreground a main-session task: mark it not-backgrounded, record it as
 * the foregrounded task, and restore any previously-foregrounded one to
 * backgrounded. Returns the task's accumulated messages.
 */
export function foregroundMainSessionTask(
  taskId: string,
  setAppState: SetAppState,
): Message[] | undefined {
  let messages: Message[] | undefined
  let found = false
  updateTaskState<LocalMainSessionTaskState>(taskId, setAppState, task => {
    if (!isLocalAgentTask(task)) return task
    found = true
    messages = task.messages
    if (!task.isBackgrounded) return task
    return { ...task, isBackgrounded: false }
  })
  if (!found) return undefined
  const previous = foregroundedTaskId
  foregroundedTaskId = taskId
  if (previous !== undefined && previous !== taskId) {
    updateTaskState<LocalAgentTaskState>(previous, setAppState, task =>
      task.isBackgrounded ? task : { ...task, isBackgrounded: true },
    )
  }
  return messages
}

/** A reduced per-turn activity (tool name + input only — no description,
 *  no classification; UI consumers must tolerate both shapes). */
type ReducedActivity = { toolName: string; input: unknown }

/**
 * Start a fresh detached background session: register the task, seed its
 * isolated transcript with the conversation so far, then drive an
 * independent query inside an agent context scoped to this chain (the
 * foreground session is unaffected). The context's identity — agent id =
 * task id, subagent name main-session, built-in — is what lets skills
 * invoked by this query be attributed to the task, which is what lets a
 * conversation clear preserve them selectively.
 */
export function startBackgroundSession(args: {
  messages: Message[]
  queryParams: Omit<QueryParams, 'messages'>
  description: string
  setAppState: SetAppState
  agentDefinition?: AgentDefinition
}): string {
  const { taskId, abortSignal } = registerMainSessionTask(
    args.description,
    args.setAppState,
    args.agentDefinition,
    args.queryParams.toolUseContext?.abortController,
  )

  // Seed the sidechain transcript with the inherited context, remembering
  // the last recorded identity so live writes chain onto it.
  let lastRecordedUuid: string | null = null
  const seeded = recordSidechainTranscript(args.messages, taskId)
    .then(() => {
      const last = args.messages[args.messages.length - 1]
      lastRecordedUuid = (last?.uuid as string | undefined) ?? null
    })
    .catch(error => {
      logError(error)
    })

  void runWithAgentContext(
    { agentType: 'subagent', agentId: taskId, subagentName: MAIN_SESSION_AGENT_TYPE, isBuiltIn: true },
    async () => {
      let accumulated: Message[] = args.messages
      let estimatedTokens = 0
      // The wire's own counts when the response carries usage (the same
      // definition LocalAgentTask reports: the last response's input side
      // plus the running output) — the character estimate over assistant
      // text stands in only until a usage record arrives, so two cards side
      // by side show the same quantity (FN-018 rank 20).
      let latestInputTokens = 0
      let totalOutputTokens = 0
      let sawUsage = false
      let toolCount = 0
      let recentActivities: ReducedActivity[] = []
      let succeeded = true
      try {
        for await (const event of query({
          ...(args.queryParams as QueryParams),
          messages: args.messages,
        })) {
          if (abortSignal.aborted) {
            let alreadyNotified = true
            updateTaskState<LocalMainSessionTaskState>(taskId, args.setAppState, task => {
              if (task.notified) return task
              alreadyNotified = false
              return { ...task, notified: true }
            })
            if (!alreadyNotified) {
              emitTaskTerminatedSdk(taskId, 'stopped', { summary: args.description })
            }
            return
          }
          const message = event as Message
          if (
            message.type !== 'user' &&
            message.type !== 'assistant' &&
            message.type !== 'system'
          ) {
            continue
          }
          accumulated = [...accumulated, message]

          // Incremental sidechain write, chained to the previous recorded
          // identity — task output stays live and survives a mid-run
          // symlink re-link. Failures are logged, never thrown.
          void seeded.then(() =>
            recordSidechainTranscript([message], taskId, lastRecordedUuid as never)
              .then(() => {
                lastRecordedUuid = (message.uuid as string | undefined) ?? lastRecordedUuid
              })
              .catch(error => {
                logError(error)
              }),
          )

          let countersChanged = false
          if (message.type === 'assistant') {
            const usage = message.message.usage
            if (usage) {
              const latest = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
              if (latest > 0) latestInputTokens = latest
              totalOutputTokens += usage.output_tokens ?? 0
              sawUsage = true
              countersChanged = true
            }
            const content = message.message.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text') {
                  estimatedTokens += roughTokenCountEstimation(block.text)
                  countersChanged = true
                } else if (block.type === 'tool_use') {
                  toolCount++
                  countersChanged = true
                  recentActivities = [
                    ...recentActivities,
                    { toolName: block.name, input: block.input },
                  ]
                  if (recentActivities.length > MAX_RECENT_ACTIVITIES) {
                    recentActivities = recentActivities.slice(-MAX_RECENT_ACTIVITIES)
                  }
                }
              }
            }
          }

          // Re-render avoidance: skip the state write entirely when nothing
          // changed; reuse the activity array when the tool count did not.
          if (!countersChanged) continue
          const tokensSnapshot = sawUsage ? latestInputTokens + totalOutputTokens : estimatedTokens
          const toolsSnapshot = toolCount
          const activitiesSnapshot = recentActivities
          const messagesSnapshot = accumulated
          updateTaskState<LocalMainSessionTaskState>(taskId, args.setAppState, task => {
            if (task.status !== 'running') return task
            return {
              ...task,
              messages: messagesSnapshot,
              progress: {
                toolUseCount: toolsSnapshot,
                tokenCount: tokensSnapshot,
                recentActivities: activitiesSnapshot as never,
              },
            }
          })
        }
        // Normal loop exit.
      } catch (error) {
        logError(error)
        succeeded = false
      }
      completeMainSessionTask(taskId, succeeded, args.setAppState)
    },
  )

  return taskId
}
