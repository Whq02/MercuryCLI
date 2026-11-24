import { Client } from '../../mcp-shapes/sdk.js'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { minutesKnobToMs, withDeadline } from '../../../platform/async/deadline.js'
import { formatFileSize } from '../../../platform/text/format.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_TOOL_TIMEOUT_MS = 100_000_000
export const LONG_CALL_LOG_INTERVAL_MS = 30_000
export const MCP_TOOL_USE_ID_META_KEY = 'mercury/toolUseId'
export const STDERR_FLUSH_BYTES = 1024 * 1024
export const INSTRUCTIONS_MAX_CHARS = 2048
export const TERMINAL_ERROR_LIMIT = 3
export const URL_ELICITATION_RETRIES = 3
export const TERMINAL_ERROR_SUBSTRINGS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ECONNREFUSED',
  'Body Timeout Error',
  'terminated',
  'SSE stream disconnected',
  'Failed to reconnect SSE stream',
]

export function connectTimeoutMs(): number {
  const raw = flagEnv('MERCURY_MCP_TIMEOUT_MS')
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONNECT_TIMEOUT_MS
}

export function toolTimeoutMs(): number {
  const raw = flagEnv('MERCURY_MCP_TOOL_TIMEOUT_MS')
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_TIMEOUT_MS
}

const MCP_LAUNCH_SPAWN_GRACE_MS = 1_000

export function mcpLaunchBudgetMs(): number {
  return connectTimeoutMs() + MCP_LAUNCH_SPAWN_GRACE_MS
}

export async function withMcpLaunchBudget(
  work: Promise<unknown>,
  budgetMs: number,
): Promise<'settled' | 'timeout'> {
  return withDeadline(
    work.then(
      () => 'settled' as const,
      passedOverAs('settled' as const),
    ),
    budgetMs,
    () => 'timeout' as const,
  )
}

export const DEFAULT_MCP_CALL_IDLE_MINUTES = 10
export function mcpCallIdleLimitMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_MCP_CALL_IDLE_MINUTES'), DEFAULT_MCP_CALL_IDLE_MINUTES)
}

export const DEFAULT_MCP_STDIO_MESSAGE_MB = 64
export function mcpStdioMaxMessageBytes(): number {
  const raw = flagEnv('MERCURY_MCP_STDIO_MESSAGE_MB')
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN
  return Math.floor((Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_STDIO_MESSAGE_MB) * 1024 * 1024)
}

export const OVERSIZED_MESSAGE = /ReadBuffer exceeded maximum size of (\d+) bytes/
export const oversizedMessages = new WeakMap<Client, number>()

export function mcpOversizedMessageWords(tool: string, serverName: string, limitBytes: number): string {
  return `MCP tool "${tool}" on server "${serverName}": the server sent one message over ${formatFileSize(limitBytes)}, the stdio message limit, and the connection was dropped before this call's answer could be read; inspect the effect before retrying — MERCURY_MCP_STDIO_MESSAGE_MB raises the limit.`
}

export function getMcpServerConnectionBatchSize(): number {
  const raw = flagEnv('MERCURY_MCP_CONNECTION_BATCH')
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3
}

export function getRemoteConnectionBatchSize(): number {
  const raw = flagEnv('MERCURY_MCP_REMOTE_CONNECTION_BATCH')
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20
}
