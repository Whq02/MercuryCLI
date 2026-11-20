import type * as tls from 'node:tls'
import type { Transport, JSONRPCMessage } from '../sdk.js'
import { getWebSocketTLSOptions } from '../../../utils/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../../../utils/proxy.js'

type WsEvent = 'open' | 'error' | 'close' | 'message'

type WsSocketLike = {
  send(data: string): void
  close(): void
  readyState?: number
  addEventListener?(event: WsEvent, handler: (event: unknown) => void): void
  on?(event: WsEvent, handler: (payload: unknown) => void): void
}

type BunWebSocketOptions = {
  protocols?: string[]
  headers?: Record<string, string>
  tls?: tls.ConnectionOptions
  proxy?: string
}

type BunWebSocketConstructor = new (url: string | URL, options?: string | string[] | BunWebSocketOptions) => WebSocket

export async function createWsTransport(url: string, headers: Record<string, string>): Promise<Transport> {
  const tlsOptions = getWebSocketTLSOptions()
  let socket: WsSocketLike
  if (typeof Bun !== 'undefined') {
    const proxyUrl = getWebSocketProxyUrl(url)
    const BunWebSocket = WebSocket as BunWebSocketConstructor
    socket = new BunWebSocket(url, {
      protocols: ['mcp'],
      headers,
      ...(tlsOptions ? { tls: tlsOptions } : {}),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    })
  } else {
    const proxyAgent = getWebSocketProxyAgent(url)
    const nodeOptions = { headers, ...(tlsOptions ?? {}), ...(proxyAgent ? { agent: proxyAgent } : {}) }
    const { default: NodeWebSocket } = await import('ws')
    socket = new NodeWebSocket(url, ['mcp'], nodeOptions as never)
  }
  const listen = (event: WsEvent, handler: (payload: unknown) => void): void => {
    if (typeof socket.on === 'function') socket.on(event, handler)
    else socket.addEventListener?.(event, handler)
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
        if (socket.readyState === 1) resolve()
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
