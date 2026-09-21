import type { ToolUseContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import { findTeammateTaskByAgentId } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { enqueueAgentReceiptRow } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { SpawnOutput, SpawnTeammateConfig } from '../../tools/shared/spawnMultiAgent.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'

export type OperatorRespawnReceipt =
  | { outcome: 'applied'; agentId: string; taskId: string; outputFile: string }
  | { outcome: 'refused'; reason: string }

export type OperatorResumeContext = {
  getAppState: () => AppState
  toolUseContext: ToolUseContext
}

export type OperatorRespawnPorts = {
  spawn?: (config: SpawnTeammateConfig, context: ToolUseContext) => Promise<{ data: SpawnOutput }>
}

export function operatorResumeWords(description: string): string {
  return `Agent "${description}" resumed from the crew view · it runs on under the same id`
}

export function teammateRespawnWords(name: string): string {
  return `Teammate "${name}" spawned again from the crew view · it starts its prompt over under a new row`
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

export async function respawnTeammateByOperator(
  taskId: string,
  context: OperatorResumeContext,
  ports: OperatorRespawnPorts = {},
): Promise<OperatorRespawnReceipt> {
  const task = context.getAppState().tasks?.[taskId]
  if (!isInProcessTeammateTask(task)) return { outcome: 'refused', reason: `${taskId} is not a teammate row` }
  if (task.status === 'running') return { outcome: 'refused', reason: 'the teammate is running — nothing to resume' }
  const spawn = ports.spawn ?? (await import('../../tools/shared/spawnMultiAgent.js')).spawnTeammate
  let spawned: { data: SpawnOutput }
  try {
    spawned = await spawn(teammateRespawnConfig(task), respawnContextOf(context.toolUseContext))
  } catch (error) {
    return { outcome: 'refused', reason: error instanceof Error ? error.message : String(error) }
  }
  const row = findTeammateTaskByAgentId(spawned.data.agent_id, context.getAppState().tasks) as InProcessTeammateTaskState | undefined
  const newTaskId = row !== undefined && row.status === 'running' ? row.id : taskId
  enqueueAgentReceiptRow({ taskId: newTaskId, description: task.description, summary: teammateRespawnWords(spawned.data.name) })
  return { outcome: 'applied', agentId: spawned.data.agent_id, taskId: newTaskId, outputFile: getTaskOutputPath(newTaskId) }
}
