import { useEffect, useRef } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { sendNotification } from '../services/notifier.js'
import type { AppState } from '../state/AppStateStore.js'
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import { getTools } from '../tools.js'
import { generateRequestId } from '../utils/agentId.js'
import { logForDebugging } from '../utils/debug.js'
import { setAwaitingPlanApproval } from '../utils/inProcessTeammateHelpers.js'
import { logError } from '../utils/log.js'
import { createAssistantMessage } from '../utils/messages.js'
import { applyPermissionUpdate } from '../utils/permissions/PermissionUpdate.js'
import { modeBypassesPermissions, toExternalPermissionMode } from '../utils/permissions/PermissionMode.js'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { setPermissionModeWithGuards } from '../utils/permissions/permissionSetup.js'
import { detectAndGetBackend } from '../utils/swarm/backends/registry.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { getLeaderToolUseConfirmQueue } from '../utils/swarm/leaderPermissionBridge.js'
import {
  sendPermissionResponseViaMailbox,
  sendSandboxPermissionResponseViaMailbox,
} from '../utils/swarm/permissionSync.js'
import { canDirect, resolveDirectActor } from '../utils/swarm/sendMessageGovernance.js'
import { readTeamFileAsync, removeTeammateFromTeamFile, syncTeammateMode } from '../utils/swarm/teamHelpers.js'
import { updateTaskState } from '../utils/task/framework.js'
import { unassignTeammateTasks } from '../utils/tasks.js'
import { getAgentName, getTeamName, isTeamLead } from '../utils/teammate.js'
import { isInProcessTeammate } from '../utils/teammateContext.js'
import {
  formatTeammateMessages,
  getMailboxStore,
  markMessagesAsReadByPredicate,
  readUnreadMessages,
  isModeSetRequest,
  isPermissionRequest,
  isPermissionResponse,
  isPlanApprovalRequest,
  isPlanApprovalResponse,
  isSandboxPermissionRequest,
  isSandboxPermissionResponse,
  isShutdownApproved,
  isShutdownRequest,
  isTeamPermissionUpdate,
  resolveShutdownApprovedVictim,
  resolveShutdownRequestSender,
  writeToMailbox,
  type TeammateMessage,
} from '../utils/teammateMailbox.js'
import { processMailboxPermissionResponse, processSandboxPermissionResponse } from './useSwarmPermissionPoller.js'
import { busEnvelopesEnabled, isBusProtocolMessage } from '../utils/swarm/busEnvelopes.js'

const SAFETY_TICK_MS = 5000
const PENDING_INBOX_CAP = 500
const WORKER_BADGE_COLOR = 'cyan'
const WORKER_PERMISSION_NOTIFICATION = 'worker_permission_prompt'

type PermissionResolution = Parameters<typeof sendPermissionResponseViaMailbox>[1]

type UseInboxPollerArgs = {
  enabled: boolean
  isLoading: boolean
  focusedInputDialog: string | undefined
  onSubmitMessage: (content: string) => boolean
}

function resolvePollingIdentity(teamContext: AppState['teamContext']): {
  agentName: string | undefined
  teamName: string | undefined
} {
  if (isInProcessTeammate()) return { agentName: undefined, teamName: undefined }
  const teamName = getTeamName(teamContext)
  let agentName = getAgentName()
  if (!agentName && isTeamLead(teamContext) && teamContext) {
    agentName = teamContext.teammates[teamContext.leadAgentId]?.name || TEAM_LEAD_NAME
  }
  return { agentName, teamName }
}

function findInProcessTaskIdIn(
  tasks: AppState['tasks'],
  agentName: string,
): string | undefined {
  for (const [taskId, task] of Object.entries(tasks ?? {})) {
    if (isInProcessTeammateTask(task) && task.identity.agentName === agentName) return taskId
  }
  return undefined
}

function messageKey(message: { from: string; timestamp: string; text: string }): string {
  return `${message.from} ${message.timestamp} ${message.text}`
}

export function absorbWithinPendingCap<M extends { from: string; timestamp: string; text: string }>(
  existingCount: number,
  incoming: readonly M[],
  cap: number,
): { absorbed: M[]; refusedKeys: Set<string> } {
  const room = Math.max(0, cap - existingCount)
  const absorbed = incoming.slice(0, room)
  const refusedKeys = new Set(incoming.slice(room).map(messageKey))
  return { absorbed, refusedKeys }
}

export type InboundDeliveryVerdict = 'submit' | 'park-pending' | 'hold'

