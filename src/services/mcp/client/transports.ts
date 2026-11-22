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
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

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
  return notBuilt('src/services/mcp/client/transports.ts:64')
}

export async function wsTransportFor(name: string, config: RemoteConfig): Promise<Transport> {
  return notBuilt('src/services/mcp/client/transports.ts:85')
}

export async function httpTransportFor(name: string, config: RemoteConfig, provider: MercuryMcpAuthProvider): Promise<Transport> {
  return notBuilt('src/services/mcp/client/transports.ts:92')
}

export function proxyTransportFor(name: string, config: RemoteConfig): Transport {
  return notBuilt('src/services/mcp/client/transports.ts:107')
}

export async function inProcessTransportFor(): Promise<Unbuilt> {
  return notBuilt('src/services/mcp/client/transports.ts:118')
}

export async function endStdioTree(name: string, stdioTransport: StdioClientTransport | null): Promise<void> {
  return notBuilt('src/services/mcp/client/transports.ts:129')
}
