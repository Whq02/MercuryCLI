import { z } from 'zod/v4'

import { lazySchema } from '../lazySchema.js'

/**
 * The todo item/list schema. The field names and status values are
 * contract data — they ride the todo-write tool's wire input.
 */

export const TodoItemSchema = lazySchema(() =>
  z.object({
    content: z.string().min(1, 'Content cannot be empty'),
    status: z.enum(['pending', 'in_progress', 'completed']),
    activeForm: z.string().min(1, 'Active form cannot be empty'),
  }),
)

export type TodoItem = z.infer<ReturnType<typeof TodoItemSchema>>

export const TodoListSchema = lazySchema(() => z.array(TodoItemSchema()))

export type TodoList = z.infer<ReturnType<typeof TodoListSchema>>
