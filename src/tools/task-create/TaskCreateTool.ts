import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../kit/tool.js'
import { lazySchema } from '../../platform/primitives/lazySchema.js'
import { createTask, getTaskListId, isTaskToolsEnabled } from '../../engine/task-framework/tasks.js'
import { TASK_CREATE_TOOL_NAME } from '../kit/names/taskCreate.js'
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
const outputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),
      subject: z.string(),
    }),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>
type Output = z.infer<ReturnType<typeof outputSchema>>

const pendingTask = ({ subject, description, activeForm, metadata }: Input) => ({
  subject, description, activeForm, status: 'pending' as const,
  owner: undefined, blocks: [] as string[], blockedBy: [] as string[], metadata,
})

const expandTasks = (state: ReturnType<ToolUseContext['getAppState']>) =>
  state.expandedView === 'tasks' ? state : { ...state, expandedView: 'tasks' as const }

async function addTask(input: Input, context: ToolUseContext): Promise<{ data: Output }> {
  const list = getTaskListId()
  const id = await createTask(list, pendingTask(input))
  context.setAppState(expandTasks)
  return { data: { task: { id, subject: input.subject } } }
}

export const TaskCreateTool = buildTool({
  name: TASK_CREATE_TOOL_NAME,
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  searchHint: 'create a new task in the task list',
  isEnabled: () => isTaskToolsEnabled(),
  userFacingName: () => TASK_CREATE_TOOL_NAME,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  call: addTask,
  renderToolUseMessage: () => null,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: `Task #${output.task.id} created successfully: ${output.task.subject}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
