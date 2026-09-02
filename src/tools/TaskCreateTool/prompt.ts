import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { TASK_LIST_TOOL_NAME } from '../TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../TaskUpdateTool/constants.js'

/** Model-facing task-creation doctrine (team-aware variants). */

export const DESCRIPTION = 'Add a task to the shared list.'

export function getPrompt(): string {
  const teamSection = isAgentSwarmsEnabled()
    ? `

## Working in a team
- Tasks can be assigned to teammates. Write the description with enough detail that another agent can pick the task up without your context.
- Assign a task by setting its owner through ${TASK_UPDATE_TOOL_NAME}'s owner parameter.`
    : ''

  return `Create a task in the shared task list.

## Why
The task list is how you track progress on complex work, organise it into steps, give the user visible evidence of what you are doing, and let the user follow along.

## When to use it
- Work that takes 3 or more steps.
- Non-trivial tasks that need planning.
- Strategy mode: capture the plan as tasks.
- When the user has asked for a task list outright.
- When the user hands you several things to do at once.
- Immediately after receiving new instructions, so the work is captured before you start.
- Mark a task in progress before starting it, and completed right after finishing it — capturing any follow-ups as new tasks.

## When NOT to use it
- A single, straightforward task.
- Trivial tracking that adds no value.
- Fewer than 3 trivial steps.
- Purely conversational or informational work.

## Fields
- subject: a brief title in the imperative form ("Fix the login redirect", "Add retry to the uploader").
- description: what needs doing, with the context required to do it.
- activeForm: an optional present-continuous phrase ("Fixing the login redirect") shown in the spinner while the task is in progress; the subject is used when omitted.

Every task is created with status pending.

## Tips
- Keep subjects clear and specific.
- Set dependencies afterwards with ${TASK_UPDATE_TOOL_NAME} (addBlocks / addBlockedBy).
- Check ${TASK_LIST_TOOL_NAME} first so you do not create duplicates.${teamSection}`
}
