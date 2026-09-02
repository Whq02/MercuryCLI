import { getSystemPrompt } from '../../constants/prompts.js'
import { getAutoCompactThreshold } from '../../services/compact/autoCompact.js'
import {
  buildPostCompactMessages,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
} from '../../services/compact/compact.js'
import { resetMicrocompactState } from '../../services/compact/microCompact.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { runAgent } from '../../tools/AgentTool/runAgent.js'
import {
  appendCappedMessage,
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
} from '../../tasks/InProcessTeammateTask/types.js'
import {
  createActivityDescriptionResolver,
  createProgressTracker,
  getProgressUpdate,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import type { PermissionDecision, PermissionMode } from '../../types/permissions.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  processMailboxPermissionResponse,
  registerPermissionCallback,
  unregisterPermissionCallback,
} from '../../hooks/useSwarmPermissionPoller.js'
import { runWithAgentContext, type TeammateAgentContext } from '../agentContext.js'
import { createChildAbortController } from '../abortController.js'
import { logForDebugging } from '../debug.js'
import { errorMessage, toError } from '../errors.js'
import { cloneFileStateCache } from '../fileStateCache.js'
import { logError } from '../log.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
} from '../messages/factories.js'
import {
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../messages/rejectionText.js'
import { isSyntheticApiErrorMessage } from '../messages/factories.js'
import { getLastAssistantMessage } from '../messages/lookups.js'
import { extractTextContent } from '../messages/text.js'
import { getAgentModel } from '../model/agent.js'
import { hasPermissionsToUseTool } from '../permissions/permissions.js'
import { applyPermissionUpdates, persistPermissionUpdates } from '../permissions/PermissionUpdate.js'
import { emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { evictTaskOutput } from '../task/diskOutput.js'
import { evictTerminalTask, STOPPED_DISPLAY_MS } from '../task/framework.js'
import { claimTask, listTasks, onTasksUpdated, updateTask } from '../tasks.js'
import { runWithTeammateContext, type TeammateContext } from '../teammateContext.js'
import {
  createIdleNotification,
  formatTeammateMessages,
  getLastPeerDmSummary,
  getMailboxStore,
  isPermissionResponse,
  isShutdownRequest,
  markSpecificMessageAsRead,
  readMailbox,
  resolveShutdownRequestSender,
  writeToMailbox,
  type ShutdownRequestMessage,
} from '../teammateMailbox.js'
import { tokenCountWithEstimation } from '../tokens.js'
import { createContentReplacementState } from '../toolResultStorage.js'
import { deriveRunnerAgentDefinition } from './agentLaunchPlan.js'
import { TEAM_LEAD_NAME } from './constants.js'
import {
  getLeaderSetToolPermissionContext,
  getLeaderToolUseConfirmQueue,
} from './leaderPermissionBridge.js'
import { createPermissionRequest, sendPermissionRequestViaMailbox } from './permissionSync.js'
import { getRoleSystemPrompt, type ResolvedTeammateRole } from './roleResolver.js'
import { formatCharterForContext, formatRolePacketForContext } from './teamCharter.js'
import { buildTeammateAddendum } from './teammatePromptAddendum.js'

/**
 * The in-process teammate run loop: one teammate for its whole life — many
 * prompt turns, idle waits in between, ending only on abort or a
 * model-approved shutdown.
 *
 * (The snapshot's performance-trace registration around the loop is absent
 * with the deleted tracer — not built, by ruling.)
 */

export type InProcessRunnerConfig = {
  identity: {
    agentId: string
    agentName: string
    teamName: string
    color?: string
    planModeRequired: boolean
    parentSessionId: string
  }
  taskId: string
  prompt: string
  agentDefinition?: AgentDefinition
  role?: ResolvedTeammateRole
  teammateContext: TeammateContext
  toolUseContext: ToolUseContext
  abortController: AbortController
  model?: string
  systemPrompt?: string
  systemPromptMode?: 'default' | 'replace' | 'append'
  allowedTools?: string[]
  allowPermissionPrompts?: boolean
  description?: string
  invokingRequestId?: string
}

export type InProcessRunnerResult = {
  success: boolean
  error?: Error
  messages: Message[]
}

type SetAppState = (updater: (prevState: AppState) => AppState) => void

function setAppStateOf(context: ToolUseContext): SetAppState {
  return context.setAppStateForTasks ?? context.setAppState
}

/** One immutable task-state update, guarded to the teammate task type. */
function updateTeammateTask(
  taskId: string,
  setAppState: SetAppState,
  mutate: (task: InProcessTeammateTaskState) => InProcessTeammateTaskState,
): void {
  setAppState(prevState => {
    const task = prevState.tasks[taskId]
    if (!task || !isInProcessTeammateTask(task)) return prevState
    return { ...prevState, tasks: { ...prevState.tasks, [taskId]: mutate(task) } }
  })
}

/** The teammate-message envelope, through the shared formatter (escaped). */
function wrapAsTeammateMessage(
  from: string,
  text: string,
  color?: string,
  summary?: string,
): string {
  return formatTeammateMessages([
    {
      from,
      text,
      timestamp: new Date().toISOString(),
      ...(color !== undefined ? { color } : {}),
      ...(summary !== undefined ? { summary } : {}),
    },
  ])
}

// ---------------------------------------------------------------------------
// Task claiming
// ---------------------------------------------------------------------------

/**
 * Claim the next available task from the team task list. Claimable: status
 * `pending`, no owner, and none of its blocked-by ids belongs to a
 * NON-completed task present in the list — an id that names no task does not
 * block. All errors are contained: a broken task list must never break the
 * teammate. (The list id is the parent session id — the lead creates tasks
 * under its session id, not the team name; risk R9.)
 */
async function claimNextAvailableTask(identity: InProcessRunnerConfig['identity']): Promise<string | null> {
  try {
    const taskListId = identity.parentSessionId
    const tasks = await listTasks(taskListId)
    const openIds = new Set(tasks.filter(task => task.status !== 'completed').map(task => task.id))
    const claimable = tasks.find(
      task =>
        task.status === 'pending' &&
        !task.owner &&
        task.blockedBy.every(id => !openIds.has(id)),
    )
    if (claimable === undefined) return null
    const outcome = await claimTask(taskListId, claimable.id, identity.agentName)
    if (!outcome.success) {
      logForDebugging(`teammate ${identity.agentName}: task claim failed (${outcome.reason ?? 'unknown'})`)
      return null
    }
    // The UI updates immediately.
    await updateTask(taskListId, claimable.id, { status: 'in_progress' })
    return `Complete all open tasks on the team task list, starting with task ${claimable.id}: ${claimable.subject}${claimable.description ? `\n\n${claimable.description}` : ''}`
  } catch (error) {
    logForDebugging(`teammate ${identity.agentName}: task claim errored: ${errorMessage(error)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Waiting for the next input
// ---------------------------------------------------------------------------

type NextInput =
  | { kind: 'aborted' }
  | { kind: 'shutdown'; request: ShutdownRequestMessage; text: string; sender: string }
  | { kind: 'message'; text: string; from: string; color?: string; summary?: string }

/**
 * A 500 ms-capped poll loop that is event-raced: the teammate's mailbox
 * store and task-list updates both wake the sleep immediately, as does the
 * abort signal; a wake arriving mid-check is recorded as pending and
 * consumed at the next sleep. The fallback timer never keeps the process
 * alive, and every subscription is removed on every exit path.
 */
async function waitForNextInput(
  identity: InProcessRunnerConfig['identity'],
  taskId: string,
  toolUseContext: ToolUseContext,
  signal: AbortSignal,
): Promise<NextInput> {
  let wakePending = false
  let wakeResolve: (() => void) | null = null
  const wake = (): void => {
    const resolve = wakeResolve
    if (resolve !== null) {
      wakeResolve = null
      resolve()
    } else {
      wakePending = true
    }
  }
  const unsubscribeMailbox = getMailboxStore(identity.agentName, identity.teamName).subscribe(
    () => wake(),
    { immediate: false },
  )
  const unsubscribeTasks = onTasksUpdated(() => wake())
  signal.addEventListener('abort', wake)

  try {
    for (let firstIteration = true; ; firstIteration = false) {
      // 1. In-app pending user messages drain first, one per iteration.
      const setAppState = setAppStateOf(toolUseContext)
      let pendingUserMessage: string | undefined
      setAppState(prevState => {
        const task = prevState.tasks[taskId]
        if (!task || !isInProcessTeammateTask(task)) return prevState
        const queue = task.pendingUserMessages ?? []
        const head = queue[0]
        if (head === undefined) return prevState
        pendingUserMessage = head
        return {
          ...prevState,
          tasks: {
            ...prevState.tasks,
            [taskId]: { ...task, pendingUserMessages: queue.slice(1) },
          },
        }
      })
      if (pendingUserMessage !== undefined) {
        return { kind: 'message', text: pendingUserMessage, from: 'user' }
      }

      // 2. Sleep (skipped on the first iteration, so the first check is immediate).
      if (!firstIteration) {
        await new Promise<void>(resolve => {
          if (wakePending || signal.aborted) {
            wakePending = false
            resolve()
            return
          }
          wakeResolve = resolve
          const timer = setTimeout(() => {
            if (wakeResolve !== null) wakeResolve = null
            resolve()
          }, 500)
          timer.unref?.()
        })
      }

      // 3.
      if (signal.aborted) return { kind: 'aborted' }

      // 4. Mailbox, by strict priority; failures log and fall to the task step.
      try {
        const messages = await readMailbox(identity.agentName, identity.teamName)
        const unread = messages.filter(message => !message.read)

        // a. Shutdown requests first, so a flood of peer messages cannot
        //    starve one. The ENVELOPE sender is authoritative; a
        //    body-declared sender that disagrees fails verification and is
        //    skipped — honouring it would both jump the queue and hand the
        //    model a shutdown prompt that appears to come from the lead.
        for (const message of unread) {
          const parsed = isShutdownRequest(message.text)
          if (!parsed) continue
          const sender = resolveShutdownRequestSender(message.from, parsed)
          if (sender === null) {
            logForDebugging(
              `teammate ${identity.agentName}: skipped a shutdown request whose declared sender disagrees with its envelope`,
            )
            continue
          }
          await markSpecificMessageAsRead(identity.agentName, identity.teamName, message)
          return { kind: 'shutdown', request: parsed, text: message.text, sender }
        }

        // b. The lead speaks for the user and for coordination — its
        //    messages never queue behind peer traffic. c. Otherwise FIFO.
        const selected = unread.find(message => message.from === TEAM_LEAD_NAME) ?? unread[0]
        if (selected !== undefined) {
          await markSpecificMessageAsRead(identity.agentName, identity.teamName, selected)
          return {
            kind: 'message',
            text: selected.text,
            from: selected.from,
            ...(selected.color !== undefined ? { color: selected.color } : {}),
            ...(selected.summary !== undefined ? { summary: selected.summary } : {}),
          }
        }
      } catch (error) {
        logForDebugging(
          `teammate ${identity.agentName}: mailbox poll failed: ${errorMessage(error)}`,
        )
      }

      // 5. Nothing selected: try to claim the next available task.
      const claimedPrompt = await claimNextAvailableTask(identity)
      if (claimedPrompt !== null) {
        return { kind: 'message', text: claimedPrompt, from: 'task-list' }
      }
    }
  } finally {
    unsubscribeMailbox()
    unsubscribeTasks()
    signal.removeEventListener('abort', wake)
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

function buildTeammatePermissionFn(
  identity: InProcessRunnerConfig['identity'],
  turnController: AbortController,
  reportPermissionWait: (elapsedMs: number) => void,
): CanUseToolFn {
  return async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) => {
    // 1. The caller's forced decision wins; only `ask` continues.
    const evaluated =
      forceDecision ?? (await hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseID))
    if (evaluated.behavior !== 'ask') return evaluated

    const refusal = (): PermissionDecision => ({
      behavior: 'ask',
      message: SUBAGENT_REJECT_MESSAGE,
    })

    // 2.
    if (turnController.signal.aborted) return refusal()

    // 3.
    const appState = toolUseContext.getAppState()
    const description = await tool.description(input, {
      toolPermissionContext: appState.toolPermissionContext,
      tools: toolUseContext.options.tools,
      isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
    })
    if (turnController.signal.aborted) return refusal()

    const queueSetter = getLeaderToolUseConfirmQueue()
    if (queueSetter !== null) {
      // 4. Preferred path — the leader's confirmation UI, with a worker
      //    badge so the leader sees whose request it is while still getting
      //    the tool-specific UI. Exactly one outcome settles, guarded by a
      //    single latch; the abort LISTENER also removes the entry (the
      //    entry's own abort callback does not — the UI owns removal
      //    there); every settling path reports the wait time.
      const promptStartedAt = Date.now()
      return new Promise<PermissionDecision>(resolve => {
        let decisionMade = false
        const onAbortSignal = (): void => {
          queueSetter(queue => queue.filter(entry => entry.toolUseID !== toolUseID))
          settle(refusal())
        }
        const settle = (decision: PermissionDecision): void => {
          if (decisionMade) return
          decisionMade = true
          turnController.signal.removeEventListener('abort', onAbortSignal)
          reportPermissionWait(Date.now() - promptStartedAt)
          resolve(decision)
        }
        turnController.signal.addEventListener('abort', onAbortSignal)

        queueSetter(queue => [
          ...queue,
          {
            assistantMessage,
            tool,
            description,
            input,
            toolUseContext,
            toolUseID,
            permissionResult: evaluated,
            permissionPromptStartTimeMs: promptStartedAt,
            ...(identity.color !== undefined
              ? { workerBadge: { name: identity.agentName, color: identity.color } }
              : {}),
            // The teammate path has no classifier auto-approval.
            onUserInteraction: () => {},
            onAbort: () => {
              settle(refusal())
            },
            onAllow: (updatedInput, permissionUpdates, feedback, contentBlocks) => {
              persistPermissionUpdates(permissionUpdates)
              if (permissionUpdates.length > 0) {
                // Apply to the current app state's permission context and
                // write back through the leader's shared setter. The setter
                // is called WITHOUT overriding the leader's mode: the
                // context being written back can carry a worker-side mode
                // rewrite, and copying that field onto the lead would
                // silently change the mode the lead operates under. (The
                // write-back rides the preserve-mode option: the setter
                // adopts the incoming mode by default (user-initiated
                // changes land), so the worker write-back passes
                // { preserveMode: true } per spec)
                const contextSetter = getLeaderSetToolPermissionContext()
                if (contextSetter !== null) {
                  const applied = applyPermissionUpdates(
                    toolUseContext.getAppState().toolPermissionContext,
                    permissionUpdates,
                  )
                  contextSetter(applied, { preserveMode: true })
                }
              }
              const trimmedFeedback = feedback?.trim()
              settle({
                behavior: 'allow',
                updatedInput,
                userModified: false,
                ...(trimmedFeedback ? { acceptFeedback: trimmedFeedback } : {}),
                ...(contentBlocks !== undefined ? { contentBlocks } : {}),
              })
            },
            onReject: (feedback, contentBlocks) => {
              const message = feedback
                ? `${SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
                : SUBAGENT_REJECT_MESSAGE
              settle({
                behavior: 'ask',
                message,
                ...(contentBlocks !== undefined ? { contentBlocks } : {}),
              })
            },
            recheckPermission: async () => {
              const rechecked = await hasPermissionsToUseTool(
                tool,
                input,
                toolUseContext,
                assistantMessage,
                toolUseID,
              )
              if (rechecked.behavior === 'allow') {
                queueSetter(queue => queue.filter(entry => entry.toolUseID !== toolUseID))
                // The fresh result is spread whole (decisionReason survives);
                // the ORIGINAL input still wins.
                settle({ ...rechecked, updatedInput: input, userModified: false })
              }
              // Otherwise stay pending.
            },
          },
        ])
      })
    }

    // 5. Fallback path — the mailbox transport. Grants come from the lead
    //    alone: a matching response from any other envelope sender is
    //    skipped (and logged) — without the check a peer's message could
    //    stand in for an approval.
    const request = createPermissionRequest({
      toolName: tool.name,
      toolUseId: toolUseID,
      input: input as Record<string, unknown>,
      description,
      permissionSuggestions: evaluated.suggestions,
      workerId: identity.agentId,
      workerName: identity.agentName,
      ...(identity.color !== undefined ? { workerColor: identity.color } : {}),
      teamName: identity.teamName,
    })
    return new Promise<PermissionDecision>(resolve => {
      let settled = false
      let pollTimer: ReturnType<typeof setInterval> | null = null
      const cleanup = (): void => {
        if (pollTimer !== null) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        unregisterPermissionCallback(request.id)
        turnController.signal.removeEventListener('abort', onAbortSignal)
      }
      // Mailbox waits are excluded from the paused-time total — only the
      // dialog path reports.
      const settle = (decision: PermissionDecision): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(decision)
      }
      const onAbortSignal = (): void => {
        settle(refusal())
      }
      turnController.signal.addEventListener('abort', onAbortSignal)

      registerPermissionCallback({
        requestId: request.id,
        toolUseId: toolUseID,
        onAllow: (updatedInput, permissionUpdates) => {
          persistPermissionUpdates(permissionUpdates)
          const finalInput =
            updatedInput !== undefined && Object.keys(updatedInput).length > 0
              ? updatedInput
              : (input as Record<string, unknown>)
          settle({ behavior: 'allow', updatedInput: finalInput, userModified: false })
        },
        onReject: feedback => {
          const message = feedback
            ? `${SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
            : SUBAGENT_REJECT_MESSAGE
          settle({ behavior: 'ask', message })
        },
      })

      // Sent without awaiting; the response arrives through the poll below.
      void sendPermissionRequestViaMailbox(request)

      pollTimer = setInterval(() => {
        void (async () => {
          try {
            if (turnController.signal.aborted) {
              settle(refusal())
              return
            }
            const messages = await readMailbox(identity.agentName, identity.teamName)
            for (const message of messages) {
              if (message.read) continue
              const response = isPermissionResponse(message.text)
              if (!response || response.request_id !== request.id) continue
              if (message.from !== TEAM_LEAD_NAME) {
                logForDebugging(
                  `teammate ${identity.agentName}: ignored a permission response from non-lead sender ${message.from}`,
                )
                continue
              }
              await markSpecificMessageAsRead(identity.agentName, identity.teamName, message)
              processMailboxPermissionResponse(
                response.subtype === 'success'
                  ? {
                      requestId: request.id,
                      decision: 'approved',
                      ...(response.response?.updated_input !== undefined
                        ? { updatedInput: response.response.updated_input }
                        : {}),
                      ...(response.response?.permission_updates !== undefined
                        ? { permissionUpdates: response.response.permission_updates }
                        : {}),
                    }
                  : { requestId: request.id, decision: 'rejected', feedback: response.error },
              )
              return
            }
          } catch (error) {
            logForDebugging(
              `teammate ${identity.agentName}: permission poll failed: ${errorMessage(error)}`,
            )
          }
        })()
      }, 500)
      pollTimer.unref?.()
    })
  }
}

// ---------------------------------------------------------------------------
// Idle notification (step 12)
// ---------------------------------------------------------------------------

async function sendIdleNotificationToLead(
  identity: InProcessRunnerConfig['identity'],
  reason: 'available' | 'interrupted' | 'failed',
  options: { summary?: string; failureReason?: string } = {},
): Promise<void> {
  const notification = createIdleNotification(identity.agentName, {
    idleReason: reason,
    ...(options.summary !== undefined ? { summary: options.summary } : {}),
    ...(reason === 'failed'
      ? {
          completedStatus: 'failed',
          ...(options.failureReason !== undefined ? { failureReason: options.failureReason } : {}),
        }
      : {}),
  })
  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: identity.agentName,
      text: JSON.stringify(notification),
      timestamp: new Date().toISOString(),
      ...(identity.color !== undefined ? { color: identity.color } : {}),
    },
    identity.teamName,
  )
}

// ---------------------------------------------------------------------------
// The run loop
// ---------------------------------------------------------------------------

/** Runs one teammate for its whole life. Never rejects. */
export async function runInProcessTeammate(
  config: InProcessRunnerConfig,
): Promise<InProcessRunnerResult> {
  const { identity, taskId, toolUseContext } = config
  const setAppState = setAppStateOf(toolUseContext)
  const allMessages: Message[] = []

  // Before the failure band: the analytics agent context, the wrapped
  // initial prompt, and one immediate task-claim attempt so the UI shows
  // real activity from the start (the claim helper contains its own errors).
  const agentContext: TeammateAgentContext = {
    agentType: 'teammate',
    agentId: identity.agentId,
    agentName: identity.agentName,
    teamName: identity.teamName,
    ...(identity.color !== undefined ? { agentColor: identity.color } : {}),
    planModeRequired: identity.planModeRequired,
    parentSessionId: identity.parentSessionId,
    isTeamLead: false,
    ...(config.invokingRequestId !== undefined
      ? { invokingRequestId: config.invokingRequestId }
      : {}),
    invocationKind: 'spawn',
    invocationEmitted: false,
  }
  // No invented summary: an absent description means NO summary attribute
  // on the initial envelope.
  let currentPrompt = wrapAsTeammateMessage(
    TEAM_LEAD_NAME,
    config.prompt,
    undefined,
    config.description,
  )
  await claimNextAvailableTask(identity)

  try {
    // ── Launch composition ──────────────────────────────────────────────
    const options = toolUseContext.options
    let composedSystemPrompt: string
    if (config.systemPromptMode === 'replace' && config.systemPrompt !== undefined) {
      composedSystemPrompt = config.systemPrompt
    } else {
      // The fixed composition order is the profile-layer contract (risk R8):
      // product prompt → teammate addendum → role contract → charter →
      // assignment → append-mode extra.
      const role = config.role
      const base = await getSystemPrompt(
        options.tools,
        options.mainLoopModel,
        undefined,
        options.mcpClients,
      )
      const parts: string[] = [base.join('\n'), buildTeammateAddendum()]
      const agentDefinition = config.agentDefinition
      if (agentDefinition) {
        // Built-in, custom, AND extension definitions alike — an earlier
        // implementation composed only custom ones, silently dropping
        // built-in role prompts in-process. A definition resolving to no
        // role prompt contributes nothing.
        const rolePrompt = getRoleSystemPrompt(agentDefinition, {
          options: toolUseContext.options,
        })
        if (rolePrompt) {
          parts.push(`# Role contract (${agentDefinition.agentType})\n\n${rolePrompt}`)
        }
      }
      if (role?.charter) {
        parts.push(formatCharterForContext(role.charter))
      }
      if (role) {
        parts.push(formatRolePacketForContext(role.rolePacket))
      }
      if (config.systemPromptMode === 'append' && config.systemPrompt !== undefined) {
        parts.push(config.systemPrompt)
      }
      composedSystemPrompt = parts.join('\n')
    }

    const derivedDefinition = deriveRunnerAgentDefinition({
      ...(config.role !== undefined ? { role: config.role } : {}),
      ...(config.agentDefinition !== undefined ? { agentDefinition: config.agentDefinition } : {}),
      displayName: identity.agentName,
      systemPrompt: composedSystemPrompt,
    })

    // The effective model is resolved EXACTLY ONCE through the shared
    // chokepoint and used ONLY to size the auto-compaction threshold; the
    // agent loop still receives the caller's raw override so its own
    // resolution is unchanged. Sizing from the parent's window would let a
    // teammate on a narrower model run past its own limit before compaction
    // ever triggered.
    const effectiveModel = getAgentModel(derivedDefinition.model, options.mainLoopModel, config.model)
    const compactThreshold = getAutoCompactThreshold(effectiveModel)

    updateTeammateTask(taskId, setAppState, task => ({
      ...task,
      messages: appendCappedMessage(task.messages, createUserMessage({ content: currentPrompt })),
    }))

    // Only when the parent context has one, so a disabled feature stays
    // disabled. Persisted across turns (replaced only on compaction): a
    // fresh one each turn would re-decide replacements from scratch,
    // changing the prefix on the wire and throwing away prompt-cache hits.
    let contentReplacementState =
      toolUseContext.contentReplacementState !== undefined
        ? createContentReplacementState()
        : undefined

    const accumulated: Message[] = []
    let exitRequested = false

    // ── Turn loop ───────────────────────────────────────────────────────
    while (!config.abortController.signal.aborted && !exitRequested) {
      // 1. The two aborts mean different things: the per-turn child ends
      //    only the current turn; a lifecycle abort must reach the model
      //    call and its tools.
      const turnController = createChildAbortController(config.abortController)
      updateTeammateTask(taskId, setAppState, task => ({
        ...task,
        currentWorkAbortController: turnController,
      }))

      // 2.
      const userMessage = createUserMessage({ content: currentPrompt })

      // 3. Auto-compaction against an ISOLATED copy of the context — a
      //    cloned read-file cache, no progress or stream-mode callbacks —
      //    so it neither clears the main session's file cache nor drives
      //    the main session's UI.
      if (tokenCountWithEstimation(accumulated) > compactThreshold) {
        // A compaction failure propagates to the failure band — the runner
        // must terminalize rather than loop on an over-budget conversation.
        const isolated: ToolUseContext = {
          ...toolUseContext,
          readFileState: cloneFileStateCache(toolUseContext.readFileState),
        }
        delete (isolated as { onCompactProgress?: unknown }).onCompactProgress
        delete (isolated as { setStreamMode?: unknown }).setStreamMode
        const compaction = await compactConversation(
          accumulated,
          isolated,
          {
            systemPrompt: asSystemPrompt([]),
            userContext: {},
            systemContext: {},
            toolUseContext: isolated,
            forkContextMessages: [],
          },
          true,
          undefined,
          true,
          // The threshold this runner compares against is the fold's ceiling.
          { isRecompaction: false, turnsSincePreviousCompact: -1, autoCompactThreshold: compactThreshold },
        )
        const compacted = buildPostCompactMessages(compaction)
        accumulated.length = 0
        accumulated.push(...compacted)
        resetMicrocompactState()
        if (contentReplacementState !== undefined) {
          // All previous tool-use ids are absent.
          contentReplacementState = createContentReplacementState()
        }
        updateTeammateTask(taskId, setAppState, task => ({
          ...task,
          messages: [...compacted, userMessage],
        }))
      }

      // 4. Fork context = the (possibly compacted) history; the new user
      //    message then joins the accumulated conversation.
      const forkContextMessages = accumulated.length > 0 ? [...accumulated] : undefined
      accumulated.push(userMessage)

      // 5.
      const progressTracker = createProgressTracker()
      const resolveActivity = createActivityDescriptionResolver(options.tools)
      const turnMessages: Message[] = []

      // 6. The live permission mode (the leader can cycle it from the UI).
      const stateNow = toolUseContext.getAppState()
      const taskNow = stateNow.tasks[taskId]
      const liveMode: PermissionMode =
        taskNow && isInProcessTeammateTask(taskNow) && taskNow.permissionMode
          ? taskNow.permissionMode
          : 'default'
      const perTurnDefinition = { ...derivedDefinition, permissionMode: liveMode }

      // 7–8. Run the shared agent loop inside the teammate and analytics
      //      contexts, streaming into both buffers and the task state.
      let turnInterrupted = false
      await runWithTeammateContext(config.teammateContext, () =>
        runWithAgentContext(agentContext, async () => {
          updateTeammateTask(taskId, setAppState, task => ({
            ...task,
            status: 'running',
            isIdle: false,
          }))
          const permissionFn = buildTeammatePermissionFn(identity, turnController, elapsedMs => {
            updateTeammateTask(taskId, setAppState, task => ({
              ...task,
              totalPausedMs: (task.totalPausedMs ?? 0) + elapsedMs,
            }))
          })
          for await (const message of runAgent({
            agentDefinition: perTurnDefinition,
            promptMessages: [userMessage],
            toolUseContext,
            canUseTool: permissionFn,
            isAsync: true,
            // Permissive by default — risk R10, reproduced deliberately.
            canShowPermissionPrompts: config.allowPermissionPrompts ?? true,
            ...(forkContextMessages !== undefined ? { forkContextMessages } : {}),
            querySource: 'agent:custom',
            override: { abortController: turnController },
            ...(config.model !== undefined ? { model: config.model } : {}),
            preserveToolUseResults: true,
            availableTools: options.tools,
            ...(config.allowedTools !== undefined ? { allowedTools: config.allowedTools } : {}),
            ...(contentReplacementState !== undefined ? { contentReplacementState } : {}),
          })) {
            if (config.abortController.signal.aborted) break
            if (turnController.signal.aborted) {
              turnInterrupted = true
              break
            }
            accumulated.push(message)
            turnMessages.push(message)
            allMessages.push(message)
            updateProgressFromMessage(progressTracker, message, resolveActivity, options.tools)
            updateTeammateTask(taskId, setAppState, task => {
              const inProgress = new Set(task.inProgressToolUseIDs ?? [])
              if (message.type === 'assistant' && Array.isArray(message.message.content)) {
                for (const block of message.message.content) {
                  if (block.type === 'tool_use') inProgress.add(block.id)
                }
              }
              if (message.type === 'user' && Array.isArray(message.message.content)) {
                for (const block of message.message.content) {
                  if (block.type === 'tool_result') inProgress.delete(block.tool_use_id)
                }
              }
              return {
                ...task,
                progress: getProgressUpdate(progressTracker),
                messages: appendCappedMessage(task.messages, message),
                inProgressToolUseIDs: inProgress,
              }
            })
          }
        }),
      )

      // 9.
      updateTeammateTask(taskId, setAppState, task => ({
        ...task,
        currentWorkAbortController: undefined,
      }))
      if (config.abortController.signal.aborted) break

      // 10. The interruption stays visible in the teammate's scrollback.
      if (turnInterrupted) {
        updateTeammateTask(taskId, setAppState, task => ({
          ...task,
          messages: appendCappedMessage(
            task.messages,
            createAssistantAPIErrorMessage({ content: ERROR_MESSAGE_USER_ABORT }),
          ),
        }))
      }

      // 11. Idle transition. The teammate's answer is NOT forwarded to the
      //     lead automatically — teammates communicate by tool, matching
      //     pane-based teammates.
      let wasAlreadyIdle = false
      setAppState(prevState => {
        const task = prevState.tasks[taskId]
        if (!task || !isInProcessTeammateTask(task)) return prevState
        wasAlreadyIdle = task.isIdle
        for (const callback of task.onIdleCallbacks ?? []) {
          try {
            callback()
          } catch {
            // An idle waiter throwing must not break the transition.
          }
        }
        return {
          ...prevState,
          tasks: {
            ...prevState.tasks,
            [taskId]: { ...task, isIdle: true, onIdleCallbacks: [] },
          },
        }
      })

      // 12. Idle notification, only on a TRANSITION into idle.
      if (wasAlreadyIdle) {
        logForDebugging(`teammate ${identity.agentName}: already idle — no idle notification`)
      } else {
        const lastAssistant = getLastAssistantMessage(turnMessages)
        const summary = getLastPeerDmSummary(allMessages)
        if (turnInterrupted) {
          await sendIdleNotificationToLead(identity, 'interrupted', {
            ...(summary !== undefined ? { summary } : {}),
          })
        } else if (lastAssistant !== undefined && isSyntheticApiErrorMessage(lastAssistant)) {
          // A provider decline is not a clean "available".
          const content = lastAssistant.message.content
          const failureReason =
            (typeof content === 'string' ? content : extractTextContent(content)) || 'API error'
          await sendIdleNotificationToLead(identity, 'failed', {
            failureReason,
            ...(summary !== undefined ? { summary } : {}),
          })
        } else {
          await sendIdleNotificationToLead(identity, 'available', {
            ...(summary !== undefined ? { summary } : {}),
          })
        }
      }

      // 13. Wait for the next input and dispatch.
      const next = await waitForNextInput(
        identity,
        taskId,
        toolUseContext,
        config.abortController.signal,
      )
      if (next.kind === 'aborted') {
        exitRequested = true
      } else if (next.kind === 'shutdown') {
        // The runner must never auto-approve; the model decides with its
        // approve/reject shutdown tools. Attribution uses the VERIFIED
        // sender (falling back to the body-declared sender, then the lead).
        const sender = next.sender || next.request.from || TEAM_LEAD_NAME
        const wrapped = wrapAsTeammateMessage(sender, next.text)
        updateTeammateTask(taskId, setAppState, task => ({
          ...task,
          messages: appendCappedMessage(task.messages, createUserMessage({ content: wrapped })),
        }))
        currentPrompt = wrapped
      } else if (next.from === 'user') {
        // Plain, not XML-wrapped, and NOT mirrored — the injector already did.
        currentPrompt = next.text
      } else {
        const wrapped = wrapAsTeammateMessage(next.from, next.text, next.color, next.summary)
        updateTeammateTask(taskId, setAppState, task => ({
          ...task,
          messages: appendCappedMessage(task.messages, createUserMessage({ content: wrapped })),
        }))
        currentPrompt = wrapped
      }
    }

    // ── Terminalisation on normal exit ──────────────────────────────────
    terminalizeTeammateRun(config, setAppState, 'completed', undefined)
    return { success: true, messages: allMessages }
  } catch (error) {
    // ── Terminalisation on error: the caller starts this fire-and-forget
    //    and swallows rejections — an escaping throw would orphan a
    //    `running` row with no bookend and no notification to the lead. ──
    const cause = error instanceof Error ? error : new Error('unknown error')
    logError(error)
    terminalizeTeammateRun(config, setAppState, 'failed', cause)
    const summary = undefined
    void summary
    await sendIdleNotificationToLead(identity, 'failed', {
      failureReason: cause.message,
    }).catch(notifyError => {
      logForDebugging(
        `teammate ${identity.agentName}: failure notification failed: ${errorMessage(notifyError)}`,
      )
    })
    return { success: false, error: cause, messages: allMessages }
  }
}

