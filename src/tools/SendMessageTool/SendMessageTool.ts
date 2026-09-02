import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ToolUseContext, type ValidationResult } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import { toAgentId } from '../../types/ids.js'
import { daemonControlRpc } from '../../daemon/controlSocket.js'
import { findTeammateTaskByAgentId } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { isLocalAgentTask, queuePendingMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { generateRequestId } from '../../utils/agentId.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseAddress } from '../../utils/peerAddress.js'
import { routerEnabled } from '../../utils/router/routerGates.js'
import {
  canonicalizeBusTarget,
  isManagedBusTeam,
  IMPLEMENTER_AGENT_NAME,
  knownBusTargets,
  PARTY_EXECUTOR_AGENT_NAMES,
  PARTY_ROUTER_AGENT_NAME,
  PARTY_TEAM_NAME,
} from '../../utils/scribe/busIdentity.js'
import {
  buildControl,
  buildDispatch,
  buildEscalate,
  buildProgress,
  looksLikeHandSerializedBusPayload,
  serializeScribeEnvelope,
  type ControlEnvelope,
  type DispatchEnvelope,
  type ProgressEnvelope,
  type ScribeEnvelope,
} from '../../utils/scribe/scribeBus.js'
import {
  isCrewRole,
  isImplementerRole,
  isScribeRole,
  scribeBusEnabled,
  scribeModeEnabled,
  scribeTaskRouterEnabled,
} from '../../utils/scribe/scribeGates.js'
import { composeDispatchAckHealth, getImplementerTelemetry } from '../../utils/scribe/implementerTelemetry.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { routerStoreWriters } from '../../substrate/routerRunStore.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import {
  answerQuestion,
  canDirect,
  checkBroadcastAllowed,
  checkBroadcastFairness,
  openQuestion,
  resolveDirectActor,
  type TeamFileWithGovernance,
} from '../../utils/swarm/sendMessageGovernance.js'
import { HANDOFF_STATUSES, recordHandoff, type EvidenceRef } from '../../utils/swarm/handoff.js'
import { readTeamFileAsync, type TeamFile } from '../../utils/swarm/teamHelpers.js'
import { assignTeammateColor } from '../../utils/swarm/teammateLayoutManager.js'
import {
  getAgentId,
  getAgentName,
  getTeamName,
  getTeammateColor,
  isTeamLead,
  isTeammate,
} from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import {
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  writeToMailbox,
} from '../../utils/teammateMailbox.js'
import { handleRoutePlan, type RoutePlanMessage } from './routePlanOps.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'


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
      route?: { effort?: string; lane?: string }
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
  | (RoutePlanMessage & { type: 'route_plan' })

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

  if (scribeBusEnabled()) {
    variants.push(
      z.object({
        type: z.literal('dispatch'),
        task: z.string().describe('The refined, well-specified task to execute'),
        title: z.string().optional(),
        priority: z.enum(['normal', 'high']).optional(),
        refRequestId: z.string().optional().describe('An earlier dispatch this one supersedes'),
        ...(scribeTaskRouterEnabled()
          ? {
              route: z
                .object({ effort: z.string().optional(), lane: z.string().optional() })
                .optional()
                .describe('Per-task routing hint'),
            }
          : {}),
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
    if (routerEnabled()) {
      variants.push(
        z.object({
          type: z.literal('route_plan'),
          op: z.enum(['plan', 'accept', 'revise', 'cancel', 'synthesize', 'accept-plan', 'explain']),
          objective: z.string().optional(),
          title: z.string().optional(),
          task: z.string().optional(),
          taskShape: z
            .enum(['mechanical', 'bounded', 'cross-cutting', 'diagnostic', 'architectural', 'research'])
            .optional(),
          ambiguity: z.number().int().min(0).max(3).optional(),
          coupling: z.number().int().min(0).max(3).optional(),
          parallelism: z.number().int().min(0).max(3).optional(),
          requiresSynthesis: semanticBoolean(z.boolean().optional()),
          modelHint: z
            .enum(['opus', 'sonnet', 'fable', 'gpt', 'glm'])
            .optional()
            .describe('A model CLASS preference — never a raw model id'),
          exactPin: z
            .string()
            .optional()
            .describe('An operator model pin that must resolve exactly or the plan is refused'),
          nodes: z
            .array(
              z.object({
                id: z.string(),
                title: z.string(),
                task: z.string(),
                dependsOn: z.array(z.string()).optional(),
                ownsPaths: z.array(z.string()).optional(),
                acceptance: z.array(z.string()).optional(),
                requestedModelClass: z.enum(['opus', 'sonnet', 'fable']).optional(),
                expectedResult: z.string().optional(),
              }),
            )
            .optional(),
          planId: z.string().optional(),
          nodeId: z.string().optional(),
          note: z.string().optional(),
        }),
      )
    }
  }

  return z.object({
    to: z.string().describe('The teammate name to send to, or "*" to broadcast to all teammates'),
    summary: z
      .string()
      .optional()
      .describe('A 5-10 word preview of the message; required for plain string messages'),
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
  return getAgentName() ?? (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
}

function selfAddressRefusalText(rawTo: string): string | null {
  const selfName = getAgentName() ?? (isTeammate() ? null : TEAM_LEAD_NAME)
  if (selfName === null || rawTo.toLowerCase() !== selfName.toLowerCase()) {
    return null
  }
  return (
    `Cannot deliver to "${rawTo}": that is this session's own address, so the message would only land back ` +
    `in your own inbox and read as if a teammate sent it.`
  )
}

function senderColor(name: string): string | undefined {
  return getTeammateColor() ?? assignTeammateColor(name)
}

function nowIso(): string {
  return new Date().toISOString()
}


function teamContextOf(context: ToolUseContext): { teamName: string; leadAgentId: string; teammates?: Record<string, { color?: string }> } | undefined {
  return context.getAppState().teamContext as
    | { teamName: string; leadAgentId: string; teammates?: Record<string, { color?: string }> }
    | undefined
}

async function readRoster(teamName: string | undefined): Promise<TeamFile | null> {
  if (!teamName) return null
  try {
    return await readTeamFileAsync(teamName)
  } catch {
    return null
  }
}

type RecipientResolution =
  | { ok: true; name: string; teamName: string }
  | { ok: false; refusal: string }

async function resolveDeliverableRecipient(
  rawTo: string,
  context: ToolUseContext,
): Promise<RecipientResolution> {
  const teamName = getTeamName(teamContextOf(context))
  if (!teamName) {
    return {
      ok: false,
      refusal:
        `Cannot deliver to "${rawTo}": this session is not in a team and no in-process agent by that name exists, ` +
        `so the message would land in a default inbox nobody reads. Spawn a team first, or address a live subagent by name.`,
    }
  }
  const selfRefusal = selfAddressRefusalText(rawTo)
  if (selfRefusal !== null) {
    const roster = await readRoster(teamName)
    const others = (roster?.members ?? [])
      .map(candidate => candidate.name)
      .filter(name => name.toLowerCase() !== rawTo.toLowerCase())
    return {
      ok: false,
      refusal:
        selfRefusal +
        (others.length > 0 ? ` Teammates you can address: ${others.join(', ')}.` : ''),
    }
  }
  if (rawTo.toLowerCase() === TEAM_LEAD_NAME.toLowerCase()) {
    return { ok: true, name: TEAM_LEAD_NAME, teamName }
  }
  const roster = await readRoster(teamName)
  const member = roster?.members.find(candidate => candidate.name.toLowerCase() === rawTo.toLowerCase())
  if (!member) {
    const memberList = roster?.members.map(candidate => candidate.name).join(', ') || 'none'
    return {
      ok: false,
      refusal:
        `Cannot deliver to "${rawTo}": no such member on team "${teamName}" (members: ${memberList}). ` +
        `A message to an unknown name creates an inbox that is never read.`,
    }
  }
  const freshRoster = await readRoster(teamName)
  const freshMember = freshRoster?.members.find(
    candidate => candidate.name.toLowerCase() === rawTo.toLowerCase(),
  )
  return { ok: true, name: freshMember?.name ?? member.name, teamName }
}

function implementerReplyTarget(addressed: string): string {
  if (isImplementerRole()) return TEAM_LEAD_NAME
  if (isCrewRole()) return TEAM_LEAD_NAME
  return addressed
}

function scribeBusContextActive(): boolean {
  if (isScribeRole() || isImplementerRole() || isCrewRole()) return true
  return scribeBusEnabled() && scribeModeEnabled()
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


async function sendScribeEnvelope(
  targetName: string,
  envelope: ScribeEnvelope,
  context: ToolUseContext,
): Promise<{ data: RequestOutput }> {
  const teamName = getTeamName(teamContextOf(context))
  const resolvedTarget = canonicalizeBusTarget(teamName, targetName)
  const isDirective =
    envelope.kind === 'dispatch' || envelope.kind === 'control' || envelope.kind === 'note'

  if (isDirective && !resolvedTarget.known && isManagedBusTeam(teamName)) {
    const busName = teamName === PARTY_TEAM_NAME ? PARTY_ROUTER_AGENT_NAME : IMPLEMENTER_AGENT_NAME
    return {
      data: {
        success: false,
        message:
          `Unknown bus address "${targetName}" — the ${envelope.kind} envelope was NOT sent. ` +
          `Valid targets for team "${teamName}": ${knownBusTargets(teamName).join(', ')}. ` +
          `Nameplates are display-only; the bus name to use here is "${busName}".`,
        request_id: '',
        target: targetName,
      },
    }
  }

  if (isDirective) {
    const roster = await readRoster(teamName)
    const leadAgentId = teamContextOf(context)?.leadAgentId
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
  if (isDirective && !isImplementerRole()) {
    try {
      const reply = await daemonControlRpc({
        op: 'envelope',
        to: resolvedTarget.name,
        ...(teamName ? { team: teamName } : {}),
        env: envelope,
        ...(color ? { color } : {}),
      } as never)
      if ((reply as { ok?: boolean }).ok) deliveredViaRpc = true
    } catch (error) {
      logForDebugging(`sendScribeEnvelope: socket path failed, journaling directly: ${String(error)}`)
    }
  }

  if (!deliveredViaRpc) {
    const delivered = await writeToMailbox(
      resolvedTarget.name,
      {
        from: envelope.from,
        text: serializeScribeEnvelope(envelope),
        timestamp: nowIso(),
        ...(color ? { color } : {}),
      },
      teamName,
    )
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

  const renamed = resolvedTarget.name !== targetName.trim() ? ` (addressed "${targetName.trim()}")` : ''
  let message = `Sent ${envelope.kind} envelope to ${resolvedTarget.name}${renamed} [request_id: ${envelope.request_id}]`
  if (teamName === PARTY_TEAM_NAME && envelope.kind === 'dispatch') {
    message +=
      `. Pacing: each seat is a model turn taking minutes — first bus activity typically lands within a few minutes, ` +
      `and a consolidated multi-lane outcome within a longer window. Wait on inbound progress (the team brief's ` +
      `turn/age fields) before re-asking, and do not disengage while a seat is mid-turn.`
  } else if (teamName === 'scribe' && envelope.kind === 'dispatch' && !isImplementerRole()) {
    message += ` ${composeDispatchAckHealth(getImplementerTelemetry(), { rpcConfirmed: deliveredViaRpc })}`
  }
  return {
    data: { success: true, message, request_id: envelope.request_id, target: resolvedTarget.name },
  }
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
  const agentId = registered ?? toAgentId(rawTo) ?? undefined
  if (agentId === undefined) return undefined

  const task = context.getAppState().tasks?.[String(agentId)]
  const liveLocal =
    task !== undefined && isLocalAgentTask(task) && !isMainSessionTask(task) ? task : undefined

  if (liveLocal) {
    if (liveLocal.status === 'running') {
      queuePendingMessage(liveLocal.id, content, context.setAppStateForTasks ?? context.setAppState)
      return {
        success: true,
        message: `Message queued for ${rawTo}; it will be delivered at the agent's next tool round.`,
      }
    }
    try {
      const resumed = await (
        await import('../AgentTool/resumeAgent.js')
      ).resumeAgentBackground({
        agentId: String(agentId),
        prompt: content,
        toolUseContext: context,
        canUseTool,
        invokingRequestId,
      })
      return {
        success: true,
        message:
          `Agent ${rawTo} was stopped (status: ${liveLocal.status}); it was resumed in the background with your ` +
          `message and you will be notified when it completes. Output file: ${resumed.outputFile}` +
          (resumed.cwdFallback === 'parent-checkout'
            ? ' NOTE: its worktree is gone (already folded or cleaned) — the revived agent runs in the PARENT checkout; anything it edits lands in the real tree.'
            : ''),
      }
    } catch (error) {
      return {
        success: false,
        message: `Agent ${rawTo} (status: ${liveLocal.status}) could not be resumed: ${errorMessage(error)}`,
      }
    }
  }

  try {
    const resumed = await (
      await import('../AgentTool/resumeAgent.js')
    ).resumeAgentBackground({
      agentId: String(agentId),
      prompt: content,
      toolUseContext: context,
      canUseTool,
      invokingRequestId,
    })
    return {
      success: true,
      message:
        `Agent ${rawTo} was stopped; it was resumed in the background with your message and you will be ` +
        `notified when it completes. Output file: ${resumed.outputFile}` +
        (resumed.cwdFallback === 'parent-checkout'
          ? ' NOTE: its worktree is gone (already folded or cleaned) — the revived agent runs in the PARENT checkout; anything it edits lands in the real tree.'
          : ''),
    }
  } catch (error) {
    return {
      success: false,
      message:
        `Agent ${rawTo} is registered but has no transcript to resume — it may have been cleaned up. ` +
        `(${errorMessage(error)})`,
    }
  }
}

async function sendDirectedPlainMessage(
  rawTo: string,
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<MessageOutput> {
  const resolution = await resolveDeliverableRecipient(rawTo, context)
  if (!resolution.ok) return { success: false, message: resolution.refusal }

  if (
    (isScribeRole() || isImplementerRole() || isCrewRole()) &&
    looksLikeHandSerializedBusPayload(content)
  ) {
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
  const delivered = await writeToMailbox(
    resolution.name,
    {
      from,
      text: content,
      timestamp: nowIso(),
      ...(summary !== undefined ? { summary } : {}),
      ...(color ? { color } : {}),
    },
    resolution.teamName,
  )
  if (!delivered) {
    return {
      success: false,
      message: `The message could NOT be delivered to ${resolution.name} — the mailbox write failed.`,
    }
  }
  const targetColor = teamContextOf(context)?.teammates?.[resolution.name]?.color
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
  const teamContext = teamContextOf(context)
  const teamName = getTeamName(teamContext)
  if (!teamName) {
    throw new Error(
      `Cannot broadcast: this session is not in a team. Create one with the team-spawn tool, or launch with ` +
        `the --team-name identity arguments.`,
    )
  }
  const roster = await readRoster(teamName)
  if (!roster) {
    throw new Error(`Cannot broadcast: unknown team "${teamName}"`)
  }
  const from = senderName()
  if (!from) {
    throw new Error('Cannot broadcast: no sender name. Launch with the --agent-name identity argument.')
  }

  const leadDenial = checkBroadcastAllowed(roster as TeamFileWithGovernance, isTeamLead(teamContext))
  if (leadDenial !== null) {
    return { success: false, message: leadDenial, recipients: [] }
  }
  const fairnessDenial = await checkBroadcastFairness(
    from,
    (roster as TeamFileWithGovernance).governance,
    teamName,
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
      message: 'No teammates to broadcast to — you are the only member of the team.',
      recipients: [],
    }
  }

  const color = senderColor(from)
  const deliveredNames: string[] = []
  const failedNames: string[] = []
  for (const recipient of recipients) {
    const delivered = await writeToMailbox(
      recipient,
      {
        from,
        text: content,
        timestamp: nowIso(),
        ...(summary !== undefined ? { summary } : {}),
        ...(color ? { color } : {}),
      },
      teamName,
    )
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
  let message = `Broadcast delivered to ${deliveredNames.length} teammate(s): ${deliveredNames.join(', ')}`
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
      target: '@team',
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
  const teamContext = teamContextOf(context)
  const teamName = getTeamName(teamContext)
  const roster = await readRoster(teamName)
  const from = senderName()
  const verdict = canDirect(
    resolveDirectActor(roster, from, teamContext?.leadAgentId),
    resolveDirectActor(roster, rawTo, teamContext?.leadAgentId),
  )
  if (!verdict.allowed) {
    return { success: false, message: verdict.reason, request_id: '', target: rawTo }
  }
  const requestId = generateRequestId('shutdown', rawTo)
  const payload = createShutdownRequestMessage({ requestId, from, ...(reason !== undefined ? { reason } : {}) })
  const color = senderColor(from)
  const delivered = await writeToMailbox(
    rawTo,
    { from, text: JSON.stringify(payload), timestamp: nowIso(), ...(color ? { color } : {}) },
    teamName,
  )
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
  const teamContext = teamContextOf(context)
  const teamName = getTeamName(teamContext)
  const agentId = getAgentId()
  const from = senderName()

  if (!message.approve) {
    void (await writeToMailbox(
      TEAM_LEAD_NAME,
      {
        from,
        text: JSON.stringify(
          createShutdownRejectedMessage({
            requestId: message.request_id,
            from,
            reason: message.reason ?? '',
          }),
        ),
        timestamp: nowIso(),
      },
      teamName,
    ))
    return {
      success: true,
      message: `Shutdown rejected: "${message.reason}" — continuing work.`,
      request_id: message.request_id,
    }
  }

  let paneId: string | undefined
  let backendType: string | undefined
  if (teamName && agentId) {
    const roster = await readRoster(teamName)
    const member = roster?.members.find(candidate => candidate.agentId === agentId) as
      | { tmuxPaneId?: string; backendType?: string }
      | undefined
    paneId = member?.tmuxPaneId || undefined
    backendType = member?.backendType || undefined
  }
  void (await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from,
      text: JSON.stringify(
        createShutdownApprovedMessage({ requestId: message.request_id, from, paneId, backendType }),
      ),
      timestamp: nowIso(),
    },
    teamName,
  ))

  const abortOwnTask = (): boolean => {
    const task = findTeammateTaskByAgentId(agentId, context.getAppState().tasks ?? {})
    if (task?.abortController) {
      task.abortController.abort()
      return true
    }
    logForDebugging(`shutdown_response: no in-process task/controller for ${agentId ?? '(no agent id)'}`)
    return false
  }

  if (isInProcessTeammate()) {
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
  const teamContext = teamContextOf(context)
  if (!isTeamLead(teamContext)) {
    throw new Error('Only the team lead can approve or reject plans.')
  }
  const teamName = teamContext?.teamName
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
  const delivered = await writeToMailbox(
    rawTo,
    { from: TEAM_LEAD_NAME, text: JSON.stringify(payload), timestamp: nowIso() },
    teamName,
  )
  if (!delivered) {
    return {
      success: false,
      message: approve
        ? `The plan approval was NOT delivered to ${rawTo} — the teammate has not been told to proceed.`
        : `The plan rejection was NOT delivered to ${rawTo} — the teammate has not received the feedback.`,
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
    resolution.teamName,
  )
  const color = senderColor(from)
  const delivered = await writeToMailbox(
    resolution.name,
    {
      from,
      text: message.content,
      timestamp: nowIso(),
      ...(message.summary !== undefined ? { summary: message.summary } : {}),
      ...(color ? { color } : {}),
    },
    resolution.teamName,
  )
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
  const teamName = getTeamName(teamContextOf(context))
  const from = senderName()
  const closed = await answerQuestion(
    { request_id: message.request_id, answeredBy: from, answerText: message.content },
    teamName,
  )
  const color = senderColor(from)
  const delivered = await writeToMailbox(
    rawTo,
    {
      from,
      text: message.content,
      timestamp: nowIso(),
      ...(message.summary !== undefined ? { summary: message.summary } : {}),
      ...(color ? { color } : {}),
    },
    teamName,
  )
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
    resolution.teamName,
  )
  const evidenceCount = (message.evidenceRefs ?? []).filter(
    entry => !!entry && typeof entry.ref === 'string' && entry.ref.trim().length > 0,
  ).length
  const text =
    `Handoff (${message.status})${verdict.verified ? '' : ' [UNVERIFIED — no evidence]'}: ${message.summary}` +
    (evidenceCount > 0 ? ` (${evidenceCount} evidence ref${evidenceCount === 1 ? '' : 's'})` : '')
  const color = senderColor(from)
  const delivered = await writeToMailbox(
    resolution.name,
    {
      from,
      text,
      timestamp: nowIso(),
      summary: message.summary,
      ...(color ? { color } : {}),
    },
    resolution.teamName,
  )
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
  searchHint: 'send messages to agent teammates over the swarm protocol',
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
  async prompt() {
    return getPrompt()
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
          'Use a bare teammate name (or "*" for broadcast) — there is only one team per session, so the @team suffix is never needed.',
        errorCode: 9,
      }
    }
    if (typeof input.message === 'string') {
      if (!input.summary || input.summary.trim().length === 0) {
        return { result: false, message: 'A summary is required for plain string messages.', errorCode: 9 }
      }
      return { result: true }
    }
    if (to === '*') {
      return { result: false, message: 'Structured messages cannot be broadcast.', errorCode: 9 }
    }
    if (input.message.type === 'shutdown_response' && to !== TEAM_LEAD_NAME) {
      return {
        result: false,
        message: `A shutdown_response must be addressed to "${TEAM_LEAD_NAME}".`,
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
      if (rawTo !== '*') {
        const selfRefusal = selfAddressRefusalText(rawTo)
        if (selfRefusal !== null) {
          return { data: { success: false, message: selfRefusal } }
        }
        const routed = await routeToLocalAgent(
          rawTo,
          content,
          context,
          canUseTool,
          parentAssistantMessage.requestId,
        )
        if (routed !== undefined) return { data: routed }
        return { data: await sendDirectedPlainMessage(rawTo, content, input.summary, context) }
      }
      return { data: await sendBroadcast(content, input.summary, context) }
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
        if (!scribeBusContextActive()) return { data: busContextRefusal('dispatch', rawTo) }
        const from = senderName()
        const envelope: DispatchEnvelope = buildDispatch(from, message.task, {
          ...(message.title !== undefined ? { title: message.title } : {}),
          ...(message.priority !== undefined ? { priority: message.priority } : {}),
          ...(message.refRequestId !== undefined ? { refRequestId: message.refRequestId } : {}),
          ...(message.route !== undefined ? { route: message.route } : {}),
        })
        return await sendScribeEnvelope(rawTo, envelope, context)
      }
      case 'escalate': {
        if (!scribeBusContextActive()) return { data: busContextRefusal('escalate', rawTo) }
        const from = senderName()
        const envelope = buildEscalate(from, message.reason, {
          ...(message.refRequestId !== undefined ? { refRequestId: message.refRequestId } : {}),
          ...(message.needsOperator !== undefined ? { needsOperator: message.needsOperator } : {}),
        })
        return await sendScribeEnvelope(implementerReplyTarget(rawTo), envelope, context)
      }
      case 'progress': {
        if (!scribeBusContextActive()) return { data: busContextRefusal('progress', rawTo) }
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
        return await sendScribeEnvelope(implementerReplyTarget(rawTo), envelope, context)
      }
      case 'control': {
        if (!scribeBusContextActive()) return { data: busContextRefusal('control', rawTo) }
        const from = senderName()
        if (message.command === 'ack' && message.refRequestId && routerEnabled()) {
          void routerStoreWriters.acceptByRequest(message.refRequestId, 'scribe', Date.now()).catch(() => {})
        }
        const envelope: ControlEnvelope = buildControl(from, message.command, {
          ...(message.detail !== undefined ? { detail: message.detail } : {}),
          ...(message.refRequestId !== undefined ? { refRequestId: message.refRequestId } : {}),
        })
        return await sendScribeEnvelope(rawTo, envelope, context)
      }
      case 'route_plan': {
        if (!scribeBusContextActive()) return { data: busContextRefusal('route_plan', rawTo) }
        if (!routerEnabled()) return { data: busContextRefusal('route_plan', rawTo) }
        if (isImplementerRole()) {
          return {
            data: {
              success: false,
              message:
                'Route planning is the planner contract (Scribe, Router, or Maintainer). An executor reports with a progress envelope instead.',
              request_id: '',
              target: rawTo,
            },
          }
        }
        const senderRole = 'scribe' as const
        return await handleRoutePlan(rawTo, message as RoutePlanMessage, {
          send: (to, env) => sendScribeEnvelope(to, env, context),
          senderRole,
          senderName: senderName(),
          executors: PARTY_EXECUTOR_AGENT_NAMES,
        })
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
