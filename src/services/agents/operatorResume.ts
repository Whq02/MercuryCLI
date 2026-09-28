import type { ToolUseContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import { findTeammateTaskByAgentId } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { AGENT_RESUME_NOTE, enqueueAgentReceiptRow } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import { formatAgentId } from '../../utils/agentId.js'
import { getAgentTranscript, readAgentMetadata, flushSessionStorage } from '../../utils/sessionStorage.js'
import { listAgentMetadata, type AgentMetadataRow } from '../../utils/sessionStorage/paths.js'
import { filterOrphanedThinkingOnlyMessages, filterUnresolvedToolUses, filterWhitespaceOnlyAssistantMessages } from '../../utils/messages.js'
import { readTeamFileAsync, removeMemberByAgentId } from '../../utils/swarm/teamHelpers.js'
import { reconstructForSubagentResume } from '../../utils/toolResultStorage.js'
import { restoreBoundPrefixFromMessages } from '../providers/anthropic/boundPrefixRecord.js'
import type { SpawnOutput, SpawnTeammateConfig } from '../../tools/shared/spawnMultiAgent.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'

export type OperatorRespawnReceipt =
  | { outcome: 'applied'; agentId: string; taskId: string; outputFile: string; name: string; description: string }
  | { outcome: 'refused'; reason: string }

export type OperatorResumeContext = {
  getAppState: () => AppState
  toolUseContext: ToolUseContext
  prompt?: string
}

export type OperatorRespawnPorts = {
  spawn?: (config: SpawnTeammateConfig, context: ToolUseContext) => Promise<{ data: SpawnOutput }>
  readTranscript?: typeof getAgentTranscript
}

export function operatorResumeWords(description: string): string {
  return `Agent "${description}" resumed from the crew view · it runs on under the same id`
}

export function teammateRespawnWords(name: string): string {
  return `Teammate "${name}" resumed from the crew view · it continues its transcript under a new row`
}

export function teammateRespawnConfig(task: InProcessTeammateTaskState): SpawnTeammateConfig {
  const agentType = task.identity.agentType ?? task.agentDefinition?.agentType
  return {
    name: task.identity.agentName,
    prompt: task.prompt,
    team_name: task.identity.teamName,
    ...(agentType !== undefined ? { agent_type: agentType } : {}),
    ...(task.model !== undefined ? { model: task.model } : {}),
    plan_mode_required: task.identity.planModeRequired === true,
  }
}

export function respawnContextOf(toolUseContext: ToolUseContext): ToolUseContext {
  const { toolUseId: _staleToolUseId, ...rest } = toolUseContext
  void _staleToolUseId
  return { ...rest, abortController: new AbortController() } as ToolUseContext
}

const resumingTeammates = new Set<string>()

export type StoppedTeammateRecord = { taskId: string; name: string }

export async function stoppedTeammateRecord(name: string, teamName: string): Promise<StoppedTeammateRecord | null> {
  const folded = name.trim().toLowerCase()
  let newest: (StoppedTeammateRecord & { launchedAt: number }) | null = null
  for (const { agentId, metadata } of await listAgentMetadata().catch((): AgentMetadataRow[] => [])) {
    if (metadata.teammate?.teamName !== teamName || typeof metadata.name !== 'string' || metadata.name.toLowerCase() !== folded) continue
    const launchedAt = typeof metadata.launchedAt === 'number' && Number.isFinite(metadata.launchedAt) ? metadata.launchedAt : 0
    if (newest === null || launchedAt >= newest.launchedAt) newest = { taskId: agentId, name: metadata.name, launchedAt }
  }
  return newest === null ? null : { taskId: newest.taskId, name: newest.name }
}

async function dropStaleRosterRow(teamName: string, agentId: string): Promise<void> {
  const roster = await readTeamFileAsync(teamName).catch(() => null)
  const stale = roster?.members.find(member => member.agentId === agentId)
  if (stale !== undefined && stale.backendType === 'in-process') removeMemberByAgentId(teamName, agentId)
}

export async function resumeTeammateFromTranscript(
  taskId: string,
  context: OperatorResumeContext,
  ports: OperatorRespawnPorts = {},
): Promise<OperatorRespawnReceipt> {
  const candidate = context.getAppState().tasks?.[taskId]
  const task = isInProcessTeammateTask(candidate) ? candidate : undefined
  if (task?.status === 'running') return { outcome: 'refused', reason: 'the teammate is running — nothing to resume' }
  const meta = await readAgentMetadata(asAgentId(taskId))
  const record = meta?.teammate
  if (task === undefined && (record === undefined || meta?.name === undefined)) return { outcome: 'refused', reason: `${taskId} is not a teammate row` }
  const config: SpawnTeammateConfig =
    task !== undefined
      ? teammateRespawnConfig(task)
      : {
          name: meta!.name!,
          prompt: record!.prompt,
          team_name: record!.teamName,
          ...(record!.agentType !== undefined ? { agent_type: record!.agentType } : {}),
          ...(meta!.model !== undefined ? { model: meta!.model } : {}),
          plan_mode_required: record!.planModeRequired,
        }
  const teamName = config.team_name!
  const agentId = formatAgentId(config.name, teamName)
  if (resumingTeammates.has(agentId)) return { outcome: 'refused', reason: `Teammate "${config.name}" is already resuming` }
  resumingTeammates.add(agentId)
  try {
    const live = findTeammateTaskByAgentId(agentId, context.getAppState().tasks) as InProcessTeammateTaskState | undefined
    if (live?.status === 'running') return { outcome: 'refused', reason: 'the teammate is running — nothing to resume' }
    const transcriptAgentId = task?.transcriptAgentId ?? record?.transcriptAgentId
    await flushSessionStorage()
    const transcript = transcriptAgentId === undefined ? null : await (ports.readTranscript ?? getAgentTranscript)(asAgentId(transcriptAgentId))
    if (transcript === null || transcript.messages.length === 0) {
      return { outcome: 'refused', reason: `No transcript found for teammate "${config.name}" (${transcriptAgentId ?? taskId}) — nothing to resume from` }
    }
    restoreBoundPrefixFromMessages(transcript.messages, { rosterOnly: true })
    const messages = filterWhitespaceOnlyAssistantMessages(filterOrphanedThinkingOnlyMessages(filterUnresolvedToolUses(transcript.messages)))
    const contentReplacementState = reconstructForSubagentResume(context.toolUseContext.contentReplacementState, messages, transcript.contentReplacements)
    config.resume = {
      transcriptAgentId: transcriptAgentId!,
      prompt: context.prompt?.trim() || AGENT_RESUME_NOTE,
      messages,
      ...(contentReplacementState !== undefined ? { contentReplacementState } : {}),
    }
    const effort = meta?.effortOverride ?? task?.effort
    if (effort !== undefined) config.effort = effort
    await dropStaleRosterRow(teamName, agentId)
    const spawn = ports.spawn ?? (await import('../../tools/shared/spawnMultiAgent.js')).spawnTeammate
    const spawned = await spawn(config, respawnContextOf(context.toolUseContext))
    const row = findTeammateTaskByAgentId(spawned.data.agent_id, context.getAppState().tasks) as InProcessTeammateTaskState | undefined
    if (row === undefined || row.status !== 'running') return { outcome: 'refused', reason: `Teammate "${config.name}" did not resume into a running row` }
    return {
      outcome: 'applied',
      agentId: spawned.data.agent_id,
      taskId: row.id,
      outputFile: getTaskOutputPath(row.id),
      name: spawned.data.name,
      description: task?.description ?? meta?.description ?? config.name,
    }
  } catch (error) {
    return { outcome: 'refused', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    resumingTeammates.delete(agentId)
  }
}

export async function respawnTeammateByOperator(
  taskId: string,
  context: OperatorResumeContext,
  ports: OperatorRespawnPorts = {},
): Promise<OperatorRespawnReceipt> {
  const receipt = await resumeTeammateFromTranscript(taskId, context, ports)
  if (receipt.outcome === 'applied') enqueueAgentReceiptRow({ taskId: receipt.taskId, description: receipt.description, summary: teammateRespawnWords(receipt.name) })
  return receipt
}
