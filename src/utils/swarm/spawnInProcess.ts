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

/**
 * Registers an in-process teammate task and kills it.
 *
 * (The snapshot registered the agent in a performance-trace hierarchy here
 * behind a permanently-false enabled query; the tracer module is deleted —
 * that step, and the two unregister steps, are NOT built by ruling.)
 */

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
  /** Spawn-frozen instruction-resolution snapshot. */
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

/**
 * Register the teammate task. The team name enters in the caller's RAW
 * spelling and is never sanitised here — it lands in the deterministic agent
 * id, the identity record and the async-context record; the task store keys
 * the teammate's list by that ambient spelling through its own sanitiser
 * while the lead's registration goes through the lower-casing sanitizeName,
 * so for a name with a capital or an underscore the two address different
 * task directories. Reproduced; never unified.
 */
export async function spawnInProcessTeammate(
  config: InProcessSpawnConfig,
  context: SpawnContext,
): Promise<InProcessSpawnOutput> {
  const agentId = formatAgentId(config.name, config.teamName)
  try {
    const taskId = generateTaskId('in_process_teammate')
    // The controller is INDEPENDENT, not linked to the leader's current
    // query — a teammate must survive the leader interrupting its own turn.
    const abortController = new AbortController()
    // The parent session id doubles as the team's task-list id.
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

    // Abort plus best-effort release of every file lease held by this agent
    // for this team — an owner that has died must not keep peers blocked
    // until the lease expires by timeout. Release is idempotent; a failure
    // is only logged.
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
      // An empty mirror so display helpers work immediately.
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

/**
 * Kill an in-process teammate by task id, inside ONE atomic state update. A
 * task that is missing, of the wrong type, or not `running` changes nothing
 * and answers false — that refusal is what stops a SECOND kill from
 * double-terminalising. `notified: true` is pre-set deliberately: it
 * suppresses the XML notification path, which is why the SDK bookend is
 * emitted directly here.
 */
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
        // An idle waiter throwing must not break the kill.
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

  // File I/O never runs inside the state update.
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
