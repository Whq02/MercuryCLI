import type * as tls from 'node:tls'
import type { Transport, JSONRPCMessage } from '../../mcp-shapes/sdk.js'
import { getWebSocketTLSOptions } from '../../../platform/network/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../../../platform/network/proxy.js'

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
  const raw =
    payload && typeof payload === 'object'
      ? ((payload as { data?: unknown }).data ?? payload)
      : payload
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.filter((chunk): chunk is Buffer => Buffer.isBuffer(chunk))).toString('utf8')
  }
  return String(raw)
}

async function openWs(url: string, headers: Record<string, string>): Promise<WsLike> {
  const tlsOptions: tls.SecureContextOptions | undefined = getWebSocketTLSOptions()
  if (typeof Bun !== 'undefined') {
    const proxyUrl = getWebSocketProxyUrl(url)
    const options: {
      protocols: string[]
      headers: Record<string, string>
      tls?: tls.SecureContextOptions
      proxy?: string
    } = {
      protocols: ['mcp'],
      headers,
      ...(tlsOptions ? { tls: tlsOptions } : {}),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    }
    const ws: WsLike = Reflect.construct(WebSocket, [url, options])
    return ws
  }
  const proxyAgent = getWebSocketProxyAgent(url)
  const { default: NodeWebSocket } = await import('ws')
  return new NodeWebSocket(url, 'mcp', {
    headers,
    ...(tlsOptions ?? {}),
    ...(proxyAgent ? { agent: proxyAgent } : {}),
  })
}

export async function createWsTransport(url: string, headers: Record<string, string>): Promise<Transport> {
  const ws = await openWs(url, headers)

  const transport: Transport = {
    start(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const settleResolve = (): void => {
          if (settled) return
          settled = true
          resolve()
        }
        const settleReject = (error: Error): void => {
          if (settled) return
          settled = true
          reject(error)
        }

        listen(ws, 'open', () => {
          settleResolve()
        })
        listen(ws, 'error', payload => {
          const error = toWsError(payload)
          transport.onerror?.(error)
          settleReject(error)
        })
        listen(ws, 'close', () => {
          transport.onclose?.()
        })
        listen(ws, 'message', payload => {
          try {
            const parsed = JSON.parse(messageText(payload)) as JSONRPCMessage
            transport.onmessage?.(parsed)
          } catch (error) {
            transport.onerror?.(error instanceof Error ? error : new Error(String(error)))
          }
        })

        if (ws.readyState === 1) {
          settleResolve()
        }
      })
    },
    async send(message: JSONRPCMessage): Promise<void> {
      ws.send(JSON.stringify(message))
    },
    async close(): Promise<void> {
      ws.close()
    },
  }

  return transport
}
