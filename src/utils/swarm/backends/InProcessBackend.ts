import type { ToolUseContext } from '../../../Tool.js'
import { findTeammateTaskByAgentId } from '../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { requestTeammateShutdown } from '../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { formatAgentId, parseAgentId } from '../../agentId.js'
import { logForDebugging } from '../../debug.js'
import { enforceSubagentModelFloor } from '../../model/modelFloor.js'
import { createShutdownRequestMessage, writeToMailbox } from '../../teammateMailbox.js'
import { TEAM_LEAD_NAME } from '../constants.js'
import { startInProcessTeammate } from '../inProcessRunner.js'
import { killInProcessTeammate, spawnInProcessTeammate } from '../spawnInProcess.js'
import type {
  TeammateExecutor,
  TeammateMessage,
  TeammateSpawnConfig,
  TeammateSpawnResult,
} from './types.js'

/**
 * Teammate executor for same-process teammates: registration and the run
 * loop live in the spawn helpers; this adapts them to the executor contract.
 */
export class InProcessBackend implements TeammateExecutor {
  readonly type = 'in-process' as const
  private context: ToolUseContext | null = null

  setContext(toolUseContext: ToolUseContext): void {
    this.context = toolUseContext
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  async spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult> {
    const agentId = formatAgentId(config.name, config.teamName)
    if (this.context === null) {
      logForDebugging(`in-process executor: spawn of ${agentId} attempted before initialisation`)
      return {
        success: false,
        agentId,
        error: 'In-process executor was not initialised — call setContext() before spawn()',
      }
    }

    // Only the identity fields this path owns; the agent definition,
    // resolved role, description and invoking request id are supplied by
    // richer callers (the spawn tool), not here.
    const spawnResult = await spawnInProcessTeammate(
      {
        name: config.name,
        teamName: config.teamName,
        prompt: config.prompt,
        ...(config.color !== undefined ? { color: config.color } : {}),
        planModeRequired: config.planModeRequired ?? false,
      },
      {
        setAppState: this.context.setAppStateForTasks ?? this.context.setAppState,
        ...(this.context.toolUseId ? { toolUseId: this.context.toolUseId } : {}),
      },
    )

    if (
      spawnResult.success &&
      spawnResult.taskId &&
      spawnResult.teammateContext &&
      spawnResult.abortController
    ) {
      startInProcessTeammate({
        identity: {
          agentId,
          agentName: config.name,
          teamName: config.teamName,
          ...(config.color !== undefined ? { color: config.color } : {}),
          planModeRequired: config.planModeRequired ?? false,
          // The parent session id comes from the returned teammate context.
          parentSessionId: spawnResult.teammateContext.parentSessionId,
        },
        taskId: spawnResult.taskId,
        prompt: config.prompt,
        teammateContext: spawnResult.teammateContext,
        // The parent's conversation is replaced by an empty array: the
        // teammate never reads it, and keeping it would hold the parent's
        // messages live for the teammate's whole lifetime.
        toolUseContext: { ...this.context, messages: [] },
        abortController: spawnResult.abortController,
        ...(config.model !== undefined
          ? { model: enforceSubagentModelFloor(config.model, 'inProcessTeammateSpawn') }
          : {}),
        ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
        ...(config.systemPromptMode !== undefined
          ? { systemPromptMode: config.systemPromptMode }
          : {}),
        ...(config.permissions?.allowedTools !== undefined
          ? { allowedTools: config.permissions.allowedTools }
          : {}),
        ...(config.allowPermissionPrompts !== undefined
          ? { allowPermissionPrompts: config.allowPermissionPrompts }
          : {}),
      })
    }

    return {
      success: spawnResult.success,
      agentId: spawnResult.agentId,
      ...(spawnResult.taskId !== undefined ? { taskId: spawnResult.taskId } : {}),
      ...(spawnResult.abortController !== undefined
        ? { abortController: spawnResult.abortController }
        : {}),
      ...(spawnResult.error !== undefined ? { error: spawnResult.error } : {}),
    }
  }

  async sendMessage(agentId: string, message: TeammateMessage): Promise<void> {
    const parsed = parseAgentId(agentId)
    if (parsed === null) {
      logForDebugging(`in-process executor: invalid agent id ${agentId}`)
      throw new Error(`Invalid agent id "${agentId}" — expected the form name@team`)
    }
    await writeToMailbox(
      parsed.agentName,
      {
        text: message.text,
        from: message.from,
        ...(message.color !== undefined ? { color: message.color } : {}),
        timestamp: message.timestamp ?? new Date().toISOString(),
        ...(message.summary !== undefined ? { summary: message.summary } : {}),
      },
      parsed.teamName,
    )
  }

  /** A second request is not sent when a shutdown was already requested. */
  async terminate(agentId: string, reason?: string): Promise<boolean> {
    if (this.context === null) {
      logForDebugging('in-process executor: terminate attempted before initialisation')
      return false
    }
    const task = findTeammateTaskByAgentId(agentId, this.context.getAppState().tasks)
    if (!task) return false
    if (task.shutdownRequested) return true
    const request = createShutdownRequestMessage({
      requestId: `shutdown-${agentId}-${Date.now()}`,
      from: TEAM_LEAD_NAME,
      ...(reason !== undefined ? { reason } : {}),
    })
    await writeToMailbox(
      task.identity.agentName,
      { from: TEAM_LEAD_NAME, text: JSON.stringify(request), timestamp: new Date().toISOString() },
      task.identity.teamName,
    )
    requestTeammateShutdown(task.id, this.context.setAppStateForTasks ?? this.context.setAppState)
    return true
  }

  async kill(agentId: string): Promise<boolean> {
    if (this.context === null) {
      logForDebugging('in-process executor: kill attempted before initialisation')
      return false
    }
    const task = findTeammateTaskByAgentId(agentId, this.context.getAppState().tasks)
    if (!task) return false
    return killInProcessTeammate(task.id, this.context.setAppStateForTasks ?? this.context.setAppState)
  }

  /** Running with a live controller; a missing controller counts as aborted. */
  async isActive(agentId: string): Promise<boolean> {
    if (this.context === null) return false
    const task = findTeammateTaskByAgentId(agentId, this.context.getAppState().tasks)
    if (!task) return false
    return (
      task.status === 'running' &&
      task.abortController !== undefined &&
      !task.abortController.signal.aborted
    )
  }
}

export function createInProcessBackend(): InProcessBackend {
  return new InProcessBackend()
}
