import { TASK_GET_TOOL_NAME } from '../TaskGetTool/constants.js'


export const DESCRIPTION = 'Read the whole task list at a glance.'

export function getPrompt(): string {
  return `Lists all tasks with id, subject, status, owner and open blockedBy ids. Prefer unowned, unblocked pending tasks in lowest-id order first; use ${TASK_GET_TOOL_NAME} for one task's full description.`
}
