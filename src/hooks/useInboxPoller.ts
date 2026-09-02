// ============================================================================
//  src/hooks/useInboxPoller.ts — the teammate/lead mailbox engine.
//
//  Turns mailbox arrivals into turns: classify → authorise → act →
//  deliver-or-queue → scoped mark-read, plus the idle drain over the pending
//  queue. This is the message-loss boundary: delivery/queueing always happens
//  BEFORE the mark, and the mark is scoped to exactly this poll's snapshot.
// ============================================================================
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

/** The safety tick: insurance against a lost watcher notification only —
 *  ordinary delivery is event-driven off the store subscription. */
const SAFETY_TICK_MS = 5000
/** The undelivered pending list is bounded to the most recent entries. */
const PENDING_INBOX_CAP = 500
/** The fixed accent the worker badge renders in. */
const WORKER_BADGE_COLOR = 'cyan'
/** Desktop-notification type for both worker permission asks (contract data). */
const WORKER_PERMISSION_NOTIFICATION = 'worker_permission_prompt'

type PermissionResolution = Parameters<typeof sendPermissionResponseViaMailbox>[1]

type UseInboxPollerArgs = {
  enabled: boolean
  isLoading: boolean
  focusedInputDialog: string | undefined
  /** Returns whether the submission was accepted (a running query rejects). */
  onSubmitMessage: (content: string) => boolean
}

/**
 * Who polls: process-based teammates under their own agent name; a team lead
 * under the lead's roster name (falling back to the conventional lead name);
 * in-process teammates and standalone sessions not at all. The in-process
 * skip is graceful — the leader's render can occur while an in-process
 * teammate's context is active.
 */
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

/** The scoped-mark composite key: unambiguous because the sender is an agent
 *  name and the timestamp an ISO stamp, neither containing a space, and the
 *  text is the final field. */
function messageKey(message: { from: string; timestamp: string; text: string }): string {
  return `${message.from} ${message.timestamp} ${message.text}`
}

/**
 * The pending-buffer back-pressure decision (pure; the prover drives it).
 * When the in-memory pending queue is at capacity, incoming messages are
 * REFUSED rather than accepted-then-evicted: an accepted message is never
 * silently dropped after its disk copy was marked read, and the refused
 * ones (the newest, so delivery order is preserved) stay UNREAD on disk —
 * the durable buffer — for a later poll once the queue drains. The sender's
 * success receipt therefore never outruns delivery. Returns which incoming
 * messages fit and the scoped-mark keys of those left unread.
 */
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

