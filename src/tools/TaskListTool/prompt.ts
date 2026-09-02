import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { TASK_GET_TOOL_NAME } from '../TaskGetTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../TaskUpdateTool/constants.js'

/** Model-facing task-list doctrine (team-aware variants). */

export const DESCRIPTION = 'Read the whole task list at a glance.'

export function getPrompt(): string {
  const teamSection = isAgentSwarmsEnabled()
    ? `

## Teammate workflow
- When you finish a task, call this tool to find your next piece of work.
- Look for tasks that are pending, unowned, and unblocked.
- Prefer them in ID order (lowest first).
- Claim a task by setting yourself as its owner with ${TASK_UPDATE_TOOL_NAME}, or wait to be assigned one.
- If everything left is blocked, focus on unblocking it, or tell the lead.`
    : ''

  return `List every task in the task list, with its status, owner and open blockers.

## When to use it
- To spot available work: pending, unowned, unblocked tasks.
- To take stock of overall progress.
- To find work that is blocked.

## Order of work
Take tasks in ID order, lowest leading — earlier tasks often set up the context that later ones depend on.

## What it returns
For each task: id, subject, status, owner (when set), and blockedBy (only the blockers that are still open).

${TASK_GET_TOOL_NAME} gives the full details of one task.${teamSection}`
}
