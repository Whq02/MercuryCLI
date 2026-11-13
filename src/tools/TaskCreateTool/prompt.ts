import { TASK_LIST_TOOL_NAME } from '../TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../TaskUpdateTool/constants.js'


export const DESCRIPTION = 'Add a task to the shared list.'

export function getPrompt(): string {
  return `Creates a pending task in the shared task list. Use for multi-step (3+ step) or non-trivial work, multi-item user requests, or explicit task-list requests — not single straightforward tasks or pure Q&A.

Capture tasks before starting; mark in_progress when starting and completed when done (opening new tasks for follow-ups). Check ${TASK_LIST_TOOL_NAME} first to avoid duplicates, and set dependencies via ${TASK_UPDATE_TOOL_NAME} (addBlocks / addBlockedBy).`
}
