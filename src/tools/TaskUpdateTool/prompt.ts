import { VERIFICATION_AGENT_TYPE } from '../AgentTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from './constants.js'

export { TASK_UPDATE_TOOL_NAME }

export const DESCRIPTION = 'Change one task — edit its fields, resolve it, or delete it.'

/**
 * The verification-nudge note shared verbatim between TaskUpdate and
 * TodoWrite: three or more items just closed with no verification step, so
 * the verifier must run before the final summary — and only the verifier
 * issues a verdict.
 */
export function getVerificationNudgeNote(): string {
  return [
    'Three or more tasks just went to completed without a verification step among them.',
    `Spawn the ${VERIFICATION_AGENT_TYPE} agent to check the work before you write the final summary.`,
    'Caveats listed in your summary are not a verdict — verdicts come from the verifier alone.',
  ].join(' ')
}

export function getPrompt(): string {
  return `Change one task on the shared list.

When to use it:
- Mark your work resolved the moment it is finished, and always mark tasks assigned to you resolved.
- Mark a task resolved when it has been superseded and no longer needs doing.
- After resolving, consult ${TASK_LIST_TOOL_NAME} for your next task.

The completion bar:
- Mark a task completed only when it is FULLY accomplished.
- Blocked or erroring? The task stays in_progress; open a new task naming the blocker.
- Never mark completed when tests fail, the implementation is partial, errors are unresolved, or required files or dependencies were not found.

Deleting:
- Setting status to "deleted" permanently removes the task. Use it for work that should never happen (duplicates, cancelled scope) — not for finished work.

Updating details:
- Update the subject or description when requirements changed; use addBlocks/addBlockedBy when dependencies between tasks become clear.

Fields you can update:
- subject: what needs doing, phrased as an imperative.
- description: the full context for the task.
- activeForm: the present-continuous phrase shown in the spinner while the task is in progress.
- owner: the agent responsible for the task (set it to claim work).
- status: pending → in_progress → completed; "deleted" removes the task.
- addBlocks: ids this task is holding up.
- addBlockedBy: ids holding this one up.
- metadata: keys merge in; null a key to delete it.

Staleness: another agent may have updated the task since you last saw it — read its latest state with ${TASK_GET_TOOL_NAME} before updating.

Examples:
- Mark in progress: {"taskId": "3", "status": "in_progress"}
- Mark completed: {"taskId": "3", "status": "completed"}
- Delete: {"taskId": "7", "status": "deleted"}
- Claim by setting an owner: {"taskId": "4", "owner": "scout"}
- Declare a dependency: {"taskId": "5", "addBlockedBy": ["2"]}`
}
