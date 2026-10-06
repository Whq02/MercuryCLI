import { TASK_GET_TOOL_NAME } from '../TaskGetTool/constants.js'


export const DESCRIPTION = 'Read the whole task list at a glance.'

export function getPrompt(): string {
  return `List every task in the task list, with its status, owner and open blockers.

## When to use it
- To spot available work: pending, unowned, unblocked tasks.
- To take stock of overall progress.
- To find work that is blocked.

## Order of work
Take tasks in ID order, lowest leading — earlier tasks often set up the context that later ones depend on.

## What it returns
For each task: id, subject, status, owner (when set), and blockedBy (only the blockers that are still open).

${TASK_GET_TOOL_NAME} gives the full details of one task.`
}
