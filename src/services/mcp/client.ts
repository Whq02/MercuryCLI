import { UnauthorizedError, StdioClientTransport, type Transport, type Client, type Resource, ProtocolError, ProtocolErrorCode, SdkError, SdkErrorCode, type Tool as McpSdkTool } from '../../utils/mcp/sdk.js'
import memoize from 'lodash-es/memoize.js'
import { LRUCache } from 'lru-cache'
import { deadlineSecondsLabel } from '../providers/fetchDeadline.js'
import type { Command } from '../../types/command.js'
import type { AssistantMessage } from '../../types/message.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type { PermissionResult } from '../../types/permissions.js'
import type { MCPProgress } from '../../types/tools.js'
import type { AppState } from '../../state/AppState.js'
import type { CanUseToolFn, Tool, ToolCallProgress, ToolUseContext } from '../../Tool.js'
import { MCPTool } from '../../tools/MCPTool/MCPTool.js'
import { classifyMcpToolForCollapse } from '../../tools/MCPTool/classifyForCollapse.js'
import { ListMcpResourcesTool } from '../../tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { createMcpAuthTool } from '../../tools/McpAuthTool/McpAuthTool.js'
import { ReadMcpResourceTool } from '../../tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { restoreRenamedArgumentKeys } from '../../utils/normalizeToolSchema.js'
import { armInactivityDeadline, formatLimit, withDeadline } from '../../utils/deadline.js'
import { errorMessage, getErrnoCode, isAbortError, TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { isShuttingDown } from '../../utils/gracefulShutdown.js'
import { logError, logMCPDebug, logMCPError } from '../../utils/log.js'
import type { MCPToolResult } from './mcpValidation.js'
import { createSecretRedactor, isSecretEnvName } from '../../utils/redactSecrets.js'
import { recursivelySanitizeUnicode } from '../../utils/sanitization.js'
import { forgetHiddenCharacters, recordHiddenCharacters } from '../../utils/text/hiddenCharacterFindings.js'
import { hasMcpDiscoveryButNoToken, MercuryMcpAuthProvider } from './auth.js'
import { markAnthropicConnectorConnected } from './anthropicConnectors.js'
import { clearEraVerdict, readEraVerdict, recordEraVerdict } from './eraVerdictCache.js'
import { getAllMcpConfigs } from './config.js'
import { mcpStdioCommandRefusal } from './stdioCommandSafety.js'
import { isMcpCatalogueMember } from './membership.js'
import { elicitationPausedClock } from './elicitationHandler.js'
import { buildMcpToolName, wireSafeMcpToolName } from '../../utils/mcp/mcpStringUtils.js'
import { normalizeNameForMCP } from '../../utils/mcp/normalization.js'
import { isMercuryServerEnabled, isMercuryServer, withMercuryLeaseHolder } from './mercuryServer.js'
import { withMcpToolCardHeader } from '../../utils/mcp/toolCard.js'
import { mcpPolicyDenyReason, mcpToolAllowed, type McpToolAnnotations } from '../../utils/mcp/toolPolicy.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig, ServerResource } from '../../utils/mcp/types.js'
import { describeMcpConnectFailure, getLoggingSafeMcpBaseUrl, mcpConfigAsWritten, MCP_CONNECT_TIMEOUT_TELEMETRY } from './utils.js'
import { McpAuthError, McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, McpSessionExpiredError, isMcpSessionExpiredError, isConnectionClosedError, isProbeExitError, isStaleSocketFetchError, isResponseStreamEndedError } from './client/errors.js'
import { LONG_CALL_LOG_INTERVAL_MS, MCP_TOOL_USE_ID_META_KEY, STDERR_FLUSH_BYTES, INSTRUCTIONS_MAX_CHARS, TERMINAL_ERROR_LIMIT, URL_ELICITATION_RETRIES, TERMINAL_ERROR_SUBSTRINGS, connectTimeoutMs, toolTimeoutMs, mcpCallIdleLimitMs, OVERSIZED_MESSAGE, oversizedMessages, mcpOversizedMessageWords, getMcpServerConnectionBatchSize, getRemoteConnectionBatchSize } from './client/limits.js'
import { routeProgress } from './client/progress.js'
import { isNeedsAuthWarm, handleRemoteAuthFailure } from './client/needsAuth.js'
import { buildClient, installRootsHandler } from './client/protocolClient.js'
import { type RemoteConfig, buildStdioTransport, sseTransportFor, wsTransportFor, httpTransportFor, proxyTransportFor, inProcessTransportFor, endStdioTree } from './client/transports.js'
import { listAllTools } from './client/toolList.js'
import { transformResultContent, processMCPResult } from './client/results.js'
import { withoutNullOptionals } from './client/nullOptionals.js'
import { type UrlElicitation, parseUrlElicitations, queueUrlElicitation } from './client/urlElicitation.js'
import { runWithLimit, fenceMcpPrefixCollisions } from './client/bulkParts.js'

export { McpAuthError, McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, isMcpSessionExpiredError, isResponseStreamEndedError } from './client/errors.js'
export { MCP_TOOL_USE_ID_META_KEY, MCP_LAUNCH_SPAWN_GRACE_MS, mcpLaunchBudgetMs, withMcpLaunchBudget, DEFAULT_MCP_CALL_IDLE_MINUTES, mcpCallIdleLimitMs, DEFAULT_MCP_STDIO_MESSAGE_MB, mcpStdioMaxMessageBytes, mcpOversizedMessageWords, getMcpServerConnectionBatchSize } from './client/limits.js'
export { mcpRequestBudgetMs, wrapFetchWithTimeout, loggedHeadersOf, createAnthropicProxyFetch } from './client/fetch.js'
export { clearMcpAuthCache, forgetMcpNeedsAuth } from './client/needsAuth.js'
export { onMcpListChanged, withoutNullToolMetadata } from './client/protocolClient.js'
export { transformResultContent, inferCompactSchema, transformMCPResult, processMCPResult } from './client/results.js'
export type { MCPResultType, TransformedMCPResult } from './client/results.js'
export { withoutNullOptionals } from './client/nullOptionals.js'
export { fenceMcpPrefixCollisions } from './client/bulkParts.js'
export type { McpPrefixCollision } from './client/bulkParts.js'
import { tellMcpToolsTheClient } from './client/forTools.js'
import { passedOver } from '../../utils/passedOver.js'
import { startInterval, stopInterval } from '../../utils/timers.js'
import { clearKeychainCache } from '../../utils/secureStorage/index.js'

export function getServerCacheKey(name: string, serverRef: ScopedMcpServerConfig): string {
  return `${name}:${JSON.stringify(serverRef)}`
}


function isTerminalErrorMessage(message: string): boolean {
  return TERMINAL_ERROR_SUBSTRINGS.some(substring => message.includes(substring))
}

export function mcpServerStderrRedactor(config: ScopedMcpServerConfig): (text: string) => string {
  const { headers, env } = config as { headers?: Record<string, unknown>; env?: Record<string, unknown> }
  const known = [
    ...Object.values(headers ?? {}),
    ...Object.entries(env ?? {}).filter(([name]) => isSecretEnvName(name)).map(([, value]) => value),
  ].filter((value): value is string => typeof value === 'string' && value.length >= 8)
  return createSecretRedactor(known)
}

function invalidateServerCaches(name: string, serverRef: ScopedMcpServerConfig): void {
  connectToServer.cache.delete(getServerCacheKey(name, serverRef))
  fetchToolsForClient.cache.delete(name)
  fetchResourcesForClient.cache.delete(name)
  fetchCommandsForClient.cache.delete(name)
  forgetHiddenCharacters('mcp', { group: name })
}

async function attachMediaHostIfConfigured(
  name: string,
  config: ScopedMcpServerConfig,
  signal: AbortSignal,
): Promise<void> {
  if (name !== 'ext:mercury-media:engine') return
  const type = config.type ?? 'stdio'
  if (type !== 'stdio') return
  const remoteId = (config as { env?: Record<string, string> }).env?.MEDIA_REMOTE_ID
  if (!remoteId) return
  const { connectMediaHost } = await import('../media/host.js')
  await connectMediaHost(remoteId, signal)
}

function isStatus401(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const record = error as { status?: unknown; code?: unknown }
  return record.status === 401 || record.code === 401
}

type StderrCollector = {
  attach(stdio: StdioClientTransport): void
  detach(): void
  flush(): void
  firstLine(): string | undefined
  redactedTail(): string
}

function createStderrCollector(name: string, redact: (text: string) => string): StderrCollector {
  let buffered = ''
  let bufferedBytes = 0
  let pendingLine = ''
  let firstNonBlank: string | undefined
  const recentLines: string[] = []
  let activeStream: StdioClientTransport['stderr'] = null

  const recordLine = (raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return
    if (firstNonBlank === undefined) firstNonBlank = trimmed
    recentLines.push(trimmed)
    if (recentLines.length > 64) recentLines.splice(0, recentLines.length - 64)
  }

  const flush = (): void => {
    if (buffered.length === 0) return
    logMCPError(name, `stderr: ${buffered}`)
    buffered = ''
    bufferedBytes = 0
  }

  const onData = (chunk: Buffer | string): void => {
    try {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      buffered += text
      bufferedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength
      if (bufferedBytes >= STDERR_FLUSH_BYTES) {
        flush()
      }
      const combined = pendingLine + text
      const parts = combined.split(/\r?\n/)
      pendingLine = parts.pop() ?? ''
      for (const line of parts) recordLine(line)
    } catch (err) {
      passedOver(err)
    }
  }

  const onError = (err: unknown): void => {
    passedOver(err)
  }

  const detach = (): void => {
    if (activeStream === null) return
    try {
      activeStream.off('data', onData)
      activeStream.off('error', onError)
    } catch (err) {
      passedOver(err)
    }
    activeStream = null
  }

  return {
    attach(stdio: StdioClientTransport): void {
      detach()
      pendingLine = ''
      const stream = stdio.stderr
      if (stream === null || stream === undefined) return
      activeStream = stream
      stream.on('data', onData)
      stream.on('error', onError)
    },
    detach,
    flush,
    firstLine(): string | undefined {
      if (firstNonBlank !== undefined) return firstNonBlank
      const trimmed = pendingLine.trim()
      return trimmed.length > 0 ? trimmed : undefined
    },
    redactedTail(): string {
      const all = pendingLine.trim().length > 0 ? [...recentLines, pendingLine.trim()] : recentLines
      const picked: string[] = []
      const seen = new Set<string>()
      for (let i = all.length - 1; i >= 0 && picked.length < 3; i--) {
        const line = all[i]!
        if (seen.has(line)) continue
        seen.add(line)
        picked.push(line)
      }
      if (picked.length === 0) return ''
      picked.reverse()
      return redact(picked.join(' · ')).slice(0, 300)
    },
  }
}

type PreparedTransport =
  | {
      ready: true
      transport: Transport
      transportLabel: string
      stdioTransport: StdioClientTransport | null
      inProcessServer: { close: () => Promise<void> } | null
    }
  | {
      ready: false
      connection: MCPServerConnection
    }

async function prepareTransportFor(
  name: string,
  serverRef: ScopedMcpServerConfig,
  type: string,
): Promise<PreparedTransport> {
  const config = serverRef as RemoteConfig
  try {
    if (type === 'stdio') {
      if (isMercuryServer(name) && isMercuryServerEnabled()) {
        const { server, clientSide } = await inProcessTransportFor()
        return { ready: true, transport: clientSide, transportLabel: 'in-process', stdioTransport: null, inProcessServer: server }
      }
      const stdio = buildStdioTransport(name, serverRef, config)
      return { ready: true, transport: stdio, transportLabel: 'stdio', stdioTransport: stdio, inProcessServer: null }
    }
    if (type === 'sse') {
      const provider = new MercuryMcpAuthProvider(name, serverRef, undefined, false, undefined, true)
      const transport = await sseTransportFor(name, config, provider)
      return { ready: true, transport, transportLabel: 'sse', stdioTransport: null, inProcessServer: null }
    }
    if (type === 'http') {
      const provider = new MercuryMcpAuthProvider(name, serverRef, undefined, false, undefined, true)
      const transport = await httpTransportFor(name, config, provider)
      return { ready: true, transport, transportLabel: 'http', stdioTransport: null, inProcessServer: null }
    }
    if (type === 'ws') {
      const transport = await wsTransportFor(name, config)
      return { ready: true, transport, transportLabel: 'ws', stdioTransport: null, inProcessServer: null }
    }
    if (type === 'claudeai-proxy') {
      const transport = proxyTransportFor(name, config)
      return { ready: true, transport, transportLabel: 'claudeai-proxy', stdioTransport: null, inProcessServer: null }
    }
    return { ready: false, connection: { name, type: 'failed', config: serverRef, error: `Unsupported MCP server type: ${String(type)}` } }
  } catch (err) {
    logMCPError(name, err)
    return { ready: false, connection: { name, type: 'failed', config: serverRef, error: errorMessage(err) } }
  }
}

function transportErrorSummary(message: string): string {
  if (message.includes('ECONNRESET')) return 'connection reset — the server crashed or restarted'
  if (message.includes('ETIMEDOUT')) return 'timeout — network or unresponsive server'
  if (message.includes('ECONNREFUSED')) return 'connection refused — the server is down'
  if (message.includes('EPIPE')) return 'broken pipe'
  if (message.includes('EHOSTUNREACH')) return 'host unreachable'
  if (message.includes('ESRCH')) return 'no such process — the stdio server terminated'
  if (message.includes('spawn')) return 'spawn failure — check the command and permissions'
  return message
}

function logConnectFailure(
  name: string,
  type: string,
  serverRef: ScopedMcpServerConfig,
  err: unknown,
): void {
  if (type === 'sse') {
    const safeUrl = getLoggingSafeMcpBaseUrl(serverRef) ?? '(url withheld)'
    const stack = err instanceof Error && err.stack ? err.stack : ''
    logMCPError(name, `SSE connect failed: ${safeUrl} ${errorMessage(err)} ${stack}`)
    return
  }
  if (type === 'http') {
    const errnoCode = getErrnoCode(err) ?? 'none'
    logMCPError(name, `HTTP connect failed: ${errorMessage(err)} code=${errnoCode}`)
    return
  }
  if (type === 'claudeai-proxy') {
    logMCPError(name, `proxy connect failed: ${errorMessage(err)}`)
    return
  }
  logMCPError(name, err)
}

function attachClientLifecycleHandlers(
  client: Client,
  name: string,
  serverRef: ScopedMcpServerConfig,
  type: string,
  transportLabel: string,
): void {
  const connectedAt = Date.now()
  const priorOnError = client.onerror
  const priorOnClose = client.onclose
  let errorSeen = false
  let terminalErrorStreak = 0
  let closeRequested = false
  const remoteManaged = type === 'sse' || type === 'http' || type === 'claudeai-proxy'

  client.onerror = (error: Error) => {
    errorSeen = true
    const message = errorMessage(error)
    const oversizedMatch = OVERSIZED_MESSAGE.exec(message)
    if (oversizedMatch) {
      const bytes = Number.parseInt(oversizedMatch[1]!, 10)
      if (Number.isFinite(bytes)) oversizedMessages.set(client, bytes)
    }
    logMCPDebug(name, `transport ${transportLabel} error after ${Date.now() - connectedAt}ms: ${message}`)
    logMCPDebug(name, transportErrorSummary(message))
    if (remoteManaged && !closeRequested) {
      if (message.includes('Maximum reconnection attempts')) {
        closeRequested = true
        void client.close().catch(passedOver)
      } else if (isTerminalErrorMessage(message)) {
        terminalErrorStreak++
        if (terminalErrorStreak >= TERMINAL_ERROR_LIMIT) {
          closeRequested = true
          void client.close().catch(passedOver)
        }
      } else {
        terminalErrorStreak = 0
      }
    }
    priorOnError?.(error)
  }

  client.onclose = () => {
    logMCPDebug(name, `transport ${transportLabel} closed after ${Date.now() - connectedAt}ms (errors: ${errorSeen})`)
    invalidateServerCaches(name, serverRef)
    priorOnClose?.()
  }
}

function buildConnectTimeoutMessage(
  name: string,
  serverRef: ScopedMcpServerConfig,
  transportLabel: string,
  timeoutMs: number,
  stderr: StderrCollector,
  redact: (text: string) => string,
): string {
  const base = `MCP server "${name}" (${transportLabel}) did not answer in ${deadlineSecondsLabel(timeoutMs)} — retry from /mcp`
  if (transportLabel !== 'stdio') return base
  const written = mcpConfigAsWritten(serverRef)
  const spawned = [written.command, ...written.args]
    .filter((word): word is string => typeof word === 'string' && word.length > 0)
    .join(' ')
  const first = stderr.firstLine()
  const detail = first !== undefined ? `stderr began: ${redact(first).slice(0, 200)}` : 'nothing on stderr'
  return `${base} · spawned ${spawned} · ${detail}`
}

async function teardownEndpoints(
  name: string,
  client: Client,
  transport: Transport,
  stdio: StdioClientTransport | null,
  inProcessServer: { close: () => Promise<void> } | null,
  stderr: StderrCollector,
): Promise<void> {
  stderr.detach()
  if (inProcessServer !== null) {
    await inProcessServer.close().catch(passedOver)
  }
  if (stdio !== null) {
    await endStdioTree(name, stdio).catch(passedOver)
  }
  await transport.close().catch(passedOver)
  await client.close().catch(passedOver)
}

export const connectToServer = memoize(
  async (name: string, serverRef: ScopedMcpServerConfig, _stats?: unknown): Promise<MCPServerConnection> => {
    const type = serverRef.type ?? 'stdio'
    const config = serverRef as RemoteConfig
    if (type === 'stdio') {
      const refusal = mcpStdioCommandRefusal(name, config as { type?: string; command?: string; args?: string[] })
      if (refusal !== null) return { name, type: 'failed', config: serverRef, error: refusal }
      try {
        await attachMediaHostIfConfigured(name, serverRef, AbortSignal.timeout(20_000))
      } catch (err) {
        logMCPError(name, err)
        return { name, type: 'failed', config: serverRef, error: errorMessage(err) }
      }
    }

    const prepared = await prepareTransportFor(name, serverRef, type)
    if (!prepared.ready) return prepared.connection

    const { transportLabel, inProcessServer } = prepared
    let transport = prepared.transport
    let activeStdio = prepared.stdioTransport
    const redact = mcpServerStderrRedactor(serverRef)
    const stderr = createStderrCollector(name, redact)

    let spawnRefused = false
    let unregisterSpawnGuard: (() => void) | null = null
    if (activeStdio !== null) {
      if (isShuttingDown()) {
        return { name, type: 'disabled', config: serverRef }
      }
      stderr.attach(activeStdio)
      unregisterSpawnGuard = registerCleanup(async () => {
        spawnRefused = true
        const current = activeStdio
        stderr.detach()
        if (current !== null) await endStdioTree(name, current)
      })
    }

    const serverKey = getServerCacheKey(name, serverRef)
    const negotiate = !serverRef.bundledBootstrap
    const transportKind = type === 'stdio' ? 'stdio' : 'remote'
    let client = buildClient(negotiate, transportKind)
    installRootsHandler(client)

    const prior = negotiate ? await readEraVerdict(serverKey) : undefined
    if (spawnRefused) {
      unregisterSpawnGuard?.()
      unregisterSpawnGuard = null
      return { name, type: 'disabled', config: serverRef }
    }
    const timeoutMs = connectTimeoutMs()
    const startedAt = Date.now()
    let timedOut = false
    const timeoutSentinel = Symbol('connect-timeout')

    const runConnect = async (): Promise<void> => {
      try {
        await client.connect(transport, prior ? { prior, timeout: timeoutMs + 1000 } : { timeout: timeoutMs + 1000 })
      } catch (err) {
        const remainingMs = timeoutMs - (Date.now() - startedAt)
        if (
          !prior &&
          negotiate &&
          activeStdio !== null &&
          !spawnRefused &&
          !timedOut &&
          !isShuttingDown() &&
          remainingMs > 0 &&
          isProbeExitError(err)
        ) {
          logMCPDebug(name, 'the server exited on the revision probe — remembered as an older server; connecting again with the handshake')
          void recordEraVerdict(serverKey, 'legacy')
          stderr.detach()
          const firstStdio = activeStdio
          activeStdio = null
          await endStdioTree(name, firstStdio).catch(passedOver)
          await firstStdio.close().catch(passedOver)
          if (spawnRefused || timedOut || isShuttingDown() || timeoutMs - (Date.now() - startedAt) <= 0) {
            throw err
          }
          const replacement = buildStdioTransport(name, serverRef, config)
          activeStdio = replacement
          transport = replacement
          stderr.attach(replacement)
          client = buildClient(false, 'stdio')
          installRootsHandler(client)
          const retryTimeout = Math.max(1, timeoutMs - (Date.now() - startedAt)) + 1000
          await client.connect(transport, { prior: { kind: 'legacy' }, timeout: retryTimeout })
          return
        }
        throw err
      }
    }

    try {
      await withDeadline(runConnect(), timeoutMs, () => {
        timedOut = true
        throw timeoutSentinel
      })
    } catch (err) {
      unregisterSpawnGuard?.()
      unregisterSpawnGuard = null
      void clearEraVerdict(serverKey)

      if (spawnRefused) {
        await teardownEndpoints(name, client, transport, activeStdio, inProcessServer, stderr)
        return { name, type: 'disabled', config: serverRef }
      }
      if ((type === 'sse' || type === 'http') && err instanceof UnauthorizedError) {
        await teardownEndpoints(name, client, transport, activeStdio, inProcessServer, stderr)
        return handleRemoteAuthFailure(name, serverRef, type === 'sse' ? 'SSE' : 'HTTP')
      }
      if (type === 'claudeai-proxy' && isStatus401(err)) {
        await teardownEndpoints(name, client, transport, activeStdio, inProcessServer, stderr)
        return handleRemoteAuthFailure(name, serverRef, 'claude.ai proxy')
      }

      const isTimeout = err === timeoutSentinel || timedOut || (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout)
      const stderrTail = transportLabel === 'stdio' ? stderr.redactedTail() : undefined
      const timeoutMessage = isTimeout
        ? buildConnectTimeoutMessage(name, serverRef, transportLabel, timeoutMs, stderr, redact)
        : undefined

      await teardownEndpoints(name, client, transport, activeStdio, inProcessServer, stderr)
      stderr.flush()

      if (timeoutMessage !== undefined) {
        logMCPError(name, timeoutMessage)
        throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
          timeoutMessage,
          MCP_CONNECT_TIMEOUT_TELEMETRY,
        )
      }

      logConnectFailure(name, type, serverRef, err)
      if (transportLabel === 'stdio' || type === 'sse' || type === 'http') {
        const written = mcpConfigAsWritten(serverRef)
        const described = describeMcpConnectFailure(err, {
          transport: transportLabel,
          ...(transportLabel === 'stdio' && written.command !== undefined ? { command: written.command } : {}),
          ...(written.url !== undefined ? { url: written.url } : {}),
          ...(stderrTail !== undefined ? { stderrTail } : {}),
        })
        throw new Error(described, { cause: err })
      }
      throw err
    }

    if (spawnRefused) {
      unregisterSpawnGuard?.()
      unregisterSpawnGuard = null
      await teardownEndpoints(name, client, transport, activeStdio, inProcessServer, stderr)
      return { name, type: 'disabled', config: serverRef }
    }

    stderr.flush()
    const era = client.getProtocolEra()
    if (era !== undefined) void recordEraVerdict(serverKey, era)
    const negotiatedVersion = client.getNegotiatedProtocolVersion()
    logMCPDebug(name, `Connected in ${Date.now() - startedAt}ms via ${transportLabel}`)
    logMCPDebug(name, `protocol ${negotiatedVersion ?? 'unknown'} (${era ?? 'unknown'} era)`)

    const capabilities = client.getServerCapabilities() ?? {}
    const rawInfo = client.getServerVersion()
    const serverInfo = rawInfo
      ? {
          name: rawInfo.name,
          version: rawInfo.version,
          ...(rawInfo.title !== undefined ? { title: rawInfo.title } : {}),
        }
      : undefined
    const rawInstructions = client.getInstructions()
    let instructions = rawInstructions
    if (rawInstructions && rawInstructions.length > INSTRUCTIONS_MAX_CHARS) {
      instructions = `${rawInstructions.slice(0, INSTRUCTIONS_MAX_CHARS)}\n\n[instructions truncated]`
      logMCPDebug(name, `instructions truncated ${rawInstructions.length} → ${instructions.length}`)
    }

    client.setRequestHandler('elicitation/create', async () => ({ action: 'cancel' as const }))
    attachClientLifecycleHandlers(client, name, serverRef, type, transportLabel)
    unregisterSpawnGuard?.()
    unregisterSpawnGuard = null

    let cleanedUp = false
    let unregisterCleanup: (() => void) | null = null
    const cleanup = async (): Promise<void> => {
      if (cleanedUp) return
      cleanedUp = true
      unregisterCleanup?.()
      unregisterCleanup = null
      if (inProcessServer !== null) {
        try {
          await inProcessServer.close()
        } catch (err) {
          logMCPError(name, err)
        }
        try {
          await client.close()
        } catch (err) {
          logMCPError(name, err)
        }
        return
      }
      if (activeStdio !== null) {
        stderr.detach()
        try {
          await endStdioTree(name, activeStdio)
        } catch (err) {
          logMCPError(name, err)
        }
      }
      try {
        await client.close()
      } catch (err) {
        logMCPError(name, err)
      }
    }
    unregisterCleanup = registerCleanup(cleanup)

    return {
      name,
      type: 'connected',
      config: serverRef,
      client,
      capabilities,
      ...(serverInfo !== undefined ? { serverInfo } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      cleanup,
    }
  },
  getServerCacheKey,
)

export async function clearServerCache(name: string, serverRef: ScopedMcpServerConfig): Promise<{ cleanupError?: string }> {
  const key = getServerCacheKey(name, serverRef)
  const existing = connectToServer.cache.get(key) as Promise<MCPServerConnection> | undefined
  let cleanupError: string | undefined
  if (existing !== undefined) {
    try {
      const connection = await existing
      if (connection.type === 'connected') {
        await connection.cleanup()
      }
    } catch (err) {
      cleanupError = errorMessage(err)
    }
  }
  invalidateServerCaches(name, serverRef)
  return cleanupError !== undefined ? { cleanupError } : {}
}

export async function ensureConnectedClient(client: MCPServerConnection): Promise<ConnectedMCPServer> {
  const current = await connectToServer(client.name, client.config)
  if (current.type !== 'connected') {
    throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      `MCP server "${client.name}" is not connected`,
      'MCP server not connected',
    )
  }
  return current
}


