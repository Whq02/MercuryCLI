// SDK Runtime Types — non-serializable types (callbacks, interfaces with
// methods, the query/session handles) that back the Agent SDK function surface
// in agentSdkTypes.ts. Unlike coreTypes, these are NOT generated from Zod
// schemas (they aren't serializable), so they are typed here.
// Reconstructed from the consuming signatures in agentSdkTypes.ts.
//
// In this build the Agent SDK function surface is TYPE-ONLY (
// the throwing runtime shell is deleted;
// scripts/ink-runtime/prove-sdk-surface.ts pins zero throwing runtime exports),
// and none of these types is imported outside agentSdkTypes.ts — so the
// shapes only need to type-check that type surface. Types are erased at
// build time.
//
// `EffortLevel` is the one type consumed elsewhere (utils/effort.ts), where it
// is constrained by `['low','medium','high','xhigh','max'] satisfies readonly
// EffortLevel[]`. `xhigh` (Opus 4.7+ / Fable) sits between high and max — see
// the Claude API effort docs.
import type { z } from 'zod/v4'
import type {
  CallToolResult,
  ToolAnnotations,
} from '../../services/mcp/sdk.js'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// ── SDK `tool()` builder ─────────────────────────────────────────────────────
/** Zod raw shape accepted by the SDK `tool()` builder. */
export type AnyZodRawShape = z.ZodRawShape
/** Argument object inferred from a tool's Zod raw shape. */
export type InferShape<Schema extends AnyZodRawShape> = {
  [K in keyof Schema]: z.infer<Schema[K]>
}
/** A custom in-process MCP tool definition produced by `tool()`. */
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
/** In-process MCP server config carrying a live server instance. */
export type McpSdkServerConfigWithInstance = {
  type: 'sdk'
  name: string
  instance: unknown
}

// ── `query()` options + handles ──────────────────────────────────────────────
/** Options bag accepted by `query()`. (The SDK query path throws in this build.) */
export type Options = Record<string, unknown>
/** Internal superset of `Options` used by first-party query callers. */
export type InternalOptions = Options & { isInternal?: boolean }
/** Async stream of SDK messages returned by `query()`. */
export type Query = AsyncGenerator<unknown, void> & {
  interrupt?: () => Promise<void>
  setPermissionMode?: (mode: string) => Promise<void>
}
/** Internal superset of `Query` with first-party control hooks. */
export type InternalQuery = Query & { internalHandle?: unknown }

// ── V2 persistent-session API (UNSTABLE) ─────────────────────────────────────
/** Options for `unstable_v2_createSession` / `unstable_v2_resumeSession`. */
export type SDKSessionOptions = Record<string, unknown>
/** Persistent multi-turn session handle (V2 API; stub in this build). */
export type SDKSession = {
  readonly sessionId: string
  prompt(message: string): Promise<unknown>
  end(): Promise<void>
}

// ── session read / mutation helpers ──────────────────────────────────────────
/** A single message read from a session transcript. */
export type SessionMessage = Record<string, unknown>
/** Options for `listSessions`. */
export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
}
/** Options for `getSessionInfo`. */
export type GetSessionInfoOptions = { dir?: string }
/** Options for `getSessionMessages`. */
export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}
/** Options for `renameSession` / `tagSession`. */
export type SessionMutationOptions = { dir?: string }
/** Options for `forkSession`. */
export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}
/** Result of `forkSession`. */
export type ForkSessionResult = { sessionId: string }
