import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { isTodoV2Enabled } from '../../utils/tasks.js'
import { TodoItemSchema } from '../../utils/todo/types.js'
import { getVerificationNudgeNote } from '../TaskUpdateTool/prompt.js'
import { DESCRIPTION, getPrompt, TODO_WRITE_TOOL_NAME } from './prompt.js'

/**
 * Replaces the session's in-memory todo checklist. Enabled exactly when the
 * durable task list is disabled — the two tracking mechanisms are never
 * both live.
 */

const inputSchema = z.strictObject({
  todos: z.array(TodoItemSchema()).describe('The complete replacement todo list'),
})

type Input = z.infer<typeof inputSchema>
type TodoItem = z.infer<ReturnType<typeof TodoItemSchema>>

const outputSchema = z.object({
  oldTodos: z.array(TodoItemSchema()).describe('The todo list before the update'),
  newTodos: z.array(TodoItemSchema()).describe('The todo list after the update'),
  verificationNudgeNeeded: z.boolean().optional().describe('Whether the verification nudge fired for this update'),
})

export type Output = z.infer<typeof outputSchema>

export const TodoWriteTool = buildTool({
  name: TODO_WRITE_TOOL_NAME,
  // Renders no header.
  userFacingName: () => '',
  searchHint: "manages the session's task checklist",
  shouldDefer: true,
  strict: true,
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  isEnabled: () => !isTodoV2Enabled(),
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async description(): Promise<string> {
    return DESCRIPTION
  },
  async prompt(): Promise<string> {
    return getPrompt()
  },
  // Todo operations never raise a permission prompt.
  async checkPermissions(input: Input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  toAutoClassifierInput(input: Input): string {
    return `${Array.isArray(input.todos) ? input.todos.length : 0} items`
  },
  async call(input: Input, context: ToolUseContext) {
    // Todos are per-agent: keyed by the caller's agent id, or the session
    // id on the main thread.
    const storageKey = context.agentId ?? getSessionId()
    const previous = context.getAppState().todos[storageKey] ?? []

    const allCompleted = input.todos.length > 0 && input.todos.every(item => item.status === 'completed')
    // A fully-completed checklist clears itself from the UI — but the
    // REPORTED new list stays the submitted one. The asymmetry is
    // deliberate: the transcript shows what the model wrote, the live
    // checklist shows nothing.
    const stored: TodoItem[] = allCompleted ? [] : input.todos

    const verificationNudgeNeeded =
      !context.agentId &&
      allCompleted &&
      input.todos.length >= 3 &&
      !input.todos.some(item => /verif/i.test(item.content))

    context.setAppState(prevState => ({
      ...prevState,
      todos: { ...prevState.todos, [storageKey]: stored },
    }))

    const output: Output = {
      oldTodos: previous,
      newTodos: input.todos,
      verificationNudgeNeeded,
    }
    return { data: output }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    let text =
      'Todos have been modified successfully. Continue using the todo list to track your progress, and proceed with the current tasks if applicable.'
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
