import { existsSync } from 'node:fs'
import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ToolUseContext, type ValidationResult } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import { asAgentId, toAgentId } from '../../types/ids.js'
import { agentStatusWord } from '../../services/resources/adapters/agentStatusWord.js'
import { getAgentTranscriptPath, listAgentMetadata } from '../../utils/sessionStorage/paths.js'
import { readAgentTranscript, transcriptEndWords } from '../WorkflowTool/agentTranscriptReader.js'
import { requestWorkflowControl, workflowControlBy } from '../WorkflowTool/runControl.js'
import { listWorkflowRunsDetailed, runLiveness } from '../WorkflowTool/runManifest.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { pidAlive } from '../../utils/pidAlive.js'
import { daemonControlRpc } from '../../daemon/controlSocket.js'
import { findCrewmateTaskByAgentId, getAllInProcessCrewmateTasks } from '../../tasks/InProcessCrewmateTask/InProcessCrewmateTask.js'
import {
  agentMessageNotice,
  agentMessageSummary,
  enqueueMessageToMainAgent,
  isLocalAgentTask,
  queuePendingMessage,
  speakAgentMessageFrame,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  launchesNamed,
  namedLaunchReceipts,
  recordedLaunchesNamed,
  recordedNamedLaunches,
  type NamedLaunch,
} from '../../tasks/LocalAgentTask/launchReceipts.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { MAIN_THREAD_AGENT } from '../../services/notices/unreadLedger.js'
import { workflowOwnedAgentWords, workflowOwningAgent } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { generateRequestId } from '../../utils/agentId.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseAddress } from '../../utils/peerAddress.js'
import { routerEnabled } from '../../utils/router/routerGates.js'
import {
  buildControl,
  buildDispatch,
  buildEscalate,
  buildProgress,
  busEnvelopesEnabled,
  looksLikeHandSerializedBusPayload,
  serializeBusEnvelope,
  type BusEnvelope,
  type ControlEnvelope,
  type DispatchEnvelope,
  type ProgressEnvelope,
} from '../../utils/swarm/busEnvelopes.js'
import { isCrewRole } from '../../utils/workerRole.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { routerStoreWriters } from '../../substrate/routerRunStore.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { CREW_LEAD_NAME } from '../../utils/swarm/constants.js'
import {
  answerQuestion,
  canDirect,
  checkBroadcastAllowed,
  checkBroadcastFairness,
  openQuestion,
  resolveDirectActor,
  type CrewFileWithGovernance,
} from '../../utils/swarm/sendMessageGovernance.js'
import { HANDOFF_STATUSES, recordHandoff, type EvidenceRef } from '../../utils/swarm/handoff.js'
import { readCrewFileAsync, type CrewFile } from '../../utils/swarm/crewHelpers.js'
import { assignCrewmateColor } from '../../utils/crew/crewmateColors.js'
import {
  getAgentId,
  getAgentName,
  getCrewName,
  getCrewmateColor,
  isCrewLead,
  isCrewmate,
} from '../../utils/crewmate.js'
import { isInProcessCrewmate } from '../../utils/crewmateContext.js'
import { liveMessagesFor, sendLiveMessage } from '../../services/crew/liveComms.js'
import { createShutdownApprovedMessage, createShutdownRejectedMessage, createShutdownRequestMessage, formatCrewmateMessages, isIdleNotification } from '../../services/crew/liveMessages.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { plainMessageSummary } from './summary.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
import { isRetiredCrewLeadName } from '../../migrations/retiredCrewSpellings.js'


export type MessageRouting = {
  sender: string
  senderColor?: string
  target: string
  targetColor?: string
  summary?: string
  content?: string
}

export type MessageOutput = {
  success: boolean
  message: string
  routing?: MessageRouting
}

export type BroadcastOutput = MessageOutput & {
  recipients: string[]
}

export type RequestOutput = {
  success: boolean
  message: string
  request_id: string
  target: string
}

export type ResponseOutput = {
  success: boolean
  message: string
  request_id?: string
}

export type SendMessageToolOutput = MessageOutput | BroadcastOutput | RequestOutput | ResponseOutput


export type StructuredMessageInput =
  | { type: 'shutdown_request'; reason?: string }
  | { type: 'shutdown_response'; request_id: string; approve: boolean; reason?: string }
  | { type: 'plan_approval_response'; request_id: string; approve: boolean; feedback?: string }
  | { type: 'question'; content: string; request_id?: string; summary?: string }
  | { type: 'answer'; request_id: string; content: string; summary?: string }
  | { type: 'handoff'; status: (typeof HANDOFF_STATUSES)[number]; summary: string; evidenceRefs?: EvidenceRef[] }
  | {
      type: 'dispatch'
      task: string
      title?: string
      priority?: 'normal' | 'high'
      refRequestId?: string
    }
  | { type: 'escalate'; reason: string; refRequestId?: string; needsOperator?: boolean }
  | {
      type: 'progress'
      status: 'started' | 'working' | 'blocked' | 'done' | 'failed'
      detail?: string
      refRequestId?: string
    }
  | {
      type: 'control'
      command: 'pause' | 'resume' | 'stop' | 'clear' | 'ack' | 'cancel'
      detail?: string
      refRequestId?: string
    }

export type Input = {
  to: string
  summary?: string
  message: string | StructuredMessageInput
}

