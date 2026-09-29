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
  isInProcessCrewmateTask,
  type InProcessCrewmateTaskState,
} from '../../tasks/InProcessCrewmateTask/types.js'
import {
  AGENT_WINDOW_RESUME_NOTE,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentReceiptRow,
  getProgressUpdate,
  updateProgressFromMessage,
  usageWindowPauseOf,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { pauseLineWords, type AgentPauseV1 } from '../../tasks/LocalAgentTask/agentPause.js'
import { CREW_ACCOUNT_RESUME_NOTE, crewAccountResumeSummary, subscribeCrewAccountChange } from '../crew/crewAccountChange.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import type { PermissionDecision, PermissionMode } from '../../types/permissions.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  processMailboxPermissionResponse,
  registerPermissionCallback,
  unregisterPermissionCallback,
} from '../../hooks/useSwarmPermissionPoller.js'
import { runWithAgentContext, type CrewmateAgentContext } from '../agentContext.js'
import { createChildAbortController } from '../abortController.js'
import { runWithCwdOverride } from '../cwd.js'
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
import { runWithCrewmateContext, type CrewmateContext } from '../crewmateContext.js'
import { setLiveBusy, subscribeLiveMessagesFor, markLiveMessageRead, liveMessagesFor, sendLiveMessage } from '../../services/crew/liveComms.js'
import { createIdleNotification, createShutdownApprovedMessage, formatCrewmateMessages, getLastPeerDmSummary, isPermissionResponse, isShutdownRequest, resolveShutdownRequestSender, type ShutdownRequestMessage } from '../../services/crew/liveMessages.js'
import { tokenCountWithEstimation } from '../tokens.js'
import { createContentReplacementState } from '../toolResultStorage.js'
import { deriveRunnerAgentDefinition } from './agentLaunchPlan.js'
import { CREW_LEAD_NAME } from './constants.js'
import {
  getLeaderSetToolPermissionContext,
  getLeaderToolUseConfirmQueue,
} from './leaderPermissionBridge.js'
import { createPermissionRequest, sendPermissionRequestViaMailbox } from './permissionSync.js'
import { getRoleSystemPrompt, type ResolvedCrewmateRole } from './roleResolver.js'
import { readCrewFileAsync, removeMemberByAgentId, setMemberActive } from './crewHelpers.js'
import { formatCharterForContext, formatRolePacketForContext } from './crewCharter.js'
import { buildCrewmateAddendum } from './crewmatePromptAddendum.js'


export type FirstDispatchOutcome = { ok: true } | { ok: false; cause: string }

export type InProcessRunnerConfig = {
  identity: {
    agentId: string
    agentName: string
    crewName: string
    color?: string
    planModeRequired: boolean
    parentSessionId: string
  }
  taskId: string
  prompt: string
  agentDefinition?: AgentDefinition
  role?: ResolvedCrewmateRole
  crewmateContext: CrewmateContext
  toolUseContext: ToolUseContext
  abortController: AbortController
  model?: string
  cwd?: string
  effortOverride?: string
  transcriptAgentId?: string
  resume?: {
    transcriptAgentId: string
    prompt: string
    messages: Message[]
    contentReplacementState?: ReturnType<typeof createContentReplacementState>
  }
  systemPrompt?: string
  systemPromptMode?: 'default' | 'replace' | 'append'
  allowedTools?: string[]
  allowPermissionPrompts?: boolean
  description?: string
  invokingRequestId?: string
  onFirstDispatch?: (outcome: FirstDispatchOutcome) => void
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

function updateCrewmateTask(
  taskId: string,
  setAppState: SetAppState,
  mutate: (task: InProcessCrewmateTaskState) => InProcessCrewmateTaskState,
): void {
  setAppState(prevState => {
    const task = prevState.tasks[taskId]
    if (!task || !isInProcessCrewmateTask(task)) return prevState
    return { ...prevState, tasks: { ...prevState.tasks, [taskId]: mutate(task) } }
  })
}

function wrapAsCrewmateMessage(
  from: string,
  text: string,
  color?: string,
  summary?: string,
): string {
  return formatCrewmateMessages([
    {
      from,
      text,
      timestamp: new Date().toISOString(),
      ...(color !== undefined ? { color } : {}),
      ...(summary !== undefined ? { summary } : {}),
    },
  ])
}


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
      logForDebugging(`crewmate ${identity.agentName}: task claim failed (${outcome.reason ?? 'unknown'})`)
      return null
    }
    await updateTask(taskListId, claimable.id, { status: 'in_progress' })
    return `Complete all open tasks on the crew task list, starting with task ${claimable.id}: ${claimable.subject}${claimable.description ? `\n\n${claimable.description}` : ''}`
  } catch (error) {
    logForDebugging(`crewmate ${identity.agentName}: task claim errored: ${errorMessage(error)}`)
    return null
  }
}


