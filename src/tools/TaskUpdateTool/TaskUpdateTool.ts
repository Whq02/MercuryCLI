import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { executeTaskCompletedHooks, getTaskCompletedHookMessage } from '../../utils/hooks.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  blockTask,
  deleteTask,
  getTask,
  getTaskListId,
  isTodoV2Enabled,
  listTasks,
  updateTask,
  type Task,
  type TaskStatus,
  TASK_STATUSES,
} from '../../utils/tasks.js'
import { getAgentName, getTeamName, getTeammateColor, isTeammate } from '../../utils/teammate.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { TASK_LIST_TOOL_NAME } from '../TaskListTool/constants.js'
import { DESCRIPTION, getPrompt, getVerificationNudgeNote, TASK_UPDATE_TOOL_NAME } from './prompt.js'

/**
 * Model-facing tool that mutates one task in the persistent task list.
 * Deliberately NOT concurrency-safe: it performs read-modify-write cycles,
 * and a create followed by an update in the same batch must land in call
 * order.
 */

const inputSchema = z.strictObject({
  taskId: z.string().describe('The id of the task to update'),
  subject: z.string().optional().describe('New subject (imperative form)'),
  description: z.string().optional().describe('New description'),
  activeForm: z
    .string()
    .optional()
    .describe('Present-continuous phrase shown in the spinner while the task is in progress'),
  owner: z.string().optional().describe('The agent that owns this task'),
  status: z
    .enum([...TASK_STATUSES, 'deleted'])
    .optional()
    .describe('New status; "deleted" permanently removes the task'),
  addBlocks: z.array(z.string()).optional().describe('Task ids this task blocks'),
  addBlockedBy: z.array(z.string()).optional().describe('Task ids that block this task'),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Keys merge into the task metadata; a key set to null deletes that key'),
})

type Input = z.infer<typeof inputSchema>

const outputSchema = z.object({
  success: z.boolean(),
  taskId: z.string(),
  updatedFields: z.array(z.string()),
  error: z.string().optional(),
  statusChange: z.object({ from: z.string(), to: z.string() }).optional(),
  verificationNudgeNeeded: z.boolean().optional(),
})

export type Output = z.infer<typeof outputSchema>

function failure(taskId: string, error: string, updatedFields: string[] = []): Output {
  return { success: false, taskId, updatedFields, error }
}

/** Fires at the loop-exit moment where verification would be skipped. */
function needsVerificationNudge(tasks: Task[]): boolean {
  if (tasks.length < 3) return false
  if (tasks.some(task => task.status !== 'completed')) return false
  return !tasks.some(task => /verif/i.test(task.subject))
}