/**
 * One state update; a row that is not `running` (e.g. a kill already
 * terminalised it) is never changed — the runner must not flip a `killed`
 * row to `completed` or double-emit a bookend.
 */
function terminalizeTeammateRun(
  config: InProcessRunnerConfig,
  setAppState: SetAppState,
  status: 'completed' | 'failed',
  cause: Error | undefined,
): void {
  const { taskId, identity } = config
  let wasRunning = false
  let capturedToolUseId: string | undefined
  setAppState(prevState => {
    const task = prevState.tasks[taskId]
    if (!task || !isInProcessTeammateTask(task) || task.status !== 'running') return prevState
    wasRunning = true
    capturedToolUseId = task.toolUseId
    for (const callback of task.onIdleCallbacks ?? []) {
      try {
        callback()
      } catch {
        // Contained.
      }
    }
    task.unregisterCleanup?.()
    const lastMessage = task.messages?.[task.messages.length - 1]
    const nextTask: InProcessTeammateTaskState = {
      ...task,
      status,
      notified: true,
      endTime: Date.now(),
      ...(status === 'failed'
        ? { error: cause?.message ?? 'unknown error', isIdle: true }
        : {}),
      ...(lastMessage !== undefined ? { messages: [lastMessage] } : { messages: undefined }),
      pendingUserMessages: [],
      inProgressToolUseIDs: undefined,
      abortController: undefined,
      currentWorkAbortController: undefined,
      unregisterCleanup: undefined,
      onIdleCallbacks: [],
    }
    return { ...prevState, tasks: { ...prevState.tasks, [taskId]: nextTask } }
  })

  // A finished teammate lingers long enough to be read; a failed one stays
  // for 30 s so the cause can be seen.
  void evictTaskOutput(taskId)
  const evictionDelay = status === 'failed' ? 30_000 : STOPPED_DISPLAY_MS
  setTimeout(() => evictTerminalTask(taskId, setAppState), evictionDelay)

  if (wasRunning) {
    emitTaskTerminatedSdk(taskId, status, {
      ...(capturedToolUseId !== undefined ? { toolUseId: capturedToolUseId } : {}),
      summary: identity.agentId,
    })
  }
}

/**
 * Fire-and-forget entry point. The agent id is extracted BEFORE the closure
 * so the rejection handler does not retain the whole config object
 * (including the tool-use context) for what may be hours.
 */
export function startInProcessTeammate(config: InProcessRunnerConfig): void {
  const agentId = config.identity.agentId
  runInProcessTeammate(config).catch((error: unknown) => {
    logError(error)
    logForDebugging(`in-process teammate ${agentId} rejected: ${errorMessage(toError(error))}`)
  })
}
