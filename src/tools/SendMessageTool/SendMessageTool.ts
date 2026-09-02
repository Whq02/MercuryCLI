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

/**
 * The inter-agent message bus tool: plain messages, broadcast, the
 * shutdown/plan protocol, tracked Q&A, evidence-gated handoff, and the
 * coordination-bus envelope kinds. The one law running through every path
 * is DELIVERY HONESTY: a swallowed mailbox write must never report success
 * (the two shutdown_response branches are the documented exception).
 */

// ── output shapes ───────────────────────────────────────────────────────────

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

// ── input shapes ────────────────────────────────────────────────────────────

/**
 * Hand-synced with the runtime schema below: the runtime variants are pushed
 * into a gate-conditional list, so the static type is written by hand as a
 * superset. Do not unify them — the runtime gating is the point.
 */
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

// The schema is built ONCE per process (the lazySchema factory runs at first
// access), so its gate reads are schema-build-time facts; the CALL path is
// the honest gate for the bus kinds (the context gate below).
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
    // Nested inside the bus branch: route_plan needs BOTH gates at
    // schema-build time (and re-checks the planner gate at call time).
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

// ── shared helpers ──────────────────────────────────────────────────────────

/** The sender identity: agent name, else the teammate literal, else the lead. */
function senderName(): string {
  return getAgentName() ?? (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
}

/**
 * The self-address guard: a message to this session's own name never
 * leaves the session — it would only land in the sender's own inbox (or
 * pending-message queue) and read back as if a teammate wrote it, so the
 * refusal names the confusion instead. Only a real agent name (or the
 * lead seat) can self-match; the unnamed 'teammate' literal never does.
 */
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

/**
 * The undeliverable-recipient guard plus canonical-name mapping. A send to
 * your OWN address is refused by name (it would land in your own inbox and
 * read back as if a teammate wrote it); a send to the team-lead name is
 * otherwise always deliverable (the lead polls its own inbox regardless of
 * roster membership); any other recipient must appear on the roster,
 * matched case-insensitively — and delivery uses the roster's STORED
 * casing, because a differently-cased inbox file is one nobody reads.
 */
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
  // The mapping re-reads the roster (the guard's read is not reused) so the
  // stored casing is current at delivery time.
  const freshRoster = await readRoster(teamName)
  const freshMember = freshRoster?.members.find(
    candidate => candidate.name.toLowerCase() === rawTo.toLowerCase(),
  )
  return { ok: true, name: freshMember?.name ?? member.name, teamName }
}

/** A worker's outbound report is routed to the seat that actually reads it. */
function implementerReplyTarget(addressed: string): string {
  if (isImplementerRole()) return TEAM_LEAD_NAME
  if (isCrewRole()) return TEAM_LEAD_NAME
  return addressed
}

/**
 * The CALL-time coordination-context gate: the schema is built once per
 * process, so this is the honest gate for the bus kinds.
 */
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

// ── the scribe-bus send path ────────────────────────────────────────────────

/**
 * The one send path for every envelope kind: address canonicalisation,
 * fail-closed unknown directive targets on managed teams, directive
 * authority, socket-first transport for dispatcher-side kinds with a
 * byte-equivalent journal fallback, and delivery honesty.
 */
