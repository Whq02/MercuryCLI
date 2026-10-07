import { existsSync } from 'node:fs'
import type { ToolUseContext, ValidationResult } from '../../Tool.js'
import { asAgentId, toAgentId } from '../../types/ids.js'
import { agentStatusWord } from '../../services/resources/adapters/agentStatusWord.js'
import { getAgentTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { readAgentTranscript } from '../WorkflowTool/agentTranscriptReader.js'
import { requestWorkflowControl, workflowControlBy } from '../WorkflowTool/runControl.js'
import { listWorkflowRunsDetailed, runLiveness } from '../WorkflowTool/runManifest.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { pidAlive } from '../../utils/pidAlive.js'
import { agentMessageNotice, agentMessageSummary, isLocalAgentTask, type LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { launchesNamed, namedLaunchReceipts, recordedLaunchesNamed, recordedNamedLaunches, type NamedLaunch } from '../../tasks/LocalAgentTask/launchReceipts.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { MAIN_THREAD_AGENT } from '../../services/notices/unreadLedger.js'
import { workflowOwnedAgentWords, workflowOwningAgent } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

export type MessageOutput = { success: boolean; message: string }
export type CrewMessageInput = { to: string; message: string }
export type CrewMessageVerb = 'deliver to' | 'resume'
type WorkflowAddress = { runDir: string; runId: string; workflowName?: string }
export type CrewAgentAddress = {
  kind: 'agent'
  agentId: string
  who: string
  task?: LocalAgentTaskState
  transcriptPath: string | null
  workflow?: WorkflowAddress | { refusal: string }
}
export type CrewAddress = { kind: 'main' } | { kind: 'unknown' } | CrewAgentAddress

export async function validateCrewMessage(input: CrewMessageInput): Promise<ValidationResult> {
  if (input.to.trim() === '') return { result: false, message: 'Recipient ("to") must not be empty.', errorCode: 9 }
  if (input.message.trim() === '') return { result: false, message: 'The message must not be empty.', errorCode: 9 }
  return { result: true }
}

export function selfAddressRefusalText(to: string, context: ToolUseContext, verb: CrewMessageVerb, resolvedId?: string): string | null {
  const own = context.agentId === undefined ? undefined : String(context.agentId)
  if (own === undefined) return null
  const registered = context.getAppState().agentNameRegistry?.get(to)
  if (to !== own && registered !== own && resolvedId !== own) return null
  return verb === 'resume'
    ? `Cannot resume "${to}": that is this session's own address — you are that agent, and you are running.`
    : `Cannot deliver to "${to}": that is this session's own address, so the message would only land back in your own queue and read as if another crewmate sent it.`
}

export function senderAgentTask(context: ToolUseContext): LocalAgentTaskState | undefined {
  if (context.agentId === undefined) return undefined
  const task = context.getAppState().tasks?.[String(context.agentId)]
  return task !== undefined && isLocalAgentTask(task) && !isMainSessionTask(task) ? task : undefined
}

export function messageNoticeFor(receiverId: string, content: string, context: ToolUseContext): string {
  const sender = senderAgentTask(context)
  return agentMessageNotice({
    taskId: receiverId,
    summary: agentMessageSummary(sender === undefined ? null : { taskId: sender.id, description: sender.description }),
    text: content,
  })
}

function agentTranscriptPathOf(agentId: string): string | null {
  try {
    const path = getAgentTranscriptPath(asAgentId(agentId))
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

async function workflowAddress(agentId: string, context: ToolUseContext): Promise<CrewAgentAddress['workflow']> {
  const own = workflowOwningAgent(context.getAppState().tasks, agentId)
  if (own !== undefined) {
    return own.runDir === undefined
      ? { refusal: workflowOwnedAgentWords(own, agentId) }
      : { runDir: own.runDir, runId: own.workflowRunId, workflowName: own.workflowName ?? own.description }
  }
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
    if (run.agents.some(agent => agent.agentId === agentId && (agent.state === 'start' || agent.state === 'progress'))) {
      return { runDir: run.runDir, runId: run.runId, workflowName: run.workflowName }
    }
  }
  return undefined
}

export async function resolveCrewAddress(to: string, context: ToolUseContext): Promise<CrewAddress> {
  if (to.toLowerCase() === MAIN_THREAD_AGENT) return { kind: 'main' }
  const state = context.getAppState()
  const registry = state.agentNameRegistry
  const registered = registry?.get(to)
  const candidate = state.tasks?.[to]
  const liveId = isLocalAgentTask(candidate) && !isMainSessionTask(candidate) ? to : undefined
  const minted = toAgentId(to) ?? undefined
  let workflow: CrewAgentAddress['workflow']
  const transcriptPath = minted === undefined ? null : agentTranscriptPathOf(minted)
  if (registered === undefined && liveId === undefined && minted !== undefined && transcriptPath === null) {
    workflow = await workflowAddress(minted, context)
  }
  const knownId = liveId ?? (transcriptPath !== null || workflow !== undefined ? minted : undefined)
  const unresolved = registered === undefined && knownId === undefined
  const receipts = unresolved ? launchesNamed(context.messages ?? [], to) : []
  const launches: NamedLaunch[] = unresolved && receipts.length === 0
    ? await recordedLaunchesNamed(to).catch((): NamedLaunch[] => [])
    : receipts
  const launch = launches[launches.length - 1]
  const agentId = registered ?? knownId ?? launch?.agentId
  if (agentId === undefined) return { kind: 'unknown' }
  const name = registered !== undefined ? to : [...registry ?? []].find(([, id]) => String(id) === String(agentId))?.[0] ?? launch?.name
  const who = name === undefined ? String(agentId) : `${name} (id ${agentId}${launches.length > 1 ? `, the newest of ${launches.length} launches that carried the name` : ''})`
  const task = context.getAppState().tasks?.[String(agentId)]
  const local = isLocalAgentTask(task) && !isMainSessionTask(task) ? task : undefined
  if (local === undefined && workflow === undefined) workflow = await workflowAddress(String(agentId), context)
  return { kind: 'agent', agentId: String(agentId), who, task: local, transcriptPath: agentTranscriptPathOf(String(agentId)), workflow }
}

export async function endedWords(address: CrewAgentAddress): Promise<string> {
  const task = address.task
  if (task !== undefined) {
    if (task.status === 'failed') return `failed${task.error ? ` (${task.error})` : ''}`
    return agentStatusWord(task.status)
  }
  const view = address.transcriptPath === null ? undefined : await readAgentTranscript(address.transcriptPath)
  if (view === undefined) return 'ended (its transcript is unreadable)'
  return view.end.kind === 'cut' ? `ended (${view.end.words})` : view.end.kind
}

type KnownLaunchedAgent = { name: string; agentId: string; status: string }
async function knownLaunchedAgents(context: ToolUseContext): Promise<KnownLaunchedAgent[]> {
  const state = context.getAppState()
  const statusOf = (id: string) => state.tasks?.[id] === undefined ? 'finished' : agentStatusWord(state.tasks[id]!.status)
  const byName = new Map<string, KnownLaunchedAgent>()
  for (const launch of await recordedNamedLaunches().catch((): NamedLaunch[] => [])) {
    byName.set(launch.name, { name: launch.name, agentId: launch.agentId, status: statusOf(launch.agentId) })
  }
  for (const receipt of namedLaunchReceipts(context.messages ?? [])) {
    byName.set(receipt.name, { name: receipt.name, agentId: receipt.agentId, status: statusOf(receipt.agentId) })
  }
  for (const [name, agentId] of state.agentNameRegistry ?? []) {
    byName.set(name, { name, agentId: String(agentId), status: statusOf(String(agentId)) })
  }
  return [...byName.values()]
}

export async function unknownAgentRefusal(to: string, context: ToolUseContext, verb: CrewMessageVerb): Promise<string> {
  const known = await knownLaunchedAgents(context)
  const own = known.find(agent => agent.name === to || agent.agentId === to) ?? known.find(agent => agent.name.toLowerCase() === to.toLowerCase())
  if (own !== undefined) {
    return `Cannot ${verb} "${to}": that is a crewmate of this session (id ${own.agentId}; ${own.status}). Address it by its name or by its id ${own.agentId}` +
      (verb === 'resume' ? '.' : own.status === 'running' ? ' — it is read at its next tool boundary.' : ' — it has finished; ResumeAgent gives it a new turn.')
  }
  if (known.length === 0) {
    return `Cannot ${verb} "${to}": no crewmate by that name or id exists in this session. Address a crewmate by the id its launch receipt names or by the name the launch gave it.`
  }
  const running = known.filter(agent => agent.status === 'running').map(agent => agent.name)
  const finished = known.filter(agent => agent.status !== 'running').map(agent => agent.name)
  return `Cannot ${verb} "${to}": no agent named ${to} in this session` +
    (running.length > 0 ? `; the running agents are: ${running.join(', ')}` : '') +
    (finished.length > 0 ? `; the finished agents are: ${finished.join(', ')}` : '') +
    ' — send to an id or one of those names.'
}

export async function messageWorkflowWorker(address: CrewAgentAddress, content: string): Promise<MessageOutput | undefined> {
  const workflow = address.workflow
  if (workflow === undefined) return undefined
  if ('refusal' in workflow) return { success: false, message: workflow.refusal }
  const { runDir, runId } = workflow
  const agentId = address.agentId
  const result = await requestWorkflowControl(runDir, { action: 'message-agent', by: workflowControlBy(getSessionId(), process.pid), agentId, message: content })
  const where = `worker ${agentId} of workflow "${workflow.workflowName ?? runId}" (${runId})`
  if (result.outcome === 'applied') return { success: true, message: `Message queued for ${where}: ${result.detail}. The run's journal carries the request and its answer.` }
  if (result.outcome === 'pending') return { success: true, message: `Message left for ${where}: ${result.reason}.` }
  return { success: false, message: `Message to ${where} refused: ${result.reason}. Inspect mercury://workflow/${runId}?child=${agentId} for its state.` }
}

export function mapMessageResult(output: MessageOutput, toolUseID: string) {
  return {
    tool_use_id: toolUseID,
    type: 'tool_result' as const,
    content: [{ type: 'text' as const, text: output.message }],
    ...(output.success ? {} : { is_error: true }),
  }
}
