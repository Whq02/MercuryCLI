import { SSEClientTransport, StreamableHTTPClientTransport, type StdioClientTransport, type Transport } from '../../../utils/mcp/sdk.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getOauthConfig } from '../../../constants/oauth.js'
import { scrubSessionEnvStamps } from '../../../substrate/envStamps.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { getClaudeAIOAuthTokens } from '../../../utils/auth.js'
import { getMCPUserAgent } from '../../../utils/http.js'
import { logMCPDebug, logMCPError } from '../../../utils/log.js'
import { getWebSocketTLSOptions } from '../../../utils/mtls.js'
import { getApiFetch, getProxyFetchOptions, getProxyUrl } from '../../../utils/proxy.js'
import { missingSpawnCommandError } from '../../../utils/platform/programs.js'
import { subprocessEnv } from '../../../utils/subprocessEnv.js'
import { MercuryMcpAuthProvider, wrapFetchWithStepUpDetection } from '../auth.js'
import { mcpStdioCommandRefusal } from '../stdioCommandSafety.js'
import { LazyStdioClientTransport } from '../lazyStdio.js'
import { getMcpServerHeaders } from '../headersHelper.js'
import type { ScopedMcpServerConfig } from '../../../utils/mcp/types.js'
import { getLoggingSafeMcpBaseUrl } from '../utils.js'
import { connectTimeoutMs, mcpStdioMaxMessageBytes } from './limits.js'
import { type FetchLike, wrapFetchWithTimeout, loggedHeadersOf, createAnthropicProxyFetch } from './fetch.js'
import { OwnedStdioClientTransport } from './protocolClient.js'
import { createWsTransport } from './wsTransport.js'

export type RemoteConfig = ScopedMcpServerConfig & { url?: string; headers?: Record<string, string> }

class CheckedStdioClientTransport extends OwnedStdioClientTransport {
  private readonly spawnCommand: string
  private readonly spawnEnv: Record<string, string> | undefined
  private readonly spawnCwd: string | undefined

  constructor(parameters: ConstructorParameters<typeof OwnedStdioClientTransport>[0]) {
    super(parameters)
    this.spawnCommand = parameters.command
    this.spawnEnv = parameters.env
    this.spawnCwd = parameters.cwd
  }

  override async start(): Promise<void> {
    const missing = missingSpawnCommandError(this.spawnCommand, this.spawnEnv, this.spawnCwd)
    if (missing !== null) throw missing
    return super.start()
  }
}

export function buildStdioTransport(name: string, serverRef: ScopedMcpServerConfig, config: RemoteConfig): StdioClientTransport {
  const stdioConfig = config as { command: string; args?: string[]; env?: Record<string, string> }
  const prefix = flagEnv('MERCURY_SHELL_PREFIX')
  const command = prefix ? prefix : stdioConfig.command
  const args = prefix ? [[stdioConfig.command, ...(stdioConfig.args ?? [])].join(' ')] : (stdioConfig.args ?? [])
  const refusal = mcpStdioCommandRefusal(name, { command, args })
  if (refusal !== null) throw new Error(refusal)
  const parameters = {
    command,
    args,
    env: { ...(scrubSessionEnvStamps(subprocessEnv({ stripProviderCredentials: true })).env as Record<string, string>), ...(stdioConfig.env ?? {}) },
    stderr: 'pipe' as const,
    maxBufferSize: mcpStdioMaxMessageBytes(),
  }
  return serverRef.bundledBootstrap
    ? new LazyStdioClientTransport(parameters, serverRef.bundledBootstrap, connectTimeoutMs())
    : new CheckedStdioClientTransport(parameters)
}

export async function sseTransportFor(name: string, config: RemoteConfig, provider: MercuryMcpAuthProvider): Promise<Transport> {
  const serverHeaders = await getMcpServerHeaders(name, config)
  const wrappedFetch = wrapFetchWithTimeout(wrapFetchWithStepUpDetection(getApiFetch(), provider))
  const headers: Record<string, string> = { 'User-Agent': getMCPUserAgent(), ...serverHeaders }
  const proxyOptions = getProxyFetchOptions()
  const eventSourceFetch: FetchLike = async (input, init) => {
    const tokens = await provider.tokens()
    const mergedHeaders = new Headers(init?.headers)
    mergedHeaders.set('User-Agent', getMCPUserAgent())
    if (tokens?.access_token) {
      mergedHeaders.set('Authorization', `Bearer ${tokens.access_token}`)
    }
    for (const [key, value] of Object.entries(serverHeaders)) {
      mergedHeaders.set(key, value)
    }
    mergedHeaders.set('Accept', 'text/event-stream')
    return getApiFetch()(input, { ...init, headers: mergedHeaders, ...proxyOptions } as RequestInit)
  }
  return new SSEClientTransport(new URL(config.url!), {
    authProvider: provider,
    fetch: wrappedFetch,
    requestInit: { headers },
    eventSourceInit: { fetch: eventSourceFetch },
  })
}

