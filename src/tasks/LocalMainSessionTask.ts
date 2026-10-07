import { randomBytes } from 'node:crypto'

import type { SetAppState } from '../Task.js'
import { createTaskStateBase } from '../Task.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'

import type { AgentId } from '../types/ids.js'

import { createAbortController } from '../utils/abortController.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'

import { getAgentTranscriptPath } from '../utils/sessionStorage/paths.js'

import { initTaskOutputAsSymlink } from '../utils/task/diskOutput.js'
import { registerTask } from '../utils/task/framework.js'

import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import { isLocalAgentTask } from './LocalAgentTask/LocalAgentTask.js'


const MAIN_SESSION_AGENT_TYPE = 'main-session'

const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function generateMainSessionTaskId(): string {
  const bytes = randomBytes(8)
  let suffix = ''
  for (const byte of bytes) {
    suffix += TASK_ID_ALPHABET[byte % TASK_ID_ALPHABET.length]
  }
  return `s${suffix}`
}

type LocalMainSessionTaskState = LocalAgentTaskState & {
  agentType: typeof MAIN_SESSION_AGENT_TYPE
}

export function isMainSessionTask(task: unknown): task is LocalMainSessionTaskState {
  return isLocalAgentTask(task) && task.agentType === MAIN_SESSION_AGENT_TYPE
}

function defaultMainSessionDefinition(): AgentDefinition {
  return {
    agentType: MAIN_SESSION_AGENT_TYPE,
    whenToUse: 'main session query',
    source: 'userSettings',
    systemPrompt: ''
  } as unknown as AgentDefinition
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
    setAppState(prevState => {
      if (!prevState.tasks?.[taskId]) return prevState
      const tasks = { ...prevState.tasks }
      delete tasks[taskId]
      return { ...prevState, tasks }
    })
  })
  const definition = mainThreadAgentDefinition ?? defaultMainSessionDefinition()
  const state: LocalMainSessionTaskState = {
    ...createTaskStateBase({ task_id: taskId, task_type: 'local_agent', description }),
    type: 'local_agent',
    status: 'running',
    agentId: taskId,
    prompt: description,
    selectedAgent: definition,
    agentType: MAIN_SESSION_AGENT_TYPE,
    abortController,
    cleanup,
    isBackgrounded: true
  }
  registerTask(state, setAppState)
  return { taskId, abortSignal: abortController.signal }
}
