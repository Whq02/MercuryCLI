import { existsSync } from 'node:fs'
import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ToolUseContext, type ValidationResult } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import { asAgentId, toAgentId } from '../../types/ids.js'
import { agentStatusWord } from '../../services/resources/adapters/agentStatusWord.js'
import { getAgentTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { readAgentTranscript, transcriptEndWords } from '../WorkflowTool/agentTranscriptReader.js'
import { requestWorkflowControl, workflowControlBy } from '../WorkflowTool/runControl.js'
import { listWorkflowRunsDetailed, runLiveness } from '../WorkflowTool/runManifest.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { pidAlive } from '../../utils/pidAlive.js'
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
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseAddress } from '../../utils/peerAddress.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'


type MessageOutput = {
  success: boolean
  message: string
}

export type SendMessageToolOutput = MessageOutput


export type Input = {
  to: string
  message: string
}

const inputSchema = lazySchema(() => {
  return z.object({
    to: z.string().describe('The crewmate to send to: the id its launch receipt names or the name its launch gave it; "main" from a background crewmate reaches the agent that launched it'),
    message: z.string().describe('The message'),
  })
})
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.union([
    z.object({
      success: z.boolean(),
      message: z.string(),
    }),
  ]),
)
type OutputSchema = ReturnType<typeof outputSchema>


function selfAddressRefusalText(rawTo: string, context: ToolUseContext): string | null {
  const own = context.agentId === undefined ? undefined : String(context.agentId)
  if (own === undefined) return null
  const registry = context.getAppState().agentNameRegistry as Map<string, string> | undefined
  const registered = registry?.get(rawTo)
  if (rawTo !== own && registered !== own) return null
  return (
    `Cannot deliver to "${rawTo}": that is this session's own address, so the message would only land back ` +
    `in your own queue and read as if another crewmate sent it.`
  )
}

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

async function unknownAgentRefusal(rawTo: string, context: ToolUseContext): Promise<string> {
  const known = await knownLaunchedAgents(context)
  const folded = rawTo.toLowerCase()
  const own =
    known.find(agent => agent.name === rawTo || agent.agentId === rawTo) ??
    known.find(agent => agent.name.toLowerCase() === folded)
  if (own !== undefined) {
    return (
      `Cannot deliver to "${rawTo}": that is a crewmate of this session (id ${own.agentId}; ${own.status}). ` +
      `Address it by its name or by its id ${own.agentId}` +
      (own.status === 'running' ? ' — it is read at its next tool boundary.' : ' to resume it.')
    )
  }
  if (known.length === 0) {
    return (
      `Cannot deliver to "${rawTo}": no crewmate by that name or id exists in this session. ` +
      `Address a crewmate by the id its launch receipt names or by the name the launch gave it.`
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
    return {
      success: false,
      message:
        `Cannot deliver to "${rawTo}": that address names this session's own main agent, and only a background crewmate reaches its main agent there. ` +
        `Address a crewmate by the id its launch receipt names or by its name.`,
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
    return {
      success: false,
      message:
        `Agent ${who}: no running task by that id in this session and no transcript on disk to resume — ` +
        `the agent may belong to another process, or its record was cleaned up. Address a live crewmate by the ` +
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

export const SendMessageTool = buildTool({
  name: SEND_MESSAGE_TOOL_NAME,
  searchHint: 'send a message to a crewmate of this session',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly: () => true,
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
    return { result: true }
  },
  async call(
    input: Input,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentAssistantMessage: AssistantMessage,
  ) {
    const rawTo = input.to.trim()
    const content = input.message
    const selfRefusal = selfAddressRefusalText(rawTo, context)
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
    return { data: { success: false, message: await unknownAgentRefusal(rawTo, context) } }
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
