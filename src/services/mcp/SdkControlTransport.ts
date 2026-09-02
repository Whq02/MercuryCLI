import type { Transport } from './sdk.js'
import type { JSONRPCMessage } from './sdk.js'

/**
 * Two MCP transports that tunnel JSON-RPC over the SDK control channel, so
 * an MCP server living inside the SDK process can serve the CLI process's
 * MCP client. Message ids are preserved end-to-end; routing is by server
 * name in the wrapper (the callback owner's job, not the transport's).
 */

export type SendMcpMessageCallback = (serverName: string, message: JSONRPCMessage) => Promise<JSONRPCMessage>

/** CLI side: send hands the message (unmodified) + server name to the callback and feeds the response back. */
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
    // Nothing to open.
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

/** SDK side: inbound control requests are pushed into onmessage by the query layer; responses go to the send callback. */
export class SdkControlServerTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private closed = false

  constructor(private readonly sendMcpMessage: (message: JSONRPCMessage) => void) {}

  async start(): Promise<void> {
    // Nothing to open.
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
