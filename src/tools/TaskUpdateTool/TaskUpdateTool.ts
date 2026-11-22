import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  blockTask,
  deleteTask,
  getTask,
  getTaskListId,
  isTaskToolsEnabled,
  listTasks,
  updateTask,
  type Task,
  type TaskStatus,
  TASK_STATUSES,
} from '../../utils/tasks.js'
import { DESCRIPTION, getPrompt, getVerificationNudgeNote, TASK_UPDATE_TOOL_NAME } from './prompt.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const outputSchema: Unbuilt = unbuilt('src/tools/TaskUpdateTool/TaskUpdateTool.ts:43')

type Output = z.infer<typeof outputSchema>

function failure(taskId: string, error: string, updatedFields: string[] = []): Output {
  return { success: false, taskId, updatedFields, error }
}

function needsVerificationNudge(tasks: Task[]): boolean {
  if (tasks.length < 3) return false
  if (tasks.some(task => task.status !== 'completed')) return false
  return !tasks.some(task => /verif/i.test(task.subject))
}

export const TaskUpdateTool: Unbuilt = unbuilt('src/tools/TaskUpdateTool/TaskUpdateTool.ts:174')
