import { TASK_GET_TOOL_NAME } from '../TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from './constants.js'

export { TASK_UPDATE_TOOL_NAME }

export const DESCRIPTION = 'Change one task — edit its fields, resolve it, or delete it.'

export function getVerificationNudgeNote(): string {
  return [
    'Three or more tasks just went to completed without a verification step among them.',
    'Run /verify to check the work before you write the final summary.',
    'Caveats listed in your summary are not a verdict — verdicts come from the verifier alone.',
  ].join(' ')
}

export function getPrompt(): string {
  return `Updates or deletes a task on the shared list. Set owner to claim a task. Read latest state with ${TASK_GET_TOOL_NAME} first if another agent may have changed it, and check ${TASK_LIST_TOOL_NAME} for the next task after finishing one.

- Completion: mark completed only when fully accomplished (or superseded). Keep status in_progress and open a blocker task if tests fail, implementation is partial, errors remain, or required files/dependencies are missing.
- Deletion: status "deleted" permanently removes duplicates or cancelled work — never finished work.`
}
