import { SSEClientTransport, StreamableHTTPClientTransport, type StdioClientTransport, type Transport } from '../sdk.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getOauthConfig } from '../../../constants/oauth.js'
import { scrubSessionEnvStamps } from '../../../substrate/envStamps.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { getClaudeAIOAuthTokens } from '../../../utils/auth.js'
import { getMCPUserAgent } from '../../../utils/http.js'
import { logMCPDebug, logMCPError } from '../../../utils/log.js'
import { getWebSocketTLSOptions } from '../../../utils/mtls.js'
import { getApiFetch, getProxyFetchOptions, getProxyUrl } from '../../../utils/proxy.js'
import { subprocessEnv } from '../../../utils/subprocessEnv.js'
import { MercuryMcpAuthProvider, wrapFetchWithStepUpDetection } from '../auth.js'
import { mcpStdioCommandRefusal } from '../stdioCommandSafety.js'
import { LazyStdioClientTransport } from '../lazyStdio.js'
import { getMcpServerHeaders } from '../headersHelper.js'
import type { ScopedMcpServerConfig } from '../types.js'
import { getLoggingSafeMcpBaseUrl } from '../utils.js'
import { connectTimeoutMs, mcpStdioMaxMessageBytes } from './limits.js'
import { type FetchLike, wrapFetchWithTimeout, loggedHeadersOf, createAnthropicProxyFetch } from './fetch.js'
import { OwnedStdioClientTransport } from './protocolClient.js'
import { createWsTransport } from './wsTransport.js'

export type RemoteConfig = ScopedMcpServerConfig & { url?: string; headers?: Record<string, string> }

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
    : new OwnedStdioClientTransport(parameters)
}

export async function sseTransportFor(name: string, config: RemoteConfig, provider: MercuryMcpAuthProvider | null): Promise<Transport> {
  const headers = await getMcpServerHeaders(name, config)
  const wrapped = wrapFetchWithTimeout(wrapFetchWithStepUpDetection(getApiFetch() as FetchLike, provider as MercuryMcpAuthProvider))
  return new SSEClientTransport(new URL(config.url as string), {
    authProvider: provider as never,
    fetch: wrapped,
    requestInit: { headers: { 'User-Agent': getMCPUserAgent(), ...headers } },
    eventSourceInit: {
      fetch: async (input, init) => {
        const tokens = await (provider as MercuryMcpAuthProvider).tokens()
        const streamHeaders = new Headers(init?.headers)
        streamHeaders.set('User-Agent', getMCPUserAgent())
        if (tokens?.access_token) streamHeaders.set('Authorization', `Bearer ${tokens.access_token}`)
        for (const [key, value] of Object.entries(headers)) streamHeaders.set(key, value)
        streamHeaders.set('Accept', 'text/event-stream')
        return getApiFetch()(input as string, { ...init, headers: streamHeaders, ...getProxyFetchOptions() })
      },
    },
  })
}

export async function wsTransportFor(name: string, config: RemoteConfig): Promise<Transport> {
  const wsHeaders: Record<string, string> = { 'User-Agent': getMCPUserAgent() }
  Object.assign(wsHeaders, await getMcpServerHeaders(name, config))
  logMCPDebug(name, `WebSocket connection options: ${JSON.stringify({ headers: loggedHeadersOf(wsHeaders), tls: Boolean(getWebSocketTLSOptions()), proxy: Boolean(getProxyUrl()) })}`)
  return await createWsTransport(config.url as string, wsHeaders)
}

export async function httpTransportFor(name: string, config: RemoteConfig, provider: MercuryMcpAuthProvider | null): Promise<Transport> {
  const headers = await getMcpServerHeaders(name, config)
  const wrapped = wrapFetchWithTimeout(wrapFetchWithStepUpDetection(getApiFetch() as FetchLike, provider as MercuryMcpAuthProvider))
  const requestInit = { headers: { 'User-Agent': getMCPUserAgent(), ...headers }, ...getProxyFetchOptions() }
  const proxyUrl = getProxyUrl()
  logMCPDebug(name, `runtime ${typeof Bun !== 'undefined' ? 'bun' : 'node'}, proxy ${proxyUrl === undefined ? 'none' : getLoggingSafeMcpBaseUrl({ type: 'http', url: proxyUrl }) ?? '[REDACTED]'}`)
  logMCPDebug(name, `HTTP request options: ${JSON.stringify({ headers: loggedHeadersOf(requestInit.headers), tls: 'tls' in requestInit, proxy: proxyUrl !== undefined })}`)
  void Boolean(await (provider as MercuryMcpAuthProvider).tokens())
  return new StreamableHTTPClientTransport(new URL(config.url as string), {
    authProvider: provider as never,
    fetch: wrapped,
    requestInit,
  })
}

export function proxyTransportFor(name: string, config: RemoteConfig): Transport {
  const token = getClaudeAIOAuthTokens()?.accessToken
  if (!token) throw new Error(`claude.ai proxy server ${name} requires a claude.ai OAuth token`)
  const oauth = getOauthConfig()
  const url = `${oauth.MCP_PROXY_URL}${oauth.MCP_PROXY_PATH.replace('{server_id}', (config as { id?: string }).id ?? '')}`
  return new StreamableHTTPClientTransport(new URL(url), {
    fetch: wrapFetchWithTimeout(createAnthropicProxyFetch(fetch as FetchLike)),
    requestInit: { headers: { 'User-Agent': getMCPUserAgent(), 'X-Mcp-Client-Session-Id': getSessionId() } },
  })
}

export async function inProcessTransportFor() {
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
  const pid = stdioTransport?.pid ?? null
  if (pid === null) return
  try {
    const { endProcessTree, endProcessTreeSurvivors } = await import('../../../utils/processGroup.js')
    const graceful = await endProcessTree(pid, 'SIGINT')
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
