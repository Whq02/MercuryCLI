import { Client } from './sdk.js'
import { UnauthorizedError } from './sdk.js'
import { SSEClientTransport } from './sdk.js'
import { StdioClientTransport } from './sdk.js'
import { StreamableHTTPClientTransport } from './sdk.js'
import type { Transport } from './sdk.js'
import type { JSONRPCMessage } from './sdk.js'
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ErrorCode,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListRootsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ProgressNotificationSchema,
  type Tool as McpSdkTool,
} from './sdk.js'
import memoize from 'lodash-es/memoize.js'
import { LRUCache } from 'lru-cache'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { deepestErrorDetail, isStaleSocketCode } from '../api/transportEvidence.js'
// The ONE deadline label (30000 → "30s", 1500 → "1.5s") — shared with the
// provider deadline door so the two families cannot drift apart.
import { deadlineSecondsLabel } from '../providers/fetchDeadline.js'
import { getOauthConfig } from '../../constants/oauth.js'
import type { Command } from '../../types/command.js'
import type { AssistantMessage } from '../../types/message.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { MCPTool } from '../../tools/MCPTool/MCPTool.js'
import { classifyMcpToolForCollapse } from '../../tools/MCPTool/classifyForCollapse.js'
import { ListMcpResourcesTool } from '../../tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { createMcpAuthTool } from '../../tools/McpAuthTool/McpAuthTool.js'
import { ReadMcpResourceTool } from '../../tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { checkAndRefreshOAuthTokenIfNeeded, getClaudeAIOAuthTokens, handleOAuth401Error } from '../../utils/auth.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { armInactivityDeadline, formatLimit, minutesKnobToMs } from '../../utils/deadline.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome, isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage, getErrnoCode, isAbortError, TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { getMCPUserAgent } from '../../utils/http.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { logError, logMCPDebug, logMCPError } from '../../utils/log.js'
import { getBinaryBlobSavedMessage, getFormatDescription, getLargeOutputInstructions, persistBinaryContent } from '../../utils/mcpOutputStorage.js'
import { mcpContentNeedsTruncation, truncateMcpContent } from '../../utils/mcpValidation.js'
import type { MCPToolResult } from '../../utils/mcpValidation.js'
import { getWebSocketTLSOptions } from '../../utils/mtls.js'
import { getApiFetch, getProxyFetchOptions, getProxyUrl, getWebSocketProxyAgent, getWebSocketProxyUrl } from '../../utils/proxy.js'
import { recursivelySanitizeUnicode } from '../../utils/sanitization.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { persistToolResult } from '../../utils/toolResultStorage.js'
import { hasMcpDiscoveryButNoToken, MercuryMcpAuthProvider, wrapFetchWithStepUpDetection } from './auth.js'
import { markClaudeAiMcpConnected } from './claudeai.js'
import { getAllMcpConfigs } from './config.js'
import { isMcpCatalogueMember } from './membership.js'
import { runElicitationHooks, runElicitationResultHooks } from './elicitationHandler.js'
import { getMcpServerHeaders } from './headersHelper.js'
import { buildMcpToolName, wireSafeMcpToolName } from './mcpStringUtils.js'
import { normalizeNameForMCP } from './normalization.js'
import { SdkControlClientTransport, type SendMcpMessageCallback } from './SdkControlTransport.js'
import { isCoordinationServerEnabled, isCoordinationServer } from './coordinationServer.js'
import { withMcpToolCardHeader } from './toolCard.js'
import { mcpPolicyDenyReason, mcpToolAllowed, type McpToolAnnotations } from './toolPolicy.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  McpServerConfig,
  ScopedMcpServerConfig,
  ServerResource,
} from './types.js'
import { getLoggingSafeMcpBaseUrl } from './utils.js'

/**
 * The MCP client core: transport selection per server type, connect with
 * timeout, drop detection/reconnect, tool/prompt/resource discovery, tool
 * invocation, result transformation, SDK-server setup.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class McpAuthError extends Error {
  constructor(
    public readonly serverName: string,
    message: string,
  ) {
    super(message)
    this.name = 'McpAuthError'
  }
}

export class McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  constructor(
    message: string,
    telemetryMessage: string,
    public readonly mcpMeta?: Record<string, unknown>,
  ) {
    super(message, telemetryMessage)
    this.name = 'McpToolCallError'
  }
}

class McpSessionExpiredError extends Error {
  constructor(serverName: string) {
    super(`MCP session for ${serverName} expired`)
    this.name = 'McpSessionExpiredError'
  }
}

/** A 404 whose message carries JSON-RPC -32001 (either JSON spacing); or -32000 "Connection closed" on http/proxy. */
export function isMcpSessionExpiredError(error: unknown): boolean {
  const status = (error as { status?: unknown; code?: unknown } | null)?.status
  const message = errorMessage(error)
  if (status === 404 && (message.includes('"code":-32001') || message.includes('"code": -32001'))) return true
  return false
}

function isConnectionClosedError(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.ConnectionClosed
}

/** A request that rode a keep-alive connection the server had already closed
 *  (B3.5): the deepest cause carries a stale-socket code, or — for a
 *  TypeError, the shape fetch failures take when the runtime attaches no
 *  code — the message names the socket event. Never matched against tool or
 *  protocol errors: a tool result that merely MENTIONS "terminated" must not
 *  ride the reconnect route and re-execute. The caller scopes this to the
 *  HTTP-shaped transports; the reconnect-once path is the same as an expired
 *  session's because the POST died at the socket, before the server parsed
 *  the call. */