const inputSchema = lazySchema(() => {
  const shutdownRequestVariant = z.object({
    type: z.literal('shutdown_request'),
    reason: z.string().optional().describe('Why the shutdown is requested'),
  })
  const shutdownResponseVariant = z.object({
    type: z.literal('shutdown_response'),
    request_id: z.string().describe('The request id from the shutdown request'),
    approve: semanticBoolean(z.boolean()).describe('Whether the shutdown is approved'),
    reason: z.string().optional().describe('Required when rejecting: why'),
  })
  const planApprovalResponseVariant = z.object({
    type: z.literal('plan_approval_response'),
    request_id: z.string().describe('The request id from the plan approval request'),
    approve: semanticBoolean(z.boolean()).describe('Whether the plan is approved'),
    feedback: z.string().optional().describe('Feedback for a rejected plan'),
  })
  const questionVariant = z.object({
    type: z.literal('question'),
    content: z.string().describe('The question text'),
    request_id: z.string().optional().describe('Auto-generated when omitted'),
    summary: z.string().optional().describe('A short preview of the question'),
  })
  const answerVariant = z.object({
    type: z.literal('answer'),
    request_id: z.string().describe('The request id of the question being answered'),
    content: z.string().describe('The answer text'),
    summary: z.string().optional().describe('A short preview of the answer'),
  })
  const handoffVariant = z.object({
    type: z.literal('handoff'),
    status: z.enum(HANDOFF_STATUSES).describe('The claimed status of the work being handed off'),
    summary: z.string().describe('What is being handed off'),
    evidenceRefs: z
      .array(
        z.object({
          kind: z.string().optional().describe('The kind of evidence (path, command, sha)'),
          ref: z.string().describe('The evidence reference itself'),
          note: z.string().optional().describe('A one-line note on the evidence'),
        }),
      )
      .optional()
      .describe('Evidence backing a done claim (paths, commands, shas)'),
  })

  const variants: z.ZodObject[] = [
    shutdownRequestVariant,
    shutdownResponseVariant,
    planApprovalResponseVariant,
    questionVariant,
    answerVariant,
    handoffVariant,
  ]

  if (busEnvelopesEnabled()) {
    variants.push(
      z.object({
        type: z.literal('dispatch'),
        task: z.string().describe('The refined, well-specified task to execute'),
        title: z.string().optional(),
        priority: z.enum(['normal', 'high']).optional(),
        refRequestId: z.string().optional().describe('An earlier dispatch this one supersedes'),
      }),
      z.object({
        type: z.literal('escalate'),
        reason: z.string().describe('The blocker, ambiguity, or out-of-scope ask'),
        refRequestId: z.string().optional(),
        needsOperator: semanticBoolean(z.boolean().optional()).describe(
          'Whether this must go to the human operator',
        ),
      }),
      z.object({
        type: z.literal('progress'),
        status: z.enum(['started', 'working', 'blocked', 'done', 'failed']),
        detail: z.string().optional(),
        refRequestId: z.string().optional(),
      }),
      z.object({
        type: z.literal('control'),
        command: z.enum(['pause', 'resume', 'stop', 'clear', 'ack', 'cancel']),
        detail: z.string().optional(),
        refRequestId: z.string().optional(),
      }),
    )
  }

  return z.object({
    to: z.string().describe('The crewmate name to send to, or "*" to broadcast to all crewmates'),
    summary: z
      .string()
      .optional()
      .describe('A 5-10 word preview of the message; optional — a plain message without one is previewed by its first line'),
    message: z.union([
      z.string().describe('A plain message'),
      z.discriminatedUnion('type', variants as never),
    ]),
  })
})
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.union([
    z.object({
      success: z.boolean(),
      message: z.string(),
      routing: z
        .object({
          sender: z.string(),
          senderColor: z.string().optional(),
          target: z.string(),
          targetColor: z.string().optional(),
          summary: z.string().optional(),
          content: z.string().optional(),
        })
        .optional(),
      recipients: z.array(z.string()).optional(),
    }),
    z.object({
      success: z.boolean(),
      message: z.string(),
      request_id: z.string(),
      target: z.string(),
    }),
    z.object({
      success: z.boolean(),
      message: z.string(),
      request_id: z.string().optional(),
    }),
  ]),
)
type OutputSchema = ReturnType<typeof outputSchema>


function senderName(): string {
  return getAgentName() ?? (isCrewmate() ? 'crewmate' : CREW_LEAD_NAME)
}

function selfAddressRefusalText(rawTo: string): string | null {
  const selfName = getAgentName() ?? (isCrewmate() ? null : CREW_LEAD_NAME)
  if (selfName === null || rawTo.toLowerCase() !== selfName.toLowerCase()) {
    return null
  }
  return (
    `Cannot deliver to "${rawTo}": that is this session's own address, so the message would only land back ` +
    `in your own inbox and read as if a crewmate sent it.`
  )
}

function senderColor(name: string): string | undefined {
  return getCrewmateColor() ?? assignCrewmateColor(name)
}

function nowIso(): string {
  return new Date().toISOString()
}


function crewContextOf(context: ToolUseContext): { crewName: string; leadAgentId: string; crewmates?: Record<string, { color?: string }> } | undefined {
  return context.getAppState().crewContext as
    | { crewName: string; leadAgentId: string; crewmates?: Record<string, { color?: string }> }
    | undefined
}

function deadInProcessSeat(rawTo: string, crewName: string, context: ToolUseContext): string | null {
  const seats = getAllInProcessCrewmateTasks(context.getAppState().tasks ?? {}).filter(
    task => task.identity.crewName === crewName && task.identity.agentName.toLowerCase() === rawTo.toLowerCase(),
  )
  if (seats.length === 0 || seats.some(task => task.status === 'running')) return null
  const last = seats.reduce((newest, task) => ((task.endTime ?? 0) >= (newest.endTime ?? 0) ? task : newest))
  if (last.paused !== undefined) return null
  if (last.status === 'failed') return `failed${last.error ? ` (${last.error})` : ''}`
  if (last.status === 'completed') return 'completed'
  return `was ${agentStatusWord(last.status)}`
}

export const PAUSED_SEAT_ENDED_WORDS = 'was paused on a usage limit'

type EndedCrewmateSeat = { taskId: string; name: string; ended: string }

async function endedCrewmateSeat(rawTo: string, crewName: string, context: ToolUseContext): Promise<EndedCrewmateSeat | null> {
  const wanted = rawTo.toLowerCase()
  if (wanted === CREW_LEAD_NAME.toLowerCase() || isRetiredCrewLeadName(wanted)) return null
  const seats = getAllInProcessCrewmateTasks(context.getAppState().tasks ?? {}).filter(
    task => task.identity.crewName === crewName && task.identity.agentName.toLowerCase() === wanted,
  )
  if (seats.some(task => task.status === 'running')) return null
  const roster = await readRoster(crewName)
  const member = roster?.members.find(candidate => candidate.name.toLowerCase() === wanted)
  if (member !== undefined && member.backendType !== 'in-process') return null
  if (seats.length > 0) {
    const last = seats.reduce((newest, task) => ((task.endTime ?? 0) >= (newest.endTime ?? 0) ? task : newest))
    if (last.paused !== undefined) return { taskId: last.id, name: last.identity.agentName, ended: PAUSED_SEAT_ENDED_WORDS }
    if (last.status === 'failed') return null
    const ended = last.status === 'completed' ? 'had completed' : `was ${agentStatusWord(last.status)}`
    return { taskId: last.id, name: last.identity.agentName, ended }
  }
  if ((await failedSeatNotice(rawTo, crewName)) !== null) return null
  let newest: { taskId: string; name: string; launchedAt: number } | undefined
  for (const { agentId, metadata } of await listAgentMetadata().catch(() => [])) {
    if (metadata.crewmate?.crewName !== crewName || metadata.name?.toLowerCase() !== wanted) continue
    const launchedAt = metadata.launchedAt ?? 0
    if (newest === undefined || launchedAt >= newest.launchedAt) newest = { taskId: agentId, name: metadata.name, launchedAt }
  }
  return newest === undefined ? null : { taskId: newest.taskId, name: newest.name, ended: 'had ended and its row had left the list' }
}

