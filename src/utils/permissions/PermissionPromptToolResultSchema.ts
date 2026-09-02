import type { ToolPermissionContext } from '../../Tool.js'
import { z } from 'zod/v4'
import { logForDebugging } from '../debug.js'
import type {
  PermissionDecision,
  PermissionUpdate,
  } from '../../types/permissions.js'
import { applyPermissionUpdates, persistPermissionUpdates } from './PermissionUpdate.js'
import { permissionUpdateSchema } from './PermissionUpdateSchema.js'

export function inputSchema() {
  return z.object({
    tool_name: z.string(),
    input: z.record(z.string(), z.unknown()),
    tool_use_id: z.string().optional(),
  })
}

const decisionClassificationSchema = z
  .enum(['user_temporary', 'user_permanent', 'user_reject'])
  .catch(undefined as never)
  .optional()

export function outputSchema() {
  const allow = z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.string(), z.unknown()),
    updatedPermissions: z.array(z.unknown()).optional(),
    toolUseID: z.string().optional(),
    decisionClassification: decisionClassificationSchema,
  })
  const deny = z.object({
    behavior: z.literal('deny'),
    message: z.string(),
    interrupt: z.boolean().optional(),
    toolUseID: z.string().optional(),
    decisionClassification: decisionClassificationSchema,
  })
  return z.union([allow, deny])
}

export type Input = z.infer<ReturnType<typeof inputSchema>>
export type Output = z.infer<ReturnType<typeof outputSchema>>

type ToolUseContext = {
  abortController?: AbortController
  setToolPermissionContext?: (updater: (c: ToolPermissionContext) => ToolPermissionContext) => void
}

function parseUpdatedPermissions(raw: unknown): PermissionUpdate[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const schema = permissionUpdateSchema()
  const parsed: PermissionUpdate[] = []
  for (const entry of raw) {
    const result = schema.safeParse(entry)
    if (!result.success) {
      logForDebugging(
        `permission-prompt tool: dropping malformed updatedPermissions (first issue: ${result.error.issues[0]?.message ?? 'unknown'})`,
      )
      return undefined
    }
    parsed.push(result.data as PermissionUpdate)
  }
  return parsed
}

export function permissionPromptToolResultToPermissionDecision(
  result: Output,
  tool: { name: string },
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
): PermissionDecision {
  const decisionReason = {
    type: 'permissionPromptTool' as const,
    toolName: tool.name,
    result,
  }

  if (result.behavior === 'allow') {
    const updates = parseUpdatedPermissions(result.updatedPermissions)
    if (updates && toolUseContext.setToolPermissionContext) {
      toolUseContext.setToolPermissionContext(context => applyPermissionUpdates(context, updates))
      persistPermissionUpdates(updates)
    }
    const updatedInput =
      result.updatedInput && Object.keys(result.updatedInput).length > 0 ? result.updatedInput : input
    return {
      ...result,
      behavior: 'allow',
      updatedInput,
      decisionReason,
    } as unknown as PermissionDecision
  }

  if (result.interrupt) {
    logForDebugging(`permission-prompt tool denied ${tool.name}: ${result.message}`)
    toolUseContext.abortController?.abort()
  }
  return {
    ...result,
    behavior: 'deny',
    decisionReason,
  } as unknown as PermissionDecision
}