async function sendScribeEnvelope(
  targetName: string,
  envelope: ScribeEnvelope,
  context: ToolUseContext,
): Promise<{ data: RequestOutput }> {
  const teamName = getTeamName(teamContextOf(context))
  // 1. Address canonicalisation — display nameplates are render-only; the
  //    mailbox writer creates an inbox file verbatim while the drain only
  //    reads the canonical one.
  const resolvedTarget = canonicalizeBusTarget(teamName, targetName)
  const isDirective =
    envelope.kind === 'dispatch' || envelope.kind === 'control' || envelope.kind === 'note'

  // 2. Fail closed for unknown directive targets on managed teams.
  if (isDirective && !resolvedTarget.known && isManagedBusTeam(teamName)) {
    const busName = IMPLEMENTER_AGENT_NAME
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

  // 3. Directive authority, between the envelope's declared sender and the
  //    RESOLVED target.
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

  // 4. Socket-first transport for dispatcher-side kinds; any refusal or
  //    connection failure falls back to the journal write, which is
  //    byte-equivalent in durability. Worker-origin kinds (progress /
  //    escalate) never take the socket.
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

  // 5+6. Mailbox write (fallback or primary), delivery-honest: the mailbox
  //      writer swallows IO errors, and the dispatcher must never believe
  //      work is in flight when nothing was written.
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

  // 7. Success text: kind, resolved target, the original address when it
  //    differed, the request id — plus the dispatch-ack health clause on
  //    the scribe team.
  const renamed = resolvedTarget.name !== targetName.trim() ? ` (addressed "${targetName.trim()}")` : ''
  let message = `Sent ${envelope.kind} envelope to ${resolvedTarget.name}${renamed} [request_id: ${envelope.request_id}]`
  if (teamName === 'scribe' && envelope.kind === 'dispatch' && !isImplementerRole()) {
    message += ` ${composeDispatchAckHealth(getImplementerTelemetry(), { rpcConfirmed: deliveredViaRpc })}`
  }
  return {
    data: { success: true, message, request_id: envelope.request_id, target: resolvedTarget.name },
  }
}

// ── plain-message paths ─────────────────────────────────────────────────────

async function routeToLocalAgent(
  rawTo: string,
  content: string,
  context: ToolUseContext,
  canUseTool?: CanUseToolFn,
  invokingRequestId?: string,
): Promise<MessageOutput | undefined> {
  const registry = context.getAppState().agentNameRegistry as Map<string, string> | undefined
  const registered = registry?.get(rawTo)
  // The owning validator decides id-shape (a null return means "not an id").
  const agentId = registered ?? toAgentId(rawTo) ?? undefined
  if (agentId === undefined) return undefined

  const task = context.getAppState().tasks?.[String(agentId)]
  const liveLocal =
    task !== undefined && isLocalAgentTask(task) && !isMainSessionTask(task) ? task : undefined

  if (liveLocal) {
    if (liveLocal.status === 'running') {
      // Delivered at the agent's next tool round; the task-scoped setter
      // must be used when the context carries one.
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

  // The id resolves but no live local (non-main-session) task holds it:
  // attempt a resume from the on-disk transcript.
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

  // Mechanically enforce the rule the prompt packs state: a bus-role sender
  // must never hand-serialise an envelope into a plain string — the retry
  // must land on the structured path instead of delivering as a context
  // frame.
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
    // Unreachable in practice (the fallback chain ends at a literal); the
    // message documents the operator remedy.
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

// ── protocol paths ──────────────────────────────────────────────────────────

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
    // HONESTY EXCEPTION (documented): both shutdown_response branches
    // report success without inspecting the write result. Reproduced, not
    // repaired — making it honest changes the shutdown handshake.
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

  // Approve: find the responder's own pane id / backend type on the roster.
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
  // Same honesty exception: the write result is not inspected.
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
  // Not in-process: the in-process abort is still attempted as a fallback.
  if (abortOwnTask()) {
    return {
      success: true,
      message:
        'Shutdown approved — confirmation sent to the lead; the in-process task was aborted (fallback path).',
      request_id: message.request_id,
    }
  }
  // Deferred so the tool result is returned first.
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
  // The team name for these two paths is read directly off the session's
  // team context, not through the shared accessor.
  const teamName = teamContext?.teamName
  const approve = message.approve
  const currentMode = context.getAppState().toolPermissionContext.mode
  // A teammate must not inherit strategy mode from an approval.
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
  // The ledger entry is opened BEFORE the mailbox write, so it exists even
  // when delivery fails.
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
  // Deliberate asymmetry: answer does NOT run the undeliverable-recipient
  // guard — it legitimately targets the asker.
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
  // The ledger receives the RAW evidence array; the delivered text quotes
  // the filtered count. Delivery is never blocked — only the claim is
  // quarantined.
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

// ── the tool ────────────────────────────────────────────────────────────────

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
  // Read-only exactly when the message is a plain string.
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
    // The bus kinds (dispatch/escalate/progress/control/route_plan) fall off
    // the end and project undefined — shipped behaviour; adding a projection
    // changes what the auto-mode classifier sees for bus traffic.
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
        // The self-address guard runs before ANY routing — a shared-state
        // registry could otherwise queue the message back onto the sender.
        const selfRefusal = selfAddressRefusalText(rawTo)
        if (selfRefusal !== null) {
          return { data: { success: false, message: selfRefusal } }
        }
        // In-process agent routing runs FIRST, before any team resolution.
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

    // The call path re-asserts the broadcast rule: a caller that bypasses
    // validation still cannot broadcast an envelope.
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
        // Router side-effects fire BEFORE the send, fire-and-forget: this is
        // the one seam both streams share (the daemon never observes a
        // worker's outbound mail). They must never block or fail the send.
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
        // An ack with a referenced request id records that node's acceptance,
        // attributed by the sender's role; idempotent on duplicates.
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
        // Planner-only: the planner gate is re-checked at call time, and its
        // refusal is the SAME "no coordinator engaged" refusal.
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
          // Route-plan dispatches are DIRECTIVES emitted through the same
          // envelope path.
          send: (to, env) => sendScribeEnvelope(to, env, context),
          senderRole,
          senderName: senderName(),
          executors: [],
        })
      }
    }
  },
  mapToolResultToToolResultBlockParam(output: SendMessageToolOutput, toolUseID: string) {
    // The whole result as JSON inside a single text content block (an array
    // of one text block, not a bare string).
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, SendMessageToolOutput>)