async function resumeEndedCrewmate(
  seat: EndedCrewmateSeat,
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<MessageOutput> {
  const from = senderName()
  const color = senderColor(from)
  const prompt = formatCrewmateMessages([
    { from, text: content, timestamp: nowIso(), ...(color ? { color } : {}), ...(summary !== undefined ? { summary } : {}) },
  ])
  const { resumeCrewmateFromTranscript } = await import('../../services/agents/operatorResume.js')
  const resumed = await resumeCrewmateFromTranscript(seat.taskId, { getAppState: context.getAppState, toolUseContext: context, prompt })
  if (resumed.outcome === 'refused') {
    return { success: false, message: `Crewmate ${seat.name} ${seat.ended} and could not be resumed with your message: ${resumed.reason}` }
  }
  return {
    success: true,
    message:
      `Crewmate ${seat.name} ${seat.ended}; it was resumed from its transcript with your message as its next turn ` +
      `and runs on under a new row (task ${resumed.taskId}) — it answers by SendMessage as before.`,
    routing: {
      sender: from,
      ...(color ? { senderColor: color } : {}),
      target: `@${seat.name}`,
      ...(summary !== undefined ? { summary } : {}),
      content,
    },
  }
}

async function failedSeatNotice(rawTo: string, crewName: string): Promise<string | null> {
  let rows: Awaited<ReturnType<typeof liveMessagesFor>>
  try {
    rows = await liveMessagesFor(crewName, CREW_LEAD_NAME)
  } catch {
    return null
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.from.toLowerCase() !== rawTo.toLowerCase()) continue
    const notice = isIdleNotification(row.text)
    if (notice === null) continue
    if (notice.idleReason === 'failed' || notice.completedStatus === 'failed') {
      return `failed${notice.failureReason ? ` (${notice.failureReason})` : ''}`
    }
    return null
  }
  return null
}

async function readRoster(crewName: string | undefined): Promise<CrewFile | null> {
  if (!crewName) return null
  try {
    return await readCrewFileAsync(crewName)
  } catch {
    return null
  }
}

type RecipientResolution =
  | { ok: true; name: string; crewName: string }
  | { ok: false; refusal: string }

type KnownLaunchedAgent = { name: string; agentId: string; status: string }

async function knownLaunchedAgents(context: ToolUseContext): Promise<KnownLaunchedAgent[]> {
  const state = context.getAppState()
  const tasks = state.tasks ?? {}
  const statusOf = (agentId: string): string => {
    const task = tasks[agentId]
    return task === undefined ? 'finished' : agentStatusWord(task.status)
  }
  const byName = new Map<string, KnownLaunchedAgent>()
  for (const launch of await recordedNamedLaunches().catch((): NamedLaunch[] => [])) {
    byName.set(launch.name, { name: launch.name, agentId: launch.agentId, status: statusOf(launch.agentId) })
  }
  for (const receipt of namedLaunchReceipts(context.messages ?? [])) {
    byName.set(receipt.name, { name: receipt.name, agentId: receipt.agentId, status: statusOf(receipt.agentId) })
  }
  const registry = state.agentNameRegistry as Map<string, string> | undefined
  for (const [name, agentId] of registry ?? []) {
    byName.set(name, { name, agentId: String(agentId), status: statusOf(String(agentId)) })
  }
  return [...byName.values()]
}

async function noCrewRefusal(rawTo: string, context: ToolUseContext): Promise<string> {
  const known = await knownLaunchedAgents(context)
  const folded = rawTo.toLowerCase()
  const own =
    known.find(agent => agent.name === rawTo || agent.agentId === rawTo) ??
    known.find(agent => agent.name.toLowerCase() === folded)
  if (own !== undefined) {
    return (
      `Cannot deliver to "${rawTo}": that is a sub-agent of this session (id ${own.agentId}; ${own.status}), and a structured message reaches crewmates only. ` +
      `Send it a plain message addressed to its name or to its id ${own.agentId}` +
      (own.status === 'running' ? ' — it is read at its next tool boundary.' : ' to resume it.')
    )
  }
  if (known.length === 0) {
    return (
      `Cannot deliver to "${rawTo}": this session is not in a crew and no in-process agent by that name exists, ` +
      `so the message would land in a default inbox nobody reads. Spawn a crew first, or address a live subagent by name.`
    )
  }
  const running = known.filter(agent => agent.status === 'running').map(agent => agent.name)
  const finished = known.filter(agent => agent.status !== 'running').map(agent => agent.name)
  return (
    `Cannot deliver to "${rawTo}": no agent named ${rawTo} in this session` +
    (running.length > 0 ? `; the running agents are: ${running.join(', ')}` : '') +
    (finished.length > 0 ? `; the finished agents are: ${finished.join(', ')}` : '') +
    ` — send to an id or one of those names.`
  )
}

async function resolveDeliverableRecipient(
  rawTo: string,
  context: ToolUseContext,
): Promise<RecipientResolution> {
  const crewName = getCrewName(crewContextOf(context))
  if (!crewName) {
    return { ok: false, refusal: await noCrewRefusal(rawTo, context) }
  }
  const selfRefusal = selfAddressRefusalText(rawTo)
  if (selfRefusal !== null) {
    const roster = await readRoster(crewName)
    const others = (roster?.members ?? [])
      .map(candidate => candidate.name)
      .filter(name => name.toLowerCase() !== rawTo.toLowerCase())
    return {
      ok: false,
      refusal:
        selfRefusal +
        (others.length > 0 ? ` Crewmates you can address: ${others.join(', ')}.` : ''),
    }
  }
  if (rawTo.toLowerCase() === CREW_LEAD_NAME.toLowerCase() || isRetiredCrewLeadName(rawTo)) {
    return { ok: true, name: CREW_LEAD_NAME, crewName }
  }
  const roster = await readRoster(crewName)
  const member = roster?.members.find(candidate => candidate.name.toLowerCase() === rawTo.toLowerCase())
  const deadSeat = deadInProcessSeat(rawTo, crewName, context) ?? (member ? null : await failedSeatNotice(rawTo, crewName))
  if (deadSeat !== null) {
    return {
      ok: false,
      refusal:
        `Cannot deliver to "${rawTo}": that seat is not running — it ${deadSeat} — so the message would sit in an inbox nobody reads. ` +
        `Spawn the seat again with the Agent tool, or address a running crewmate.`,
    }
  }
  if (!member) {
    const memberList = roster?.members.map(candidate => candidate.name).join(', ') || 'none'
    return {
      ok: false,
      refusal:
        `Cannot deliver to "${rawTo}": no such member on crew "${crewName}" (members: ${memberList}). ` +
        `A message to an unknown name creates an inbox that is never read.`,
    }
  }
  const freshRoster = await readRoster(crewName)
  const freshMember = freshRoster?.members.find(
    candidate => candidate.name.toLowerCase() === rawTo.toLowerCase(),
  )
  return { ok: true, name: freshMember?.name ?? member.name, crewName }
}

function workerReplyTarget(addressed: string): string {
  if (isCrewRole()) return CREW_LEAD_NAME
  return addressed
}

function busContextActive(): boolean {
  return isCrewRole() || busEnvelopesEnabled()
}

