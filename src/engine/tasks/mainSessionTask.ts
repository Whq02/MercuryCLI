import { randomBytes } from 'node:crypto'

import type { SetAppState } from './taskBase.js'
import { createTaskStateBase } from './taskBase.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import { asAgentId, TASK_ID_ALPHABET, TASK_ID_SUFFIX_LENGTH } from '../../sessions/transcripts/ids.js'
import { createAbortController } from '../../platform/async/abortController.js'
import { registerCleanup } from '../../platform/processes/cleanupRegistry.js'
import { getCrewmateTranscriptPath } from '../../sessions/transcripts/paths.js'
import { initTaskOutputAsSymlink } from '../task-framework/diskOutput.js'
import { registerTask } from '../task-framework/taskRegistry.js'
import type { CrewmateTaskState } from './local-agent/crewmateTask.js'
import { isCrewmateTask } from './local-agent/crewmateTask.js'

const MAIN_SESSION_AGENT_TYPE = 'main-session'

type LocalMainSessionTaskState = CrewmateTaskState & {
  agentType: typeof MAIN_SESSION_AGENT_TYPE
}

export function isMainSessionTask(task: unknown): task is LocalMainSessionTaskState {
  return isCrewmateTask(task) && task.agentType === MAIN_SESSION_AGENT_TYPE
}

function generateMainSessionTaskId(): string {
  const bytes = randomBytes(TASK_ID_SUFFIX_LENGTH)
  let suffix = ''
  for (let i = 0; i < TASK_ID_SUFFIX_LENGTH; i++) {
    suffix += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]!
  }
  return `s${suffix}`
}

export function registerMainSessionTask(
  description: string,
  setAppState: SetAppState,
  mainThreadAgentDefinition?: AgentDefinition,
  existingAbortController?: AbortController,
): { taskId: string; abortSignal: AbortSignal } {
  const taskId = generateMainSessionTaskId()
  void initTaskOutputAsSymlink(taskId, getCrewmateTranscriptPath(asAgentId(taskId)))
  const abortController = existingAbortController ?? createAbortController()
  const cleanup = registerCleanup(async () => {
    setAppState(prev => {
      if (prev.tasks[taskId] === undefined) return prev
      const { [taskId]: _removed, ...rest } = prev.tasks
      return { ...prev, tasks: rest }
    })
  })
  const selectedAgent: AgentDefinition = mainThreadAgentDefinition ?? {
    agentType: MAIN_SESSION_AGENT_TYPE,
    whenToUse: 'main session query',
    source: 'userSettings',
    getSystemPrompt: () => '',
  }
  const state: LocalMainSessionTaskState = {
    ...createTaskStateBase({
      task_id: taskId,
      task_type: 'local_agent',
      description,
    }),
    type: 'local_agent',
    status: 'running',
    agentId: taskId,
    prompt: description,
    selectedAgent,
    agentType: MAIN_SESSION_AGENT_TYPE,
    abortController,
    cleanup,
    isBackgrounded: true,
  }
  registerTask(state, setAppState)
  return { taskId, abortSignal: abortController.signal }
}
