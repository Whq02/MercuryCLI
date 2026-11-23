import type * as tls from 'node:tls'
import type { Transport, JSONRPCMessage } from '../../../utils/mcp/sdk.js'
import { getWebSocketTLSOptions } from '../../../utils/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../../../utils/proxy.js'

type WsEvent = 'open' | 'error' | 'close' | 'message'

type WsLike = {
  readyState: number
  send(data: string): void
  close(): void
  on?: (event: WsEvent, listener: (payload?: unknown) => void) => void
  addEventListener?: (event: WsEvent, listener: (payload?: unknown) => void) => void
}

function listen(socket: WsLike, event: WsEvent, listener: (payload?: unknown) => void): void {
  if (typeof socket.on === 'function') socket.on(event, listener)
  else socket.addEventListener?.(event, listener)
}

function toWsError(payload: unknown): Error {
  if (payload instanceof Error) return payload
  if (payload && typeof payload === 'object') {
    const inner = (payload as { error?: unknown }).error
    if (inner instanceof Error) return inner
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return new Error(message)
  }
  return new Error(typeof payload === 'string' && payload.length > 0 ? payload : 'WebSocket error')
}

function messageText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (Buffer.isBuffer(payload)) return payload.toString('utf8')
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString('utf8')
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8')
  if (Array.isArray(payload)) {
    return Buffer.concat(payload.filter((chunk): chunk is Buffer => Buffer.isBuffer(chunk))).toString('utf8')
  }
  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data
    if (data !== undefined) return messageText(data)
  }
  return String(payload)
}

async function openWs(url: string, headers: Record<string, string>): Promise<WsLike> {
  const tlsOptions: tls.SecureContextOptions | undefined = getWebSocketTLSOptions()
  if (typeof Bun !== 'undefined') {
    const proxyUrl = getWebSocketProxyUrl(url)
    const options: {
      headers: Record<string, string>
      tls?: tls.SecureContextOptions
      proxy?: string
    } = {
      headers,
      ...(tlsOptions ? { tls: tlsOptions } : {}),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    }
    const ws: WsLike = Reflect.construct(WebSocket, [url, options])
    return ws
  }
  const proxyAgent = getWebSocketProxyAgent(url)
  const { default: NodeWebSocket } = await import('ws')
  return new NodeWebSocket(url, {
    headers,
    ...(tlsOptions ?? {}),
    ...(proxyAgent ? { agent: proxyAgent } : {}),
  })
}

export async function createWsTransport(url: string, headers: Record<string, string>): Promise<Transport> {
  let socket: WsLike | null = null
  let closed = false

  const transport: Transport = {
    async start(): Promise<void> {
      if (socket !== null) return
      closed = false
      const ws = await openWs(url, headers)
      socket = ws
      await new Promise<void>((resolve, reject) => {
        let settled = false
        listen(ws, 'open', () => {
          if (settled) return
          settled = true
          resolve()
        })
        listen(ws, 'error', payload => {
          const error = toWsError(payload)
          if (!settled) {
            settled = true
            reject(error)
            return
          }
          transport.onerror?.(error)
        })
        listen(ws, 'close', () => {
          if (socket === ws) socket = null
          if (!settled) {
            settled = true
            reject(new Error('WebSocket closed before open'))
          }
          if (!closed) {
            closed = true
            transport.onclose?.()
          }
        })
        listen(ws, 'message', payload => {
          try {
            const parsed = JSON.parse(messageText(payload)) as JSONRPCMessage
            transport.onmessage?.(parsed)
          } catch (error) {
            transport.onerror?.(error instanceof Error ? error : new Error(String(error)))
          }
        })
      })
    },
    async send(message: JSONRPCMessage): Promise<void> {
      if (socket === null || socket.readyState !== 1) {
        throw new Error('WebSocket is not connected')
      }
      socket.send(JSON.stringify(message))
    },
    async close(): Promise<void> {
      const current = socket
      socket = null
      if (current !== null && current.readyState !== 3) {
        current.close()
      }
      if (!closed) {
        closed = true
        transport.onclose?.()
      }
    },
  }

  return transport
}