type NextInput =
  | { kind: 'aborted' }
  | { kind: 'shutdown'; request: ShutdownRequestMessage; text: string; sender: string }
  | { kind: 'message'; text: string; from: string; color?: string; summary?: string }

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
  const unsubscribeMailbox = subscribeLiveMessagesFor(identity.crewName, identity.agentName, () => wake(), { immediate: false })
  const unsubscribeTasks = onTasksUpdated(() => wake())
  signal.addEventListener('abort', wake)

  try {
    for (let firstIteration = true; ; firstIteration = false) {
      const setAppState = setAppStateOf(toolUseContext)
      let pendingUserMessage: string | undefined
      setAppState(prevState => {
        const task = prevState.tasks[taskId]
        if (!task || !isInProcessCrewmateTask(task)) return prevState
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

      if (signal.aborted) return { kind: 'aborted' }

      try {
        const messages = await liveMessagesFor(identity.crewName, identity.agentName)
        const unread = messages.filter(message => !message.read)

        for (const message of unread) {
          const parsed = isShutdownRequest(message.text)
          if (!parsed) continue
          const sender = resolveShutdownRequestSender(message.from, parsed)
          if (sender === null) {
            logForDebugging(
              `crewmate ${identity.agentName}: skipped a shutdown request whose declared sender disagrees with its envelope`,
            )
            continue
          }
          await markLiveMessageRead(identity.crewName, identity.agentName, message)
          return { kind: 'shutdown', request: parsed, text: message.text, sender }
        }

        const selected = unread.find(message => message.from === CREW_LEAD_NAME) ?? unread[0]
        if (selected !== undefined) {
          await markLiveMessageRead(identity.crewName, identity.agentName, selected)
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
          `crewmate ${identity.agentName}: mailbox poll failed: ${errorMessage(error)}`,
        )
      }

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


function buildCrewmatePermissionFn(
  identity: InProcessRunnerConfig['identity'],
  turnController: AbortController,
  reportPermissionWait: (elapsedMs: number) => void,
): CanUseToolFn {
  return async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) => {
    const evaluated =
      forceDecision ?? (await hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseID))
    if (evaluated.behavior !== 'ask') return evaluated

    const refusal = (): PermissionDecision => ({
      behavior: 'ask',
      message: SUBAGENT_REJECT_MESSAGE,
    })

    if (turnController.signal.aborted) return refusal()

    const appState = toolUseContext.getAppState()
    const description = await tool.description(input, {
      toolPermissionContext: appState.toolPermissionContext,
      tools: toolUseContext.options.tools,
      isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
    })
    if (turnController.signal.aborted) return refusal()

    const queueSetter = getLeaderToolUseConfirmQueue()
    if (queueSetter !== null) {
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
            onUserInteraction: () => {},
            onAbort: () => {
              settle(refusal())
            },
            onAllow: (updatedInput, permissionUpdates, feedback, contentBlocks) => {
              persistPermissionUpdates(permissionUpdates)
              if (permissionUpdates.length > 0) {
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
                settle({ ...rechecked, updatedInput: input, userModified: false })
              }
            },
          },
        ])
      })
    }

    const request = createPermissionRequest({
      toolName: tool.name,
      toolUseId: toolUseID,
      input: input as Record<string, unknown>,
      description,
      permissionSuggestions: evaluated.suggestions,
      workerId: identity.agentId,
      workerName: identity.agentName,
      ...(identity.color !== undefined ? { workerColor: identity.color } : {}),
      crewName: identity.crewName,
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

      void sendPermissionRequestViaMailbox(request)

      pollTimer = setInterval(() => {
        void (async () => {
          try {
            if (turnController.signal.aborted) {
              settle(refusal())
              return
            }
            const messages = await liveMessagesFor(identity.crewName, identity.agentName)
            for (const message of messages) {
              if (message.read) continue
              const response = isPermissionResponse(message.text)
              if (!response || response.request_id !== request.id) continue
              if (message.from !== CREW_LEAD_NAME) {
                logForDebugging(
                  `crewmate ${identity.agentName}: ignored a permission response from non-lead sender ${message.from}`,
                )
                continue
              }
              await markLiveMessageRead(identity.crewName, identity.agentName, message)
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
              `crewmate ${identity.agentName}: permission poll failed: ${errorMessage(error)}`,
            )
          }
        })()
      }, 500)
      pollTimer.unref?.()
    })
  }
}


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
  await sendLiveMessage(identity.crewName, {
    to: CREW_LEAD_NAME,
    from: identity.agentName,
    text: JSON.stringify(notification),
    timestamp: new Date().toISOString(),
    ...(identity.color !== undefined ? { color: identity.color } : {}),
  })
}

