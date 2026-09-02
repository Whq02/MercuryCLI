import sample from 'lodash-es/sample.js'

import { getSessionId } from '../../bootstrap/state.js'
import { sampleSpinnerVerb } from '../../constants/spinnerVerbs.js'
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js'
import type { AppState } from '../../state/AppState.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
  type TeammateIdentity,
} from '../../tasks/InProcessTeammateTask/types.js'
import { formatAgentId } from '../agentId.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { logError } from '../log.js'
import { evictTaskOutput } from '../task/diskOutput.js'
import { evictTerminalTask, registerTask, STOPPED_DISPLAY_MS } from '../task/framework.js'
import { emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import { createTeammateContext, type TeammateContext } from '../teammateContext.js'
import { releaseAllForAgent } from './leaseGlob.js'
import { removeMemberByAgentId } from './teamHelpers.js'


export type SpawnContext = {
  setAppState: (updater: (prevState: AppState) => AppState) => void
  toolUseId?: string
}

export type InProcessSpawnConfig = {
  name: string
  teamName: string
  prompt: string
  color?: string
  planModeRequired: boolean
  model?: string
  agentType?: string
  instructionAtSpawn?: InProcessTeammateTaskState['instructionAtSpawn']
}

export type InProcessSpawnOutput = {
  success: boolean
  agentId: string
  taskId?: string
  abortController?: AbortController
  teammateContext?: TeammateContext
  error?: string
}

export async function spawnInProcessTeammate(
  config: InProcessSpawnConfig,
  context: SpawnContext,
): Promise<InProcessSpawnOutput> {
  const agentId = formatAgentId(config.name, config.teamName)
  try {
    const taskId = generateTaskId('in_process_teammate')
    const abortController = new AbortController()
    const parentSessionId = String(getSessionId())

    const identity: TeammateIdentity = {
      agentId,
      agentName: config.name,
      teamName: config.teamName,
      ...(config.agentType !== undefined ? { agentType: config.agentType } : {}),
      ...(config.color !== undefined ? { color: config.color } : {}),
      ...(config.planModeRequired ? { planModeRequired: true } : { planModeRequired: false }),
      parentSessionId,
    }
    const teammateContext = createTeammateContext({
      agentId,
      agentName: config.name,
      teamName: config.teamName,
      ...(config.color !== undefined ? { color: config.color } : {}),
      planModeRequired: config.planModeRequired,
      parentSessionId,
      abortController,
    })

    const truncated =
      config.prompt.length > 50 ? `${config.prompt.slice(0, 50)}...` : config.prompt
    const description = `${config.name}: ${truncated}`

    const unregisterCleanup = registerCleanup(async () => {
      abortController.abort()
      try {
        await releaseAllForAgent(config.teamName, agentId)
      } catch (error) {
        logForDebugging(`lease release for ${agentId} failed: ${errorMessage(error)}`)
      }
    })

    const task: InProcessTeammateTaskState = {
      ...createTaskStateBase(taskId, 'in_process_teammate', description, context.toolUseId),
      type: 'in_process_teammate',
      status: 'running',
      identity,
      prompt: config.prompt,
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.instructionAtSpawn !== undefined
        ? { instructionAtSpawn: config.instructionAtSpawn }
        : {}),
      abortController,
      unregisterCleanup,
      awaitingPlanApproval: false,
      spinnerVerb: sampleSpinnerVerb(),
      pastTenseVerb: sample(TURN_COMPLETION_VERBS) ?? 'Worked',
      permissionMode: config.planModeRequired ? 'strategy' : 'default',
      isIdle: false,
      shutdownRequested: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      pendingUserMessages: [],
      messages: [],
    }
    registerTask(task, context.setAppState)
    return { success: true, agentId, taskId, abortController, teammateContext }
  } catch (error) {
    logError(error)
    return {
      success: false,
      agentId,
      error: error instanceof Error ? error.message : 'unknown error during spawn',
    }
  }
}

export function killInProcessTeammate(
  taskId: string,
  setAppState: SpawnContext['setAppState'],
): boolean {
  let killed = false
  let capturedTeamName: string | undefined
  let capturedAgentId: string | undefined
  let capturedToolUseId: string | undefined
  let capturedDescription = ''

  setAppState(prevState => {
    const task = prevState.tasks[taskId]
    if (!task || !isInProcessTeammateTask(task) || task.status !== 'running') {
      return prevState
    }
    killed = true
    capturedTeamName = task.identity.teamName
    capturedAgentId = task.identity.agentId
    capturedToolUseId = task.toolUseId
    capturedDescription = task.description

    task.abortController?.abort()
    task.unregisterCleanup?.()
    for (const callback of task.onIdleCallbacks ?? []) {
      try {
        callback()
      } catch {
      }
    }

    const lastMessage = task.messages?.[task.messages.length - 1]
    const nextTask: InProcessTeammateTaskState = {
      ...task,
      status: 'killed',
      notified: true,
      endTime: Date.now(),
      onIdleCallbacks: [],
      ...(lastMessage !== undefined ? { messages: [lastMessage] } : { messages: undefined }),
      pendingUserMessages: [],
      inProgressToolUseIDs: undefined,
      abortController: undefined,
      currentWorkAbortController: undefined,
      unregisterCleanup: undefined,
    }

    const teamContext = prevState.teamContext
    const teammates = teamContext?.teammates
    let nextTeamContext = teamContext
    if (teamContext && teammates && task.identity.agentName in teammates) {
      const remaining = { ...teammates }
      delete remaining[task.identity.agentName]
      nextTeamContext = { ...teamContext, teammates: remaining }
    }

    return {
      ...prevState,
      tasks: { ...prevState.tasks, [taskId]: nextTask },
      ...(nextTeamContext !== teamContext ? { teamContext: nextTeamContext } : {}),
    }
  })

  if (capturedTeamName !== undefined && capturedAgentId !== undefined) {
    removeMemberByAgentId(capturedTeamName, capturedAgentId)
  }
  if (killed) {
    void evictTaskOutput(taskId)
    emitTaskTerminatedSdk(taskId, 'stopped', {
      ...(capturedToolUseId !== undefined ? { toolUseId: capturedToolUseId } : {}),
      summary: capturedDescription,
    })
    const timer = setTimeout(() => evictTerminalTask(taskId, setAppState), STOPPED_DISPLAY_MS)
    timer.unref?.()
  }
  return killed
}