export function classifyInboundDelivery(args: {
  idle: boolean
  bypassMode: boolean
  holdGateOn: boolean
}): InboundDeliveryVerdict {
  if (args.bypassMode && args.holdGateOn) return 'hold'
  return args.idle ? 'submit' : 'park-pending'
}

export function useInboxPoller({
  enabled,
  isLoading,
  focusedInputDialog,
  onSubmitMessage,
}: UseInboxPollerArgs): void {
  const setAppState = useSetAppState()
  const teamContext = useAppState(state => state.teamContext)
  const toolPermissionContext = useAppState(state => state.toolPermissionContext)
  const inboxMessages = useAppState(state => state.inbox.messages)
  const tasks = useAppState(state => state.tasks)
  const terminal = useTerminalNotification()

  const { agentName, teamName } = resolvePollingIdentity(teamContext)

  const isLoadingRef = useRef(isLoading)
  isLoadingRef.current = isLoading
  const focusedInputDialogRef = useRef(focusedInputDialog)
  focusedInputDialogRef.current = focusedInputDialog
  const onSubmitMessageRef = useRef(onSubmitMessage)
  onSubmitMessageRef.current = onSubmitMessage
  const teamContextRef = useRef(teamContext)
  teamContextRef.current = teamContext
  const toolPermissionContextRef = useRef(toolPermissionContext)
  toolPermissionContextRef.current = toolPermissionContext
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  const pollInFlightRef = useRef(false)
  const pollAgainRef = useRef(false)

  const queuePendingMessages = (
    messages: TeammateMessage[],
    status: 'pending' | 'held' = 'pending',
  ): Set<string> => {
    let refusedKeys = new Set<string>()
    setAppState(previous => {
      const { absorbed, refusedKeys: refused } = absorbWithinPendingCap(
        previous.inbox.messages.length,
        messages,
        PENDING_INBOX_CAP,
      )
      refusedKeys = refused
      if (refused.size > 0) {
        logForDebugging(
          `[InboxPoller] pending inbox at cap — ${refused.size} message(s) held unread on disk for a later poll`,
        )
      }
      if (absorbed.length === 0) return previous
      const appended = [
        ...previous.inbox.messages,
        ...absorbed.map(message => ({
          id: generateRequestId('inbox', message.from),
          from: message.from,
          text: message.text,
          timestamp: message.timestamp,
          status,
          ...(message.color !== undefined ? { color: message.color } : {}),
          ...(message.summary !== undefined ? { summary: message.summary } : {}),
        })),
      ]
      return { ...previous, inbox: { messages: appended } }
    })
    return refusedKeys
  }

  const deliverOrQueue = (regular: TeammateMessage[]): Set<string> => {
    if (regular.length === 0) return new Set()
    const idle = !isLoadingRef.current && !focusedInputDialogRef.current
    const verdict = classifyInboundDelivery({
      idle,
      bypassMode: modeBypassesPermissions(toolPermissionContextRef.current.mode),
      holdGateOn: flagEnabled('MERCURY_INBOX_HOLD_BYPASS'),
    })
    if (verdict === 'hold') {
      return queuePendingMessages(regular, 'held')
    }
    if (verdict === 'submit') {
      const accepted = onSubmitMessageRef.current(formatTeammateMessages(regular))
      if (accepted) return new Set()
    }
    return queuePendingMessages(regular)
  }

  const pollOnce = async (agent: string, team: string | undefined): Promise<void> => {
    const snapshot = await readUnreadMessages(agent, team)
    if (snapshot.length === 0) return
    const deliveredKeys = new Set(snapshot.map(messageKey))

    if (!isTeamLead(teamContextRef.current) && toolPermissionContextRef.current.mode === 'strategy') {
      for (const m of snapshot) {
        const response = isPlanApprovalResponse(m.text)
        if (!response) continue
        if (m.from !== TEAM_LEAD_NAME) continue
        if (!response.approved) {
          logForDebugging(`[InboxPoller] plan approval rejected by ${m.from}`)
          continue
        }
        const targetMode = response.permissionMode ?? 'default'
        const outcome = setPermissionModeWithGuards(
          targetMode,
          toolPermissionContextRef.current,
          updater =>
            setAppState(previous => ({
              ...previous,
              toolPermissionContext: updater(previous.toolPermissionContext),
            })),
          'crew-lead',
        )
        if (!outcome.ok) logForDebugging(`[InboxPoller] plan-approval mode change refused: ${outcome.error}`)
      }
    }

    const permissionRequests: TeammateMessage[] = []
    const permissionResponses: TeammateMessage[] = []
    const sandboxRequests: TeammateMessage[] = []
    const sandboxResponses: TeammateMessage[] = []
    const shutdownRequests: TeammateMessage[] = []
    const shutdownApprovals: TeammateMessage[] = []
    const teamPermissionUpdates: TeammateMessage[] = []
    const modeSetRequests: TeammateMessage[] = []
    const planApprovalRequests: TeammateMessage[] = []
    const busEnvelopes: TeammateMessage[] = []
    const regular: TeammateMessage[] = []
    for (const m of snapshot) {
      if (isPermissionRequest(m.text)) permissionRequests.push(m)
      else if (isPermissionResponse(m.text)) permissionResponses.push(m)
      else if (isSandboxPermissionRequest(m.text)) sandboxRequests.push(m)
      else if (isSandboxPermissionResponse(m.text)) sandboxResponses.push(m)
      else if (isShutdownRequest(m.text)) shutdownRequests.push(m)
      else if (isShutdownApproved(m.text)) shutdownApprovals.push(m)
      else if (isTeamPermissionUpdate(m.text)) teamPermissionUpdates.push(m)
      else if (isModeSetRequest(m.text)) modeSetRequests.push(m)
      else if (isPlanApprovalRequest(m.text)) planApprovalRequests.push(m)
      else if (busEnvelopesEnabled() && isBusProtocolMessage(m.text)) busEnvelopes.push(m)
      else regular.push(m)
    }
    regular.push(...busEnvelopes)

    if (permissionRequests.length > 0) {
      const baseTools = getTools(toolPermissionContextRef.current)
      let notified = false
      for (const m of permissionRequests) {
        const request = isPermissionRequest(m.text)
        if (!request) continue
        const tool = (baseTools as Tool[]).find(candidate => candidate.name === request.tool_name)
        if (!tool) {
          logForDebugging(`[InboxPoller] permission request for unknown tool ${request.tool_name} skipped`)
          continue
        }
        if (!notified) {
          notified = true
          if (!isLoadingRef.current && !focusedInputDialogRef.current) {
            void sendNotification(
              {
                message: `${request.agent_id} needs permission to use ${request.tool_name}`,
                notificationType: WORKER_PERMISSION_NOTIFICATION,
              },
              terminal,
            ).catch(() => {})
          }
        }
        const setQueue = getLeaderToolUseConfirmQueue()
        if (!setQueue) {
          logForDebugging(`[InboxPoller] confirmation queue unavailable — dropping permission request ${request.request_id}`)
          continue
        }
        const respond = (resolution: PermissionResolution): void => {
          void sendPermissionResponseViaMailbox(
            request.agent_id,
            resolution,
            request.request_id,
            team,
          ).catch((error: unknown) => logError(error))
        }
        const entry: ToolUseConfirm = {
          assistantMessage: createAssistantMessage({ content: '' }),
          tool,
          description: request.description,
          input: request.input,
          toolUseContext: {} as ToolUseContext,
          toolUseID: request.tool_use_id,
          permissionResult: { behavior: 'ask', message: request.description },
          permissionPromptStartTimeMs: Date.now(),
          workerBadge: { name: request.agent_id, color: WORKER_BADGE_COLOR },
          onUserInteraction: () => {},
          onAbort: () => respond({ decision: 'rejected', resolvedBy: 'leader' }),
          onReject: feedback =>
            respond({
              decision: 'rejected',
              resolvedBy: 'leader',
              ...(feedback !== undefined ? { feedback } : {}),
            }),
          onAllow: (updatedInput, permissionUpdates) =>
            respond({
              decision: 'approved',
              resolvedBy: 'leader',
              updatedInput,
              permissionUpdates,
            }),
          recheckPermission: async () => {},
        }
        setQueue(previous =>
          previous.some(existing => existing.toolUseID === entry.toolUseID) ? previous : [...previous, entry],
        )
      }
    }

    for (const m of permissionResponses) {
      if (m.from !== TEAM_LEAD_NAME) continue
      const response = isPermissionResponse(m.text)
      if (!response) continue
      if (response.subtype === 'success') {
        processMailboxPermissionResponse({
          requestId: response.request_id,
          decision: 'approved',
          ...(response.response?.updated_input !== undefined
            ? { updatedInput: response.response.updated_input }
            : {}),
          ...(response.response?.permission_updates !== undefined
            ? { permissionUpdates: response.response.permission_updates }
            : {}),
        })
      } else {
        processMailboxPermissionResponse({
          requestId: response.request_id,
          decision: 'rejected',
          feedback: response.error,
        })
      }
    }


    for (const m of sandboxResponses) {
      if (m.from !== TEAM_LEAD_NAME) continue
      const response = isSandboxPermissionResponse(m.text)
      if (!response) continue
      processSandboxPermissionResponse({
        requestId: response.requestId,
        host: response.host,
        allow: response.allow,
      })
    }

    for (const m of teamPermissionUpdates) {
      if (m.from !== TEAM_LEAD_NAME) continue
      const update = isTeamPermissionUpdate(m.text)
      if (!update || !Array.isArray(update.permissionUpdate?.rules) || !update.permissionUpdate?.behavior) {
        logForDebugging('[InboxPoller] malformed team permission update skipped')
        continue
      }
      setAppState(previous => ({
        ...previous,
        toolPermissionContext: applyPermissionUpdate(previous.toolPermissionContext, {
          type: 'addRules',
          rules: update.permissionUpdate.rules,
          behavior: update.permissionUpdate.behavior,
          destination: 'session',
        }),
      }))
    }

    for (const m of modeSetRequests) {
      if (m.from !== TEAM_LEAD_NAME) continue
      const request = isModeSetRequest(m.text)
      if (!request) continue
      const outcome = setPermissionModeWithGuards(
        request.mode,
        toolPermissionContextRef.current,
        updater =>
          setAppState(previous => ({
            ...previous,
            toolPermissionContext: updater(previous.toolPermissionContext),
          })),
        'crew-lead',
      )
      if (!outcome.ok) {
        logForDebugging(`[InboxPoller] mode-set refused: ${outcome.error}`)
        continue
      }
      syncTeammateMode(request.mode, team)
    }

    for (const m of planApprovalRequests) {
      const request = isPlanApprovalRequest(m.text)
      if (!request) continue
      const ownMode = toolPermissionContextRef.current.mode
      const inheritMode = ownMode === 'strategy' ? 'default' : toExternalPermissionMode(ownMode)
      const response = {
        type: 'plan_approval_response' as const,
        requestId: request.requestId,
        approved: true,
        timestamp: new Date().toISOString(),
        permissionMode: inheritMode,
      }
      void writeToMailbox(
        request.from,
        { from: agent, text: JSON.stringify(response), timestamp: new Date().toISOString() },
        team,
      ).catch((error: unknown) => logError(error))
      const taskId = findInProcessTaskIdIn(tasksRef.current, request.from)
      if (taskId) setAwaitingPlanApproval(taskId, setAppState, false)
      regular.push(m)
    }

    if (shutdownRequests.length > 0) {
      const sdTeamFile = team ? await readTeamFileAsync(team).catch(() => null) : null
      const sdSelf = agent
      const sdLeadId = teamContextRef.current?.leadAgentId
      for (const m of shutdownRequests) {
        const request = isShutdownRequest(m.text)
        const verifiedFrom = resolveShutdownRequestSender(m.from, request)
        if (!verifiedFrom) {
          logForDebugging('[InboxPoller] shutdown request dropped: sender binding failed')
          continue
        }
        if (sdSelf) {
          const verdict = canDirect(
            resolveDirectActor(sdTeamFile, verifiedFrom, sdLeadId),
            resolveDirectActor(sdTeamFile, sdSelf, sdLeadId),
          )
          if (!verdict.allowed) {
            logForDebugging(`[InboxPoller] shutdown request from ${verifiedFrom} dropped: no authority`)
            continue
          }
        }
        regular.push(m)
      }
    }

    for (const m of shutdownApprovals) {
      const approval = isShutdownApproved(m.text)
      const victim = resolveShutdownApprovedVictim(m.from, approval)
      if (!victim) {
        logForDebugging('[InboxPoller] shutdown approval ignored: in-body sender disagrees with the envelope')
        continue
      }
      const roster = teamContextRef.current?.teammates ?? {}
      const victimEntry = Object.entries(roster).find(([, teammate]) => teammate.name === victim)
      const victimId = victimEntry?.[0]
      const paneId = victimEntry?.[1]?.tmuxPaneId
      if (paneId) {
        void (async () => {
          const detection = await detectAndGetBackend()
          await detection.backend.killPane(paneId, !detection.isNative)
        })().catch((error: unknown) => {
          logForDebugging(`[InboxPoller] pane kill for ${victim} failed: ${String(error)}`)
        })
      }
      if (victimId && team) {
        removeTeammateFromTeamFile(team, { agentId: victimId, name: victim })
        const unassigned = await unassignTeammateTasks(team, victimId, victim, 'shutdown').catch(
          (error: unknown) => {
            logError(error)
            return null
          },
        )
        const notification =
          (unassigned as { notificationMessage?: string } | null)?.notificationMessage ??
          `${victim} has shut down`
        setAppState(previous => {
          let next = previous
          if (next.teamContext?.teammates && victimId in next.teamContext.teammates) {
            const { [victimId]: _removed, ...remaining } = next.teamContext.teammates
            next = { ...next, teamContext: { ...next.teamContext, teammates: remaining } }
          }
          const appended = [
            ...next.inbox.messages,
            {
              id: generateRequestId('inbox', victim),
              from: victim,
              text: notification,
              timestamp: new Date().toISOString(),
              status: 'pending' as const,
            },
          ]
          next = {
            ...next,
            inbox: {
              messages: appended.length > PENDING_INBOX_CAP ? appended.slice(-PENDING_INBOX_CAP) : appended,
            },
          }
          return next
        })
        const completedTaskId = findInProcessTaskIdIn(tasksRef.current, victim)
        if (completedTaskId) {
          updateTaskState<InProcessTeammateTaskState>(completedTaskId, setAppState, task => ({
            ...task,
            status: 'completed',
            endTime: Date.now(),
          }))
        }
      }
      regular.push(m)
    }

    const refusedKeys = deliverOrQueue(regular)
    await markMessagesAsReadByPredicate(
      agent,
      message => {
        const key = messageKey(message)
        return deliveredKeys.has(key) && !refusedKeys.has(key)
      },
      team,
    )
  }

  const poll = async (): Promise<void> => {
    const identity = resolvePollingIdentity(teamContextRef.current)
    if (!identity.agentName) return
    if (pollInFlightRef.current) {
      pollAgainRef.current = true
      return
    }
    pollInFlightRef.current = true
    try {
      do {
        pollAgainRef.current = false
        await pollOnce(identity.agentName, identity.teamName)
      } while (pollAgainRef.current)
    } catch (error) {
      logError(error)
    } finally {
      pollInFlightRef.current = false
    }
  }
  const pollRef = useRef(poll)
  pollRef.current = poll

  useEffect(() => {
    if (!enabled || !agentName) return
    const store = getMailboxStore(agentName, teamName)
    const unsubscribe = store.subscribe(() => {
      void pollRef.current()
    })
    const safetyTick = setInterval(() => {
      void pollRef.current()
    }, SAFETY_TICK_MS)
    return () => {
      unsubscribe()
      clearInterval(safetyTick)
    }
  }, [enabled, agentName, teamName])

  const bypassModeNow = modeBypassesPermissions(toolPermissionContext.mode)
  const heldCount = inboxMessages.filter(message => message.status === 'held').length
  useEffect(() => {
    if (bypassModeNow || heldCount === 0) return
    setAppState(previous => ({
      ...previous,
      inbox: {
        messages: previous.inbox.messages.map(message =>
          message.status === 'held' ? { ...message, status: 'pending' as const } : message,
        ),
      },
    }))
  }, [bypassModeNow, heldCount, setAppState])

  const pendingCount = inboxMessages.filter(message => message.status === 'pending').length
  useEffect(() => {
    if (!enabled || !agentName) return
    if (isLoading || focusedInputDialog) return
    const processedIds = inboxMessages
      .filter(message => message.status === 'processed')
      .map(message => message.id)
    if (processedIds.length > 0) {
      const drop = new Set(processedIds)
      setAppState(previous => ({
        ...previous,
        inbox: { messages: previous.inbox.messages.filter(message => !drop.has(message.id)) },
      }))
    }
    const pending = inboxMessages.filter(message => message.status === 'pending')
    if (pending.length === 0) return
    const wrapped = formatTeammateMessages(
      pending.map(message => ({
        from: message.from,
        text: message.text,
        timestamp: message.timestamp,
        ...(message.color !== undefined ? { color: message.color } : {}),
        ...(message.summary !== undefined ? { summary: message.summary } : {}),
      })),
    )
    const accepted = onSubmitMessageRef.current(wrapped)
    if (accepted) {
      const submitted = new Set(pending.map(message => message.id))
      setAppState(previous => ({
        ...previous,
        inbox: { messages: previous.inbox.messages.filter(message => !submitted.has(message.id)) },
      }))
    }
  }, [enabled, agentName, teamName, isLoading, focusedInputDialog, pendingCount])
}