type ToolWithPermissions = ScopedMcpServerConfig & { toolPermissions?: Record<string, string> }

function buildMcpTool(client: ConnectedMCPServer, sdkTool: McpSdkTool): Tool {
  const wireName = wireSafeMcpToolName(client.name, sdkTool.name)
  const qualifiedName = buildMcpToolName(client.name, sdkTool.name)
  const annotations = sdkTool.annotations as McpToolAnnotations
  const meta = (sdkTool as { _meta?: Record<string, unknown> })._meta
  const rawSearchHint = meta?.['anthropic/searchHint']
  const searchHint =
    typeof rawSearchHint === 'string'
      ? rawSearchHint.replace(/\s+/g, ' ').trim() || undefined
      : undefined
  const alwaysLoad = meta?.['anthropic/alwaysLoad'] === true
  const toolPermissions = (client.config as ToolWithPermissions).toolPermissions
  const ownCeiling =
    toolPermissions !== undefined && Object.hasOwn(toolPermissions, sdkTool.name)
      ? toolPermissions[sdkTool.name]
      : undefined
  const effectiveMaxPermission = ownCeiling || undefined
  const baseDescription =
    client.name === 'ext:mercury-media:engine' && sdkTool.name === 'pipeline_describe'
      ? `${sdkTool.description ?? ''} Without a pipeline, also lists project .pipeline.json files.`
      : (sdkTool.description ?? '')
  const cardDescription = withMcpToolCardHeader(client.name, baseDescription, annotations)
  const title = typeof annotations?.title === 'string' && annotations.title ? annotations.title : sdkTool.name

  return {
    ...MCPTool,
    name: wireName,
    mcpInfo: {
      serverName: client.name,
      toolName: sdkTool.name,
      ...(effectiveMaxPermission ? { effectiveMaxPermission } : {}),
    },
    isMcp: true,
    inputJSONSchema: sdkTool.inputSchema as Tool['inputJSONSchema'],
    ...(searchHint !== undefined ? { searchHint } : {}),
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
    description: async () => cardDescription,
    prompt: async () => cardDescription,
    userFacingName: () => `${client.name} - ${title} (MCP)`,
    isReadOnly: () => annotations?.readOnlyHint === true,
    isConcurrencySafe: () => annotations?.readOnlyHint === true,
    isDestructive: () => annotations?.destructiveHint === true,
    isOpenWorld: () => annotations?.openWorldHint === true,
    isSearchOrReadCommand: () => classifyMcpToolForCollapse(client.name, sdkTool.name),
    async checkPermissions(): Promise<PermissionResult> {
      if (!mcpToolAllowed(client.name, sdkTool.name, annotations)) {
        const reason = mcpPolicyDenyReason(client.name, sdkTool.name, annotations)
        return {
          behavior: 'deny',
          message: reason,
          decisionReason: { type: 'other', reason },
        }
      }
      return {
        behavior: 'passthrough',
        message: `Allow ${qualifiedName}?`,
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: qualifiedName }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      }
    },
    async call(
      args: Record<string, unknown>,
      toolUseContext: ToolUseContext,
      _canUseTool: CanUseToolFn,
      parentMessage: AssistantMessage,
      onProgress?: ToolCallProgress<MCPProgress>,
    ) {
      let callArgs = restoreRenamedArgumentKeys(wireName, (args ?? {}) as Record<string, unknown>)
      let discovery: Array<{ type: 'text'; text: string }> = []
      if (client.name === 'ext:mercury-media:engine' && sdkTool.name.startsWith('pipeline_')) {
        const { mediaPipelineArguments, mediaPipelineDiscoveryContent } = await import('../media/pipeline.js')
        const cwd = getCwd()
        callArgs = mediaPipelineArguments(client.name, sdkTool.name, callArgs, cwd)
        discovery = await mediaPipelineDiscoveryContent(client.name, sdkTool.name, callArgs, cwd)
      }
      const contextHandler = toolUseContext.handleElicitation
      const handleUrlElicitation = contextHandler
        ? async (elicitation: UrlElicitation): Promise<'accept' | 'decline' | 'cancel'> => {
            const response = (await contextHandler(client.name, elicitation, toolUseContext.abortController.signal)) as {
              action?: 'accept' | 'decline' | 'cancel'
            }
            return response?.action ?? 'cancel'
          }
        : undefined
      const invoke = () =>
        callMCPToolWithUrlElicitationRetry({
          client,
          tool: sdkTool.name,
          args: callArgs,
          toolDefinition: sdkTool,
          signal: toolUseContext.abortController.signal,
          parentMessage,
          toolUseId: toolUseContext.toolUseId,
          onProgress,
          setAppState: toolUseContext.setAppState,
          isNonInteractive: toolUseContext.options?.isNonInteractiveSession,
          handleUrlElicitation,
        })
      const result = isMercuryServer(client.name)
        ? await withMercuryLeaseHolder(toolUseContext.agentId, invoke)
        : await invoke()
      if (discovery.length === 0) return { data: result.content }
      const existing: ContentBlockParam[] =
        result.content === undefined
          ? []
          : typeof result.content === 'string'
            ? [{ type: 'text', text: result.content }]
            : Array.isArray(result.content)
              ? result.content
              : [{ type: 'text', text: String(result.content) }]
      return { data: [...existing, ...discovery] }
    },
  } as Tool
}

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
      forgetHiddenCharacters('mcp', { group: client.name })
      for (const sdkTool of raw) recordHiddenCharacters('mcp', `${client.name} · ${sdkTool.name}`, JSON.stringify(sdkTool), { group: client.name })
      const tools = sanitized.map(sdkTool => buildMcpTool(client, sdkTool))
      toolDiscoveryFailures.delete(client.name)
      return tools.filter(tool => {
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
fetchToolsForClientMemo.cache = new LRUCache<string, Promise<Tool[]>>({ max: 20 })

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
      const result = await client.client.request({ method: 'resources/list', params: {} }, { timeout: connectTimeoutMs() })
      return (result.resources ?? []).map(resource => ({ ...resource, server: client.name })) as ServerResource[]
    } catch (err) {
      logMCPError(client.name, err)
      fetchResourcesForClient.cache.delete(client.name)
      return []
    }
  },
  client => client.name,
)
fetchResourcesForClient.cache = new LRUCache<string, Promise<ServerResource[]>>({ max: 20 })