export async function wsTransportFor(name: string, config: RemoteConfig): Promise<Transport> {
  const serverHeaders = await getMcpServerHeaders(name, config)
  const headers: Record<string, string> = { 'User-Agent': getMCPUserAgent(), ...serverHeaders }
  logMCPDebug(
    name,
    `WebSocket connection options: ${JSON.stringify({
      headers: loggedHeadersOf(headers),
      tls: Boolean(getWebSocketTLSOptions()),
      proxy: Boolean(getProxyUrl()),
    })}`,
  )
  return createWsTransport(config.url!, headers)
}

export async function httpTransportFor(name: string, config: RemoteConfig, provider: MercuryMcpAuthProvider): Promise<Transport> {
  const serverHeaders = await getMcpServerHeaders(name, config)
  const apiFetch = getApiFetch()
  const wrappedFetch = wrapFetchWithTimeout(wrapFetchWithStepUpDetection(apiFetch, provider))
  const headers: Record<string, string> = { 'User-Agent': getMCPUserAgent(), ...serverHeaders }
  const proxyOptions = getProxyFetchOptions()
  const requestInit = { headers, ...proxyOptions } as RequestInit
  const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 'bun' : 'node'
  const proxyUrl = getProxyUrl()
  const safeProxy = proxyUrl !== undefined ? (getLoggingSafeMcpBaseUrl({ type: 'http', url: proxyUrl }) ?? '[REDACTED]') : 'none'
  logMCPDebug(name, `runtime ${runtime}, proxy ${safeProxy}`)
  logMCPDebug(
    name,
    `HTTP request options: ${JSON.stringify({
      headers: loggedHeadersOf(headers),
      tls: proxyOptions.tls !== undefined,
      proxy: Boolean(proxyUrl),
    })}`,
  )
  await provider.tokens()
  return new StreamableHTTPClientTransport(new URL(config.url!), {
    authProvider: provider,
    fetch: wrappedFetch,
    requestInit,
  })
}

export function proxyTransportFor(name: string, config: RemoteConfig): Transport {
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    throw new Error(`claude.ai proxy server ${name} requires a claude.ai OAuth token`)
  }
  const oauth = getOauthConfig()
  const serverId = (config as { id?: string }).id ?? ''
  const path = oauth.MCP_PROXY_PATH.replace('{server_id}', serverId)
  const wrappedFetch = wrapFetchWithTimeout(createAnthropicProxyFetch(fetch))
  const headers: Record<string, string> = {
    'User-Agent': getMCPUserAgent(),
    'X-Mcp-Client-Session-Id': getSessionId(),
  }
  return new StreamableHTTPClientTransport(new URL(`${oauth.MCP_PROXY_URL}${path}`), {
    fetch: wrappedFetch,
    requestInit: { headers },
  })
}

export async function inProcessTransportFor(): Promise<{
  server: { connect: (transport: Transport) => Promise<void>; close: () => Promise<void> }
  clientSide: Transport
}> {
  const [{ createMercuryServer }, { createLinkedTransportPair }] = await Promise.all([
    import('../mercuryServer.js'),
    import('../InProcessTransport.js'),
  ])
  const server = await createMercuryServer()
  const [clientSide, serverSide] = createLinkedTransportPair()
  await server.connect(serverSide)
  return { server, clientSide }
}

export async function endStdioTree(name: string, stdioTransport: StdioClientTransport | null): Promise<void> {
  const pid = stdioTransport?.pid
  if (pid === null || pid === undefined) return
  try {
    const { endProcessTree, endProcessTreeSurvivors } = await import('../../../utils/processGroup.js')
    const first = await endProcessTree(pid, 'SIGINT')
    let ended = first.ended
    let survivors = first.survivors
    if (survivors.length > 0) {
      const second = await endProcessTreeSurvivors(pid, survivors, 'SIGKILL')
      ended += second.ended
      survivors = second.survivors
    }
    if (survivors.length > 0) {
      logMCPDebug(name, `process tree still present after kill (${survivors.length} pid(s) unconfirmed)`)
    } else {
      logMCPDebug(name, `process tree exited (${ended} process(es) ended)`)
    }
  } catch (err) {
    logMCPError(name, err)
  }
}