function noteMemberActive(identity: InProcessRunnerConfig['identity'], active: boolean): void {
  setMemberActive(identity.crewName, identity.agentName, active).catch((error: unknown) => {
    logForDebugging(`crewmate ${identity.agentName}: active flag write failed: ${errorMessage(error)}`)
  })
  setLiveBusy(identity.crewName, identity.agentName, active).catch((error: unknown) => {
    logForDebugging(`crewmate ${identity.agentName}: live busy write failed: ${errorMessage(error)}`)
  })
}

async function approveIdleShutdown(
  identity: InProcessRunnerConfig['identity'],
  request: ShutdownRequestMessage,
): Promise<void> {
  const roster = await readCrewFileAsync(identity.crewName).catch(() => null)
  const member = roster?.members.find(candidate => candidate.agentId === identity.agentId) as
    | { tmuxPaneId?: string; backendType?: string }
    | undefined
  const approved = createShutdownApprovedMessage({
    requestId: request.requestId,
    from: identity.agentName,
    paneId: member?.tmuxPaneId || undefined,
    backendType: member?.backendType || undefined,
  })
  const delivered = await sendLiveMessage(identity.crewName, {
    to: CREW_LEAD_NAME,
    from: identity.agentName,
    text: JSON.stringify(approved),
    timestamp: new Date().toISOString(),
    ...(identity.color !== undefined ? { color: identity.color } : {}),
  })
  if (!delivered) logForDebugging(`crewmate ${identity.agentName}: the shutdown approval could not be written to the lead's mailbox`)
}


