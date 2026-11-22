import type * as tls from 'node:tls'
import type { Transport, JSONRPCMessage } from '../../../utils/mcp/sdk.js'
import { getWebSocketTLSOptions } from '../../../utils/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../../../utils/proxy.js'
import { notBuilt } from '../../../pi/holes.js'

type WsEvent = 'open' | 'error' | 'close' | 'message'

export async function createWsTransport(url: string, headers: Record<string, string>): Promise<Transport> {
  return notBuilt('src/services/mcp/client/wsTransport.ts:25')
}