function busContextRefusal(kind: string, target: string): RequestOutput {
  return {
    success: false,
    message:
      `The "${kind}" envelope kind is coordination-mode plumbing, and this session has no coordinator engaged — ` +
      `the envelope would render to nobody (a silent drop). Send a plain message instead.`,
    request_id: '',
    target,
  }
}


async function sendBusEnvelope(
  targetName: string,
  envelope: BusEnvelope,
  context: ToolUseContext,
): Promise<{ data: RequestOutput }> {
  const crewName = getCrewName(crewContextOf(context))
  const resolvedTarget = { name: targetName.trim() }
  const isDirective =
    envelope.kind === 'dispatch' || envelope.kind === 'control' || envelope.kind === 'note'

  if (isDirective) {
    const roster = await readRoster(crewName)
    const leadAgentId = crewContextOf(context)?.leadAgentId
    const verdict = canDirect(
      resolveDirectActor(roster, envelope.from, leadAgentId),
      resolveDirectActor(roster, resolvedTarget.name, leadAgentId),
    )
    if (!verdict.allowed) {
      return {
        data: { success: false, message: verdict.reason, request_id: '', target: resolvedTarget.name },
      }
    }
  }

  const color = senderColor(envelope.from)

  let deliveredViaRpc = false
  if (isDirective) {
    try {
      const reply = await daemonControlRpc({
        op: 'envelope',
        to: resolvedTarget.name,
        ...(crewName ? { crew: crewName } : {}),
        env: envelope,
        ...(color ? { color } : {}),
      } as never)
      if ((reply as { ok?: boolean }).ok) deliveredViaRpc = true
    } catch (error) {
      logForDebugging(`sendBusEnvelope: socket path failed, journaling directly: ${String(error)}`)
    }
  }

  if (!deliveredViaRpc) {
    const delivered = await sendLiveMessage(crewName, {
      to: resolvedTarget.name,
      from: envelope.from,
      text: serializeBusEnvelope(envelope),
      timestamp: nowIso(),
      ...(color ? { color } : {}),
    })
    if (!delivered) {
      return {
        data: {
          success: false,
          message: `The ${envelope.kind} envelope could not be delivered to ${resolvedTarget.name} — the mailbox write failed.`,
          request_id: '',
          target: resolvedTarget.name,
        },
      }
    }
  }

  const message = `Sent ${envelope.kind} envelope to ${resolvedTarget.name} [request_id: ${envelope.request_id}]`
  return {
    data: { success: true, message, request_id: envelope.request_id, target: resolvedTarget.name },
  }
}


const DELIVERED_WORDS =
  "it is read at the receiver's next tool boundary, else at the end of its turn; a receiver between turns starts a turn for it"

function senderAgentTask(context: ToolUseContext): LocalAgentTaskState | undefined {
  const agentId = context.agentId
  if (agentId === undefined) return undefined
  const task = context.getAppState().tasks?.[String(agentId)]
  return task !== undefined && isLocalAgentTask(task) && !isMainSessionTask(task) ? task : undefined
}

function messageNoticeFor(receiverId: string, content: string, context: ToolUseContext): string {
  const sender = senderAgentTask(context)
  return agentMessageNotice({
    taskId: receiverId,
    summary: agentMessageSummary(sender === undefined ? null : { taskId: sender.id, description: sender.description }),
    text: content,
  })
}

function routeToMainAgent(rawTo: string, content: string, context: ToolUseContext): MessageOutput | undefined {
  if (rawTo.toLowerCase() !== MAIN_THREAD_AGENT) return undefined
  const sender = senderAgentTask(context)
  if (sender === undefined) {
    const crew = getCrewName(crewContextOf(context))
    return {
      success: false,
      message:
        `Cannot deliver to "${rawTo}": that address names this session's own main agent, and only a background sub-agent reaches its main agent there. ` +
        `Address a sub-agent by the id its launch receipt names or by its name${crew ? `, or a crewmate by name (the lead is "${CREW_LEAD_NAME}")` : ''}.`,
    }
  }
  enqueueMessageToMainAgent({ fromTaskId: sender.id, description: sender.description, text: content })
  return { success: true, message: `Message delivered to the main agent — ${DELIVERED_WORDS}.` }
}

async function routeToLocalAgent(
  rawTo: string,
  content: string,
  context: ToolUseContext,
  canUseTool?: CanUseToolFn,
  invokingRequestId?: string,
): Promise<MessageOutput | undefined> {
  const registry = context.getAppState().agentNameRegistry as Map<string, string> | undefined
  const registered = registry?.get(rawTo)
  const minted = toAgentId(rawTo) ?? undefined
  const unresolved = registered === undefined && minted === undefined
  const receipts = unresolved ? launchesNamed(context.messages ?? [], rawTo) : []
  const launches: NamedLaunch[] =
    unresolved && receipts.length === 0 ? await recordedLaunchesNamed(rawTo).catch((): NamedLaunch[] => []) : receipts
  const launch = launches[launches.length - 1]
  if (minted === undefined && (await crewmateWinsName(rawTo, registered, context))) return undefined
  const agentId = registered ?? minted ?? launch?.agentId
  if (agentId === undefined) return undefined
  const who =
    launch === undefined
      ? rawTo
      : `${rawTo} (id ${agentId}${launches.length > 1 ? `, the newest of ${launches.length} launches that carried the name` : ''})`

  const task = context.getAppState().tasks?.[String(agentId)]
  const liveLocal =
    task !== undefined && isLocalAgentTask(task) && !isMainSessionTask(task) ? task : undefined

  if (liveLocal) {
    if (liveLocal.status === 'running') {
      queuePendingMessage(liveLocal.id, messageNoticeFor(liveLocal.id, content, context), context.setAppStateForTasks ?? context.setAppState)
      return {
        success: true,
        message: `Message delivered to agent ${who} — ${DELIVERED_WORDS}.`,
      }
    }
    const ended =
      liveLocal.status === 'failed'
        ? `had failed${liveLocal.error ? ` (${liveLocal.error})` : ''}`
        : liveLocal.status === 'completed'
          ? 'had completed'
          : `was ${agentStatusWord(liveLocal.status)}`
    try {
      const notice = messageNoticeFor(String(agentId), content, context)
      const resumed = await (
        await import('../AgentTool/resumeAgent.js')
      ).resumeAgentBackground({
        agentId: String(agentId),
        prompt: notice,
        toolUseContext: context,
        canUseTool,
        invokingRequestId,
      })
      speakAgentMessageFrame(String(agentId), notice)
      return {
        success: true,
        message:
          `Agent ${who} ${ended}; it was resumed in the background with your ` +
          `message and you will be notified when it completes. Output file: ${resumed.outputFile}` +
          (resumed.note ?? ''),
      }
    } catch (error) {
      return {
        success: false,
        message: `Agent ${who} ${ended} and could not be resumed: ${errorMessage(error)}`,
      }
    }
  }

  const owningWorkflow = workflowOwningAgent(context.getAppState().tasks, String(agentId))
  if (owningWorkflow !== undefined) {
    if (owningWorkflow.runDir === undefined) {
      return { success: false, message: workflowOwnedAgentWords(owningWorkflow, String(agentId)) }
    }
    return messageWorkflowWorker(owningWorkflow.runDir, owningWorkflow.workflowName ?? owningWorkflow.description, owningWorkflow.workflowRunId, String(agentId), content)
  }
  const elsewhere = await workflowRunningAgentElsewhere(String(agentId))
  if (elsewhere !== undefined) {
    return messageWorkflowWorker(elsewhere.runDir, elsewhere.workflowName ?? elsewhere.runId, elsewhere.runId, String(agentId), content)
  }

  const transcriptPath = agentTranscriptPathOf(String(agentId))
  if (transcriptPath === null || !existsSync(transcriptPath)) {
    if (registered === undefined && launch === undefined && getCrewName(crewContextOf(context))) {
      return undefined
    }
    return {
      success: false,
      message:
        `Agent ${who}: no running task by that id in this session and no transcript on disk to resume — ` +
        `the agent may belong to another process, or its record was cleaned up. Address a live sub-agent by the ` +
        `id its launch receipt names, or by the name its launch gave it.`,
    }
  }
  const view = await readAgentTranscript(transcriptPath)
  const endedOnDisk = view !== undefined ? transcriptEndWords(view.end) : 'transcript on disk'
  try {
    const notice = messageNoticeFor(String(agentId), content, context)
    const resumed = await (
      await import('../AgentTool/resumeAgent.js')
    ).resumeAgentBackground({
      agentId: String(agentId),
      prompt: notice,
      toolUseContext: context,
      canUseTool,
      invokingRequestId,
    })
    speakAgentMessageFrame(String(agentId), notice)
    return {
      success: true,
      message:
        `Agent ${who} is not running (${endedOnDisk}); it was resumed in the background with your message and you will be ` +
        `notified when it completes. Output file: ${resumed.outputFile}` +
        (resumed.note ?? ''),
    }
  } catch (error) {
    return {
      success: false,
      message:
        `Agent ${who} is not running (${endedOnDisk}) and could not be resumed: ${errorMessage(error)}`,
    }
  }
}