export async function runInProcessCrewmate(
  config: InProcessRunnerConfig,
): Promise<InProcessRunnerResult> {
  const { identity, taskId, toolUseContext } = config
  const setAppState = setAppStateOf(toolUseContext)
  const allMessages: Message[] = []
  let firstDispatchSettled = false
  let firstDispatch: FirstDispatchOutcome | undefined
  const settleFirstDispatch = (outcome: FirstDispatchOutcome): void => {
    if (firstDispatchSettled) return
    firstDispatchSettled = true
    firstDispatch = outcome
    try {
      config.onFirstDispatch?.(outcome)
    } catch (error) {
      logForDebugging(`crewmate ${identity.agentName}: first-dispatch listener failed: ${errorMessage(error)}`)
    }
  }

  const agentContext: CrewmateAgentContext = {
    agentType: 'crewmate',
    agentId: identity.agentId,
    agentName: identity.agentName,
    crewName: identity.crewName,
    ...(identity.color !== undefined ? { agentColor: identity.color } : {}),
    planModeRequired: identity.planModeRequired,
    parentSessionId: identity.parentSessionId,
    isCrewLead: false,
    ...(config.invokingRequestId !== undefined
      ? { invokingRequestId: config.invokingRequestId }
      : {}),
    invocationKind: config.resume === undefined ? 'spawn' : 'resume',
    invocationEmitted: false,
  }
  let currentPrompt =
    config.resume?.prompt ??
    wrapAsCrewmateMessage(CREW_LEAD_NAME, config.prompt, undefined, config.description)
  await claimNextAvailableTask(identity)

  try {
    const options = toolUseContext.options
    let composedSystemPrompt: string
    if (config.systemPromptMode === 'replace' && config.systemPrompt !== undefined) {
      composedSystemPrompt = config.systemPrompt
    } else {
      const role = config.role
      const base = await getSystemPrompt(
        options.tools,
        options.mainLoopModel,
        undefined,
        options.mcpClients,
      )
      const parts: string[] = [base.join('\n'), buildCrewmateAddendum()]
      const agentDefinition = config.agentDefinition
      if (agentDefinition) {
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

    const effectiveModel = getAgentModel(derivedDefinition.model, options.mainLoopModel, config.model)
    const compactThreshold = getAutoCompactThreshold(effectiveModel)

    updateCrewmateTask(taskId, setAppState, task => ({
      ...task,
      messages: appendCappedMessage(task.messages, createUserMessage({ content: currentPrompt })),
    }))

    let contentReplacementState = config.resume?.contentReplacementState ?? (
      toolUseContext.contentReplacementState !== undefined
        ? { ...createContentReplacementState(), budgetChars: toolUseContext.contentReplacementState.budgetChars }
        : undefined
    )

    const accumulated: Message[] = [...(config.resume?.messages ?? [])]
    let exitRequested = false

    while (!config.abortController.signal.aborted && !exitRequested) {
      const turnController = createChildAbortController(config.abortController)
      updateCrewmateTask(taskId, setAppState, task => ({
        ...task,
        currentWorkAbortController: turnController,
      }))

      const userMessage = createUserMessage({ content: currentPrompt })

      if (tokenCountWithEstimation(accumulated) > compactThreshold) {
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
          { isRecompaction: false, turnsSincePreviousCompact: -1, autoCompactThreshold: compactThreshold },
        )
        const compacted = buildPostCompactMessages(compaction)
        accumulated.length = 0
        accumulated.push(...compacted)
        resetMicrocompactState()
        if (contentReplacementState !== undefined) {
          contentReplacementState = { ...createContentReplacementState(), budgetChars: contentReplacementState.budgetChars }
        }
        updateCrewmateTask(taskId, setAppState, task => ({
          ...task,
          messages: [...compacted, userMessage],
        }))
      }

      const forkContextMessages = accumulated.length > 0 ? [...accumulated] : undefined
      accumulated.push(userMessage)

      const progressTracker = createProgressTracker()
      const resolveActivity = createActivityDescriptionResolver(options.tools)
      const turnMessages: Message[] = []

      const stateNow = toolUseContext.getAppState()
      const taskNow = stateNow.tasks[taskId]
      const liveMode: PermissionMode =
        taskNow && isInProcessCrewmateTask(taskNow) && taskNow.permissionMode
          ? taskNow.permissionMode
          : 'default'
      const perTurnDefinition = { ...derivedDefinition, permissionMode: liveMode }

      let turnInterrupted = false
      await runWithCrewmateContext(config.crewmateContext, () =>
        runWithAgentContext(agentContext, async () => {
          updateCrewmateTask(taskId, setAppState, task => ({
            ...task,
            status: 'running',
            isIdle: false,
          }))
          noteMemberActive(identity, true)
          const permissionFn = buildCrewmatePermissionFn(identity, turnController, elapsedMs => {
            updateCrewmateTask(taskId, setAppState, task => ({
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
            canShowPermissionPrompts: config.allowPermissionPrompts ?? true,
            ...(forkContextMessages !== undefined ? { forkContextMessages } : {}),
            querySource: 'agent:custom',
            override: {
              abortController: turnController,
              ...(config.transcriptAgentId !== undefined ? { agentId: config.transcriptAgentId } : {}),
            },
            ...(config.model !== undefined ? { model: config.model } : {}),
            ...(config.effortOverride !== undefined ? { effortOverride: config.effortOverride } : {}),
            onResolvedIdentity: identity => {
              if (identity.effort === undefined) return
              updateCrewmateTask(taskId, setAppState, task => (task.effort === identity.effort ? task : { ...task, effort: identity.effort }))
            },
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
            if (!firstDispatchSettled && message.type === 'assistant') {
              if (isSyntheticApiErrorMessage(message) && usageWindowPauseOf([message], config.model ?? effectiveModel) === null) {
                const failedContent = message.message.content
                settleFirstDispatch({
                  ok: false,
                  cause: (typeof failedContent === 'string' ? failedContent : extractTextContent(failedContent)) || 'API error',
                })
              } else {
                settleFirstDispatch({ ok: true })
              }
            }
            accumulated.push(message)
            turnMessages.push(message)
            allMessages.push(message)
            updateProgressFromMessage(progressTracker, message, resolveActivity, options.tools)
            updateCrewmateTask(taskId, setAppState, task => {
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

      updateCrewmateTask(taskId, setAppState, task => ({
        ...task,
        currentWorkAbortController: undefined,
      }))
      if (config.abortController.signal.aborted) {
        settleFirstDispatch({ ok: false, cause: 'the seat was stopped before its first response' })
        break
      }
      settleFirstDispatch({ ok: true })

      if (turnInterrupted) {
        updateCrewmateTask(taskId, setAppState, task => ({
          ...task,
          messages: appendCappedMessage(
            task.messages,
            createAssistantAPIErrorMessage({ content: ERROR_MESSAGE_USER_ABORT }),
          ),
        }))
      }

      let wasAlreadyIdle = false
      setAppState(prevState => {
        const task = prevState.tasks[taskId]
        if (!task || !isInProcessCrewmateTask(task)) return prevState
        wasAlreadyIdle = task.isIdle
        for (const callback of task.onIdleCallbacks ?? []) {
          try {
            callback()
          } catch {
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
      noteMemberActive(identity, false)

      if (wasAlreadyIdle) {
        logForDebugging(`crewmate ${identity.agentName}: already idle — no idle notification`)
      } else {
        const lastAssistant = getLastAssistantMessage(turnMessages)
        const summary = getLastPeerDmSummary(allMessages)
        const windowPause = !turnInterrupted && lastAssistant !== undefined && isSyntheticApiErrorMessage(lastAssistant) ? usageWindowPauseOf(turnMessages, config.model ?? effectiveModel) : null
        if (windowPause !== null) {
          const refusal = lastAssistant!.message.content
          const cause = new Error((typeof refusal === 'string' ? refusal : extractTextContent(refusal)) || 'API error')
          pauseCrewmateRun(config, setAppState, windowPause, cause)
          await tellLeadPaused(identity, windowPause)
          armCrewmatePauseResume(config, windowPause)
          return { success: false, error: cause, messages: allMessages }
        }
        if (turnInterrupted) {
          await sendIdleNotificationToLead(identity, 'interrupted', {
            ...(summary !== undefined ? { summary } : {}),
          })
        } else if (lastAssistant !== undefined && isSyntheticApiErrorMessage(lastAssistant)) {
          const content = lastAssistant.message.content
          const failureReason =
            (typeof content === 'string' ? content : extractTextContent(content)) || 'API error'
          await sendIdleNotificationToLead(identity, 'failed', {
            failureReason,
            ...(summary !== undefined ? { summary } : {}),
          })
          if (firstDispatch !== undefined && !firstDispatch.ok) {
            const cause = new Error(failureReason)
            terminalizeCrewmateRun(config, setAppState, 'failed', cause)
            return { success: false, error: cause, messages: allMessages }
          }
        } else {
          await sendIdleNotificationToLead(identity, 'available', {
            ...(summary !== undefined ? { summary } : {}),
          })
        }
      }

      const next = await waitForNextInput(
        identity,
        taskId,
        toolUseContext,
        config.abortController.signal,
      )
      if (next.kind === 'aborted') {
        exitRequested = true
      } else if (next.kind === 'shutdown') {
        const sender = next.sender || next.request.from || CREW_LEAD_NAME
        const wrapped = wrapAsCrewmateMessage(sender, next.text)
        updateCrewmateTask(taskId, setAppState, task => ({
          ...task,
          shutdownRequested: true,
          messages: appendCappedMessage(task.messages, createUserMessage({ content: wrapped })),
        }))
        await approveIdleShutdown(identity, next.request)
        exitRequested = true
      } else if (next.from === 'user') {
        currentPrompt = next.text
      } else {
        const wrapped = wrapAsCrewmateMessage(next.from, next.text, next.color, next.summary)
        updateCrewmateTask(taskId, setAppState, task => ({
          ...task,
          messages: appendCappedMessage(task.messages, createUserMessage({ content: wrapped })),
        }))
        currentPrompt = wrapped
      }
    }

    terminalizeCrewmateRun(config, setAppState, 'completed', undefined)
    return { success: true, messages: allMessages }
  } catch (error) {
    const cause = error instanceof Error ? error : new Error('unknown error')
    logError(error)
    settleFirstDispatch({ ok: false, cause: cause.message })
    terminalizeCrewmateRun(config, setAppState, 'failed', cause)
    const summary = undefined
    void summary
    await sendIdleNotificationToLead(identity, 'failed', {
      failureReason: cause.message,
    }).catch(notifyError => {
      logForDebugging(
        `crewmate ${identity.agentName}: failure notification failed: ${errorMessage(notifyError)}`,
      )
    })
    return { success: false, error: cause, messages: allMessages }
  }
}

function terminalizeCrewmateRun(
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
    if (!task || !isInProcessCrewmateTask(task) || task.status !== 'running') return prevState
    wasRunning = true
    capturedToolUseId = task.toolUseId
    for (const callback of task.onIdleCallbacks ?? []) {
      try {
        callback()
      } catch {
      }
    }
    task.unregisterCleanup?.()
    const lastMessage = task.messages?.[task.messages.length - 1]
    const nextTask: InProcessCrewmateTaskState = {
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
    const crewContext = prevState.crewContext
    const crewmates = crewContext?.crewmates
    let nextCrewContext = crewContext
    if (status === 'failed' && crewContext && crewmates && (identity.agentName in crewmates || identity.agentId in crewmates)) {
      const remaining = { ...crewmates }
      delete remaining[identity.agentName]
      delete remaining[identity.agentId]
      nextCrewContext = { ...crewContext, crewmates: remaining }
    }
    return {
      ...prevState,
      tasks: { ...prevState.tasks, [taskId]: nextTask },
      ...(nextCrewContext !== crewContext ? { crewContext: nextCrewContext } : {}),
    }
  })
  if (wasRunning && status === 'failed') {
    removeMemberByAgentId(identity.crewName, identity.agentId).catch((error: unknown) => {
      logForDebugging(`crewmate ${identity.agentName}: roster removal after the failure failed: ${errorMessage(error)}`)
    })
  }

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

function pauseCrewmateRun(
  config: InProcessRunnerConfig,
  setAppState: SetAppState,
  pause: AgentPauseV1,
  cause: Error,
): void {
  const { taskId } = config
  let wasRunning = false
  let capturedToolUseId: string | undefined
  setAppState(prevState => {
    const task = prevState.tasks[taskId]
    if (!task || !isInProcessCrewmateTask(task) || task.status !== 'running') return prevState
    wasRunning = true
    capturedToolUseId = task.toolUseId
    for (const callback of task.onIdleCallbacks ?? []) {
      try {
        callback()
      } catch {
        continue
      }
    }
    task.unregisterCleanup?.()
    const lastMessage = task.messages?.[task.messages.length - 1]
    const nextTask: InProcessCrewmateTaskState = {
      ...task,
      status: 'failed',
      notified: true,
      endTime: Date.now(),
      error: cause.message,
      isIdle: true,
      paused: pause,
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
  void evictTaskOutput(taskId)
  if (wasRunning) {
    emitTaskTerminatedSdk(taskId, 'failed', {
      ...(capturedToolUseId !== undefined ? { toolUseId: capturedToolUseId } : {}),
      summary: `${config.identity.agentId} ${pauseLineWords(pause, Date.now())}`,
    })
  }
}

export function crewmatePausedWords(name: string, pause: AgentPauseV1, nowMs: number): string {
  return `Crewmate "${name}" ${pauseLineWords(pause, nowMs)}`
}

async function tellLeadPaused(identity: InProcessRunnerConfig['identity'], pause: AgentPauseV1): Promise<void> {
  const delivered = await sendLiveMessage(identity.crewName, {
    to: CREW_LEAD_NAME,
    from: identity.agentName,
    text: crewmatePausedWords(identity.agentName, pause, Date.now()),
    timestamp: new Date().toISOString(),
    ...(identity.color !== undefined ? { color: identity.color } : {}),
  }).catch(() => false)
  if (!delivered) logForDebugging(`crewmate ${identity.agentName}: the pause notice could not be written to the lead's mailbox`)
}

const armedCrewmateResumes = new Map<string, () => void>()

export function cancelCrewmatePauseResume(taskId: string): boolean {
  const cancel = armedCrewmateResumes.get(taskId)
  if (cancel === undefined) return false
  cancel()
  return true
}

function armCrewmatePauseResume(config: InProcessRunnerConfig, pause: AgentPauseV1): void {
  const { taskId, identity, toolUseContext } = config
  cancelCrewmatePauseResume(taskId)
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    unsubscribe?.()
    unsubscribe = undefined
    armedCrewmateResumes.delete(taskId)
  }
  const stillPaused = (): boolean => {
    const row = toolUseContext.getAppState().tasks[taskId]
    return isInProcessCrewmateTask(row) && row.status !== 'running' && row.paused !== undefined
  }
  const fire = async (accountChanged: boolean): Promise<void> => {
    disarm()
    if (!stillPaused()) return
    const { resumeCrewmateFromTranscript } = await import('../../services/agents/operatorResume.js')
    const receipt = await resumeCrewmateFromTranscript(taskId, {
      getAppState: toolUseContext.getAppState,
      toolUseContext,
      prompt: accountChanged ? CREW_ACCOUNT_RESUME_NOTE : AGENT_WINDOW_RESUME_NOTE,
    })
    if (receipt.outcome === 'refused') {
      logForDebugging(`crewmate ${identity.agentName}: the automatic resume after the pause was refused: ${receipt.reason}`)
      return
    }
    enqueueAgentReceiptRow({
      taskId: receipt.taskId,
      description: receipt.description,
      summary: accountChanged
        ? crewAccountResumeSummary(`Crewmate "${identity.agentName}"`)
        : `Crewmate "${identity.agentName}" resumed by itself — the usage window reset; its partial work carried forward`,
    })
  }
  if (pause.resumesAtMs !== undefined) {
    timer = setTimeout(() => {
      void fire(false)
    }, Math.max(1_000, pause.resumesAtMs - Date.now() + 1_000))
    timer.unref?.()
  }
  unsubscribe = subscribeCrewAccountChange(() => {
    void fire(true)
  })
  armedCrewmateResumes.set(taskId, disarm)
}

export function startInProcessCrewmate(config: InProcessRunnerConfig): void {
  const agentId = config.identity.agentId
  const life = (): Promise<InProcessRunnerResult> => runInProcessCrewmate(config)
  ;(config.cwd !== undefined ? runWithCwdOverride(config.cwd, life) : life()).catch((error: unknown) => {
    logError(error)
    logForDebugging(`in-process crewmate ${agentId} rejected: ${errorMessage(toError(error))}`)
  })
}
