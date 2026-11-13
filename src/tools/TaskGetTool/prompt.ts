import { TASK_LIST_TOOL_NAME } from '../TaskListTool/constants.js'


export const DESCRIPTION = 'Retrieve one task from the task list by its id.'

export const PROMPT = `Returns one task's id, subject, description, status (pending, in_progress, completed), blocks and blockedBy. Read a task before starting it (confirming blockedBy is empty) or when assigned; use ${TASK_LIST_TOOL_NAME} for the full list overview.`
