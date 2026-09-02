import type { Transport } from './sdk.js'
import type { JSONRPCMessage } from './sdk.js'


class InProcessTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private peer: InProcessTransport | null = null
  private closed = false

  link(peer: InProcessTransport): void {
    this.peer = peer
  }

  async start(): Promise<void> {
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('InProcessTransport: cannot send on a closed transport')
    const target = this.peer
    if (target === null || target.closed) throw new Error('InProcessTransport: peer transport is closed')
    queueMicrotask(() => {
      target.onmessage?.(message)
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
    const target = this.peer
    if (target !== null && !target.closed) {
      target.closed = true
      target.onclose?.()
    }
  }
}

export function createLinkedTransportPair(): [Transport, Transport] {
  const client = new InProcessTransport()
  const server = new InProcessTransport()
  client.link(server)
  server.link(client)
  return [client, server]
}