const STALE_SOCKET_MESSAGE_SUBSTRINGS = ['other side closed', 'socket hang up', 'ECONNRESET', 'terminated']
function isStaleSocketFetchError(error: unknown): boolean {
  if (isStaleSocketCode(deepestErrorDetail(error).code)) return true
  if (!(error instanceof TypeError)) return false
  const message = `${errorMessage(error)} ${errorMessage((error as { cause?: unknown }).cause)}`
  return STALE_SOCKET_MESSAGE_SUBSTRINGS.some(substring => message.includes(substring))
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_TOOL_TIMEOUT_MS = 100_000_000
const REQUEST_TIMEOUT_MS = 60_000
const LONG_CALL_LOG_INTERVAL_MS = 30_000
const STDERR_FLUSH_BYTES = 1024 * 1024
const INSTRUCTIONS_MAX_CHARS = 2048
const PROMPT_MAX_CHARS = 2048
const SCHEMA_MAX_CHARS = 32_768
const TOOLS_MAX_PAGES = 50
const TOOLS_MAX_PER_SERVER = 1000
const TERMINAL_ERROR_LIMIT = 3
const NEEDS_AUTH_TTL_MS = 15 * 60 * 1000
const URL_ELICITATION_RETRIES = 3
const IDE_SERVER_NAME = 'ide'
const IDE_TOOL_ALLOWLIST = new Set(['mcp__ide__executeCode', 'mcp__ide__getDiagnostics'])
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const TERMINAL_ERROR_SUBSTRINGS = [
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

function connectTimeoutMs(): number {
  const raw = process.env.MCP_TIMEOUT
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONNECT_TIMEOUT_MS
}

function toolTimeoutMs(): number {
  const raw = process.env.MCP_TOOL_TIMEOUT
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_TIMEOUT_MS
}

/** The headless launch's bound on the MCP connect-and-discover batch: as
 *  long as one connect may take (the MCP_TIMEOUT deadline, read live). A
 *  server still settling after it serves later calls — the headless tool
 *  pool reads the store live (FN-015 rank 39). */
export function mcpLaunchBudgetMs(): number {
  return connectTimeoutMs()
}

/** Race a batch against a launch budget: 'settled' when the work settles
 *  first (fulfilled or rejected — a batch reports its own failures),
 *  'timeout' when the budget elapses first. The timer never outlives the
 *  race, and the work keeps running after a timeout. */
export async function withMcpLaunchBudget(
  work: Promise<unknown>,
  budgetMs: number,
): Promise<'settled' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), budgetMs)
  })
  try {
    return await Promise.race([
      work.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      bound,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The per-call INACTIVITY limit (sweep #2, B20): a tools/call that
 *  produces neither a result nor a progress notification for this long is
 *  stalled and settles as a typed error instead of holding the turn for the
 *  ~28h total cap. Progress keeps a long call alive. Registered knob
 *  MERCURY_MCP_CALL_IDLE_MINUTES (default 10 — the shell tool's own ceiling;
 *  0 disables). */
export const DEFAULT_MCP_CALL_IDLE_MINUTES = 10
export function mcpCallIdleLimitMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_MCP_CALL_IDLE_MINUTES'), DEFAULT_MCP_CALL_IDLE_MINUTES)
}

/**
 * ONE progress router per client (law 6). `setNotificationHandler` replaces
 * the client's single progress handler, so a per-call install made two
 * concurrent calls on one server lose each other's progress and silenced the
 * SDK's own progress plumbing for good. The router is installed once and
 * dispatches by progress token; each call registers and releases its route.
 */
type ProgressParams = { progressToken?: string | number; progress: number; total?: number; message?: string }
const progressRouters = new WeakMap<Client, Map<string, (params: ProgressParams) => void>>()
function routeProgress(client: Client, token: string, handler: (params: ProgressParams) => void): () => void {
  let routes = progressRouters.get(client)
  if (!routes) {
    const table = new Map<string, (params: ProgressParams) => void>()
    routes = table
    progressRouters.set(client, table)
    client.setNotificationHandler(ProgressNotificationSchema, notification => {
      const params = notification.params as ProgressParams
      if (params.progressToken === undefined) return
      table.get(String(params.progressToken))?.(params)
    })
  }
  routes.set(token, handler)
  return () => {
    routes?.delete(token)
  }
}

export function getMcpServerConnectionBatchSize(): number {
  const raw = process.env.MCP_SERVER_CONNECTION_BATCH_SIZE
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3
}

function getRemoteConnectionBatchSize(): number {
  const raw = process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

// ---------------------------------------------------------------------------
// The shared request-fetch wrapper
// ---------------------------------------------------------------------------

/** The JSON-RPC method inside a request body, cheaply: a head regex first
 *  (the SDK serializes `method` before `params`), a full parse as the
 *  fallback for exotic layouts, null when the body is not a JSON-RPC
 *  string. */
function jsonRpcMethodOf(body: unknown): string | null {
  if (typeof body !== 'string') return null
  const head = body.slice(0, 2048)
  const match = /"method"\s*:\s*"([^"\\]+)"/.exec(head)
  if (match) return match[1]!
  try {
    const parsed = JSON.parse(body) as { method?: unknown } | Array<{ method?: unknown }>
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    return typeof first?.method === 'string' ? first.method : null
  } catch {
    return null
  }
}

/** The wire budget for one streamable-HTTP request, scoped by JSON-RPC
 *  METHOD, not HTTP verb (release-hardening audit rank 37): a fixed 60s on
 *  every POST capped remote tools/call below the documented tool timeout —
 *  a server answering with a single application/json body (which the
 *  transport explicitly supports) was cut at exactly 60s, and BOTH
 *  documented knobs were unreachable: MCP_TOOL_TIMEOUT never applied
 *  because the socket died first, and MERCURY_MCP_CALL_IDLE_MINUTES could
 *  not help because a JSON-answering server has no stream to carry the
 *  progress that feeds it. tools/call now rides the tool-timeout budget
 *  (the inactivity watchdog at the call layer stays the liveness owner);
 *  the handshake and the list calls keep the short budget. */
export function mcpRequestBudgetMs(body: unknown): number {
  return jsonRpcMethodOf(body) === 'tools/call' ? toolTimeoutMs() : REQUEST_TIMEOUT_MS
}

/** GET is exempt (long-lived stream); every other method gets a fresh budget scoped by JSON-RPC method (see mcpRequestBudgetMs) and the streamable-HTTP Accept pair. */
export function wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike {
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET') return baseFetch(input, init)
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException('MCP request timed out', 'TimeoutError')),
      mcpRequestBudgetMs(init?.body),
    )
    timer.unref?.()
    const callerSignal = init?.signal ?? undefined
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason)
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason)
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }
    const headers = new Headers(init?.headers)
    if (!headers.has('accept')) headers.set('Accept', 'application/json, text/event-stream')
    try {
      return await baseFetch(input, { ...init, headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }
}

// ---------------------------------------------------------------------------
// The claude.ai proxy fetch
// ---------------------------------------------------------------------------

export function createClaudeAiProxyFetch(innerFetch: FetchLike): FetchLike {
  return async (input, init) => {
    const send = async (): Promise<{ response: Response; sentToken: string }> => {
      await checkAndRefreshOAuthTokenIfNeeded()
      const token = getClaudeAIOAuthTokens()?.accessToken
      if (!token) throw new Error('No claude.ai OAuth token available for the MCP proxy')
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${token}`)
      return { response: await innerFetch(input, { ...init, headers }), sentToken: token }
    }
    const first = await send()
    if (first.response.status !== 401) return first.response
    // Retry ONCE, only when the token actually changed — compared against the
    // token that was SENT, never a re-read.
    const changed = await handleOAuth401Error(first.sentToken)
    if (!changed) {
      const current = getClaudeAIOAuthTokens()?.accessToken
      if (!current || current === first.sentToken) return first.response
    }
    try {
      return (await send()).response
    } catch {
      return first.response
    }
  }
}

// ---------------------------------------------------------------------------
// The needs-auth cache
// ---------------------------------------------------------------------------

function needsAuthCachePath(): string {
  return join(getMercuryHome(), 'mcp-needs-auth-cache.json')
}

let needsAuthReadMemo: Promise<Record<string, { timestamp: number }>> | null = null
let needsAuthWriteChain: Promise<void> = Promise.resolve()

function readNeedsAuthCache(): Promise<Record<string, { timestamp: number }>> {
  if (needsAuthReadMemo === null) {
    needsAuthReadMemo = readFile(needsAuthCachePath(), 'utf8')
      .then(text => JSON.parse(text) as Record<string, { timestamp: number }>)
      .catch(() => ({}))
  }
  return needsAuthReadMemo
}

async function isNeedsAuthWarm(serverName: string): Promise<boolean> {
  const cache = await readNeedsAuthCache()
  const entry = cache[serverName]
  return entry !== undefined && Date.now() - entry.timestamp < NEEDS_AUTH_TTL_MS
}

function writeNeedsAuth(serverName: string): Promise<void> {
  needsAuthWriteChain = needsAuthWriteChain.then(async () => {
    const cache = await readNeedsAuthCache()
    cache[serverName] = { timestamp: Date.now() }
    const path = needsAuthCachePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(cache, null, 2))
    needsAuthReadMemo = null
  })
  return needsAuthWriteChain
}

export function clearMcpAuthCache(): void {
  needsAuthReadMemo = null
  void rm(needsAuthCachePath(), { force: true }).catch(() => {})
}

async function handleRemoteAuthFailure(name: string, config: ScopedMcpServerConfig, transportClass: string): Promise<MCPServerConnection> {
  logMCPDebug(name, `Authentication required for ${transportClass} server`)
  await writeNeedsAuth(name)
  return { name, type: 'needs-auth', config }
}

// ---------------------------------------------------------------------------
// Client identity + roots
// ---------------------------------------------------------------------------

function clientVersion(): string {
  return typeof MACRO !== 'undefined' ? (MACRO.VERSION ?? 'unknown') : 'unknown'
}

/** The on-wire client identity: no borrowed product URL; elicitation an EMPTY object (load-bearing). */
function buildClient(): Client {
  return new Client(
    {
      name: 'mercury',
      title: 'Mercury',
      version: clientVersion(),
      description: 'Mercury, an agentic coding harness',
    },
    { capabilities: { roots: {}, elicitation: {} } },
  )
}

/** SDK-server clients carry the same identity but NO declared capabilities. */
function buildSdkClient(): Client {
  return new Client(
    {
      name: 'mercury',
      title: 'Mercury',
      version: clientVersion(),
      description: 'Mercury, an agentic coding harness',
    },
    { capabilities: {} },
  )
}

function installRootsHandler(client: Client): void {
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    // Evaluated per request so a directory change is reflected. Every path
    // goes through a REAL path→URI conversion (string interpolation broke
    // Windows drive letters and never percent-encoded spaces/non-ASCII).
    const roots = [pathToFileURL(getOriginalCwd()).href]
    const add = (p: string): void => {
      const stripped = p.replace(/[\\/]+$/, '')
      const uri = pathToFileURL(stripped || p).href
      if (!roots.includes(uri)) roots.push(uri)
    }
    if (flagEnv('MERCURY_MCP_ROOTS_WIDE') !== '0') {
      add(getCwd())
      add(tmpdir())
      if (process.platform !== 'win32') {
        add('/tmp')
        add('/private/tmp')
      }
    }
    return { roots: roots.map(uri => ({ uri })) }
  })
}


// ---------------------------------------------------------------------------
// WebSocket transport (ws / ws-ide) — the `mcp` subprotocol, headers, TLS and
// proxy from the harness owners. Two construction paths: one runtime's
// WebSocket takes headers/TLS/proxy in its options bag; the other needs the
// Node package's three-argument form.
// ---------------------------------------------------------------------------

type WsSocketLike = {
  send(data: string): void
  close(): void
  addEventListener?(event: string, handler: (event: never) => void): void
  on?(event: string, handler: (...args: never[]) => void): void
}

async function createWsTransport(url: string, headers: Record<string, string>): Promise<Transport> {
  const tlsOptions = getWebSocketTLSOptions()
  let socket: WsSocketLike
  if (typeof Bun !== 'undefined') {
    // Bun's native WebSocket takes the bypass-aware proxy as a plain URL.
    const proxyUrl = getWebSocketProxyUrl(url)
    socket = new WebSocket(url, {
      protocols: ['mcp'],
      headers,
      ...(tlsOptions ? { tls: tlsOptions } : {}),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as never) as unknown as WsSocketLike
  } else {
    // The Node package's constructor takes the bypass-aware proxy as `agent`.
    const proxyAgent = getWebSocketProxyAgent(url)
    const nodeOptions = { headers, ...(tlsOptions ?? {}), ...(proxyAgent ? { agent: proxyAgent } : {}) }
    const { default: NodeWebSocket } = await import('ws')
    socket = new NodeWebSocket(url, ['mcp'], nodeOptions as never) as unknown as WsSocketLike
  }
  const listen = (event: string, handler: (payload: unknown) => void): void => {
    if (typeof socket.on === 'function') socket.on(event, handler as never)
    else socket.addEventListener?.(event, handler as never)
  }
  const wsTransport: Transport & { onmessage?: (message: JSONRPCMessage) => void } = {
    start: () =>
      new Promise<void>((resolve, reject) => {
        listen('open', () => resolve())
        listen('error', (payload: unknown) => {
          const error = payload instanceof Error ? payload : new Error(String((payload as { message?: unknown } | null)?.message ?? 'WebSocket error'))
          wsTransport.onerror?.(error)
          reject(error)
        })
        listen('close', () => wsTransport.onclose?.())
        listen('message', (payload: unknown) => {
          const raw = (payload as { data?: unknown } | null)?.data ?? payload
          try {
            wsTransport.onmessage?.(JSON.parse(String(raw)) as JSONRPCMessage)
          } catch (err) {
            wsTransport.onerror?.(err instanceof Error ? err : new Error(String(err)))
          }
        })
      }),
    send: async (message: JSONRPCMessage) => {
      socket.send(JSON.stringify(message))
    },
    close: async () => {
      socket.close()
    },
  }
  return wsTransport
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

export function getServerCacheKey(name: string, serverRef: ScopedMcpServerConfig): string {
  return `${name}:${JSON.stringify(serverRef)}`
}

type RemoteConfig = ScopedMcpServerConfig & { url?: string; headers?: Record<string, string> }

function isTerminalErrorMessage(message: string): boolean {
  return TERMINAL_ERROR_SUBSTRINGS.some(substring => message.includes(substring))
}

const connectImpl = async (name: string, serverRef: ScopedMcpServerConfig, serverStats?: unknown): Promise<MCPServerConnection> => {
  void serverStats
  const config = serverRef as RemoteConfig
  const type = config.type ?? 'stdio'
  const startedAt = Date.now()
  let transport: Transport
  let inProcessServer: { close: () => Promise<void> } | null = null
  let stdioTransport: StdioClientTransport | null = null
  let stderrBuffer = ''
  let inProcess = false
  const isIde = type === 'sse-ide' || type === 'ws-ide'
  const provider =
    type === 'sse' || type === 'http' ? new MercuryMcpAuthProvider(name, serverRef, undefined, false) : null

  try {
    if (type === 'sse') {
      const headers = await getMcpServerHeaders(name, config as never)
      const wrapped = wrapFetchWithTimeout(wrapFetchWithStepUpDetection(getApiFetch() as FetchLike, provider as MercuryMcpAuthProvider))
      transport = new SSEClientTransport(new URL(config.url as string), {
        authProvider: provider as never,
        fetch: wrapped as never,
        requestInit: { headers: { 'User-Agent': getMCPUserAgent(), ...headers } },
        // The long-lived event stream is configured separately, WITHOUT the
        // timeout wrapper (a 60 s budget would kill the persistent stream).
        eventSourceInit: {
          fetch: async (input: string | URL, init?: RequestInit) => {
            const tokens = await (provider as MercuryMcpAuthProvider).tokens()
            const streamHeaders = new Headers(init?.headers)
            streamHeaders.set('User-Agent', getMCPUserAgent())
            if (tokens?.access_token) streamHeaders.set('Authorization', `Bearer ${tokens.access_token}`)
            for (const [key, value] of Object.entries(headers)) streamHeaders.set(key, value)
            streamHeaders.set('Accept', 'text/event-stream')
            return getApiFetch()(input as string, { ...init, headers: streamHeaders, ...getProxyFetchOptions() } as never)
          },
        } as never,
      })
    } else if (type === 'sse-ide') {
      const proxyUrl = getProxyUrl()
      transport = proxyUrl
        ? new SSEClientTransport(new URL(config.url as string), {
            eventSourceInit: {
              fetch: (input: string | URL, init?: RequestInit) =>
                getApiFetch()(input as string, { ...init, ...getProxyFetchOptions() } as never),
            } as never,
          })
        : new SSEClientTransport(new URL(config.url as string))
    } else if (type === 'ws-ide' || type === 'ws') {
      const ideToken = (config as { authToken?: string }).authToken
      const wsHeaders: Record<string, string> = { 'User-Agent': getMCPUserAgent() }
      if (type === 'ws-ide') {
        if (ideToken) wsHeaders['X-Claude-Code-Ide-Authorization'] = ideToken
      } else {
        Object.assign(wsHeaders, await getMcpServerHeaders(name, config as never))
      }
      if (type === 'ws') {
        const logged = { ...wsHeaders }
        for (const key of Object.keys(logged)) if (key.toLowerCase() === 'authorization') logged[key] = '[REDACTED]'
        logMCPDebug(name, `WebSocket connection options: ${JSON.stringify({ headers: logged, tls: Boolean(getWebSocketTLSOptions()), proxy: Boolean(getProxyUrl()) })}`)
      }
      transport = await createWsTransport(config.url as string, wsHeaders)
    } else if (type === 'http') {
      const headers = await getMcpServerHeaders(name, config as never)
      const wrapped = wrapFetchWithTimeout(wrapFetchWithStepUpDetection(getApiFetch() as FetchLike, provider as MercuryMcpAuthProvider))
      const requestInit = { headers: { 'User-Agent': getMCPUserAgent(), ...headers }, ...getProxyFetchOptions() }
      const logged = { ...requestInit, headers: { ...headers, ...(headers.authorization ? { authorization: '[REDACTED]' } : {}) } }
      logMCPDebug(name, `runtime ${typeof Bun !== 'undefined' ? 'bun' : 'node'}, proxy ${getProxyUrl() ?? 'none'}`)
      logMCPDebug(name, `HTTP request options: ${JSON.stringify(logged)}`)
      // A deliberate warm-up whose boolean result is unused: reading tokens
      // can fire the proactive refresh or the cross-app silent exchange.
      void Boolean(await (provider as MercuryMcpAuthProvider).tokens())
      transport = new StreamableHTTPClientTransport(new URL(config.url as string), {
        authProvider: provider as never,
        fetch: wrapped as never,
        requestInit: requestInit as never,
      })
    } else if (type === 'sdk') {
      throw new Error('SDK servers are connected through setupSdkMcpClients')
    } else if (type === 'claudeai-proxy') {
      const token = getClaudeAIOAuthTokens()?.accessToken
      if (!token) throw new Error(`claude.ai proxy server ${name} requires a claude.ai OAuth token`)
      const oauth = getOauthConfig()
      const url = `${oauth.MCP_PROXY_URL}${oauth.MCP_PROXY_PATH.replace('{server_id}', (config as { id?: string }).id ?? '')}`
      transport = new StreamableHTTPClientTransport(new URL(url), {
        fetch: wrapFetchWithTimeout(createClaudeAiProxyFetch(fetch as FetchLike)) as never,
        requestInit: { headers: { 'User-Agent': getMCPUserAgent(), 'X-Mcp-Client-Session-Id': getSessionId() } },
      })
    } else if ((type === 'stdio' || config.type === undefined) && isCoordinationServer(name) && isCoordinationServerEnabled()) {
      // Intercepted BEFORE the generic stdio branch: an in-process server over
      // a linked transport pair; the config's command/args are inert carriers.
      const [{ createCoordinationServer }, { createLinkedTransportPair }] = await Promise.all([
        import('./coordinationServer.js'),
        import('./InProcessTransport.js'),
      ])
      const server = await createCoordinationServer()
      const [clientSide, serverSide] = createLinkedTransportPair()
      await server.connect(serverSide)
      inProcessServer = server
      transport = clientSide
      inProcess = true
    } else if (type === 'stdio') {
      const stdioConfig = config as { command: string; args?: string[]; env?: Record<string, string> }
      const prefix = flagEnv('MERCURY_SHELL_PREFIX')
      const command = prefix ? prefix : stdioConfig.command
      const args = prefix ? [[stdioConfig.command, ...(stdioConfig.args ?? [])].join(' ')] : (stdioConfig.args ?? [])
      stdioTransport = new StdioClientTransport({
        command,
        args,
        env: { ...(subprocessEnv() as Record<string, string>), ...(stdioConfig.env ?? {}) },
        stderr: 'pipe',
      })
      transport = stdioTransport
    } else {
      throw new Error(`Unsupported MCP server type: ${String(type)}`)
    }
  } catch (err) {
    logMCPError(name, err)
    return { name, type: 'failed', config: serverRef, error: errorMessage(err) }
  }

  // Stdio stderr: installed BEFORE connecting; flushed to the error log past 1 MiB.
  const onStderr = (chunk: Buffer): void => {
    try {
      stderrBuffer += chunk.toString()
      if (stderrBuffer.length > STDERR_FLUSH_BYTES) {
        logMCPError(name, `stderr: ${stderrBuffer}`)
        stderrBuffer = ''
      }
    } catch {
      // String-length overflow: ignore.
    }
  }
  stdioTransport?.stderr?.on('data', onStderr)

  // THE ONE STDIO KILL OWNER (field w4-f05-02): whatever the connect
  // outcome, a spawned server ends WITH ITS WHOLE TREE — phase 1 the
  // graceful interrupt across the tree (win32's taskkill has no graceful
  // form; the owner's arm there is the one taskkill walk), phase 2 a hard
  // sweep of survivors. The connected path's cleanup rides this; the
  // CONNECT TIMEOUT and the connect-failure catch call it directly —
  // transport.close() ends only the direct child, so a server that never
  // connected left its grandchildren running with no kill owner at all.
  const endStdioTree = async (): Promise<void> => {
    const pid = stdioTransport?.pid ?? null
    if (pid === null) return
    try {
      const { endProcessTree, endProcessTreeSurvivors } = await import('../../utils/processGroup.js')
      const graceful = await endProcessTree(pid, 'SIGINT')
      // The sweep strikes the graceful phase's SURVIVORS by pid before it
      // re-walks: a root the interrupt killed has reparented its detached
      // descendants to pid 1, and a fresh walk from the dead root found
      // nothing — a never-connected server's grandchild lived on.
      const swept = graceful.survivors.length > 0 ? await endProcessTreeSurvivors(pid, graceful.survivors, 'SIGKILL') : null
      const survivors = swept ? swept.survivors : graceful.survivors
      const ended = graceful.ended + (swept?.ended ?? 0)
      logMCPDebug(
        name,
        survivors.length > 0
          ? `process tree still present after kill (${survivors.length} pid(s) unconfirmed)`
          : `process tree exited (${ended} process(es) ended)`,
      )
    } catch (err) {
      logMCPError(name, err)
    }
  }

  const client = buildClient()
  installRootsHandler(client)

  const connectPromise = client.connect(transport)
  let timer: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // The ONE connect deadline, every transport; the reason names the
      // transport and the seconds, and the row it lands on is retryable
      // from /mcp (the reconnect flow) — never a spinner held forever.
      // Reject BEFORE closing: closing first makes the transport's own
      // close cascade ("Connection closed") win the race, and the roster
      // row then lies about why the server fell.
      const transportLabel = inProcess ? 'in-process' : type
      reject(
        new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
          `MCP server "${name}" (${transportLabel}) did not answer in ${deadlineSecondsLabel(connectTimeoutMs())} — retry from /mcp`,
          'MCP connection timeout',
        ),
      )
      // The tree BEFORE the close (w4-f05-02): closing the pipes kills a
      // frozen server first, its detached grandchildren reparent to pid 1,
      // and a walk from the dead root finds nothing — so the snapshot and
      // the strike come first, the transport closes behind them. The
      // reject above stays first: the roster row keeps its honest reason.
      void endStdioTree().finally(() => {
        void inProcessServer?.close().catch(() => {})
        void transport.close().catch(() => {})
      })
    }, connectTimeoutMs())
  })
  try {
    await Promise.race([connectPromise, timeoutPromise])
    if (stderrBuffer) {
      logMCPError(name, `stderr: ${stderrBuffer}`)
      stderrBuffer = ''
    }
    logMCPDebug(name, `Connected in ${Date.now() - startedAt}ms via ${type}`)
  } catch (err) {
    if (type === 'sse') logMCPError(name, `SSE connect failed: ${getLoggingSafeMcpBaseUrl(config) ?? '(url withheld)'} ${errorMessage(err)} ${(err as Error)?.stack ?? ''}`)
    else if (type === 'http') logMCPError(name, `HTTP connect failed: ${errorMessage(err)} code=${getErrnoCode(err) ?? 'none'}`)
    else if (type === 'claudeai-proxy') logMCPError(name, `proxy connect failed: ${errorMessage(err)}`)
    else logMCPError(name, err)
    const unauthorized = err instanceof UnauthorizedError
    if ((type === 'sse' || type === 'http') && unauthorized) return handleRemoteAuthFailure(name, serverRef, type.toUpperCase())
    if (type === 'claudeai-proxy' && (err as { code?: unknown } | null)?.code === 401) return handleRemoteAuthFailure(name, serverRef, 'claude.ai proxy')
    // The tree BEFORE the close (w4-f05-02) — the same order as the timeout
    // arm: a closed pipe would kill the root and orphan its grandchildren
    // before the walk could see them.
    await endStdioTree()
    await inProcessServer?.close().catch(() => {})
    await transport.close().catch(() => {})
    if (stderrBuffer) logMCPError(name, `stderr: ${stderrBuffer}`)
    // The operator-facing reason carries the server's own last words
    // (FC-066): every stdio failure surfaced as one opaque sentence — the
    // SDK's generic close error — while the distinguishing evidence (the
    // server's stderr, or its absence) reached only the debug log.
    if (type === 'stdio') {
      const stderrTail = stderrBuffer.trim().split('\n').slice(-3).join(' · ').slice(0, 300)
      throw new Error(
        stderrTail.length > 0
          ? `${errorMessage(err)} — server stderr: ${stderrTail}`
          : `${errorMessage(err)} — the server wrote nothing to stderr before closing (run the command by hand to see why it exits)`,
        { cause: err },
      )
    }
    throw err
  } finally {
    if (timer !== null) clearTimeout(timer)
  }

  const capabilities = client.getServerCapabilities() ?? {}
  const serverInfo = client.getServerVersion()
  let instructions = client.getInstructions()
  if (instructions && instructions.length > INSTRUCTIONS_MAX_CHARS) {
    const original = instructions.length
    instructions = `${instructions.slice(0, INSTRUCTIONS_MAX_CHARS)}\n\n[instructions truncated]`
    logMCPDebug(name, `instructions truncated ${original} → ${instructions.length}`)
  }
  // Default elicitation handler until the real one replaces it.
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'cancel' }))
  if (isIde) {
    client.notification({ method: 'ide_connected', params: { pid: process.pid } }).catch(err => {
      logMCPDebug(name, `ide_connected notification failed: ${errorMessage(err)}`)
    })
  }

  // Drop detection / reconnection.
  const originalOnError = client.onerror
  const originalOnClose = client.onclose
  let terminalErrors = 0
  let closing = false
  let sawError = false
  const remote = type === 'sse' || type === 'http' || type === 'claudeai-proxy'
  const closeViaClient = (): void => {
    if (closing) return
    closing = true
    // Through the CLIENT's close so pending request handlers reject.
    void client.close().catch(() => {})
  }
  client.onerror = (error: Error) => {
    sawError = true
    const uptime = Date.now() - startedAt
    const message = error.message
    logMCPDebug(name, `transport ${type} error after ${uptime}ms: ${message}`)
    if (message.includes('ECONNRESET')) logMCPDebug(name, 'connection reset — the server crashed or restarted')
    else if (message.includes('ETIMEDOUT')) logMCPDebug(name, 'timeout — network or unresponsive server')
    else if (message.includes('ECONNREFUSED')) logMCPDebug(name, 'connection refused — the server is down')
    else if (message.includes('EPIPE')) logMCPDebug(name, 'broken pipe')
    else if (message.includes('EHOSTUNREACH')) logMCPDebug(name, 'host unreachable')
    else if (message.includes('ESRCH')) logMCPDebug(name, 'no such process — the stdio server terminated')
    else if (message.includes('spawn')) logMCPDebug(name, 'spawn failure — check the command and permissions')
    else logMCPDebug(name, message)
    if ((type === 'http' || type === 'claudeai-proxy') && isMcpSessionExpiredError(error)) closeViaClient()
    if (remote) {
      if (message.includes('Maximum reconnection attempts')) {
        closeViaClient()
      } else if (isTerminalErrorMessage(message)) {
        terminalErrors++
        if (terminalErrors >= TERMINAL_ERROR_LIMIT) {
          terminalErrors = 0
          closeViaClient()
        }
      } else {
        terminalErrors = 0
      }
    }
    originalOnError?.(error)
  }
  client.onclose = () => {
    logMCPDebug(name, `transport ${type} closed after ${Date.now() - startedAt}ms (errors: ${sawError})`)
    connectToServer.cache.delete(getServerCacheKey(name, serverRef))
    fetchToolsForClient.cache.delete(name)
    fetchResourcesForClient.cache.delete(name)
    fetchCommandsForClient.cache.delete(name)
    originalOnClose?.()
  }

  // Cleanup.
  const cleanup = async (): Promise<void> => {
    unregister()
    if (inProcess) {
      await inProcessServer?.close().catch(err => logMCPError(name, err))
      await client.close().catch(err => logMCPError(name, err))
      return
    }
    if (type === 'stdio' || config.type === undefined) {
      // Disabling or removing a server DISCONNECTS for real: the whole tree
      // the server started ends with it, on every platform, through the ONE
      // stdio kill owner above.
      stdioTransport?.stderr?.off('data', onStderr)
      await endStdioTree()
    }
    await client.close().catch(err => logMCPError(name, err))
  }
  const unregister = registerCleanup(cleanup)

  return {
    type: 'connected',
    name,
    client,
    capabilities,
    serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : undefined,
    instructions,
    config: serverRef,
    cleanup,
  }
}

export const connectToServer = memoize(connectImpl, getServerCacheKey)

export async function clearServerCache(name: string, serverRef: ScopedMcpServerConfig): Promise<void> {
  // Consult the memo, never dial it: a disconnect step must not open a new
  // connection to learn whether one exists. A cold memo means no client was
  // connected through this door, so there is nothing to tear down — invoking
  // connectToServer here would burn a whole connect deadline against an
  // unresponsive server, and the "/mcp" retry the deadline line advertises
  // would take two deadlines while printing one (field finding F-4.1).
  const memoized = connectToServer.cache.get(getServerCacheKey(name, serverRef)) as
    | ReturnType<typeof connectToServer>
    | undefined
  if (memoized !== undefined) {
    try {
      const existing = await memoized
      if (existing.type === 'connected') await existing.cleanup()
    } catch {
      // The server may have failed to connect.
    }
  }
  connectToServer.cache.delete(getServerCacheKey(name, serverRef))
  fetchToolsForClient.cache.delete(name)
  fetchResourcesForClient.cache.delete(name)
  fetchCommandsForClient.cache.delete(name)
}

export async function ensureConnectedClient(client: MCPServerConnection): Promise<ConnectedMCPServer> {
  if (client.config.type === 'sdk') return client as ConnectedMCPServer
  const connection = await connectToServer(client.name, client.config)
  if (connection.type !== 'connected') {
    throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      `MCP server "${client.name}" is not connected`,
      'MCP server not connected',
    )
  }
  return connection
}

/** Types match and JSON forms match with the scope excluded. */
export function areMcpConfigsEqual(a: ScopedMcpServerConfig, b: ScopedMcpServerConfig): boolean {
  if (a.type !== b.type) return false
  const { scope: _scopeA, ...restA } = a
  const { scope: _scopeB, ...restB } = b
  return JSON.stringify(restA) === JSON.stringify(restB)
}

// ---------------------------------------------------------------------------
// Tool construction and discovery
// ---------------------------------------------------------------------------

export function mcpToolInputToAutoClassifierInput(input: Record<string, unknown>, toolName: string): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return toolName
  return keys.map(key => `${key}=${String(input[key])}`).join(' ')
}

type ToolWithPermissions = ScopedMcpServerConfig & { toolPermissions?: Record<string, string> }

function buildMcpTool(client: ConnectedMCPServer, sdkTool: McpSdkTool): Tool {
  const serverName = client.name
  const toolName = sdkTool.name
  const annotations = (sdkTool.annotations ?? undefined) as McpToolAnnotations
  const meta = (sdkTool as { _meta?: Record<string, unknown> })._meta ?? {}
  const rawHint = meta['anthropic/searchHint']
  const searchHint = typeof rawHint === 'string' ? rawHint.replace(/\s+/g, ' ').trim() || undefined : undefined
  const alwaysLoad = meta['anthropic/alwaysLoad'] === true
  const skipPrefix = client.config.type === 'sdk' && isEnvTruthy(process.env.MERCURY_SDK_MCP_NO_PREFIX)
  const qualifiedName = buildMcpToolName(serverName, toolName)
  // The name the model calls fits every wire's grammar (one over-long name
  // would reject the whole request on the 64-character wires); permission
  // rules keep matching the fully-qualified name through mcpInfo.
  const modelFacingName = skipPrefix ? toolName : wireSafeMcpToolName(serverName, toolName)
  const rawDescription = sdkTool.description ?? ''
  const description = withMcpToolCardHeader(serverName, rawDescription, annotations)
  const prompt = description.length > PROMPT_MAX_CHARS ? `${description.slice(0, PROMPT_MAX_CHARS)}\n\n[description truncated]` : description
  let inputJSONSchema: unknown = sdkTool.inputSchema
  if (JSON.stringify(inputJSONSchema ?? {}).length > SCHEMA_MAX_CHARS) {
    logMCPError(serverName, `tool ${toolName} input schema exceeds ${SCHEMA_MAX_CHARS} characters; replaced with a permissive schema`)
    inputJSONSchema = { type: 'object', additionalProperties: true }
  }
  const effectiveMaxPermission = (client.config as ToolWithPermissions).toolPermissions?.[toolName]
  const displayName = `${serverName} - ${(annotations as { title?: string } | undefined)?.title ?? toolName} (MCP)`

  const tool = {
    ...(MCPTool as unknown as Record<string, unknown>),
    name: modelFacingName,
    mcpInfo: { serverName, toolName, ...(effectiveMaxPermission ? { effectiveMaxPermission } : {}) },
    isMcp: true,
    searchHint,
    alwaysLoad,
    description: async () => description,
    prompt: async () => prompt,
    isConcurrencySafe: () => (annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true,
    isReadOnly: () => (annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true,
    toAutoClassifierInput: (input: Record<string, unknown>) => mcpToolInputToAutoClassifierInput(input, toolName),
    isDestructive: () => (annotations as { destructiveHint?: boolean } | undefined)?.destructiveHint === true,
    isOpenWorld: () => (annotations as { openWorldHint?: boolean } | undefined)?.openWorldHint === true,
    isSearchOrReadCommand: () => classifyMcpToolForCollapse(serverName, toolName),
    inputJSONSchema,
    checkPermissions: async (input: Record<string, unknown>) => {
      if (!mcpToolAllowed(serverName, toolName, annotations)) {
        const reason = mcpPolicyDenyReason(serverName, toolName, annotations)
        return { behavior: 'deny', message: reason, decisionReason: { type: 'other', reason } }
      }
      return {
        behavior: 'passthrough',
        message: `Allow ${qualifiedName}?`,
        suggestions: [
          { type: 'addRules', rules: [{ toolName: qualifiedName }], behavior: 'allow', destination: 'localSettings' },
        ],
        updatedInput: input,
      }
    },
    call: async (
      args: Record<string, unknown>,
      context: ToolUseContext,
      _canUseTool: CanUseToolFn,
      parentMessage: AssistantMessage,
      onProgress?: (progress: unknown) => void,
    ) => {
      const result = await callMCPToolWithUrlElicitationRetry({
        client,
        tool: toolName,
        args,
        signal: context.abortController.signal,
        parentMessage,
        onProgress: onProgress as ((progress: unknown) => void) | undefined,
        setAppState: context.setAppState as unknown as (updater: (prev: unknown) => unknown) => void,
        isNonInteractive: context.options.isNonInteractiveSession,
        // Print/SDK mode: URL elicitations delegate to the structured-IO handler
        // on the tool-use context; interactive sessions leave this unset and take
        // the app-state queue path.
        handleUrlElicitation: context.handleElicitation
          ? async elicitation =>
              (await context.handleElicitation!(client.name, elicitation, context.abortController.signal))
                ?.action as 'accept' | 'decline' | 'cancel'
          : undefined,
      })
      return { data: result.content }
    },
    userFacingName: () => displayName,
  } as unknown as Tool
  return tool
}

async function listAllTools(client: ConnectedMCPServer): Promise<McpSdkTool[]> {
  const accumulated: McpSdkTool[] = []
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  for (let page = 0; page < TOOLS_MAX_PAGES; page++) {
    let result: z.infer<typeof ListToolsResultSchema>
    try {
      // Every discovery request carries the connect deadline explicitly: a
      // server that completes the handshake and then stalls on tools/list
      // used to inherit the SDK's 60s default per page (FN-015 rank 39).
      result = await client.client.request(
        { method: 'tools/list', params: cursor ? { cursor } : {} },
        ListToolsResultSchema,
        { timeout: connectTimeoutMs() },
      )
    } catch (err) {
      if (page === 0) throw err
      logMCPDebug(client.name, `tools/list page ${page} failed; keeping ${accumulated.length} tools: ${errorMessage(err)}`)
      break
    }
    accumulated.push(...(result.tools ?? []))
    if (accumulated.length >= TOOLS_MAX_PER_SERVER) {
      logMCPDebug(client.name, `tool cap ${TOOLS_MAX_PER_SERVER} reached; truncating`)
      accumulated.length = TOOLS_MAX_PER_SERVER
      break
    }
    const next = result.nextCursor
    if (!next) break
    if (seenCursors.has(next)) {
      logMCPDebug(client.name, 'repeated tools/list cursor; stopping pagination')
      break
    }
    seenCursors.add(next)
    cursor = next
  }
  // Prime the SDK's output-schema validator cache: the SDK only populates it
  // inside its own list call, and discovery here uses raw requests.
  try {
    const primer = (client.client as unknown as { cacheToolMetadata?: (tools: McpSdkTool[]) => void }).cacheToolMetadata
    if (typeof primer === 'function') primer.call(client.client, accumulated)
  } catch (err) {
    logMCPDebug(client.name, `output-schema validator priming failed (validation off): ${errorMessage(err)}`)
  }
  return accumulated
}

// ── tool-discovery honesty (release-hardening audit rank 36) ────────────────
/** A failed tools/list, recorded per server. Two consumers: the roster can
 *  say WHY a connected server contributes zero tools
 *  (getToolDiscoveryFailure), and the fetch wrapper retries on a bounded
 *  backoff (30s doubling to 5min — the LSP init-failure ladder's shape)
 *  instead of serving the memoized empty answer for the life of the
 *  connection. "The server has no tools" and "discovery failed" are no
 *  longer the same cached answer. Cleared by a successful discovery. */
type ToolDiscoveryFailure = { message: string; at: number; attempts: number; nextRetryAt: number }
const toolDiscoveryFailures = new Map<string, ToolDiscoveryFailure>()
const TOOL_DISCOVERY_RETRY_BASE_MS = 30_000
const TOOL_DISCOVERY_RETRY_CAP_MS = 5 * 60_000

export function getToolDiscoveryFailure(name: string): { message: string; at: number } | null {
  const failure = toolDiscoveryFailures.get(name)
  return failure ? { message: failure.message, at: failure.at } : null
}

const fetchToolsForClientMemo = memoize(
  async (client: MCPServerConnection): Promise<Tool[]> => {
    if (client.type !== 'connected') return []
    if (!client.capabilities.tools) return []
    try {
      const raw = await listAllTools(client)
      const sanitized = recursivelySanitizeUnicode(raw)
      const tools = sanitized.map(sdkTool => buildMcpTool(client, sdkTool))
      toolDiscoveryFailures.delete(client.name)
      return tools.filter(tool => {
        if (tool.name.startsWith('mcp__ide__') && !IDE_TOOL_ALLOWLIST.has(tool.name)) return false
        const info = (tool as { mcpInfo?: { toolName: string } }).mcpInfo
        const annotations = sanitized.find(entry => entry.name === info?.toolName)?.annotations as McpToolAnnotations
        return mcpToolAllowed(client.name, info?.toolName ?? tool.name, annotations)
      })
    } catch (err) {
      logMCPError(client.name, err)
      const attempts = (toolDiscoveryFailures.get(client.name)?.attempts ?? 0) + 1
      toolDiscoveryFailures.set(client.name, {
        message: errorMessage(err),
        at: Date.now(),
        attempts,
        nextRetryAt: Date.now() + Math.min(TOOL_DISCOVERY_RETRY_BASE_MS * 2 ** (attempts - 1), TOOL_DISCOVERY_RETRY_CAP_MS),
      })
      return []
    }
  },
  client => client.name,
)
fetchToolsForClientMemo.cache = new LRUCache({ max: 20 }) as never

/** The public fetch keeps the memo's shape (`.cache` included — the three
 *  invalidation sites ride it), but a recorded discovery failure whose
 *  backoff has elapsed evicts the poisoned entry first, so the next read
 *  retries instead of trusting an empty answer forever. */
export const fetchToolsForClient = Object.assign(
  (client: MCPServerConnection): Promise<Tool[]> => {
    const failure = toolDiscoveryFailures.get(client.name)
    if (failure !== undefined && Date.now() >= failure.nextRetryAt) {
      fetchToolsForClientMemo.cache.delete(client.name)
    }
    return fetchToolsForClientMemo(client)
  },
  { cache: fetchToolsForClientMemo.cache },
)

export const fetchResourcesForClient = memoize(
  async (client: MCPServerConnection): Promise<ServerResource[]> => {
    if (client.type !== 'connected') return []
    if (!client.capabilities.resources) return []
    try {
      const result = await client.client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema, { timeout: connectTimeoutMs() })
      return (result.resources ?? []).map(resource => ({ ...resource, server: client.name })) as ServerResource[]
    } catch (err) {
      logMCPError(client.name, err)
      return []
    }
  },
  client => client.name,
)
fetchResourcesForClient.cache = new LRUCache({ max: 20 }) as never

export const fetchCommandsForClient = memoize(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected') return []
    if (!client.capabilities.prompts) return []
    try {
      const result = await client.client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema, { timeout: connectTimeoutMs() })
      const prompts = recursivelySanitizeUnicode(result.prompts ?? [])
      return prompts.map(prompt => {
        const commandName = `mcp__${normalizeNameForMCP(client.name)}__${normalizeNameForMCP(prompt.name)}`
        const argNames = (prompt.arguments ?? []).map(argument => argument.name)
        return {
          type: 'prompt',
          name: commandName,
          description: prompt.description ?? '',
          hasUserSpecifiedDescription: prompt.description !== undefined,
          isEnabled: () => true,
          isHidden: false,
          isMcp: true,
          source: 'mcp',
          contentLength: 0,
          progressMessage: 'running',
          argNames,
          // The identifier, never the human title: a title may contain spaces.
          userFacingName: () => `${client.name}:${prompt.name} (MCP)`,
          getPromptForCommand: async (args: string) => {
            const values = args.split(' ')
            const promptArgs: Record<string, string> = {}
            argNames.forEach((argName, index) => {
              if (values[index] !== undefined) promptArgs[argName] = values[index] as string
            })
            try {
              const connected = await ensureConnectedClient(client)
              const response = await connected.client.request(
                { method: 'prompts/get', params: { name: prompt.name, arguments: promptArgs } },
                GetPromptResultSchema,
              )
              const blocks: ContentBlockParam[] = []
              for (const message of response.messages ?? []) {
                const content = Array.isArray(message.content) ? message.content : [message.content]
                blocks.push(...(await transformResultContent(content as never, client.name)))
              }
              return blocks
            } catch (err) {
              logMCPError(client.name, `prompt ${prompt.name} failed: ${errorMessage(err)}`)
              throw err
            }
          },
        } as unknown as Command
      })
    } catch (err) {
      logMCPError(client.name, err)
      return []
    }
  },
  client => client.name,
)
fetchCommandsForClient.cache = new LRUCache({ max: 20 }) as never

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type MCPResultType = 'toolResult' | 'structuredContent' | 'contentArray'

export type TransformedMCPResult = {
  type: MCPResultType
  content: MCPToolResult
  schema?: string
  isImage?: boolean
}

function persistId(serverName: string, extra?: string): string {
  return `${normalizeNameForMCP(serverName)}${extra ? `-${normalizeNameForMCP(extra)}` : ''}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function persistBlob(bytes: Buffer, mimeType: string | undefined, serverName: string, source: string): Promise<ContentBlockParam> {
  const saved = await persistBinaryContent(bytes, mimeType, persistId(serverName))
  if ('error' in saved) {
    return { type: 'text', text: `${source}: binary content could not be saved (${mimeType ?? 'unknown type'}, ${bytes.length} bytes): ${saved.error}` } as ContentBlockParam
  }
  return { type: 'text', text: getBinaryBlobSavedMessage(saved.filepath, mimeType, saved.size, source) } as ContentBlockParam
}

async function resizedImageBlock(base64: string, mimeType: string | undefined): Promise<ContentBlockParam> {
  const subtype = mimeType?.split('/')[1] ?? 'png'
  const bytes = Buffer.from(base64, 'base64')
  const resized = await maybeResizeAndDownsampleImageBuffer(bytes, bytes.length, subtype)
  return {
    type: 'image',
    source: { type: 'base64', media_type: `image/${resized.mediaType}`, data: resized.buffer.toString('base64') },
  } as ContentBlockParam
}

export async function transformResultContent(content: unknown[], serverName: string): Promise<ContentBlockParam[]> {
  const out: ContentBlockParam[] = []
  for (const block of content) {
    const record = block as Record<string, unknown>
    switch (record.type) {
      case 'text':
        out.push({ type: 'text', text: String(record.text ?? '') } as ContentBlockParam)
        break
      case 'audio': {
        const bytes = Buffer.from(String(record.data ?? ''), 'base64')
        out.push(await persistBlob(bytes, record.mimeType as string | undefined, serverName, `Audio from ${serverName}`))
        break
      }
      case 'image':
        out.push(await resizedImageBlock(String(record.data ?? ''), record.mimeType as string | undefined))
        break
      case 'resource': {
        const resource = record.resource as { uri?: string; text?: string; blob?: string; mimeType?: string } | undefined
        const marker = `Resource from ${serverName} at ${resource?.uri ?? 'unknown'}`
        if (resource?.text !== undefined) {
          out.push({ type: 'text', text: `${marker}:\n${resource.text}` } as ContentBlockParam)
        } else if (resource?.blob !== undefined) {
          if (resource.mimeType && IMAGE_MIME_TYPES.has(resource.mimeType)) {
            out.push({ type: 'text', text: marker } as ContentBlockParam)
            out.push(await resizedImageBlock(resource.blob, resource.mimeType))
          } else {
            out.push(await persistBlob(Buffer.from(resource.blob, 'base64'), resource.mimeType, serverName, marker))
          }
        }
        break
      }
      case 'resource_link':
        out.push({
          type: 'text',
          text: `Resource: ${String(record.name ?? '')} (${String(record.uri ?? '')})${record.description ? ` (${String(record.description)})` : ''}`,
        } as ContentBlockParam)
        break
      default:
        break
    }
  }
  return out
}

export function inferCompactSchema(value: unknown, depth: number = 2): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${inferCompactSchema(value[0], depth - 1)}]`
  if (typeof value === 'object') {
    if (depth <= 0) return '{...}'
    const entries = Object.entries(value as Record<string, unknown>)
    const shown = entries.slice(0, 10).map(([key, inner]) => `${key}: ${inferCompactSchema(inner, depth - 1)}`)
    return `{${shown.join(', ')}${entries.length > 10 ? ', ...' : ''}}`
  }
  return typeof value
}

export async function transformMCPResult(result: unknown, tool: string, name: string): Promise<TransformedMCPResult> {
  const record = result as { toolResult?: unknown; structuredContent?: unknown; content?: unknown } | null
  if (record && 'toolResult' in record && record.toolResult !== undefined) {
    return { type: 'toolResult', content: String(record.toolResult) }
  }
  if (record && record.structuredContent !== undefined) {
    return {
      type: 'structuredContent',
      content: JSON.stringify(record.structuredContent),
      schema: inferCompactSchema(record.structuredContent),
    }
  }
  if (record && Array.isArray(record.content)) {
    const content = await transformResultContent(record.content, name)
    return {
      type: 'contentArray',
      content,
      schema: inferCompactSchema(record.content),
      isImage: content.some(block => (block as { type?: string }).type === 'image'),
    }
  }
  logMCPError(name, `unexpected response format from tool ${tool}`)
  throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    `Unexpected response format from MCP server "${name}" tool "${tool}"`,
    'MCP unexpected response format',
  )
}

export async function processMCPResult(result: unknown, tool: string, name: string): Promise<MCPToolResult> {
  const transformed = await transformMCPResult(result, tool, name)
  // The IDE server's results bypass everything (they do not go to the model directly).
  if (name === IDE_SERVER_NAME) return transformed.content
  if (transformed.content === undefined) return transformed.content
  if (!(await mcpContentNeedsTruncation(transformed.content))) return transformed.content
  if (isEnvDefinedFalsy(process.env.ENABLE_MCP_LARGE_OUTPUT_FILES)) return truncateMcpContent(transformed.content)
  if (transformed.isImage) return truncateMcpContent(transformed.content)
  const serialized = typeof transformed.content === 'string' ? transformed.content : JSON.stringify(transformed.content, null, 2)
  const persisted = await persistToolResult(serialized, persistId(name, tool))
  if ('error' in persisted) {
    return `MCP tool result exceeded the maximum allowed tokens (${serialized.length} characters), and saving it to disk failed: ${persisted.error}. If the server offers pagination or filtering tools, use them.`
  }
  return getLargeOutputInstructions(persisted.filepath, serialized.length, getFormatDescription(transformed.type, transformed.schema))
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

type MCPToolCallResult = { content: MCPToolResult; _meta?: Record<string, unknown>; structuredContent?: unknown }

async function callToolOnce(
  connected: ConnectedMCPServer,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  toolUseId: string | undefined,
  onProgress: ((event: Record<string, unknown>) => void) | undefined,
): Promise<MCPToolCallResult> {
  const startedAt = Date.now()
  const timeoutMs = toolTimeoutMs()
  const idleLimitMs = mcpCallIdleLimitMs()
  const stillRunning = setInterval(() => {
    logMCPDebug(connected.name, `tool ${tool} still running after ${Math.round((Date.now() - startedAt) / 1000)}s`)
  }, LONG_CALL_LOG_INTERVAL_MS)
  stillRunning.unref()
  // The inactivity watchdog: a result or a progress notification is progress;
  // silence past the limit settles the call as a typed error and cancels the
  // request on the wire (the server learns the call was abandoned).
  const watchdog = armInactivityDeadline({
    seam: `MCP tool "${tool}" on server "${connected.name}"`,
    limitMs: idleLimitMs,
    advice: `no result and no progress notification for ${formatLimit(idleLimitMs)} — the call was cancelled; MERCURY_MCP_CALL_IDLE_MINUTES tunes the limit (0 disables)`,
  })
  const requestController = new AbortController()
  const forwardAbort = (): void => requestController.abort()
  if (signal.aborted) requestController.abort()
  else signal.addEventListener('abort', forwardAbort, { once: true })
  watchdog.signal.addEventListener('abort', forwardAbort, { once: true })
  // A progress token rides every call that has a tool-use id, so a progress
  // notification can feed the watchdog even when nobody renders progress.
  const progressToken = toolUseId
  const releaseRoute =
    progressToken !== undefined
      ? routeProgress(connected.client, progressToken, params => {
          watchdog.touch()
          onProgress?.({ status: 'progress', progress: params.progress, total: params.total, progressMessage: params.message })
        })
      : () => {}
  let timer: NodeJS.Timeout | null = null
  try {
    const call = connected.client.request(
      {
        method: 'tools/call',
        params: {
          name: tool,
          arguments: args,
          ...(toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId, ...(progressToken ? { progressToken } : {}) } } : {}),
        },
      },
      CallToolResultSchema,
      { signal: requestController.signal, timeout: timeoutMs },
    )
    const result = await Promise.race([
      call,
      watchdog.expiry,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                `MCP tool "${tool}" on server "${connected.name}" timed out after ${Math.round(timeoutMs / 1000)}s`,
                'MCP tool call timeout',
              ),
            ),
          timeoutMs,
        )
      }),
    ])
    if ((result as { isError?: boolean }).isError) {
      const first = (result.content as Array<{ type?: string; text?: string }> | undefined)?.[0]
      const detail =
        (first?.type === 'text' ? first.text : undefined) ??
        (result as { error?: string }).error ??
        'Unknown error'
      logMCPError(connected.name, `tool ${tool} returned an error: ${detail}`)
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP tool "${tool}" on server "${connected.name}" failed: ${detail}`,
        'MCP tool returned error',
        (result as { _meta?: Record<string, unknown> })._meta,
      )
    }
    const elapsed = Date.now() - startedAt
    const unit = elapsed < 1000 ? `${elapsed}ms` : elapsed < 60_000 ? `${(elapsed / 1000).toFixed(1)}s` : `${Math.floor(elapsed / 60_000)}m${Math.round((elapsed % 60_000) / 1000)}s`
    logMCPDebug(connected.name, `tool ${tool} completed in ${unit}`)
    return {
      content: await processMCPResult(result, tool, connected.name),
      ...((result as { _meta?: Record<string, unknown> })._meta ? { _meta: (result as { _meta?: Record<string, unknown> })._meta } : {}),
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    }
  } catch (err) {
    clearInterval(stillRunning)
    if (watchdog.fired) {
      // The watchdog's own cancel surfaces as an abort on the wire; the truth
      // is the typed deadline, never a silent escape.
      logMCPError(connected.name, `tool ${tool} stalled: ${errorMessage(err)}`)
      throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP tool "${tool}" on server "${connected.name}" stalled: no result and no progress for ${formatLimit(idleLimitMs)} — the call was cancelled (MERCURY_MCP_CALL_IDLE_MINUTES tunes the limit, 0 disables)`,
        'MCP tool call idle deadline',
      )
    }
    if (isAbortError(err) || (err as { name?: string } | null)?.name === 'AbortError') {
      // Escape: not a failure; the tool layer passes the absent content on.
      return { content: undefined }
    }
    const status = (err as { status?: unknown } | null)?.status
    if (status === 401 || err instanceof UnauthorizedError) {
      throw new McpAuthError(connected.name, `MCP server "${connected.name}" requires re-authorization`)
    }
    const configType = connected.config.type
    if (
      isMcpSessionExpiredError(err) ||
      ((isConnectionClosedError(err) || isStaleSocketFetchError(err)) &&
        (configType === 'http' || configType === 'claudeai-proxy'))
    ) {
      await clearServerCache(connected.name, connected.config)
      throw new McpSessionExpiredError(connected.name)
    }
    throw err
  } finally {
    clearInterval(stillRunning)
    if (timer !== null) clearTimeout(timer)
    watchdog.cancel()
    signal.removeEventListener('abort', forwardAbort)
    releaseRoute()
  }
}

type UrlElicitation = { mode: 'url'; url: string; elicitationId: string; message: string }

function parseUrlElicitations(error: unknown): UrlElicitation[] {
  const data = (error as { data?: { elicitations?: unknown[] } } | null)?.data
  const raw = Array.isArray(data?.elicitations) ? data.elicitations : []
  return raw.filter((entry): entry is UrlElicitation => {
    const record = entry as Record<string, unknown> | null
    return (
      record !== null &&
      record.mode === 'url' &&
      typeof record.url === 'string' &&
      typeof record.elicitationId === 'string' &&
      typeof record.message === 'string'
    )
  })
}

export async function callMCPToolWithUrlElicitationRetry(params: {
  client: MCPServerConnection
  tool: string
  args: Record<string, unknown>
  signal: AbortSignal
  parentMessage?: AssistantMessage
  onProgress?: (progress: unknown) => void
  setAppState?: (updater: (prev: unknown) => unknown) => void
  isNonInteractive?: boolean
  handleUrlElicitation?: (elicitation: UrlElicitation) => Promise<'accept' | 'decline' | 'cancel'>
  callFn?: (attemptClient: ConnectedMCPServer, toolUseId: string | undefined, onProgress: ((event: Record<string, unknown>) => void) | undefined) => Promise<MCPToolCallResult>
}): Promise<MCPToolCallResult> {
  const { client, tool, args, signal, parentMessage } = params
  // The tool_use id belongs to THIS call's block, found by NAME — never
  // blindly content[0] (release-hardening audit rank 24): the non-streaming
  // fallback mints one assistant message carrying every content block, so a
  // model that narrates before calling puts a text block at index 0 — the
  // id then resolved undefined, no progressToken was sent, the server could
  // not emit progress at all, and the idle watchdog killed a healthy long
  // call at ten minutes. Two parallel calls land as two tool_use blocks in
  // one message — both shared the first block's id, progress rendered under
  // the wrong row, and the first release deleted the shared route, starving
  // the still-running sibling. Both the wire spelling and the bare tool
  // name are accepted (the model-facing name skips the prefix in
  // single-server shapes).
  const parentContent = parentMessage?.message.content
  let toolUseId: string | undefined
  if (Array.isArray(parentContent)) {
    const wireName = wireSafeMcpToolName(client.name, tool)
    for (const block of parentContent) {
      const b = block as { type?: string; id?: string; name?: string }
      if (b.type === 'tool_use' && (b.name === wireName || b.name === tool)) {
        toolUseId = b.id
        break
      }
    }
  }
  const progressSink = params.onProgress && toolUseId ? (event: Record<string, unknown>) => {
    params.onProgress?.({ toolUseID: toolUseId, data: { type: 'mcp_progress', serverName: client.name, toolName: tool, ...event } })
  } : undefined
  const startedAt = Date.now()
  progressSink?.({ status: 'started' })

  const invoke = async (): Promise<MCPToolCallResult> => {
    let sessionRetried = false
    for (;;) {
      const connected = await ensureConnectedClient(client)
      try {
        return params.callFn
          ? await params.callFn(connected, toolUseId, progressSink)
          : await callToolOnce(connected, tool, args, signal, toolUseId, progressSink)
      } catch (err) {
        if (err instanceof McpSessionExpiredError && !sessionRetried) {
          sessionRetried = true
          continue
        }
        throw err
      }
    }
  }

  const declined = (who: string): MCPToolCallResult => ({
    content: `URL elicitation was ${who}; the tool ${tool} could not complete because it requires the user to open a URL.`,
  })

  try {
    for (let retry = 0; ; retry++) {
      try {
        const result = await invoke()
        progressSink?.({ status: 'completed', elapsedTimeMs: Date.now() - startedAt })
        return result
      } catch (err) {
        if (!(err instanceof McpError && err.code === ErrorCode.UrlElicitationRequired) || retry >= URL_ELICITATION_RETRIES) {
          throw err
        }
        const elicitations = parseUrlElicitations(err)
        if (elicitations.length === 0) {
          logMCPDebug(client.name, `URL elicitation error (${ErrorCode.UrlElicitationRequired}) carried no valid elicitations`)
          throw err
        }
        for (const elicitation of elicitations) {
          const hookAnswer = await runElicitationHooks(client.name, elicitation as never, signal)
          let answer: 'accept' | 'decline' | 'cancel'
          if (hookAnswer !== undefined) {
            if ((hookAnswer as { action?: string }).action !== 'accept') return declined('declined by a hook')
            answer = 'accept'
          } else if (params.isNonInteractive && params.handleUrlElicitation) {
            answer = await params.handleUrlElicitation(elicitation)
          } else if (params.setAppState) {
            answer = await queueUrlElicitation(client.name, elicitation, signal, params.setAppState)
          } else {
            answer = 'cancel'
          }
          const finalAnswer = await runElicitationResultHooks(client.name, { action: answer } as never, signal, 'url', elicitation.elicitationId)
          if ((finalAnswer as { action?: string }).action !== 'accept') return declined('declined by the user')
        }
      }
    }
  } catch (err) {
    progressSink?.({ status: 'failed', elapsedTimeMs: Date.now() - startedAt })
    // Re-wrap so telemetry receives context instead of a bare class name.
    if (!(err instanceof TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)) {
      if (err instanceof McpError && typeof err.code === 'number') {
        throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(err.message, `MCP protocol error ${err.code}`)
      }
      if (err instanceof Error && err.constructor === Error) {
        throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(err.message, err.message.slice(0, 200))
      }
    }
    throw err
  }
}

/** REPL two-phase consent/waiting flow: accept in phase 1 is a no-op (waiting), decline/cancel resolve. */
function queueUrlElicitation(
  serverName: string,
  elicitation: UrlElicitation,
  signal: AbortSignal,
  setAppState: (updater: (prev: unknown) => unknown) => void,
): Promise<'accept' | 'decline' | 'cancel'> {
  if (signal.aborted) return Promise.resolve('cancel')
  return new Promise(resolve => {
    let settled = false
    const finish = (answer: 'accept' | 'decline' | 'cancel'): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(answer)
    }
    const onAbort = (): void => finish('cancel')
    signal.addEventListener('abort', onAbort, { once: true })
    const event = {
      serverName,
      requestId: elicitation.elicitationId,
      elicitationId: elicitation.elicitationId,
      params: { mode: 'url', url: elicitation.url, message: elicitation.message },
      signal,
      respond: (response: { action?: string }) => {
        if (response.action === 'accept') return
        finish(response.action === 'decline' ? 'decline' : 'cancel')
      },
      waitingState: { actionLabel: 'Open the URL, then return here', showCancel: true },
      onWaitingDismiss: (action: 'dismiss' | 'retry' | 'cancel') => finish(action === 'retry' ? 'accept' : 'cancel'),
    }
    setAppState(prev => {
      const state = prev as { elicitation?: { queue?: unknown[] } }
      const queue = state.elicitation?.queue ?? []
      return { ...state, elicitation: { ...(state.elicitation ?? {}), queue: [...queue, event] } }
    })
  })
}

/** Direct IDE RPC: no elicitation retry, no progress sink, no session-expiry loop, no request metadata. */
export async function callIdeRpc(
  toolName: string,
  args: Record<string, unknown>,
  client: ConnectedMCPServer,
): Promise<string | ContentBlockParam[] | undefined> {
  const controller = new AbortController()
  const result = await client.client.request(
    { method: 'tools/call', params: { name: toolName, arguments: args } },
    CallToolResultSchema,
    { signal: controller.signal },
  )
  return processMCPResult(result, toolName, client.name)
}

// ---------------------------------------------------------------------------
// Batched connection, reconnect, prefetch, SDK servers
// ---------------------------------------------------------------------------

type ConnectionReport = { client: MCPServerConnection; tools: Tool[]; commands: Command[]; resources?: ServerResource[] }

async function discoverFor(connection: ConnectedMCPServer, includeResourceTools: boolean): Promise<ConnectionReport> {
  if (connection.config.type === 'claudeai-proxy') markClaudeAiMcpConnected(connection.name)
  const [tools, commands, resources] = await Promise.all([
    fetchToolsForClient(connection),
    fetchCommandsForClient(connection),
    connection.capabilities.resources ? fetchResourcesForClient(connection) : Promise.resolve([] as ServerResource[]),
  ])
  const allTools = includeResourceTools && connection.capabilities.resources
    ? [...tools, ListMcpResourcesTool as unknown as Tool, ReadMcpResourceTool as unknown as Tool]
    : tools
  return { client: connection, tools: allTools, commands, ...(resources.length > 0 ? { resources } : {}) }
}

async function runWithLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  // The first freed slot goes to the next waiting item — never fixed waves.
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++] as T
      await work(item)
    }
  })
  await Promise.all(workers)
}

/** One collider the fence refused: the name, its config, the name that
 *  keeps the prefix, and the reason the roster shows. */
export type McpPrefixCollision = { name: string; config: ScopedMcpServerConfig; winner: string; error: string }

/**
 * Normalized-prefix collision fence (FC-023) — ONE owner for every connect
 * road. Two names differing only outside [A-Za-z0-9_-] fold to ONE
 * mcp__<server>__ prefix: both spawned, both reported connected, the
 * second one's whole namespace silently dropped at the name-dedupe, and a
 * grant written for one name executed by the other. The FIRST name (config
 * precedence order) keeps the prefix; every later collider is refused with
 * a reason naming the collision and the winner, and is never spawned —
 * deterministic and loud, nothing silent. The interactive walk ran this
 * fence inline; the headless batch ran none and accepted the collision
 * silently (FN-015 rank 35) — both now read this one verdict.
 */
export function fenceMcpPrefixCollisions(configs: Record<string, ScopedMcpServerConfig>): {
  survivors: Record<string, ScopedMcpServerConfig>
  collided: McpPrefixCollision[]
} {
  const prefixOwners = new Map<string, string>()
  // Null-prototype: keyed by user-supplied server names ('__proto__'-safe).
  const survivors = Object.create(null) as Record<string, ScopedMcpServerConfig>
  const collided: McpPrefixCollision[] = []
  for (const [name, config] of Object.entries(configs)) {
    const folded = normalizeNameForMCP(name)
    const winner = prefixOwners.get(folded)
    if (winner === undefined) {
      prefixOwners.set(folded, name)
      survivors[name] = config
      continue
    }
    collided.push({
      name,
      config,
      winner,
      error: `its tool prefix collides with '${winner}' (both normalise to mcp__${folded}__) — rename one server; only '${winner}' was connected`,
    })
  }
  return { survivors, collided }
}

export async function getMcpToolsCommandsAndResources(
  onConnectionAttempt: (report: ConnectionReport) => void,
  mcpConfigs?: Record<string, ScopedMcpServerConfig>,
): Promise<void> {
  const configs = mcpConfigs ?? (await getAllMcpConfigs()).servers
  const { survivors, collided } = fenceMcpPrefixCollisions(configs)
  for (const { name, config, error } of collided) {
    onConnectionAttempt({ client: { name, type: 'failed', config, error }, tools: [], commands: [] })
  }
  const local: Array<[string, ScopedMcpServerConfig]> = []
  const remote: Array<[string, ScopedMcpServerConfig]> = []
  for (const [name, config] of Object.entries(survivors)) {
    if (!isMcpCatalogueMember(name)) {
      onConnectionAttempt({ client: { name, type: 'disabled', config }, tools: [], commands: [] })
      continue
    }
    const type = config.type ?? 'stdio'
    if (type === 'stdio' || type === 'sdk') local.push([name, config])
    else remote.push([name, config])
  }
  let resourceToolsAdded = false
  const authTool = (name: string, config: ScopedMcpServerConfig): Tool =>
    createMcpAuthTool(name, config as never) as unknown as Tool
  const connectOne = async ([name, config]: [string, ScopedMcpServerConfig]): Promise<void> => {
    try {
      if (!isMcpCatalogueMember(name)) {
        onConnectionAttempt({ client: { name, type: 'disabled', config }, tools: [], commands: [] })
        return
      }
      const type = config.type
      if (type === 'claudeai-proxy' || type === 'http' || type === 'sse') {
        const warm = await isNeedsAuthWarm(name)
        const discoveredNoToken = (type === 'http' || type === 'sse') && hasMcpDiscoveryButNoToken(name, config)
        if (warm || discoveredNoToken) {
          onConnectionAttempt({ client: { name, type: 'needs-auth', config }, tools: [authTool(name, config)], commands: [] })
          return
        }
      }
      const connection = await connectToServer(name, config)
      if (connection.type !== 'connected') {
        onConnectionAttempt({
          client: connection,
          tools: connection.type === 'needs-auth' ? [authTool(name, config)] : [],
          commands: [],
        })
        return
      }
      const includeResourceTools = !resourceToolsAdded && Boolean(connection.capabilities.resources)
      if (includeResourceTools) resourceToolsAdded = true
      onConnectionAttempt(await discoverFor(connection, includeResourceTools))
    } catch (err) {
      logMCPError(name, err)
      onConnectionAttempt({ client: { name, type: 'failed', config, error: errorMessage(err) }, tools: [], commands: [] })
    }
  }
  await Promise.all([
    runWithLimit(local, getMcpServerConnectionBatchSize(), connectOne),
    runWithLimit(remote, getRemoteConnectionBatchSize(), connectOne),
  ])
}

export async function prefetchAllMcpResources(
  mcpConfigs: Record<string, ScopedMcpServerConfig>,
): Promise<{ clients: MCPServerConnection[]; tools: Tool[]; commands: Command[] }> {
  const clients: MCPServerConnection[] = []
  const tools: Tool[] = []
  const commands: Command[] = []
  if (Object.keys(mcpConfigs).length === 0) return { clients, tools, commands }
  try {
    await getMcpToolsCommandsAndResources(report => {
      clients.push(report.client)
      tools.push(...report.tools)
      commands.push(...report.commands)
    }, mcpConfigs)
  } catch (err) {
    logError(err)
  }
  return { clients, tools, commands }
}

export async function reconnectMcpServerImpl(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<{ client: MCPServerConnection; tools: Tool[]; commands: Command[]; resources?: ServerResource[] }> {
  try {
    // Another process may have replaced tokens; a stale keychain cache would never notice.
    const { clearKeychainCache } = await import('../../utils/secureStorage/index.js')
    clearKeychainCache()
    await clearServerCache(name, config)
    const connection = await connectToServer(name, config)
    if (connection.type !== 'connected') return { client: connection, tools: [], commands: [] }
    return discoverFor(connection, Boolean(connection.capabilities.resources))
  } catch (err) {
    logMCPError(name, err)
    return { client: { name, type: 'failed', config, error: errorMessage(err) }, tools: [], commands: [] }
  }
}

export async function setupSdkMcpClients(
  sdkMcpConfigs: Record<string, McpServerConfig>,
  sendMcpMessage: SendMcpMessageCallback,
): Promise<{ clients: MCPServerConnection[]; tools: Tool[] }> {
  const settled = await Promise.allSettled(
    Object.entries(sdkMcpConfigs).map(async ([name, config]): Promise<{ client: MCPServerConnection; tools: Tool[] }> => {
      try {
        const client = buildSdkClient()
        const transport = new SdkControlClientTransport(name, sendMcpMessage)
        // The one connect deadline covers the SDK control channel too: a
        // host that never answers the handshake settles this row as failed
        // instead of holding the batch open forever.
        let timer: NodeJS.Timeout | null = null
        try {
          await Promise.race([
            client.connect(transport),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                // Reject BEFORE closing — the close cascade must not win
                // the race and rewrite the reason.
                reject(
                  new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                    `MCP server "${name}" (sdk) did not answer in ${deadlineSecondsLabel(connectTimeoutMs())} — retry from /mcp`,
                    'MCP connection timeout',
                  ),
                )
                void transport.close().catch(() => {})
              }, connectTimeoutMs())
            }),
          ])
        } finally {
          if (timer !== null) clearTimeout(timer)
        }
        const connection: ConnectedMCPServer = {
          type: 'connected',
          name,
          client,
          capabilities: client.getServerCapabilities() ?? {},
          config: { ...config, scope: 'dynamic' } as ScopedMcpServerConfig,
          cleanup: async () => {
            await client.close()
          },
        }
        const tools = connection.capabilities.tools ? await fetchToolsForClient(connection) : []
        return { client: connection, tools }
      } catch (err) {
        logMCPError(name, err)
        // Note the asymmetry: the failure path stamps the USER scope.
        return { client: { name, type: 'failed', config: { ...config, scope: 'user' } as ScopedMcpServerConfig, error: errorMessage(err) }, tools: [] }
      }
    }),
  )
  const clients: MCPServerConnection[] = []
  const tools: Tool[] = []
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    clients.push(result.value.client)
    tools.push(...result.value.tools)
  }
  return { clients, tools }
}