async function crewmateWinsName(rawTo: string, registered: string | undefined, context: ToolUseContext): Promise<boolean> {
  const crewName = getCrewName(crewContextOf(context))
  if (!crewName) return false
  if (rawTo.toLowerCase() === CREW_LEAD_NAME.toLowerCase() || isRetiredCrewLeadName(rawTo)) return true
  const roster = await readRoster(crewName)
  const member = (roster?.members ?? []).find(candidate => candidate.name.toLowerCase() === rawTo.toLowerCase())
  if (member === undefined) return false
  const registeredTask = registered === undefined ? undefined : context.getAppState().tasks?.[registered]
  if (registeredTask === undefined || registeredTask.status !== 'running') return true
  return (registeredTask.startTime ?? 0) <= member.joinedAt
}

async function messageWorkflowWorker(
  runDir: string,
  workflowName: string,
  runId: string,
  agentId: string,
  content: string,
): Promise<MessageOutput> {
  const result = await requestWorkflowControl(runDir, {
    action: 'message-agent',
    by: workflowControlBy(getSessionId(), process.pid),
    agentId,
    message: content,
  })
  const where = `worker ${agentId} of workflow "${workflowName}" (${runId})`
  if (result.outcome === 'applied') {
    return { success: true, message: `Message queued for ${where}: ${result.detail}. The run's journal carries the request and its answer.` }
  }
  if (result.outcome === 'pending') {
    return { success: true, message: `Message left for ${where}: ${result.reason}.` }
  }
  return { success: false, message: `Message to ${where} refused: ${result.reason}. Inspect mercury://workflow/${runId}?child=${agentId} for its state.` }
}

async function workflowRunningAgentElsewhere(
  agentId: string,
): Promise<{ runDir: string; runId: string; workflowName?: string } | undefined> {
  let listing: Awaited<ReturnType<typeof listWorkflowRunsDetailed>>
  try {
    listing = await listWorkflowRunsDetailed(getCwd())
  } catch {
    return undefined
  }
  const now = Date.now()
  for (const run of listing.rows) {
    if (run.status !== 'running' || run.controlVersion === undefined) continue
    if (runLiveness(run, run.mtimeMs, now, pidAlive) !== 'live') continue
    const inFlight = run.agents.some(a => a.agentId === agentId && (a.state === 'start' || a.state === 'progress'))
    if (inFlight) return { runDir: run.runDir, runId: run.runId, workflowName: run.workflowName }
  }
  return undefined
}

function agentTranscriptPathOf(agentId: string): string | null {
  try {
    return getAgentTranscriptPath(asAgentId(agentId))
  } catch {
    return null
  }
}

