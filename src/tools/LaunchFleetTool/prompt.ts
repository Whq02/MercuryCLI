import { LAUNCH_FLEET_TOOL_NAME } from './constants.js'

export const DESCRIPTION =
  'Fan out a mission: atomically create a set of dependency-ordered subtasks under one shared missionId'

export function getPrompt(): string {
  return `${LAUNCH_FLEET_TOOL_NAME} creates a whole fan-out of subtasks in one grouped mission, so a lead doesn't have to call TaskCreate + TaskUpdate (for dependencies and owners) one subtask at a time.

Give it a list of subtasks. For each subtask:
- content (required) — what needs to be done (becomes the task subject + description).
- activeForm (optional) — present-continuous spinner label (e.g. "Running tests").
- owner (optional) — the teammate/agent to assign the subtask to.
- dependsOn (optional) — a list of INDICES into this same subtasks array; this subtask is blocked until those earlier subtasks complete. Indices must be earlier in the list (a subtask can only depend on ones listed before it), so the fan-out is a valid DAG.

All subtasks are created together and stamped with one shared missionId (in each task's metadata.missionId) so the whole fan-out is a single grouped mission. Dependencies are wired with the same blocker model TaskUpdate uses (a depended-on task BLOCKS the dependent one), and owners are assigned as given.

Size the fan to the work's real independence and difficulty, not a preset count: let independent subtasks converge before you widen the mission, and add subtasks only where the evidence is thin or conflicting. (Widening doesn't change when the mission ends — the fan-out finishes when its dependsOn DAG completes, not on any convergence signal.)

Returns the missionId and the created task ids (in input order). Use ${LAUNCH_FLEET_TOOL_NAME} when you, as a lead, are kicking off a multi-step plan across teammates. For a single task, use TaskCreate.`
}