export const fetchCommandsForClient = memoize(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected' || !client.capabilities.prompts) return []
    try {
      const result = (await client.client.request(
        { method: 'prompts/list', params: {} },
        { timeout: connectTimeoutMs() },
      )) as {
        prompts?: Array<{
          name: string
          description?: string
          arguments?: Array<{ name: string }>
        }>
      }
      const prompts = recursivelySanitizeUnicode(result.prompts ?? [])
      return prompts.map((prompt): Command => {
        const argNames = (prompt.arguments ?? []).map(arg => arg.name)
        const normalizedName = `mcp__${normalizeNameForMCP(client.name)}__${normalizeNameForMCP(prompt.name)}`
        return {
          type: 'prompt',
          name: normalizedName,
          description: prompt.description ?? '',
          hasUserSpecifiedDescription: prompt.description !== undefined,
          isEnabled: () => true,
          isHidden: false,
          isMcp: true,
          source: 'mcp',
          contentLength: 0,
          progressMessage: 'running',
          argNames,
          userFacingName: () => `${client.name}:${prompt.name} (MCP)`,
          async getPromptForCommand(args: string): Promise<ContentBlockParam[]> {
            const values = args === '' ? [] : args.split(' ')
            const namedArgs: Record<string, string> = {}
            for (let i = 0; i < argNames.length && i < values.length; i++) {
              namedArgs[argNames[i]!] = values[i]!
            }
            try {
              const connected = await ensureConnectedClient(client)
              const response = (await connected.client.request({
                method: 'prompts/get',
                params: { name: prompt.name, arguments: namedArgs },
              })) as { messages?: Array<{ content?: unknown }> }
              const blocks: ContentBlockParam[] = []
              for (const message of response.messages ?? []) {
                if (message.content === undefined) continue
                const items = Array.isArray(message.content) ? message.content : [message.content]
                blocks.push(...(await transformResultContent(items, client.name)))
              }
              return blocks
            } catch (err) {
              logMCPError(client.name, `prompt ${prompt.name} failed: ${errorMessage(err)}`)
              throw err
            }
          },
        }
      })
    } catch (err) {
      logMCPError(client.name, err)
      fetchCommandsForClient.cache.delete(client.name)
      return []
    }
  },
  client => client.name,
)
fetchCommandsForClient.cache = new LRUCache<string, Promise<Command[]>>({ max: 20 })

