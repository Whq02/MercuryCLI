export const TASK_STOP_TOOL_NAME = 'TaskStop'

export const DESCRIPTION = `
- Halts a running background task, addressed by its ID
- The task_id parameter names which task to halt
- Reports whether the stop landed
- A task that has already finished is not an error: the answer says how and when it ended and where its output file is, and nothing is stopped
- The tool for ending a long-running task you no longer need
`
