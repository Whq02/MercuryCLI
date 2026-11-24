import { existsSync } from 'node:fs'
import type { ToolUseContext, ValidationResult } from '../kit/tool.js'
import { asAgentId, toAgentId } from '../../sessions/transcripts/ids.js'
import { agentStatusWord } from '../../integrations/resources/adapters/agentStatusWord.js'
import { getCrewmateTranscriptPath } from '../../sessions/transcripts/paths.js'
import { readCrewmateTranscript } from '../../crew/crewmates/agentTranscriptReader.js'
import { agentMessageNotice, agentMessageSummary, isCrewmateTask, type CrewmateTaskState } from '../../engine/tasks/local-agent/crewmateTask.js'
import { launchesNamed, namedLaunchReceipts, recordedLaunchesNamed, recordedNamedLaunches, type NamedLaunch } from '../../engine/tasks/local-agent/launchReceipts.js'
import { isMainSessionTask } from '../../engine/tasks/mainSessionTask.js'
import { MAIN_THREAD_AGENT } from '../../sessions/notices/unreadLedger.js'

export type MessageOutput = { success: boolean; message: string }
export type CrewMessageInput = { to: string; message: string }
type CrewMessageVerb = 'deliver to' | 'resume'
type CrewmateAddress = {
  kind: 'agent'
  agentId: string
  who: string
  task?: CrewmateTaskState
  transcriptPath: string | null
}
type CrewAddress = { kind: 'main' } | { kind: 'unknown' } | CrewmateAddress

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

export function senderCrewmateTask(context: ToolUseContext): CrewmateTaskState | undefined {
  if (context.agentId === undefined) return undefined
  const task = context.getAppState().tasks?.[String(context.agentId)]
  return task !== undefined && isCrewmateTask(task) && !isMainSessionTask(task) ? task : undefined
}

export function messageNoticeFor(receiverId: string, content: string, context: ToolUseContext): string {
  const sender = senderCrewmateTask(context)
  return agentMessageNotice({
    taskId: receiverId,
    summary: agentMessageSummary(sender === undefined ? null : { taskId: sender.id, description: sender.description }),
    text: content,
  })
}

function crewmateTranscriptPathOf(agentId: string): string | null {
  const path = getCrewmateTranscriptPath(asAgentId(agentId))
  return existsSync(path) ? path : null
}

export async function resolveCrewAddress(to: string, context: ToolUseContext): Promise<CrewAddress> {
  if (to.toLowerCase() === MAIN_THREAD_AGENT) return { kind: 'main' }
  const state = context.getAppState()
  const registry = state.agentNameRegistry
  const registered = registry?.get(to)
  const candidate = state.tasks?.[to]
  const liveId = isCrewmateTask(candidate) && !isMainSessionTask(candidate) ? to : undefined
  const minted = toAgentId(to) ?? undefined
  const transcriptPath = minted === undefined ? null : crewmateTranscriptPathOf(minted)
  const knownId = liveId ?? (transcriptPath !== null ? minted : undefined)
  const unresolved = registered === undefined && knownId === undefined
  const receipts = unresolved ? launchesNamed(context.messages ?? [], to) : []
  const launches: NamedLaunch[] = unresolved && receipts.length === 0
    ? await recordedLaunchesNamed(to)
    : receipts
  const launch = launches[launches.length - 1]
  const agentId = registered ?? knownId ?? launch?.agentId
  if (agentId === undefined) return { kind: 'unknown' }
  const name = registered !== undefined ? to : [...registry ?? []].find(([, id]) => String(id) === String(agentId))?.[0] ?? launch?.name
  const who = name === undefined ? String(agentId) : `${name} (id ${agentId}${launches.length > 1 ? `, the newest of ${launches.length} launches that carried the name` : ''})`
  const task = context.getAppState().tasks?.[String(agentId)]
  const local = isCrewmateTask(task) && !isMainSessionTask(task) ? task : undefined
  return { kind: 'agent', agentId: String(agentId), who, task: local, transcriptPath: crewmateTranscriptPathOf(String(agentId)) }
}

export async function endedWords(address: CrewmateAddress): Promise<string> {
  const task = address.task
  if (task !== undefined) {
    if (task.status === 'failed') return `failed${task.error ? ` (${task.error})` : ''}`
    return agentStatusWord(task.status)
  }
  const view = address.transcriptPath === null ? undefined : await readCrewmateTranscript(address.transcriptPath)
  if (view === undefined) return 'ended (its transcript is unreadable)'
  return view.end.kind === 'cut' ? `ended (${view.end.words})` : view.end.kind
}

type KnownLaunchedCrewmate = { name: string; agentId: string; status: string }
async function knownLaunchedCrewmates(context: ToolUseContext): Promise<KnownLaunchedCrewmate[]> {
  const state = context.getAppState()
  const statusOf = (id: string) => state.tasks?.[id] === undefined ? 'finished' : agentStatusWord(state.tasks[id]!.status)
  const byName = new Map<string, KnownLaunchedCrewmate>()
  for (const launch of await recordedNamedLaunches()) {
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

export async function unknownCrewmateRefusal(to: string, context: ToolUseContext, verb: CrewMessageVerb): Promise<string> {
  const known = await knownLaunchedCrewmates(context)
  const own = known.find(agent => agent.name === to || agent.agentId === to) ?? known.find(agent => agent.name.toLowerCase() === to.toLowerCase())
  if (own !== undefined) {
    return `Cannot ${verb} "${to}": that is a crewmate of this session (id ${own.agentId}; ${own.status}). Address it by its name or by its id ${own.agentId}` +
      (verb === 'resume' ? '.' : own.status === 'running' ? ' — it is read at its next tool boundary.' : ' — it has finished; ResumeCrewmate gives it a new turn.')
  }
  if (known.length === 0) {
    return `Cannot ${verb} "${to}": no crewmate by that name or id exists in this session. Address a crewmate by the id its launch receipt names or by the name the launch gave it.`
  }
  const running = known.filter(agent => agent.status === 'running').map(agent => agent.name)
  const finished = known.filter(agent => agent.status !== 'running').map(agent => agent.name)
  return `Cannot ${verb} "${to}": no crewmate named ${to} in this session` +
    (running.length > 0 ? `; the running crewmates are: ${running.join(', ')}` : '') +
    (finished.length > 0 ? `; the finished crewmates are: ${finished.join(', ')}` : '') +
    ' — send to an id or one of those names.'
}

export function mapMessageResult(output: MessageOutput, toolUseID: string) {
  return {
    tool_use_id: toolUseID,
    type: 'tool_result' as const,
    content: [{ type: 'text' as const, text: output.message }],
    ...(output.success ? {} : { is_error: true }),
  }
}