type MCPToolCallResult = { content: MCPToolResult; _meta?: Record<string, unknown>; structuredContent?: unknown }
type McpProgressEvent = Omit<MCPProgress, 'type' | 'serverName' | 'toolName'>

function formatCallDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

async function callToolOnce(
  connected: ConnectedMCPServer,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  toolUseId: string | undefined,
  onProgress: ((event: McpProgressEvent) => void) | undefined,
  toolDefinition: McpSdkTool | undefined,
): Promise<MCPToolCallResult> {
  if (signal.aborted) return { content: undefined }

  const startedAt = Date.now()
  const timeoutMs = toolTimeoutMs()
  const idleLimitMs = mcpCallIdleLimitMs()
  const requestController = new AbortController()
  const onCallerAbort = (): void => requestController.abort(signal.reason)
  signal.addEventListener('abort', onCallerAbort, { once: true })

  const pausedClock = elicitationPausedClock(connected.client)
  const watchdog = armInactivityDeadline({
    seam: `MCP tool "${tool}" on server "${connected.name}"`,
    limitMs: idleLimitMs,
    advice: `no result and no progress notification for ${formatLimit(idleLimitMs)} — the call was cancelled; MERCURY_MCP_CALL_IDLE_MINUTES tunes the limit (0 disables)`,
    now: pausedClock.now,
    onExpire: err => requestController.abort(err),
  })

  const unrouteProgress =
    toolUseId !== undefined && toolUseId !== ''
      ? routeProgress(connected.client, toolUseId, params => {
          watchdog.touch()
          onProgress?.({
            status: 'progress',
            progress: params.progress,
            ...(params.total !== undefined ? { total: params.total } : {}),
            ...(params.message !== undefined ? { progressMessage: params.message } : {}),
          })
        })
      : undefined

  const runningLogTimer = startInterval(() => {
    logMCPDebug(connected.name, `tool ${tool} still running after ${Math.round((Date.now() - startedAt) / 1000)}s`)
  }, LONG_CALL_LOG_INTERVAL_MS)
  runningLogTimer.unref?.()

  let mayHaveSent = false
  let responseReceived = false
  try {
    await attachMediaHostIfConfigured(connected.name, connected.config, requestController.signal)
    if (signal.aborted || requestController.signal.aborted) {
      return { content: undefined }
    }
    const cleanedArgs = withoutNullOptionals(args, toolDefinition?.inputSchema)
    const callParams: Parameters<ConnectedMCPServer['client']['callTool']>[0] = {
      name: tool,
      arguments: cleanedArgs,
      ...(toolUseId !== undefined && toolUseId !== ''
        ? { _meta: { [MCP_TOOL_USE_ID_META_KEY]: toolUseId, progressToken: toolUseId } }
        : {}),
    }
    const callOptions: Parameters<ConnectedMCPServer['client']['callTool']>[1] = {
      timeout: timeoutMs,
      signal: requestController.signal,
      ...(toolDefinition !== undefined ? { toolDefinition } : {}),
    }
    mayHaveSent = true
    const rawResult = await watchdog.within(
      withDeadline(
        connected.client.callTool(callParams, callOptions),
        timeoutMs,
        () => {
          requestController.abort()
          throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
            `MCP tool "${tool}" on server "${connected.name}" timed out after ${Math.round(timeoutMs / 1000)}s`,
            'MCP tool call timeout',
          )
        },
        { signal: requestController.signal },
      ),
    )
    responseReceived = true

    const resultRecord = rawResult as {
      content?: unknown
      isError?: boolean
      error?: unknown
      _meta?: Record<string, unknown>
      structuredContent?: unknown
    }
    if (resultRecord.isError) {
      let detail: string | undefined
      if (Array.isArray(resultRecord.content)) {
        const firstText = resultRecord.content.find(
          (block): block is { type: string; text: string } =>
            block !== null &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string',
        )
        if (firstText !== undefined) detail = firstText.text
      }
      if (detail === undefined && resultRecord.error !== undefined && resultRecord.error !== null) {
        detail = typeof resultRecord.error === 'string' ? resultRecord.error : errorMessage(resultRecord.error)
      }
      const errorDetail = detail || 'Unknown error'
      logMCPError(connected.name, `tool ${tool} returned an error: ${errorDetail}`)
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP tool "${tool}" on server "${connected.name}" failed: ${errorDetail}`,
        'MCP tool returned error',
        resultRecord._meta,
      )
    }

    const processedContent = await processMCPResult(rawResult, tool, connected.name)
    logMCPDebug(connected.name, `tool ${tool} completed in ${formatCallDuration(Date.now() - startedAt)}`)
    return {
      content: processedContent,
      ...(resultRecord._meta ? { _meta: resultRecord._meta } : {}),
      ...(resultRecord.structuredContent !== undefined ? { structuredContent: resultRecord.structuredContent } : {}),
    }
  } catch (err) {
    if (responseReceived) throw err
    if (watchdog.fired) {
      requestController.abort()
      logMCPError(connected.name, `tool ${tool} stalled: ${errorMessage(err)}`)
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP tool "${tool}" on server "${connected.name}": unknown outcome; inspect the effect before retrying.`,
        'MCP tool call unknown outcome',
      )
    }
    if (signal.aborted || isAbortError(err)) {
      if (!mayHaveSent) return { content: undefined }
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP tool "${tool}" on server "${connected.name}": interrupted before it answered; if it has side effects, check them before calling again.`,
        'MCP tool call interrupted',
      )
    }
    if (err instanceof UnauthorizedError || isStatus401(err)) {
      throw new McpAuthError(connected.name, `MCP server "${connected.name}" requires re-authorization`)
    }
    if (isMcpSessionExpiredError(err) || (err instanceof SdkError && err.code === SdkErrorCode.NotConnected)) {
      await clearServerCache(connected.name, connected.config)
      throw new McpSessionExpiredError(connected.name)
    }
    if (isConnectionClosedError(err)) {
      invalidateServerCaches(connected.name, connected.config)
      const overLimitBytes = oversizedMessages.get(connected.client)
      if (overLimitBytes !== undefined) {
        oversizedMessages.delete(connected.client)
        logMCPError(connected.name, `tool ${tool}: the server sent one message over ${overLimitBytes} bytes; the connection was dropped`)
        throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
          mcpOversizedMessageWords(tool, connected.name, overLimitBytes),
          'MCP stdio message over the limit',
        )
      }
    }
    if (isResponseStreamEndedError(err)) {
      logMCPError(connected.name, `tool ${tool}: the server closed the response stream before answering`)
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP tool "${tool}" on server "${connected.name}": the server closed the response stream before answering — unknown outcome; inspect the effect before retrying.`,
        'MCP tool call response stream ended',
      )
    }
    if (isStaleSocketFetchError(err)) {
      invalidateServerCaches(connected.name, connected.config)
      if (mayHaveSent) {
        requestController.abort()
        logMCPError(connected.name, `tool ${tool}: the server closed the response stream before answering`)
        throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
          `MCP tool "${tool}" on server "${connected.name}": the server closed the response stream before answering — unknown outcome; inspect the effect before retrying.`,
          'MCP tool call response stream ended',
        )
      }
    }
    if (mayHaveSent && !(err instanceof ProtocolError)) {
      requestController.abort()
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP tool "${tool}" on server "${connected.name}": unknown outcome; inspect the effect before retrying.`,
        'MCP tool call unknown outcome',
      )
    }
    throw err
  } finally {
    stopInterval(runningLogTimer)
    watchdog.cancel()
    pausedClock.release()
    unrouteProgress?.()
    signal.removeEventListener('abort', onCallerAbort)
  }
}

export async function callMCPToolWithUrlElicitationRetry(params: {
  client: MCPServerConnection
  tool: string
  args: Record<string, unknown>
  toolDefinition?: McpSdkTool
  signal: AbortSignal
  parentMessage?: AssistantMessage
  toolUseId?: string
  onProgress?: ToolCallProgress<MCPProgress>
  setAppState?: (updater: (prev: AppState) => AppState) => void
  isNonInteractive?: boolean
  handleUrlElicitation?: (elicitation: UrlElicitation) => Promise<'accept' | 'decline' | 'cancel'>
  callFn?: (attemptClient: ConnectedMCPServer, toolUseId: string | undefined, onProgress: ((event: McpProgressEvent) => void) | undefined) => Promise<MCPToolCallResult>
}): Promise<MCPToolCallResult> {
  const { client, tool, args, signal, parentMessage, toolDefinition } = params
  const parentContent = parentMessage?.message.content
  let toolUseId: string | undefined = params.toolUseId
  if (toolUseId === undefined && Array.isArray(parentContent)) {
    const wireName = wireSafeMcpToolName(client.name, tool)
    for (const block of parentContent) {
      const b = block as { type?: string; id?: string; name?: string }
      if (b.type === 'tool_use' && (b.name === wireName || b.name === tool)) {
        toolUseId = b.id
        break
      }
    }
  }
  const progressSink = params.onProgress && toolUseId ? (event: McpProgressEvent) => {
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
          : await callToolOnce(connected, tool, args, signal, toolUseId, progressSink, toolDefinition)
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
        if (!(err instanceof ProtocolError && err.code === ProtocolErrorCode.UrlElicitationRequired) || retry >= URL_ELICITATION_RETRIES) {
          throw err
        }
        const elicitations = parseUrlElicitations(err)
        if (elicitations.length === 0) {
          logMCPDebug(client.name, `URL elicitation error (${ProtocolErrorCode.UrlElicitationRequired}) carried no valid elicitations`)
          throw err
        }
        for (const elicitation of elicitations) {
          let answer: 'accept' | 'decline' | 'cancel'
          if (params.isNonInteractive && params.handleUrlElicitation) {
            answer = await params.handleUrlElicitation(elicitation)
          } else if (params.setAppState) {
            answer = await queueUrlElicitation(client.name, elicitation, signal, params.setAppState)
          } else {
            answer = 'cancel'
          }
          if (answer !== 'accept') return declined('declined by the user')
        }
      }
    }
  } catch (err) {
    progressSink?.({ status: 'failed', elapsedTimeMs: Date.now() - startedAt })
    if (!(err instanceof TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)) {
      if (err instanceof ProtocolError) {
        throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(err.message, `MCP protocol error ${err.code}`)
      }
      if (err instanceof SdkError) {
        throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(err.message, `MCP client error ${err.code}`)
      }
      if (err instanceof Error && err.constructor === Error) {
        throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(err.message, err.message.slice(0, 200))
      }
    }
    throw err
  }
}

type ConnectionReport = { client: MCPServerConnection; tools: Tool[]; commands: Command[]; resources?: ServerResource[] }

async function discoverFor(connection: ConnectedMCPServer, includeResourceTools: boolean): Promise<ConnectionReport> {
  if (connection.config.type === 'claudeai-proxy') markAnthropicConnectorConnected(connection.name)
  const [tools, commands, resources] = await Promise.all([
    fetchToolsForClient(connection),
    fetchCommandsForClient(connection),
    connection.capabilities.resources ? fetchResourcesForClient(connection) : Promise.resolve([] as ServerResource[]),
  ])
  const allTools = includeResourceTools
    ? [...tools, ...supplementaryToolsForMcpClient(connection)]
    : tools
  return { client: connection, tools: allTools, commands, ...(resources.length > 0 ? { resources } : {}) }
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
    if (type === 'stdio') local.push([name, config])
    else remote.push([name, config])
  }
  let resourceToolsAdded = false
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
          const needsAuth: MCPServerConnection = { name, type: 'needs-auth', config }
          onConnectionAttempt({ client: needsAuth, tools: supplementaryToolsForMcpClient(needsAuth), commands: [] })
          return
        }
      }
      const connection = await connectToServer(name, config)
      if (connection.type !== 'connected') {
        onConnectionAttempt({
          client: connection,
          tools: supplementaryToolsForMcpClient(connection),
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

export function supplementaryToolsForMcpClient(client: MCPServerConnection): Tool[] {
  if (client.type === 'connected' && client.capabilities.resources) {
    return [ListMcpResourcesTool, ReadMcpResourceTool]
  }
  if (client.type === 'needs-auth') {
    return [createMcpAuthTool(client.name, client.config) as Tool]
  }
  return []
}

export function pruneStaleMcpResourceTools(
  clients: readonly MCPServerConnection[],
  tools: Tool[],
): Tool[] {
  if (clients.some(client => client.type === 'connected' && Boolean(client.capabilities.resources))) {
    return tools
  }
  return tools.filter(
    tool => tool.name !== ListMcpResourcesTool.name && tool.name !== ReadMcpResourceTool.name,
  )
}

export async function reconnectMcpServerImpl(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<{ client: MCPServerConnection; tools: Tool[]; commands: Command[]; resources?: ServerResource[] }> {
  try {
    clearKeychainCache()
    await clearServerCache(name, config)
    const connection = await connectToServer(name, config)
    if (connection.type !== 'connected') {
      return {
        client: connection,
        tools: supplementaryToolsForMcpClient(connection),
        commands: [],
      }
    }
    return await discoverFor(connection, Boolean(connection.capabilities.resources))
  } catch (err) {
    logMCPError(name, err)
    return {
      client: { name, type: 'failed', config, error: errorMessage(err) },
      tools: [],
      commands: [],
    }
  }
}

tellMcpToolsTheClient({ ensureConnectedClient, fetchResourcesForClient, reconnectMcpServerImpl })