async function runUpdate(input: Input, context: ToolUseContext): Promise<Output> {
  const taskListId = getTaskListId()

  // Expand the task list view — but only when not already expanded, so a
  // no-op does not churn state.
  context.setAppState(prevState =>
    prevState.expandedView === 'tasks' ? prevState : { ...prevState, expandedView: 'tasks' },
  )

  const task = await getTask(taskListId, input.taskId)
  if (!task) {
    return failure(input.taskId, `Task ${input.taskId} not found`)
  }

  const updates: Partial<Omit<Task, 'id'>> = {}
  const updatedFields: string[] = []
  const stage = (field: 'subject' | 'description' | 'activeForm' | 'owner', value: string | undefined): void => {
    if (value === undefined || value === task[field]) return
    updates[field] = value
    updatedFields.push(field)
  }
  stage('subject', input.subject)
  stage('description', input.description)
  stage('activeForm', input.activeForm)
  stage('owner', input.owner)

  // Owner auto-assignment: what lets the task list attribute activity to
  // teammates without every teammate naming itself.
  if (
    isAgentSwarmsEnabled() &&
    input.status === 'in_progress' &&
    input.owner === undefined &&
    !task.owner
  ) {
    const agentName = getAgentName()
    if (agentName) {
      updates.owner = agentName
      updatedFields.push('owner')
    }
  }

  if (input.metadata !== undefined) {
    // Merging is unconditionally a change, even when the merged map is
    // identical to the stored one.
    const merged: Record<string, unknown> = { ...(task.metadata ?? {}) }
    for (const [key, value] of Object.entries(input.metadata)) {
      if (value === null) delete merged[key]
      else merged[key] = value
    }
    updates.metadata = merged
    updatedFields.push('metadata')
  }

  let statusChange: Output['statusChange']
  if (input.status !== undefined) {
    if (input.status === 'deleted') {
      // Every staged field is discarded: a call that renames and deletes in
      // one shot only deletes.
      const deleted = await deleteTask(taskListId, input.taskId)
      if (!deleted) {
        return failure(input.taskId, `Failed to delete task ${input.taskId}`)
      }
      return {
        success: true,
        taskId: input.taskId,
        updatedFields: ['deleted'],
        statusChange: { from: task.status, to: 'deleted' },
        verificationNudgeNeeded: false,
      }
    }
    if (input.status !== task.status && input.status === 'completed') {
      const blockingMessages: string[] = []
      for await (const result of executeTaskCompletedHooks(
        input.taskId,
        task.subject,
        task.description,
        getAgentName(),
        getTeamName(),
        undefined,
        context.abortController.signal,
        undefined,
        context,
      )) {
        if (result.blockingError) blockingMessages.push(getTaskCompletedHookMessage(result.blockingError))
      }
      if (blockingMessages.length > 0) {
        // Nothing is written when a hook blocks the completion.
        return failure(input.taskId, blockingMessages.join('\n'))
      }
    }
    if (input.status !== task.status) {
      updates.status = input.status as TaskStatus
      updatedFields.push('status')
      statusChange = { from: task.status, to: input.status }
    }
  }

  if (Object.keys(updates).length > 0) {
    const written = await updateTask(taskListId, input.taskId, updates)
    if (written === null) {
      // The store settled differently between the read and this write:
      // reporting success here would be a false claim, and mailing an
      // assignment for an update that never landed doubly so.
      return failure(
        input.taskId,
        `Task ${input.taskId} disappeared before the update landed (deleted or list reset concurrently); nothing was applied`,
      )
    }
  }

  // Ownership notification: truthiness is the test — staging an explicit
  // empty-string owner records the change but mails nobody.
  if (updates.owner && isAgentSwarmsEnabled()) {
    // Truthiness on purpose: an empty-string agent name falls back to the lead.
    const sender = getAgentName() || TEAM_LEAD_NAME
    await writeToMailbox(
      updates.owner,
      {
        from: sender,
        // Minted separately from the body's timestamp at the same moment —
        // the two reads may differ by a millisecond.
        timestamp: new Date().toISOString(),
        text: JSON.stringify({
          type: 'task_assignment',
          taskId: input.taskId,
          // The PRE-update values read at step 3, even when this same call
          // renames the task.
          subject: task.subject,
          description: task.description,
          assignedBy: sender,
          timestamp: new Date().toISOString(),
        }),
        color: getTeammateColor(),
      },
      taskListId,
    )
  }

  // Dependency edges. A silently dropped edge would report success for a
  // dependency that does not exist, so failures are collected and named.
  const failedEdges: string[] = []
  if (input.addBlocks !== undefined) {
    const fresh = input.addBlocks.filter(id => !task.blocks.includes(id))
    let landed = 0
    for (const targetId of fresh) {
      if (await blockTask(taskListId, input.taskId, targetId)) landed += 1
      else failedEdges.push(`${targetId} (blocks)`)
    }
    if (landed > 0) updatedFields.push('blocks')
  }
  if (input.addBlockedBy !== undefined) {
    const fresh = input.addBlockedBy.filter(id => !task.blockedBy.includes(id))
    let landed = 0
    for (const blockerId of fresh) {
      // The named blocker blocks this task, so the edge runs the other way.
      if (await blockTask(taskListId, blockerId, input.taskId)) landed += 1
      else failedEdges.push(`${blockerId} (blockedBy)`)
    }
    if (landed > 0) updatedFields.push('blockedBy')
  }
  if (failedEdges.length > 0) {
    const landedNote = updatedFields.length > 0 ? `Fields that did land: ${updatedFields.join(', ')}.` : 'No fields landed.'
    return {
      success: false,
      taskId: input.taskId,
      updatedFields,
      error: `Dependency edges were not applied — missing task endpoints: ${failedEdges.join(', ')}. ${landedNote}`,
    }
  }

  let verificationNudgeNeeded = false
  if (!context.agentId && updates.status === 'completed') {
    verificationNudgeNeeded = needsVerificationNudge(await listTasks(taskListId))
    if (verificationNudgeNeeded) logForDebugging('task update: verification nudge fired')
  }

  return {
    success: true,
    taskId: input.taskId,
    updatedFields,
    ...(statusChange ? { statusChange } : {}),
    verificationNudgeNeeded,
  }
}

export const TaskUpdateTool = buildTool({
  name: TASK_UPDATE_TOOL_NAME,
  searchHint: 'update a task',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  isEnabled: () => isTodoV2Enabled(),
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  userFacingName: () => TASK_UPDATE_TOOL_NAME,
  async description(): Promise<string> {
    return DESCRIPTION
  },
  async prompt(): Promise<string> {
    return getPrompt()
  },
  toAutoClassifierInput(input: Input): string {
    return [input.taskId, input.status, input.subject].filter((part): part is string => part !== undefined).join(' ')
  },
  async call(input: Input, context: ToolUseContext) {
    return { data: await runUpdate(input, context) }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    if (!output.success) {
      // A missing task is a benign condition the model can handle; marking
      // it an error would paint a failure in the transcript. Note a
      // successful DELETE renders through the success branch (the key is
      // the success flag).
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: output.error ?? `Task ${output.taskId} not found`,
      }
    }
    let text = `Updated task ${output.taskId} (${output.updatedFields.join(', ')})`
    if (output.statusChange?.to === 'completed' && isTeammate() && isAgentSwarmsEnabled()) {
      text += `\nCall ${TASK_LIST_TOOL_NAME} now to find your next available task or see whether your work unblocked others.`
    }
    if (output.verificationNudgeNeeded) {
      text += `\n${getVerificationNudgeNote()}`
    }
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: text }
  },
  renderToolUseMessage: () => null,
  renderToolUseProgressMessage: () => null,
  renderToolUseQueuedMessage: () => null,
  renderToolUseRejectedMessage: () => null,
  renderToolResultMessage: () => null,
  renderToolUseErrorMessage: () => null,
})
