import { TASK_LIST_TOOL_NAME } from '../TaskListTool/constants.js'

/** Model-facing task-get doctrine. */

export const DESCRIPTION = 'Retrieve one task from the task list by its id.'

export const PROMPT = `Get the full details of one task by id.

## When to use it
- Right before picking a task up, to read its full description and context.
- To understand a task's dependencies (what it blocks and what blocks it).
- Right after being assigned a task.

## What it returns
- id: the task id.
- subject: the brief title.
- description: the full description.
- status: one of pending, in_progress, completed.
- blocks: tasks held up until this one lands.
- blockedBy: tasks that must land ahead of this one.

## Tips
- Confirm blockedBy stands empty before picking the task up.
- The wide-angle pass over every task belongs to ${TASK_LIST_TOOL_NAME}; this tool goes deep on one.`
