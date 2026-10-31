import { randomUUID } from 'node:crypto'
import { StdioClientTransport, type Implementation, type JSONRPCMessage, type ServerCapabilities, type Tool } from './sdk.js'

export type McpBootstrapManifest = {
  serverInfo: Implementation
  capabilities: ServerCapabilities
  instructions: string
  tools: Tool[]
}

export class LazyStdioClientTransport extends StdioClientTransport {
  private initialize: JSONRPCMessage | undefined
  private activation: Promise<void> | undefined
  private closed = false
  private rejectInitialization: ((error: Error) => void) | undefined

  constructor(parameters: ConstructorParameters<typeof StdioClientTransport>[0], private manifest: McpBootstrapManifest, private timeoutMs: number) {
    super(parameters)
  }

  override async start(): Promise<void> {}

  private activate(): Promise<void> {
    if (this.activation) return this.activation
    this.activation = (async () => {
      if (this.closed || !this.initialize) throw new Error('MCP transport is closed')
      const id = `mercury-lazy-${randomUUID()}`
      const receive = this.onmessage
      let timer: ReturnType<typeof setTimeout> | undefined
      const initialized = new Promise<void>((resolve, reject) => {
        this.rejectInitialization = reject
        timer = setTimeout(() => reject(new Error('MCP server initialization timed out')), this.timeoutMs)
        this.onmessage = message => {
          if ('id' in message && message.id === id) {
            if ('error' in message) reject(new Error(message.error.message))
            else resolve()
          } else receive?.(message)
        }
      })
      void initialized.catch(() => {})
      try {
        await super.start()
        if (this.closed) throw new Error('MCP transport is closed')
        await super.send({ ...this.initialize, id } as JSONRPCMessage)
        await initialized
        await super.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      } catch (error) {
        this.closed = true
        await super.close()
        throw error
      } finally {
        clearTimeout(timer)
        this.rejectInitialization = undefined
        this.onmessage = receive
      }
    })()
    return this.activation
  }

  override async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('MCP transport is closed')
    if (!this.activation && 'method' in message) {
      if (message.method === 'notifications/initialized') return
      if ('id' in message) {
        let result: Record<string, unknown> | undefined
        if (message.method === 'initialize') {
          this.initialize = message
          const { tools: _tools, ...manifest } = this.manifest
          result = { protocolVersion: message.params?.protocolVersion, ...manifest }
        } else if (message.method === 'tools/list') result = { tools: this.manifest.tools }
        else if (message.method === 'resources/list') result = { resources: [] }
        else if (message.method === 'resources/templates/list') result = { resourceTemplates: [] }
        else if (message.method === 'prompts/list') result = { prompts: [] }
        else if (message.method === 'ping') result = {}
        if (result) {
          queueMicrotask(() => { if (!this.closed) this.onmessage?.({ jsonrpc: '2.0', id: message.id, result }) })
          return
        }
      }
    }
    await this.activate()
    return super.send(message)
  }

  override async close(): Promise<void> {
    const cold = this.activation === undefined
    this.closed = true
    this.rejectInitialization?.(new Error('MCP transport is closed'))
    await super.close()
    if (cold) this.onclose?.()
  }
}
