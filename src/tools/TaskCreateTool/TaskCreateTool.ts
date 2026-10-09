import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createTask, getTaskListId, isTaskToolsEnabled } from '../../utils/tasks.js'
import { TASK_CREATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'


const inputSchema = lazySchema(() =>
  z.strictObject({
    subject: z.string().describe('A brief title for the task, in the imperative form'),
    description: z.string().describe('What needs to be done'),
    activeForm: z
      .string()
      .optional()
      .describe('Present-continuous phrase shown in the spinner while the task is in progress'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Free-form metadata for the task'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),
      subject: z.string(),
    }),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const TaskCreateTool = buildTool({
  name: TASK_CREATE_TOOL_NAME,
  searchHint: 'create a new task in the task list',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled: () => isTaskToolsEnabled(),
  userFacingName: () => 'TaskCreate',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  async call(input: Input, context: ToolUseContext) {
    const taskListId = getTaskListId()
    const taskId = await createTask(taskListId, {
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata: input.metadata,
    })

    context.setAppState(prevState =>
      prevState.expandedView === 'tasks' ? prevState : { ...prevState, expandedView: 'tasks' },
    )

    return { data: { task: { id: taskId, subject: input.subject } } satisfies Output }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `Task #${output.task.id} created successfully: ${output.task.subject}`,
    }
  },
  renderToolUseMessage: () => null,
} satisfies ToolDef<InputSchema, Output>)
