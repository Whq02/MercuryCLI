import { randomBytes } from 'node:crypto'

import type { SetAppState } from '../Task.js'
import { createTaskStateBase } from '../Task.js'
import type { AgentDefinition } from '../types/agent.js'

import type { AgentId } from '../types/ids.js'

import { createAbortController } from '../utils/abortController.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'

import { getAgentTranscriptPath } from '../utils/sessionStorage/paths.js'

import { initTaskOutputAsSymlink } from '../utils/task/diskOutput.js'
import { registerTask } from '../utils/task/framework.js'

import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import { isLocalAgentTask } from './LocalAgentTask/LocalAgentTask.js'


const MAIN_SESSION_AGENT_TYPE = 'main-session'
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

type LocalMainSessionTaskState = LocalAgentTaskState & {
  agentType: typeof MAIN_SESSION_AGENT_TYPE
}

export function isMainSessionTask(task: unknown): task is LocalMainSessionTaskState {
  return isLocalAgentTask(task) && task.agentType === MAIN_SESSION_AGENT_TYPE
}

function generateMainSessionTaskId(): string {
  const bytes = randomBytes(8)
  let suffix = ''
  for (let i = 0; i < bytes.length; i++) {
    suffix += BASE36[bytes[i]! % BASE36.length]!
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
  void initTaskOutputAsSymlink(taskId, getAgentTranscriptPath(taskId as AgentId))
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
