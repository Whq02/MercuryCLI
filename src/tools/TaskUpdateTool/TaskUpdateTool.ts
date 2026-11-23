import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  blockTask,
  deleteTask,
  getTask,
  getTaskListId,
  isTaskToolsEnabled,
  listTasks,
  updateTask,
  type Task,
  type TaskStatus,
  TASK_STATUSES,
} from '../../utils/tasks.js'
import { DESCRIPTION, getPrompt, getVerificationNudgeNote, TASK_UPDATE_TOOL_NAME } from './prompt.js'

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
  statusChange: z
    .object({
      from: z.string(),
      to: z.string(),
    })
    .optional(),
  verificationNudgeNeeded: z.boolean().optional(),
})

type Output = z.infer<typeof outputSchema>

function failure(taskId: string, error: string, updatedFields: string[] = []): Output {
  return { success: false, taskId, updatedFields, error }
}

function needsVerificationNudge(tasks: Task[]): boolean {
  if (tasks.length < 3) return false
  if (tasks.some(task => task.status !== 'completed')) return false
  return !tasks.some(task => /verif/i.test(task.subject))
}

export const TaskUpdateTool = buildTool({
  name: TASK_UPDATE_TOOL_NAME,
  userFacingName: () => TASK_UPDATE_TOOL_NAME,
  searchHint: 'update a task',
  shouldDefer: true,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isEnabled: () => isTaskToolsEnabled(),
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  async call(input: Input, context: ToolUseContext): Promise<{ data: Output }> {
    const taskListId = getTaskListId()
    context.setAppState(prev =>
      prev.expandedView === 'tasks' ? prev : { ...prev, expandedView: 'tasks' as const },
    )
    const existing = await getTask(taskListId, input.taskId)
    if (!existing) {
      return { data: failure(input.taskId, `Task ${input.taskId} not found`) }
    }
    if (input.status === 'deleted') {
      const deleted = await deleteTask(taskListId, input.taskId)
      if (!deleted) {
        return { data: failure(input.taskId, `Failed to delete task ${input.taskId}`) }
      }
      return {
        data: {
          success: true,
          taskId: input.taskId,
          updatedFields: ['deleted'],
          statusChange: { from: existing.status, to: 'deleted' },
          verificationNudgeNeeded: false,
        },
      }
    }
    const updates: Partial<Omit<Task, 'id'>> = {}
    const updatedFields: string[] = []
    if (input.subject !== undefined && input.subject !== existing.subject) {
      updates.subject = input.subject
      updatedFields.push('subject')
    }
    if (input.description !== undefined && input.description !== existing.description) {
      updates.description = input.description
      updatedFields.push('description')
    }
    if (input.activeForm !== undefined && input.activeForm !== existing.activeForm) {
      updates.activeForm = input.activeForm
      updatedFields.push('activeForm')
    }
    if (input.owner !== undefined && input.owner !== existing.owner) {
      updates.owner = input.owner
      updatedFields.push('owner')
    }
    if (input.metadata !== undefined) {
      const merged: Record<string, unknown> = { ...(existing.metadata ?? {}) }
      for (const [key, value] of Object.entries(input.metadata)) {
        if (value === null) {
          delete merged[key]
        } else {
          merged[key] = value
        }
      }
      updates.metadata = merged
      updatedFields.push('metadata')
    }
    let statusChange: { from: TaskStatus; to: TaskStatus } | undefined
    if (input.status !== undefined && input.status !== existing.status) {
      updates.status = input.status
      updatedFields.push('status')
      statusChange = { from: existing.status, to: input.status }
    }
    if (updatedFields.length > 0) {
      const saved = await updateTask(taskListId, input.taskId, updates)
      if (saved === null) {
        return {
          data: failure(
            input.taskId,
            `Task ${input.taskId} disappeared before the update landed (deleted or list reset concurrently); nothing was applied`,
          ),
        }
      }
    }
    const failedEdges: string[] = []
    if (input.addBlocks && input.addBlocks.length > 0) {
      let addedAny = false
      for (const targetId of input.addBlocks) {
        if (existing.blocks.includes(targetId)) continue
        const ok = await blockTask(taskListId, input.taskId, targetId)
        if (ok) {
          addedAny = true
        } else {
          failedEdges.push(`${targetId} (blocks)`)
        }
      }
      if (addedAny) updatedFields.push('blocks')
    }
    if (input.addBlockedBy && input.addBlockedBy.length > 0) {
      let addedAny = false
      for (const blockerId of input.addBlockedBy) {
        if (existing.blockedBy.includes(blockerId)) continue
        const ok = await blockTask(taskListId, blockerId, input.taskId)
        if (ok) {
          addedAny = true
        } else {
          failedEdges.push(`${blockerId} (blockedBy)`)
        }
      }
      if (addedAny) updatedFields.push('blockedBy')
    }
    if (failedEdges.length > 0) {
      const landedNote =
        updatedFields.length > 0
          ? `Fields that did land: ${updatedFields.join(', ')}.`
          : 'No fields landed.'
      return {
        data: failure(
          input.taskId,
          `Dependency edges were not applied — missing task endpoints: ${failedEdges.join(', ')}. ${landedNote}`,
          updatedFields,
        ),
      }
    }
    let verificationNudgeNeeded = false
    if (!context.agentId && statusChange?.to === 'completed') {
      const allTasks = await listTasks(taskListId)
      if (needsVerificationNudge(allTasks)) {
        verificationNudgeNeeded = true
        logForDebugging('task update: verification nudge fired')
      }
    }
    return {
      data: {
        success: true,
        taskId: input.taskId,
        updatedFields,
        ...(statusChange !== undefined ? { statusChange } : {}),
        verificationNudgeNeeded,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    if (!output.success) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: output.error ?? `Task ${output.taskId} not found`,
      }
    }
    let content = `Updated task ${output.taskId} (${output.updatedFields.join(', ')})`
    if (output.verificationNudgeNeeded) {
      content += `\n${getVerificationNudgeNote()}`
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
  renderToolUseMessage: () => null,
  renderToolUseProgressMessage: () => null,
  renderToolUseQueuedMessage: () => null,
  renderToolUseRejectedMessage: () => null,
  renderToolUseErrorMessage: () => null,
  renderToolResultMessage: () => null,
})