async function sendDirectedPlainMessage(
  rawTo: string,
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<MessageOutput> {
  const crewName = getCrewName(crewContextOf(context))
  const ended = crewName ? await endedCrewmateSeat(rawTo, crewName, context) : null
  if (ended !== null) return resumeEndedCrewmate(ended, content, summary, context)
  const resolution = await resolveDeliverableRecipient(rawTo, context)
  if (!resolution.ok) return { success: false, message: resolution.refusal }

  const busRoleSender = Boolean(isCrewRole())
  if (busRoleSender && looksLikeHandSerializedBusPayload(content)) {
    return {
      success: false,
      message:
        `REFUSED: this looks like a hand-serialized bus envelope sent as a plain string. ` +
        `Send it in structured form instead — { "to": "${resolution.name}", "message": { "type": "dispatch" | "progress" | "escalate" | "control", … } } — ` +
        `and re-send it now.`,
    }
  }

  const from = senderName()
  const color = senderColor(from)
  const delivered = await sendLiveMessage(resolution.crewName, {
    to: resolution.name,
    from,
    text: content,
    timestamp: nowIso(),
    ...(summary !== undefined ? { summary } : {}),
    ...(color ? { color } : {}),
  })
  if (!delivered) {
    return {
      success: false,
      message: `The message could NOT be delivered to ${resolution.name} — the mailbox write failed.`,
    }
  }
  const targetColor = crewContextOf(context)?.crewmates?.[resolution.name]?.color
  return {
    success: true,
    message: `Message delivered to ${resolution.name}'s inbox`,
    routing: {
      sender: from,
      ...(color ? { senderColor: color } : {}),
      target: `@${resolution.name}`,
      ...(targetColor ? { targetColor } : {}),
      ...(summary !== undefined ? { summary } : {}),
      content,
    },
  }
}

async function sendBroadcast(
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<BroadcastOutput> {
  const crewContext = crewContextOf(context)
  const crewName = getCrewName(crewContext)
  if (!crewName) {
    throw new Error(
      `Cannot broadcast: this session is not in a crew. Create one with the crew-spawn tool, or launch with ` +
        `the --crew-name identity arguments.`,
    )
  }
  const roster = await readRoster(crewName)
  if (!roster) {
    throw new Error(`Cannot broadcast: unknown crew "${crewName}"`)
  }
  const from = senderName()
  if (!from) {
    throw new Error('Cannot broadcast: no sender name. Launch with the --agent-name identity argument.')
  }

  const leadDenial = checkBroadcastAllowed(roster as CrewFileWithGovernance, isCrewLead(crewContext))
  if (leadDenial !== null) {
    return { success: false, message: leadDenial, recipients: [] }
  }
  const fairnessDenial = await checkBroadcastFairness(
    from,
    (roster as CrewFileWithGovernance).governance,
    crewName,
  )
  if (fairnessDenial !== null) {
    return { success: false, message: fairnessDenial, recipients: [] }
  }

  const recipients = roster.members
    .map(member => member.name)
    .filter(name => name.toLowerCase() !== from.toLowerCase())
  if (recipients.length === 0) {
    return {
      success: true,
      message: 'No crewmates to broadcast to — you are the only member of the crew.',
      recipients: [],
    }
  }

  const color = senderColor(from)
  const deliveredNames: string[] = []
  const failedNames: string[] = []
  for (const recipient of recipients) {
    const delivered = await sendLiveMessage(crewName, {
      to: recipient,
      from,
      text: content,
      timestamp: nowIso(),
      ...(summary !== undefined ? { summary } : {}),
      ...(color ? { color } : {}),
    })
    if (delivered) deliveredNames.push(recipient)
    else failedNames.push(recipient)
  }

  if (deliveredNames.length === 0) {
    return {
      success: false,
      message: `The broadcast could NOT be delivered — every mailbox write failed (${failedNames.join(', ')}).`,
      recipients: [],
    }
  }
  let message = `Broadcast delivered to ${deliveredNames.length} crewmate(s): ${deliveredNames.join(', ')}`
  if (failedNames.length > 0) {
    message += `. Delivery FAILED for: ${failedNames.join(', ')}`
  }
  return {
    success: true,
    message,
    recipients: deliveredNames,
    routing: {
      sender: from,
      ...(color ? { senderColor: color } : {}),
      target: '@crew',
      ...(summary !== undefined ? { summary } : {}),
      content,
    },
  }
}


async function sendShutdownRequest(
  rawTo: string,
  reason: string | undefined,
  context: ToolUseContext,
): Promise<RequestOutput> {
  const crewContext = crewContextOf(context)
  const crewName = getCrewName(crewContext)
  const roster = await readRoster(crewName)
  const from = senderName()
  const verdict = canDirect(
    resolveDirectActor(roster, from, crewContext?.leadAgentId),
    resolveDirectActor(roster, rawTo, crewContext?.leadAgentId),
  )
  if (!verdict.allowed) {
    return { success: false, message: verdict.reason, request_id: '', target: rawTo }
  }
  const requestId = generateRequestId('shutdown', rawTo)
  const payload = createShutdownRequestMessage({ requestId, from, ...(reason !== undefined ? { reason } : {}) })
  const color = senderColor(from)
  const delivered = await sendLiveMessage(crewName, { to: rawTo, from, text: JSON.stringify(payload), timestamp: nowIso(), ...(color ? { color } : {}) })
  if (!delivered) {
    return {
      success: false,
      message: `The shutdown request could not be delivered to ${rawTo} — the mailbox write failed.`,
      request_id: '',
      target: rawTo,
    }
  }
  return {
    success: true,
    message: `Shutdown request sent to ${rawTo} (request_id: ${requestId})`,
    request_id: requestId,
    target: rawTo,
  }
}

async function sendShutdownResponse(
  message: Extract<StructuredMessageInput, { type: 'shutdown_response' }>,
  context: ToolUseContext,
): Promise<ResponseOutput> {
  const crewContext = crewContextOf(context)
  const crewName = getCrewName(crewContext)
  const agentId = getAgentId()
  const from = senderName()

  if (!message.approve) {
    void (await sendLiveMessage(crewName, {
      to: CREW_LEAD_NAME,
      from,
      text: JSON.stringify(
        createShutdownRejectedMessage({
          requestId: message.request_id,
          from,
          reason: message.reason ?? '',
        }),
      ),
      timestamp: nowIso(),
    }))
    return {
      success: true,
      message: `Shutdown rejected: "${message.reason}" — continuing work.`,
      request_id: message.request_id,
    }
  }

  let paneId: string | undefined
  let backendType: string | undefined
  if (crewName && agentId) {
    const roster = await readRoster(crewName)
    const member = roster?.members.find(candidate => candidate.agentId === agentId) as
      | { tmuxPaneId?: string; backendType?: string }
      | undefined
    paneId = member?.tmuxPaneId || undefined
    backendType = member?.backendType || undefined
  }
  void (await sendLiveMessage(crewName, {
    to: CREW_LEAD_NAME,
    from,
    text: JSON.stringify(
      createShutdownApprovedMessage({ requestId: message.request_id, from, paneId, backendType }),
    ),
    timestamp: nowIso(),
  }))

  const abortOwnTask = (): boolean => {
    const task = findCrewmateTaskByAgentId(agentId, context.getAppState().tasks ?? {})
    if (task?.abortController) {
      task.abortController.abort()
      return true
    }
    logForDebugging(`shutdown_response: no in-process task/controller for ${agentId ?? '(no agent id)'}`)
    return false
  }

  if (isInProcessCrewmate()) {
    abortOwnTask()
    return {
      success: true,
      message: 'Shutdown approved — confirmation sent to the lead; this agent is exiting.',
      request_id: message.request_id,
    }
  }
  if (abortOwnTask()) {
    return {
      success: true,
      message:
        'Shutdown approved — confirmation sent to the lead; the in-process task was aborted (fallback path).',
      request_id: message.request_id,
    }
  }
  setImmediate(() => gracefulShutdownSync(0))
  return {
    success: true,
    message: 'Shutdown approved — confirmation sent to the lead; this process will exit.',
    request_id: message.request_id,
  }
}

async function sendPlanApprovalResponse(
  rawTo: string,
  message: Extract<StructuredMessageInput, { type: 'plan_approval_response' }>,
  context: ToolUseContext,
): Promise<ResponseOutput> {
  const crewContext = crewContextOf(context)
  if (!isCrewLead(crewContext)) {
    throw new Error('Only the crew lead can approve or reject plans.')
  }
  const crewName = crewContext?.crewName
  const approve = message.approve
  const currentMode = context.getAppState().toolPermissionContext.mode
  const permissionMode = currentMode === 'strategy' ? 'default' : currentMode
  const feedback = approve
    ? undefined
    : message.feedback?.trim() || 'The plan needs revision — please refine it and resubmit.'
  const payload = {
    type: 'plan_approval_response' as const,
    requestId: message.request_id,
    approved: approve,
    timestamp: nowIso(),
    ...(approve ? { permissionMode } : { feedback }),
  }
  const delivered = await sendLiveMessage(crewName, { to: rawTo, from: CREW_LEAD_NAME, text: JSON.stringify(payload), timestamp: nowIso() })
  if (!delivered) {
    return {
      success: false,
      message: approve
        ? `The plan approval was NOT delivered to ${rawTo} — the crewmate has not been told to proceed.`
        : `The plan rejection was NOT delivered to ${rawTo} — the crewmate has not received the feedback.`,
      request_id: message.request_id,
    }
  }
  return {
    success: true,
    message: approve
      ? `Plan approved — ${rawTo} has been told to proceed.`
      : `Plan rejected — feedback sent to ${rawTo}: "${feedback}"`,
    request_id: message.request_id,
  }
}

async function sendQuestion(
  rawTo: string,
  message: Extract<StructuredMessageInput, { type: 'question' }>,
  context: ToolUseContext,
): Promise<RequestOutput> {
  const resolution = await resolveDeliverableRecipient(rawTo, context)
  if (!resolution.ok) {
    return { success: false, message: resolution.refusal, request_id: '', target: rawTo }
  }
  const from = senderName()
  const requestId = message.request_id ?? generateRequestId('question', resolution.name)
  await openQuestion(
    {
      request_id: requestId,
      from,
      to: resolution.name,
      text: message.content,
      ...(message.summary !== undefined ? { summary: message.summary } : {}),
    },
    resolution.crewName,
  )
  const color = senderColor(from)
  const delivered = await sendLiveMessage(resolution.crewName, {
    to: resolution.name,
    from,
    text: message.content,
    timestamp: nowIso(),
    ...(message.summary !== undefined ? { summary: message.summary } : {}),
    ...(color ? { color } : {}),
  })
  if (!delivered) {
    return {
      success: false,
      message: `The question could not be delivered to ${resolution.name} — the mailbox write failed (the ledger entry was opened).`,
      request_id: requestId,
      target: resolution.name,
    }
  }
  return {
    success: true,
    message: `Question sent to ${resolution.name}; it stays open until answered (request_id: ${requestId}).`,
    request_id: requestId,
    target: resolution.name,
  }
}

async function sendAnswer(
  rawTo: string,
  message: Extract<StructuredMessageInput, { type: 'answer' }>,
  context: ToolUseContext,
): Promise<ResponseOutput> {
  const crewName = getCrewName(crewContextOf(context))
  const from = senderName()
  const closed = await answerQuestion(
    { request_id: message.request_id, answeredBy: from, answerText: message.content },
    crewName,
  )
  const color = senderColor(from)
  const delivered = await sendLiveMessage(crewName, {
    to: rawTo,
    from,
    text: message.content,
    timestamp: nowIso(),
    ...(message.summary !== undefined ? { summary: message.summary } : {}),
    ...(color ? { color } : {}),
  })
  if (!delivered) {
    return {
      success: false,
      message:
        `The answer could not be delivered to ${rawTo} — the mailbox write failed.` +
        (closed ? ' The question was closed in the ledger anyway.' : ''),
      request_id: message.request_id,
    }
  }
  return {
    success: true,
    message: closed
      ? `Answer sent to ${rawTo}; question ${message.request_id} closed.`
      : `Answer sent to ${rawTo} as a plain message — no matching open question for ${message.request_id}.`,
    request_id: message.request_id,
  }
}

async function sendHandoff(
  rawTo: string,
  message: Extract<StructuredMessageInput, { type: 'handoff' }>,
  context: ToolUseContext,
): Promise<RequestOutput> {
  const resolution = await resolveDeliverableRecipient(rawTo, context)
  if (!resolution.ok) {
    return { success: false, message: resolution.refusal, request_id: '', target: rawTo }
  }
  const from = senderName()
  const handoffId = generateRequestId('handoff', resolution.name)
  const verdict = await recordHandoff(
    {
      id: handoffId,
      from,
      to: resolution.name,
      status: message.status,
      summary: message.summary,
      ...(message.evidenceRefs !== undefined ? { evidenceRefs: message.evidenceRefs } : {}),
    },
    resolution.crewName,
  )
  const evidenceCount = (message.evidenceRefs ?? []).filter(
    entry => !!entry && typeof entry.ref === 'string' && entry.ref.trim().length > 0,
  ).length
  const text =
    `Handoff (${message.status})${verdict.verified ? '' : ' [UNVERIFIED — no evidence]'}: ${message.summary}` +
    (evidenceCount > 0 ? ` (${evidenceCount} evidence ref${evidenceCount === 1 ? '' : 's'})` : '')
  const color = senderColor(from)
  const delivered = await sendLiveMessage(resolution.crewName, {
    to: resolution.name,
    from,
    text,
    timestamp: nowIso(),
    summary: message.summary,
    ...(color ? { color } : {}),
  })
  if (!delivered) {
    return {
      success: false,
      message: `The handoff ${handoffId} could not be delivered — the mailbox write failed.`,
      request_id: handoffId,
      target: resolution.name,
    }
  }
  let resultMessage = `Handoff (${message.status}) sent to ${resolution.name} (id: ${handoffId}).`
  if (!verdict.verified) {
    resultMessage += ` The claim was flagged unverified: ${verdict.reason ?? 'a done claim needs at least one evidence ref'}`
  }
  return { success: true, message: resultMessage, request_id: handoffId, target: resolution.name }
}


export const SendMessageTool = buildTool({
  name: SEND_MESSAGE_TOOL_NAME,
  searchHint: 'send messages to agent crewmates over the swarm protocol',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled: () => isAgentSwarmsEnabled(),
  isReadOnly: (input: Input) => typeof input?.message === 'string',
  async description() {
    return DESCRIPTION
  },
  async prompt({ tools }) {
    return getPrompt(new Set(tools.map(tool => tool.name)))
  },
  async checkPermissions(input: Input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async validateInput(input: Input): Promise<ValidationResult> {
    const to = input.to?.trim() ?? ''
    if (to.length === 0) {
      return { result: false, message: 'Recipient ("to") must not be empty.', errorCode: 9 }
    }
    const address = parseAddress(input.to)
    if ((address.scheme === 'uds' || address.scheme === 'bridge') && address.target.trim().length === 0) {
      return { result: false, message: 'The socket address has no target.', errorCode: 9 }
    }
    if (input.to.includes('@')) {
      return {
        result: false,
        message:
          'Use a bare crewmate name (or "*" for broadcast) — there is only one crew per session, so the @crew suffix is never needed.',
        errorCode: 9,
      }
    }
    if (typeof input.message === 'string') {
      return { result: true }
    }
    if (to === '*') {
      return { result: false, message: 'Structured messages cannot be broadcast.', errorCode: 9 }
    }
    if (input.message.type === 'shutdown_response' && to !== CREW_LEAD_NAME) {
      return {
        result: false,
        message: `A shutdown_response must be addressed to "${CREW_LEAD_NAME}".`,
        errorCode: 9,
      }
    }
    if (
      input.message.type === 'shutdown_response' &&
      !input.message.approve &&
      (!input.message.reason || input.message.reason.trim().length === 0)
    ) {
      return {
        result: false,
        message: 'A rejecting shutdown_response must carry a non-empty reason.',
        errorCode: 9,
      }
    }
    return { result: true }
  },
  backfillObservableInput(input: Input): void {
    const copy = input as Input & {
      type?: string
      recipient?: string
      content?: string
      request_id?: string
      approve?: boolean
    }
    if (typeof copy.type === 'string') return
    if (typeof copy.to !== 'string') return
    if (typeof copy.message === 'string') {
      if (copy.to === '*') {
        copy.type = 'broadcast'
        copy.content = copy.message
      } else {
        copy.type = 'message'
        copy.recipient = copy.to
        copy.content = copy.message
      }
      return
    }
    const structured = copy.message
    copy.type = structured.type
    copy.recipient = copy.to
    if ('request_id' in structured && structured.request_id !== undefined) {
      copy.request_id = structured.request_id
    }
    if ('approve' in structured && structured.approve !== undefined) {
      copy.approve = structured.approve
    }
    const content =
      ('content' in structured ? structured.content : undefined) ??
      ('reason' in structured ? structured.reason : undefined) ??
      ('feedback' in structured ? structured.feedback : undefined)
    if (content !== undefined) copy.content = content
  },
  toAutoClassifierInput(input: Input): string | undefined {
    if (typeof input.message === 'string') {
      return `to ${input.to}: ${input.message}`
    }
    if (typeof input.message !== 'object' || input.message === null) {
      return `to ${input.to}`
    }
    switch (input.message.type) {
      case 'shutdown_request':
        return `shutdown_request to ${input.to}`
      case 'shutdown_response':
        return `shutdown_response ${input.message.approve ? 'approve' : 'reject'} ${input.message.request_id}`
      case 'plan_approval_response':
        return `plan_approval ${input.message.approve ? 'approve' : 'reject'} to ${input.to}`
      case 'question':
        return `question to ${input.to}: ${input.message.content}`
      case 'answer':
        return `answer to ${input.to} (${input.message.request_id})`
      case 'handoff':
        return `handoff to ${input.to} [${input.message.status}]: ${input.message.summary}`
    }
    return undefined
  },
  async call(
    input: Input,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentAssistantMessage: AssistantMessage,
  ) {
    const rawTo = input.to.trim()
    const { message } = input

    if (typeof message === 'string') {
      const content = message
      const summary = plainMessageSummary(input.summary, content)
      if (rawTo !== '*') {
        const selfRefusal = selfAddressRefusalText(rawTo)
        if (selfRefusal !== null) {
          return { data: { success: false, message: selfRefusal } }
        }
        const toMain = routeToMainAgent(rawTo, content, context)
        if (toMain !== undefined) return { data: toMain }
        const routed = await routeToLocalAgent(
          rawTo,
          content,
          context,
          canUseTool,
          parentAssistantMessage.requestId,
        )
        if (routed !== undefined) return { data: routed }
        return { data: await sendDirectedPlainMessage(rawTo, content, summary, context) }
      }
      return { data: await sendBroadcast(content, summary, context) }
    }

    if (rawTo === '*') {
      throw new Error('Structured messages cannot be broadcast.')
    }

    switch (message.type) {
      case 'shutdown_request':
        return { data: await sendShutdownRequest(rawTo, message.reason, context) }
      case 'shutdown_response':
        return { data: await sendShutdownResponse(message, context) }
      case 'plan_approval_response':
        return { data: await sendPlanApprovalResponse(rawTo, message, context) }
      case 'question':
        return { data: await sendQuestion(rawTo, message, context) }
      case 'answer':
        return { data: await sendAnswer(rawTo, message, context) }
      case 'handoff':
        return { data: await sendHandoff(rawTo, message, context) }
      case 'dispatch': {
        if (!busContextActive()) return { data: busContextRefusal('dispatch', rawTo) }
        const from = senderName()
        const envelope: DispatchEnvelope = buildDispatch(from, message.task, {
          ...(message.title !== undefined ? { title: message.title } : {}),
          ...(message.priority !== undefined ? { priority: message.priority } : {}),
          ...(message.refRequestId !== undefined ? { refRequestId: message.refRequestId } : {}),
        })
        return await sendBusEnvelope(rawTo, envelope, context)
      }
      case 'escalate': {
        if (!busContextActive()) return { data: busContextRefusal('escalate', rawTo) }
        const from = senderName()
        const envelope = buildEscalate(from, message.reason, {
          ...(message.refRequestId !== undefined ? { refRequestId: message.refRequestId } : {}),
          ...(message.needsOperator !== undefined ? { needsOperator: message.needsOperator } : {}),
        })
        return await sendBusEnvelope(workerReplyTarget(rawTo), envelope, context)
      }
      case 'progress': {
        if (!busContextActive()) return { data: busContextRefusal('progress', rawTo) }
        const from = senderName()
        if (message.refRequestId && routerEnabled()) {
          const now = Date.now()
          const ref = message.refRequestId
          if (message.status === 'started' || message.status === 'working') {
            void routerStoreWriters.requestWorking(ref, now).catch(() => {})
          } else if (message.status === 'done') {
            void routerStoreWriters.requestReported(ref, message.detail, now).catch(() => {})
          } else if (message.status === 'failed') {
            void routerStoreWriters.requestFailed(ref, message.detail, now).catch(() => {})
          }
        }
        const envelope: ProgressEnvelope = buildProgress(from, message.status, {
          ...(message.detail !== undefined ? { detail: message.detail } : {}),
          ...(message.refRequestId !== undefined ? { refRequestId: message.refRequestId } : {}),
        })
        return await sendBusEnvelope(workerReplyTarget(rawTo), envelope, context)
      }
      case 'control': {
        if (!busContextActive()) return { data: busContextRefusal('control', rawTo) }
        const from = senderName()
        if (message.command === 'ack' && message.refRequestId && routerEnabled()) {
          void routerStoreWriters.acceptByRequest(message.refRequestId, 'planner', Date.now()).catch(() => {})
        }
        const envelope: ControlEnvelope = buildControl(from, message.command, {
          ...(message.detail !== undefined ? { detail: message.detail } : {}),
          ...(message.refRequestId !== undefined ? { refRequestId: message.refRequestId } : {}),
        })
        return await sendBusEnvelope(rawTo, envelope, context)
      }
    }
  },
  mapToolResultToToolResultBlockParam(output: SendMessageToolOutput, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, SendMessageToolOutput>)
