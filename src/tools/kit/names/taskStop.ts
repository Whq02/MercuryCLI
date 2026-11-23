export const TASK_STOP_TOOL_NAME = 'TaskStop'

export const DESCRIPTION = `Stops a running background task by id and reports whether the stop landed. A task that has already finished is not an error: the answer says how and when it ended and where its output file is, and nothing is stopped.`
