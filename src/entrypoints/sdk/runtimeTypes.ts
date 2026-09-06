import type { z } from 'zod/v4'
import type {
  CallToolResult,
  ToolAnnotations,
} from '../../services/mcp/sdk.js'

const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LADDER)[number]
export const EFFORT_LEVELS: readonly EffortLevel[] = EFFORT_LADDER

export type AnyZodRawShape = z.ZodRawShape
export type InferShape<Schema extends AnyZodRawShape> = {
  [K in keyof Schema]: z.infer<Schema[K]>
}
export type SdkMcpToolDefinition<
  Schema extends AnyZodRawShape = AnyZodRawShape,
> = {
  name: string
  description: string
  inputSchema: Schema
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>
  annotations?: ToolAnnotations
  searchHint?: string
  alwaysLoad?: boolean
}
export type McpSdkServerConfigWithInstance = {
  type: 'sdk'
  name: string
  instance: unknown
}

export type Options = Record<string, unknown>
export type InternalOptions = Options & { isInternal?: boolean }
export type Query = AsyncGenerator<unknown, void> & {
  interrupt?: () => Promise<void>
  setPermissionMode?: (mode: string) => Promise<void>
}
export type InternalQuery = Query & { internalHandle?: unknown }

export type SDKSessionOptions = Record<string, unknown>
export type SDKSession = {
  readonly sessionId: string
  prompt(message: string): Promise<unknown>
  end(): Promise<void>
}

export type SessionMessage = Record<string, unknown>
export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
}
export type GetSessionInfoOptions = { dir?: string }
export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}
export type SessionMutationOptions = { dir?: string }
export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}
export type ForkSessionResult = { sessionId: string }
