import type { Transport } from './sdk.js'
import type { JSONRPCMessage } from './sdk.js'


export type SendMcpMessageCallback = (serverName: string, message: JSONRPCMessage) => Promise<JSONRPCMessage>

export class SdkControlClientTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private closed = false

  constructor(
    private readonly serverName: string,
    private readonly sendMcpMessage: SendMcpMessageCallback,
  ) {}

  async start(): Promise<void> {
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('SdkControlClientTransport: transport is closed')
    const response = await this.sendMcpMessage(this.serverName, message)
    this.onmessage?.(response)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
}

export class SdkControlServerTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private closed = false

  constructor(private readonly sendMcpMessage: (message: JSONRPCMessage) => void) {}

  async start(): Promise<void> {
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('SdkControlServerTransport: transport is closed')
    this.sendMcpMessage(message)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
}
