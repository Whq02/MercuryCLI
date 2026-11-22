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
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

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

export const connectToServer: Unbuilt = unbuilt('src/services/mcp/client.ts:334')

export async function clearServerCache(name: string, serverRef: ScopedMcpServerConfig): Promise<{ cleanupError?: string }> {
  return notBuilt('src/services/mcp/client.ts:336')
}

export async function ensureConnectedClient(client: MCPServerConnection): Promise<ConnectedMCPServer> {
  return notBuilt('src/services/mcp/client.ts:358')
}


type ToolWithPermissions = ScopedMcpServerConfig & { toolPermissions?: Record<string, string> }

function buildMcpTool(client: ConnectedMCPServer, sdkTool: McpSdkTool): Tool {
  return notBuilt('src/services/mcp/client.ts:372')
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

export const fetchResourcesForClient: Unbuilt = unbuilt('src/services/mcp/client.ts:510')
fetchResourcesForClient.cache = new LRUCache<string, Promise<ServerResource[]>>({ max: 20 })

export const fetchCommandsForClient: Unbuilt = unbuilt('src/services/mcp/client.ts:527')
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
  return notBuilt('src/services/mcp/client.ts:588')
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
  return notBuilt('src/services/mcp/client.ts:903')
}

export function supplementaryToolsForMcpClient(client: MCPServerConnection): Tool[] {
  return notBuilt('src/services/mcp/client.ts:924')
}

export function pruneStaleMcpResourceTools(
  clients: readonly MCPServerConnection[],
  tools: Tool[],
): Tool[] {
  return notBuilt('src/services/mcp/client.ts:934')
}

export async function reconnectMcpServerImpl(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<{ client: MCPServerConnection; tools: Tool[]; commands: Command[]; resources?: ServerResource[] }> {
  return notBuilt('src/services/mcp/client.ts:944')
}

tellMcpToolsTheClient({ ensureConnectedClient, fetchResourcesForClient, reconnectMcpServerImpl })
