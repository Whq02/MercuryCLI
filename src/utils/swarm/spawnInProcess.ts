import sample from 'lodash-es/sample.js'

import { getSessionId } from '../../bootstrap/state.js'
import { sampleSpinnerVerb } from '../../constants/spinnerVerbs.js'
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js'
import type { AppState } from '../../state/AppState.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import {
  isInProcessCrewmateTask,
  type InProcessCrewmateTaskState,
  type CrewmateIdentity,
} from '../../tasks/InProcessCrewmateTask/types.js'
import { formatAgentId } from '../agentId.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { logError } from '../log.js'
import { evictTaskOutput } from '../task/diskOutput.js'
import { evictTerminalTask, registerTask, STOPPED_DISPLAY_MS } from '../task/framework.js'
import { emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import { writeAgentMetadata } from '../sessionStorage/paths.js'
import { asAgentId } from '../../types/ids.js'
import { createCrewmateContext, type CrewmateContext } from '../crewmateContext.js'
import { crewWorktreeLeftWords } from '../crew/crewWorktreeReminder.js'
import { releaseAllForAgent } from './leaseGlob.js'
import { markMemberStopped } from './crewHelpers.js'
import { setLiveBusy } from '../../services/crew/liveComms.js'


export type SpawnContext = {
  setAppState: (updater: (prevState: AppState) => AppState) => void
  toolUseId?: string
}

export type InProcessSpawnConfig = {
  name: string
  crewName: string
  prompt: string
  color?: string
  planModeRequired: boolean
  model?: string
  cwd?: string
  worktree?: string
  agentType?: string
  transcriptAgentId?: string
  effort?: string
  instructionAtSpawn?: InProcessCrewmateTaskState['instructionAtSpawn']
}

export type InProcessSpawnOutput = {
  success: boolean
  agentId: string
  taskId?: string
  transcriptAgentId?: string
  abortController?: AbortController
  crewmateContext?: CrewmateContext
  error?: string
}

export async function spawnInProcessCrewmate(
  config: InProcessSpawnConfig,
  context: SpawnContext,
): Promise<InProcessSpawnOutput> {
  const agentId = formatAgentId(config.name, config.crewName)
  try {
    const taskId = generateTaskId('in_process_crewmate')
    const transcriptAgentId = config.transcriptAgentId ?? generateTaskId('local_agent')
    const abortController = new AbortController()
    const parentSessionId = String(getSessionId())

    const identity: CrewmateIdentity = {
      agentId,
      agentName: config.name,
      crewName: config.crewName,
      ...(config.agentType !== undefined ? { agentType: config.agentType } : {}),
      ...(config.color !== undefined ? { color: config.color } : {}),
      ...(config.planModeRequired ? { planModeRequired: true } : { planModeRequired: false }),
      parentSessionId,
    }
    const crewmateContext = createCrewmateContext({
      agentId,
      agentName: config.name,
      crewName: config.crewName,
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
        await releaseAllForAgent(config.crewName, config.name)
      } catch (error) {
        logForDebugging(`lease release for ${agentId} failed: ${errorMessage(error)}`)
      }
    })

    const task: InProcessCrewmateTaskState = {
      ...createTaskStateBase(taskId, 'in_process_crewmate', description, context.toolUseId),
      type: 'in_process_crewmate',
      status: 'running',
      identity,
      prompt: config.prompt,
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      ...(config.worktree !== undefined ? { worktree: config.worktree } : {}),
      transcriptAgentId,
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
    await writeAgentMetadata(asAgentId(taskId), {
      agentType: config.agentType ?? config.name,
      name: config.name,
      description,
      launchedAt: task.startTime,
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      ...(config.worktree !== undefined ? { worktreePath: config.worktree } : {}),
      ...(config.effort !== undefined ? { effortOverride: config.effort } : {}),
      crewmate: {
        crewName: config.crewName,
        prompt: config.prompt,
        transcriptAgentId,
        planModeRequired: config.planModeRequired,
        ...(config.agentType !== undefined ? { agentType: config.agentType } : {}),
      },
    }).catch((error: unknown) => {
      logForDebugging(`crewmate ${agentId}: the resume record was not written: ${errorMessage(error)}`)
    })
    registerTask(task, context.setAppState)
    return { success: true, agentId, taskId, transcriptAgentId, abortController, crewmateContext }
  } catch (error) {
    logError(error)
    return {
      success: false,
      agentId,
      error: error instanceof Error ? error.message : 'unknown error during spawn',
    }
  }
}

export function unwindCrewmateSpawn(taskId: string, setAppState: SpawnContext['setAppState'], cause: string): boolean {
  let unwound = false
  let capturedToolUseId: string | undefined
  setAppState(prevState => {
    const task = prevState.tasks[taskId]
    if (!task || !isInProcessCrewmateTask(task) || task.status !== 'running') return prevState
    unwound = true
    capturedToolUseId = task.toolUseId
    task.abortController?.abort()
    task.unregisterCleanup?.()
    const tasks = { ...prevState.tasks }
    delete tasks[taskId]
    return { ...prevState, tasks }
  })
  if (unwound) {
    void evictTaskOutput(taskId)
    emitTaskTerminatedSdk(taskId, 'failed', {
      ...(capturedToolUseId !== undefined ? { toolUseId: capturedToolUseId } : {}),
      summary: cause,
    })
  }
  return unwound
}

export function killInProcessCrewmate(
  taskId: string,
  setAppState: SpawnContext['setAppState'],
): boolean {
  let killed = false
  let capturedCrewName: string | undefined
  let capturedAgentId: string | undefined
  let capturedToolUseId: string | undefined
  let capturedDescription = ''
  let capturedWorktree: string | undefined
  let capturedName: string | undefined
  let capturedEndTime = Date.now()

  setAppState(prevState => {
    const task = prevState.tasks[taskId]
    if (!task || !isInProcessCrewmateTask(task) || task.status !== 'running') {
      return prevState
    }
    killed = true
    capturedCrewName = task.identity.crewName
    capturedAgentId = task.identity.agentId
    capturedName = task.identity.agentName
    capturedToolUseId = task.toolUseId
    capturedDescription = task.description
    capturedWorktree = task.worktree

    task.abortController?.abort()
    task.unregisterCleanup?.()
    for (const callback of task.onIdleCallbacks ?? []) {
      try {
        callback()
      } catch {
      }
    }

    const lastMessage = task.messages?.[task.messages.length - 1]
    capturedEndTime = Date.now()
    const nextTask: InProcessCrewmateTaskState = {
      ...task,
      status: 'killed',
      notified: true,
      endTime: capturedEndTime,
      onIdleCallbacks: [],
      ...(lastMessage !== undefined ? { messages: [lastMessage] } : { messages: undefined }),
      pendingUserMessages: [],
      inProgressToolUseIDs: undefined,
      abortController: undefined,
      currentWorkAbortController: undefined,
      unregisterCleanup: undefined,
    }

    const crewContext = prevState.crewContext
    const crewmates = crewContext?.crewmates
    let nextCrewContext = crewContext
    if (crewContext && crewmates && task.identity.agentName in crewmates) {
      const remaining = { ...crewmates }
      delete remaining[task.identity.agentName]
      nextCrewContext = { ...crewContext, crewmates: remaining }
    }

    return {
      ...prevState,
      tasks: { ...prevState.tasks, [taskId]: nextTask },
      ...(nextCrewContext !== crewContext ? { crewContext: nextCrewContext } : {}),
    }
  })

  if (capturedCrewName !== undefined && capturedAgentId !== undefined && capturedName !== undefined) {
    markMemberStopped(capturedCrewName, capturedAgentId, capturedEndTime).catch((error: unknown) => {
      logForDebugging(`crewmate ${capturedAgentId}: the roster's stop mark was not written: ${errorMessage(error)}`)
    })
    setLiveBusy(capturedCrewName, capturedName, false).catch((error: unknown) => {
      logForDebugging(`crewmate ${capturedAgentId}: the live busy word was not cleared at the stop: ${errorMessage(error)}`)
    })
  }
  if (killed) {
    void evictTaskOutput(taskId)
    emitTaskTerminatedSdk(taskId, 'stopped', {
      ...(capturedToolUseId !== undefined ? { toolUseId: capturedToolUseId } : {}),
      summary: capturedWorktree !== undefined ? `${capturedDescription} · ${crewWorktreeLeftWords(capturedWorktree)}` : capturedDescription,
    })
    const timer = setTimeout(() => evictTerminalTask(taskId, setAppState), STOPPED_DISPLAY_MS)
    timer.unref?.()
  }
  return killed
}