/**
 * The one delivery decision for inbound teammate messages (pure — the
 * prover drives the whole table). A session in a bypass-permissions mode
 * executes whatever a delivered message asks without prompting, so a peer
 * could launder actions through it: with the hold gate on, such arrivals
 * are HELD until the operator returns to a prompting mode. Prompting-mode
 * sessions deliver exactly as before: submit when idle, park when busy.
 */
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

  // Freshest-closure refs: the store subscription must stay STABLE across
  // busy/dialog-state flips — rebuilding it per flip would tear down the
  // watcher and land its subscribe-time immediate poll on top of a poll
  // already under way.
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

  // Serialisation: one poll at a time; a request during a poll sets the
  // run-again flag, and the re-run begins only AFTER the prior poll's
  // mark-as-read has published (reads take no lock — two side-by-side polls
  // could each see the same message unread and deliver it twice).
  const pollInFlightRef = useRef(false)
  const pollAgainRef = useRef(false)

  // Returns the scoped-mark keys of any message REFUSED by the cap (left
  // unread on disk) so the caller does not mark it read.
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
        // Never silent, never lost: a long-busy session with a chatty peer
        // holds the overflow unread on disk instead of dropping it.
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

  // Returns the scoped-mark keys of any message NOT absorbed (refused by the
  // cap) — the caller must leave those unread on disk.
  const deliverOrQueue = (regular: TeammateMessage[]): Set<string> => {
    if (regular.length === 0) return new Set()
    const idle = !isLoadingRef.current && !focusedInputDialogRef.current
    const verdict = classifyInboundDelivery({
      idle,
      bypassMode: modeBypassesPermissions(toolPermissionContextRef.current.mode),
      holdGateOn: flagEnabled('MERCURY_INBOX_HOLD_BYPASS'),
    })
    if (verdict === 'hold') {
      // Visible park (the InboxParkNotice line); released by the
      // mode-return effect below, never auto-submitted.
      return queuePendingMessages(regular, 'held')
    }
    if (verdict === 'submit') {
      const accepted = onSubmitMessageRef.current(formatTeammateMessages(regular))
      if (accepted) return new Set()
      // A rejected submission (a query is already running) falls back to
      // queueing — never dropped.
    }
    return queuePendingMessages(regular)
  }

  const pollOnce = async (agent: string, team: string | undefined): Promise<void> => {
    const snapshot = await readUnreadMessages(agent, team)
    if (snapshot.length === 0) return
    const deliveredKeys = new Set(snapshot.map(messageKey))

    // ── plan approval, teammate side: a pre-pass over the whole unread
    // batch, before classification. Only the team lead's response counts (a
    // peer must not forge an approval); the response also flows on as a
    // regular message so the model sees the approval it just acted on.
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
        const outcome = setPermissionModeWithGuards(targetMode, toolPermissionContextRef.current, updater =>
          setAppState(previous => ({
            ...previous,
            toolPermissionContext: updater(previous.toolPermissionContext),
          })),
        )
        if (!outcome.ok) logForDebugging(`[InboxPoller] plan-approval mode change refused: ${outcome.error}`)
      }
    }

    // ── classification: each unread message lands in exactly one bucket.
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
    // Bus envelopes are delivered as turns; the separate bucket only gives
    // the bus a defined place to hook routing in.
    regular.push(...busEnvelopes)

    // ── permission requests, lead side.
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
        // First request of the batch: a desktop notification when idle and
        // undialogued — even when the queue is unavailable below.
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
        // Every outcome writes back keyed by request id, resolver = leader.
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
          // Inert: permission state lives on the worker.
          recheckPermission: async () => {},
        }
        // Dedup by tool-use id: a failed mark-as-read re-reads the same
        // message on the next poll and must not enqueue a duplicate.
        setQueue(previous =>
          previous.some(existing => existing.toolUseID === entry.toolUseID) ? previous : [...previous, entry],
        )
      }
    }

    // ── permission responses, worker side: only the team lead's word counts.
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

    // ── sandbox permission requests: RETIRED with the dedicated sandbox
    // chain (the stranded-estate walk) — a worker's sandbox ask rides the
    // ONE ask road now (structuredIO canUseTool → the daemon's permission
    // asks → the consent card); the mailbox shape is ignored here.

    // ── sandbox permission responses, worker side: lead-only, same forge guard.
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

    // ── team permission updates, teammate side: lead-only, session scope.
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

    // ── mode-set requests, teammate side: lead-only, session scope; the
    // stored member mode follows so the lead's UI reflects it.
    for (const m of modeSetRequests) {
      if (m.from !== TEAM_LEAD_NAME) continue
      const request = isModeSetRequest(m.text)
      if (!request) continue
      const outcome = setPermissionModeWithGuards(request.mode, toolPermissionContextRef.current, updater =>
        setAppState(previous => ({
          ...previous,
          toolPermissionContext: updater(previous.toolPermissionContext),
        })),
      )
      if (!outcome.ok) {
        logForDebugging(`[InboxPoller] mode-set refused: ${outcome.error}`)
        continue
      }
      syncTeammateMode(request.mode, team)
    }

    // ── plan-approval requests, lead side: auto-approved; the teammate must
    // not inherit plan mode, and the request also flows on as a turn so the
    // model is told what the teammate is about to do.
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
      // When the requester is an in-process teammate task, the approval is
      // applied to that task's state too.
      const taskId = findInProcessTaskIdIn(tasksRef.current, request.from)
      if (taskId) setAwaitingPlanApproval(taskId, setAppState, false)
      regular.push(m)
    }

    // ── shutdown requests, teammate side: identity from the VERIFIED
    // envelope sender only, then the send-path authority gate re-applied on
    // receipt. The team file is read once per poll batch.
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
        // With no resolvable self name only the sender-binding check applies.
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
        // Survivors pass through as regular messages so the UI renders them
        // and the model can act.
        regular.push(m)
      }
    }

    // ── shutdown approvals, lead side: the victim is the verified envelope
    // sender; the pane comes from the roster, never the message body.
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
      // Kill is fire-and-forget; an in-process teammate has no roster pane
      // and terminates itself — the removal still runs.
      const paneId = victimEntry?.[1]?.tmuxPaneId
      if (paneId) {
        void (async () => {
          const detection = await detectAndGetBackend()
          // A lead running OUTSIDE the backend's native environment must
          // pass the external-session flag or the kill targets the wrong
          // context and the pane survives its own shutdown approval.
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
        // A process-based teammate has no local runner to move its task to
        // completed; without this such tasks show as running indefinitely.
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

    // ── deliver-or-queue, then the scoped mark. The ordering is the whole
    // point: die anywhere before the mark and the envelopes are still unread
    // on disk for the next poll; invert it and they are absent. A message the
    // pending buffer refused at capacity is EXCLUDED from the mark — it
    // stays unread on disk (the durable buffer) rather than being reported
    // delivered while actually dropped.
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

  // The subscription is stable across busy/dialog flips (it invokes the
  // freshest closure through the ref) and rebuilt only when the resolved
  // agent or team changes — that is a different mailbox.
  useEffect(() => {
    if (!enabled || !agentName) return
    const store = getMailboxStore(agentName, teamName)
    // One immediate fire per subscription; re-poll on each change.
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

  // ── hold release: held messages exist because bypass modes execute
  // without prompting — the moment the operator returns to a prompting
  // mode, delivery stops being a laundering vector and the hold flips to
  // the ordinary pending drain below. The operator's mode switch IS the
  // approval, and it is mechanical.
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

  // ── idle drain: a separate effect, gated on idle and the same
  // do-I-poll identity (a standalone session never drains). Messages already
  // marked processed were delivered mid-turn as attachments and are filtered
  // out by id; only the specific submitted ids clear on success.
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
    // Rejected: the entries stay queued for the next idle window.
  }, [enabled, agentName, teamName, isLoading, focusedInputDialog, pendingCount])
}
