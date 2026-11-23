import type { Transport } from '../mcp-shapes/sdk.js'
import type { JSONRPCMessage } from '../mcp-shapes/sdk.js'
import { startMicrotask } from '../../platform/async/timers.js'

class InProcessTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private peer: InProcessTransport | null = null
  private closed = false

  setPeer(peer: InProcessTransport): void {
    this.peer = peer
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error('InProcessTransport: cannot send on a closed transport')
    }
    const peer = this.peer
    if (peer === null || peer.closed) {
      throw new Error('InProcessTransport: peer transport is closed')
    }
    startMicrotask(() => {
      peer.onmessage?.(message)
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
    const peer = this.peer
    if (peer !== null && !peer.closed) {
      peer.closed = true
      peer.onclose?.()
    }
  }
}

export function createLinkedTransportPair(): [Transport, Transport] {
  const client = new InProcessTransport()
  const server = new InProcessTransport()
  client.setPeer(server)
  server.setPeer(client)
  return [client, server]
}
