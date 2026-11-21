import { UnauthorizedError, StdioClientTransport, type Transport, ProtocolError, ProtocolErrorCode, SdkError, SdkErrorCode, type Tool as McpSdkTool } from '../../utils/mcp/sdk.js'
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

const connectImpl = async (name: string, serverRef: ScopedMcpServerConfig, serverStats?: unknown): Promise<MCPServerConnection> => {
  void serverStats
  const refusal = mcpStdioCommandRefusal(name, serverRef)
  if (refusal !== null) return { name, type: 'failed', config: serverRef, error: refusal }
  const config = serverRef as RemoteConfig
  const type = config.type ?? 'stdio'
  if (name === 'ext:mercury-media:engine' && type === 'stdio') {
    const host = (serverRef as { env?: Record<string, string> }).env?.MEDIA_REMOTE_ID
    if (host) {
      try { await (await import('../media/host.js')).connectMediaHost(host, AbortSignal.timeout(20000)) }
      catch (error) { return { name, type: 'failed', config: serverRef, error: error instanceof Error ? error.message : String(error) } }
    }
  }
  const startedAt = Date.now()
  let transport: Transport
  let inProcessServer: { close: () => Promise<void> } | null = null
  let stdioTransport: StdioClientTransport | null = null
  let releaseSpawnGuard: (() => void) | undefined
  let spawnRefused = false
  let stderrBuffer = ''
  let inProcess = false
  const redactStderr = mcpServerStderrRedactor(serverRef)

  try {
    if (type === 'sse') {
      transport = await sseTransportFor(name, config, new MercuryMcpAuthProvider(name, serverRef, undefined, false))
    } else if (type === 'ws') {
      transport = await wsTransportFor(name, config)
    } else if (type === 'http') {
      transport = await httpTransportFor(name, config, new MercuryMcpAuthProvider(name, serverRef, undefined, false))
    } else if (type === 'claudeai-proxy') {
      transport = proxyTransportFor(name, config)
    } else if ((type === 'stdio' || config.type === undefined) && isMercuryServer(name) && isMercuryServerEnabled()) {
      const { server, clientSide } = await inProcessTransportFor()
      inProcessServer = server
      transport = clientSide
      inProcess = true
    } else if (type === 'stdio') {
      stdioTransport = buildStdioTransport(name, serverRef, config)
      transport = stdioTransport
      releaseSpawnGuard = registerCleanup(async () => {
        spawnRefused = true
        const pid = stdioTransport?.pid ?? null
        if (pid !== null) {
          const { endProcessTree } = await import('../../utils/processGroup.js')
          await endProcessTree(pid, 'SIGKILL').catch(passedOver)
        }
        await stdioTransport?.close().catch(passedOver)
      })
      if (isShuttingDown()) spawnRefused = true
    } else {
      throw new Error(`Unsupported MCP server type: ${String(type)}`)
    }
  } catch (err) {
    logMCPError(name, err)
    return { name, type: 'failed', config: serverRef, error: errorMessage(err) }
  }

  const onStderr = (chunk: Buffer): void => {
    try {
      stderrBuffer += chunk.toString()
      if (stderrBuffer.length > STDERR_FLUSH_BYTES) {
        logMCPError(name, `stderr: ${stderrBuffer}`)
        stderrBuffer = ''
      }
    } catch (error) {
      passedOver(error)
    }
  }
  stdioTransport?.stderr?.on('data', onStderr)

  let client = buildClient(!serverRef.bundledBootstrap, stdioTransport !== null ? 'stdio' : 'remote')
  installRootsHandler(client)
  const eraKey = getServerCacheKey(name, serverRef)
  const prior = await readEraVerdict(eraKey)
  if (spawnRefused) return { name, type: 'disabled', config: serverRef }

  let timedOut = false
  const connectPromise = (async (): Promise<void> => {
    try {
      await client.connect(transport, prior ? { prior } : undefined)
    } catch (err) {
      if (stdioTransport === null || prior || !isProbeExitError(err) || spawnRefused) throw err
      logMCPDebug(name, 'the server exited on the revision probe — remembered as an older server; connecting again with the handshake')
      await recordEraVerdict(eraKey, 'legacy')
      await endStdioTree(name, stdioTransport)
      stdioTransport.stderr?.off('data', onStderr)
      if (spawnRefused) throw err
      stdioTransport = buildStdioTransport(name, serverRef, config)
      transport = stdioTransport
      stdioTransport.stderr?.on('data', onStderr)
      client = buildClient(false)
      installRootsHandler(client)
      if (timedOut || spawnRefused) throw err
      await client.connect(transport)
    }
  })()
  try {
    await withDeadline(connectPromise, connectTimeoutMs(), () => {
      timedOut = true
      const transportLabel = inProcess ? 'in-process' : type
      const written = mcpConfigAsWritten(config)
      const stderrFirstLine = redactStderr(stderrBuffer.trim().split('\n')[0]?.trim() ?? '').slice(0, 200)
      const spawnedTail =
        stdioTransport === null
          ? ''
          : ` · spawned ${[written.command ?? '', ...written.args].join(' ').trim()} · ${stderrFirstLine !== '' ? `stderr began: ${stderrFirstLine}` : 'nothing on stderr'}`
      void endStdioTree(name, stdioTransport).finally(() => {
        void inProcessServer?.close().catch(passedOver)
        void transport.close().catch(passedOver)
      })
      throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP server "${name}" (${transportLabel}) did not answer in ${deadlineSecondsLabel(connectTimeoutMs())} — retry from /mcp${spawnedTail}`,
        MCP_CONNECT_TIMEOUT_TELEMETRY,
      )
    })
    if (stderrBuffer) {
      logMCPError(name, `stderr: ${stderrBuffer}`)
      stderrBuffer = ''
    }
    logMCPDebug(name, `Connected in ${Date.now() - startedAt}ms via ${type}`)
    const era = client.getProtocolEra()
    logMCPDebug(name, `protocol ${client.getNegotiatedProtocolVersion() ?? 'unknown'} (${era ?? 'unknown'} era)`)
    if (era !== undefined) void recordEraVerdict(eraKey, era)
  } catch (err) {
    await clearEraVerdict(eraKey)
    if (spawnRefused) {
      releaseSpawnGuard?.()
      await transport.close().catch(passedOver)
      return { name, type: 'disabled', config: serverRef }
    }
    if (type === 'sse') logMCPError(name, `SSE connect failed: ${getLoggingSafeMcpBaseUrl(config) ?? '(url withheld)'} ${errorMessage(err)} ${(err as Error)?.stack ?? ''}`)
    else if (type === 'http') logMCPError(name, `HTTP connect failed: ${errorMessage(err)} code=${getErrnoCode(err) ?? 'none'}`)
    else if (type === 'claudeai-proxy') logMCPError(name, `proxy connect failed: ${errorMessage(err)}`)
    else logMCPError(name, err)
    const unauthorized = err instanceof UnauthorizedError
    if ((type === 'sse' || type === 'http') && unauthorized) return handleRemoteAuthFailure(name, serverRef, type.toUpperCase())
    if (type === 'claudeai-proxy' && (err as { code?: unknown } | null)?.code === 401) return handleRemoteAuthFailure(name, serverRef, 'claude.ai proxy')
    releaseSpawnGuard?.()
    await endStdioTree(name, stdioTransport)
    await inProcessServer?.close().catch(passedOver)
    await transport.close().catch(passedOver)
    if (stderrBuffer) logMCPError(name, `stderr: ${stderrBuffer}`)
    if (type === 'stdio' || type === 'sse' || type === 'http') {
      const stderrTail = redactStderr(Array.from(new Set(stderrBuffer.trim().split('\n').map(line => line.trim()).filter(line => line !== ''))).slice(-3).join(' · ')).slice(0, 300)
      const written = mcpConfigAsWritten(config)
      throw new Error(
        describeMcpConnectFailure(err, {
          transport: type,
          command: type === 'stdio' ? written.command : undefined,
          url: written.url,
          stderrTail,
        }),
        { cause: err },
      )
    }
    throw err
  }

  const capabilities = client.getServerCapabilities() ?? {}
  const serverInfo = client.getServerVersion()
  let instructions = client.getInstructions()
  if (instructions && instructions.length > INSTRUCTIONS_MAX_CHARS) {
    const original = instructions.length
    instructions = `${instructions.slice(0, INSTRUCTIONS_MAX_CHARS)}\n\n[instructions truncated]`
    logMCPDebug(name, `instructions truncated ${original} → ${instructions.length}`)
  }
  client.setRequestHandler('elicitation/create', async () => ({ action: 'cancel' as const }))

  const originalOnError = client.onerror
  const originalOnClose = client.onclose
  let terminalErrors = 0
  let closing = false
  let sawError = false
  const remote = type === 'sse' || type === 'http' || type === 'claudeai-proxy'
  const closeViaClient = (): void => {
    if (closing) return
    closing = true
    void client.close().catch(passedOver)
  }
  client.onerror = (error: Error) => {
    sawError = true
    const uptime = Date.now() - startedAt
    const message = error.message
    logMCPDebug(name, `transport ${type} error after ${uptime}ms: ${message}`)
    const oversized = OVERSIZED_MESSAGE.exec(message)
    if (oversized !== null) oversizedMessages.set(client, Number(oversized[1]))
    if (message.includes('ECONNRESET')) logMCPDebug(name, 'connection reset — the server crashed or restarted')
    else if (message.includes('ETIMEDOUT')) logMCPDebug(name, 'timeout — network or unresponsive server')
    else if (message.includes('ECONNREFUSED')) logMCPDebug(name, 'connection refused — the server is down')
    else if (message.includes('EPIPE')) logMCPDebug(name, 'broken pipe')
    else if (message.includes('EHOSTUNREACH')) logMCPDebug(name, 'host unreachable')
    else if (message.includes('ESRCH')) logMCPDebug(name, 'no such process — the stdio server terminated')
    else if (message.includes('spawn')) logMCPDebug(name, 'spawn failure — check the command and permissions')
    else logMCPDebug(name, message)
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
    forgetHiddenCharacters('mcp', { group: name })
    originalOnClose?.()
  }

  const cleanup = async (): Promise<void> => {
    unregister()
    if (inProcess) {
      await inProcessServer?.close().catch(err => logMCPError(name, err))
      await client.close().catch(err => logMCPError(name, err))
      return
    }
    if (type === 'stdio' || config.type === undefined) {
      stdioTransport?.stderr?.off('data', onStderr)
      await endStdioTree(name, stdioTransport)
    }
    await client.close().catch(err => logMCPError(name, err))
  }
  releaseSpawnGuard?.()
  const unregister = registerCleanup(cleanup)

  return {
    type: 'connected',
    name,
    client,
    capabilities,
    serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version, ...(serverInfo.title !== undefined ? { title: serverInfo.title } : {}) } : undefined,
    instructions,
    config: serverRef,
    cleanup,
  }
}

export const connectToServer = memoize(connectImpl, getServerCacheKey)

export async function clearServerCache(name: string, serverRef: ScopedMcpServerConfig): Promise<{ cleanupError?: string }> {
  let cleanupError: string | undefined
  const memoized = connectToServer.cache.get(getServerCacheKey(name, serverRef)) as
    | ReturnType<typeof connectToServer>
    | undefined
  if (memoized !== undefined) {
    try {
      const existing = await memoized
      if (existing.type === 'connected') await existing.cleanup()
    } catch (error) {
      passedOver(error)
      cleanupError = error instanceof Error ? error.message : String(error)
    }
  }
  connectToServer.cache.delete(getServerCacheKey(name, serverRef))
  fetchToolsForClient.cache.delete(name)
  fetchResourcesForClient.cache.delete(name)
  fetchCommandsForClient.cache.delete(name)
  forgetHiddenCharacters('mcp', { group: name })
  return cleanupError !== undefined ? { cleanupError } : {}
}

export async function ensureConnectedClient(client: MCPServerConnection): Promise<ConnectedMCPServer> {
  const connection = await connectToServer(client.name, client.config)
  if (connection.type !== 'connected') {
    throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      `MCP server "${client.name}" is not connected`,
      'MCP server not connected',
    )
  }
  return connection
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
  const qualifiedName = buildMcpToolName(serverName, toolName)
  const modelFacingName = wireSafeMcpToolName(serverName, toolName)
  const rawDescription = (sdkTool.description ?? '') + (serverName === 'ext:mercury-media:engine' && toolName === 'pipeline_describe' ? ' Without a pipeline, also lists project .pipeline.json files.' : '')
  const description = withMcpToolCardHeader(serverName, rawDescription, annotations)
  const inputJSONSchema = sdkTool.inputSchema
  const ceilings = (client.config as ToolWithPermissions).toolPermissions
  const effectiveMaxPermission = ceilings !== undefined && Object.hasOwn(ceilings, toolName) ? ceilings[toolName] : undefined
  const displayName = `${serverName} - ${(annotations as { title?: string } | undefined)?.title ?? toolName} (MCP)`

  const tool: Tool = {
    ...MCPTool,
    name: modelFacingName,
    mcpInfo: { serverName, toolName, ...(effectiveMaxPermission ? { effectiveMaxPermission } : {}) },
    isMcp: true,
    searchHint,
    alwaysLoad,
    description: async () => description,
    prompt: async () => description,
    isConcurrencySafe: () => (annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true,
    isReadOnly: () => (annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true,
    isDestructive: () => (annotations as { destructiveHint?: boolean } | undefined)?.destructiveHint === true,
    isOpenWorld: () => (annotations as { openWorldHint?: boolean } | undefined)?.openWorldHint === true,
    isSearchOrReadCommand: () => classifyMcpToolForCollapse(serverName, toolName),
    inputJSONSchema,
    checkPermissions: async (input: Record<string, unknown>): Promise<PermissionResult> => {
      if (!mcpToolAllowed(serverName, toolName, annotations)) {
        const reason = mcpPolicyDenyReason(serverName, toolName, annotations)
        return { behavior: 'deny', message: reason, decisionReason: { type: 'other', reason } }
      }
      const passthrough = {
        behavior: 'passthrough' as const,
        message: `Allow ${qualifiedName}?`,
        suggestions: [
          { type: 'addRules' as const, rules: [{ toolName: qualifiedName }], behavior: 'allow' as const, destination: 'localSettings' as const },
        ],
        updatedInput: input,
      }
      return passthrough
    },
    call: async (
      args: Record<string, unknown>,
      context: ToolUseContext,
      _canUseTool: CanUseToolFn,
      parentMessage: AssistantMessage,
      onProgress?: ToolCallProgress<MCPProgress>,
    ) => {
      const pipeline = serverName === 'ext:mercury-media:engine' && toolName.startsWith('pipeline_') ? await import('../media/pipeline.js') : undefined
      const restored = restoreRenamedArgumentKeys(modelFacingName, args)
      const input = pipeline ? pipeline.mediaPipelineArguments(serverName, toolName, restored, getCwd()) : restored
      const discovery = pipeline ? await pipeline.mediaPipelineDiscoveryContent(serverName, toolName, input, getCwd()) : []
      const invoke = () => callMCPToolWithUrlElicitationRetry({
        client,
        tool: toolName,
        args: input,
        toolDefinition: sdkTool,
        signal: context.abortController.signal,
        parentMessage,
        toolUseId: context.toolUseId,
        onProgress,
        setAppState: context.setAppState,
        isNonInteractive: context.options.isNonInteractiveSession,
        handleUrlElicitation: context.handleElicitation
          ? async elicitation =>
              (await context.handleElicitation!(client.name, elicitation, context.abortController.signal))
                ?.action as 'accept' | 'decline' | 'cancel'
          : undefined,
      })
      const result = await (isMercuryServer(client.name)
        ? withMercuryLeaseHolder(context.agentId, invoke)
        : invoke())
      return { data: discovery.length ? [...(Array.isArray(result.content) ? result.content : typeof result.content === 'string' ? [{ type: 'text' as const, text: result.content }] : []), ...discovery] : result.content }
    },
    userFacingName: () => displayName,
  }
  return tool
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
    if (client.type !== 'connected') return []
    if (!client.capabilities.prompts) return []
    try {
      const result = await client.client.request({ method: 'prompts/list', params: {} }, { timeout: connectTimeoutMs() })
      const prompts = recursivelySanitizeUnicode(result.prompts ?? [])
      return prompts.map((prompt): Command => {
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
          userFacingName: () => `${client.name}:${prompt.name} (MCP)`,
          getPromptForCommand: async (args: string) => {
            const values = args.split(' ')
            const promptArgs: Record<string, string> = {}
            argNames.forEach((argName, index) => {
              if (values[index] !== undefined) promptArgs[argName] = values[index] as string
            })
            try {
              const connected = await ensureConnectedClient(client)
              const response = await connected.client.request({
                method: 'prompts/get',
                params: { name: prompt.name, arguments: promptArgs },
              })
              const blocks: ContentBlockParam[] = []
              for (const message of response.messages ?? []) {
                const content = Array.isArray(message.content) ? message.content : [message.content]
                blocks.push(...(await transformResultContent(content, client.name)))
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

async function callToolOnce(
  connected: ConnectedMCPServer,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  toolUseId: string | undefined,
  onProgress: ((event: McpProgressEvent) => void) | undefined,
  toolDefinition: McpSdkTool | undefined,
): Promise<MCPToolCallResult> {
  const startedAt = Date.now()
  const timeoutMs = toolTimeoutMs()
  const idleLimitMs = mcpCallIdleLimitMs()
  const stillRunning = startInterval(() => {
    logMCPDebug(connected.name, `tool ${tool} still running after ${Math.round((Date.now() - startedAt) / 1000)}s`)
  }, LONG_CALL_LOG_INTERVAL_MS)
  stillRunning.unref()
  const clock = elicitationPausedClock(connected.client)
  const watchdog = armInactivityDeadline({
    seam: `MCP tool "${tool}" on server "${connected.name}"`,
    limitMs: idleLimitMs,
    advice: `no result and no progress notification for ${formatLimit(idleLimitMs)} — the call was cancelled; MERCURY_MCP_CALL_IDLE_MINUTES tunes the limit (0 disables)`,
    now: clock.now,
  })
  const requestController = new AbortController()
  const forwardAbort = (): void => requestController.abort()
  if (signal.aborted) requestController.abort()
  else signal.addEventListener('abort', forwardAbort, { once: true })
  watchdog.signal.addEventListener('abort', forwardAbort, { once: true })
  const progressToken = toolUseId
  const releaseRoute =
    progressToken !== undefined
      ? routeProgress(connected.client, progressToken, params => {
          watchdog.touch()
          onProgress?.({ status: 'progress', progress: params.progress, total: params.total, progressMessage: params.message })
        })
      : () => {}
  let couldHaveExecuted = false
  const unknownOutcome = () => new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    `MCP tool "${tool}" on server "${connected.name}": unknown outcome; inspect the effect before retrying.`,
    'MCP tool call unknown outcome',
  )
  try {
    if (requestController.signal.aborted) return { content: undefined }
    if (connected.name === 'ext:mercury-media:engine' && (connected.config.type ?? 'stdio') === 'stdio') {
      const host = (connected.config as { env?: Record<string, string> }).env?.MEDIA_REMOTE_ID
      if (host) await (await import('../media/host.js')).connectMediaHost(host, requestController.signal)
    }
    couldHaveExecuted = true
    const call = connected.client.callTool(
      {
        name: tool,
        arguments: withoutNullOptionals(args, toolDefinition?.inputSchema),
        ...(toolUseId ? { _meta: { [MCP_TOOL_USE_ID_META_KEY]: toolUseId, ...(progressToken ? { progressToken } : {}) } } : {}),
      },
      { signal: requestController.signal, timeout: timeoutMs, ...(toolDefinition ? { toolDefinition } : {}) },
    )
    const result = await withDeadline(
      watchdog.within(call),
      timeoutMs,
      () => {
        throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
          `MCP tool "${tool}" on server "${connected.name}" timed out after ${Math.round(timeoutMs / 1000)}s`,
          'MCP tool call timeout',
        )
      },
      { signal },
    )
    couldHaveExecuted = false
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
    stopInterval(stillRunning)
    if (watchdog.fired) {
      logMCPError(connected.name, `tool ${tool} stalled: ${errorMessage(err)}`)
      throw unknownOutcome()
    }
    if (signal.aborted || isAbortError(err) || (err as { name?: string } | null)?.name === 'AbortError') {
      if (!couldHaveExecuted) return { content: undefined }
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP tool "${tool}" on server "${connected.name}": interrupted before it answered; if it has side effects, check them before calling again.`,
        'MCP tool call interrupted',
      )
    }
    const status = (err as { status?: unknown } | null)?.status
    if (status === 401 || err instanceof UnauthorizedError) {
      throw new McpAuthError(connected.name, `MCP server "${connected.name}" requires re-authorization`)
    }
    if (isMcpSessionExpiredError(err) || (err instanceof SdkError && err.code === SdkErrorCode.NotConnected)) {
      couldHaveExecuted = false
      await clearServerCache(connected.name, connected.config)
      throw new McpSessionExpiredError(connected.name)
    }
    if (isConnectionClosedError(err) || isStaleSocketFetchError(err)) {
      await clearServerCache(connected.name, connected.config)
    }
    const oversizedLimit = oversizedMessages.get(connected.client)
    if (oversizedLimit !== undefined && isConnectionClosedError(err)) {
      logMCPError(connected.name, `tool ${tool}: the server sent one message over ${oversizedLimit} bytes; the connection was dropped`)
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(mcpOversizedMessageWords(tool, connected.name, oversizedLimit), 'MCP stdio message over the limit')
    }
    if (isResponseStreamEndedError(err) || (couldHaveExecuted && isStaleSocketFetchError(err))) {
      logMCPError(connected.name, `tool ${tool}: the server closed the response stream before answering`)
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP tool "${tool}" on server "${connected.name}": the server closed the response stream before answering — unknown outcome; inspect the effect before retrying.`,
        'MCP tool call response stream ended',
      )
    }
    if (couldHaveExecuted && !(err instanceof ProtocolError)) {
      requestController.abort()
      throw unknownOutcome()
    }
    throw err
  } finally {
    stopInterval(stillRunning)
    watchdog.cancel()
    clock.release()
    signal.removeEventListener('abort', forwardAbort)
    releaseRoute()
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

const MCP_RESOURCE_TOOL_NAMES = new Set([ListMcpResourcesTool.name, ReadMcpResourceTool.name])

export function supplementaryToolsForMcpClient(client: MCPServerConnection): Tool[] {
  if (client.type === 'connected') {
    return client.capabilities.resources ? [ListMcpResourcesTool, ReadMcpResourceTool] : []
  }
  if (client.type === 'needs-auth') {
    return [createMcpAuthTool(client.name, client.config)]
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
  return tools.filter(tool => !MCP_RESOURCE_TOOL_NAMES.has(tool.name))
}

export async function reconnectMcpServerImpl(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<{ client: MCPServerConnection; tools: Tool[]; commands: Command[]; resources?: ServerResource[] }> {
  try {
    const { clearKeychainCache } = await import('../../utils/secureStorage/index.js')
    clearKeychainCache()
    await clearServerCache(name, config)
    const connection = await connectToServer(name, config)
    if (connection.type !== 'connected') return { client: connection, tools: supplementaryToolsForMcpClient(connection), commands: [] }
    return discoverFor(connection, Boolean(connection.capabilities.resources))
  } catch (err) {
    logMCPError(name, err)
    return { client: { name, type: 'failed', config, error: errorMessage(err) }, tools: [], commands: [] }
  }
}

tellMcpToolsTheClient({ ensureConnectedClient, fetchResourcesForClient, reconnectMcpServerImpl })
