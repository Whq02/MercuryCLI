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
import { notBuilt, type Unbuilt } from '../pi/holes.js'


const MAIN_SESSION_AGENT_TYPE = 'main-session'

type LocalMainSessionTaskState = Unbuilt

export function isMainSessionTask(task: unknown): task is LocalMainSessionTaskState {
  return notBuilt('src/tasks/LocalMainSessionTask.ts:38')
}

export function registerMainSessionTask(
  description: string,
  setAppState: SetAppState,
  mainThreadAgentDefinition?: AgentDefinition,
  existingAbortController?: AbortController,
): { taskId: string; abortSignal: AbortSignal } {
  return notBuilt('src/tasks/LocalMainSessionTask.ts:51')
}
