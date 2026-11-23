import { randomUUID } from 'node:crypto'
import { StdioClientTransport, type JSONRPCMessage } from '../mcp-shapes/sdk.js'
import type { McpBootstrapManifest } from '../mcp-shapes/mcpServerRecords.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { missingSpawnCommandError } from '../../platform/host-os/programs.js'
import { startMicrotask, startTimeout, stopTimeout } from '../../platform/async/timers.js'

export class LazyStdioClientTransport extends StdioClientTransport {
  private initialize: JSONRPCMessage | undefined
  private activation: Promise<void> | undefined
  private closed = false
  private rejectInitialization: ((error: Error) => void) | undefined
  private readonly spawnParameters: ConstructorParameters<typeof StdioClientTransport>[0]

  constructor(parameters: ConstructorParameters<typeof StdioClientTransport>[0], private manifest: McpBootstrapManifest, private timeoutMs: number) {
    super(parameters)
    this.spawnParameters = parameters
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
        timer = startTimeout(() => reject(new Error('MCP server initialization timed out')), this.timeoutMs)
        this.onmessage = message => {
          if ('id' in message && message.id === id) {
            if ('error' in message) reject(new Error(message.error.message))
            else resolve()
          } else receive?.(message)
        }
      })
      void initialized.catch(passedOver)
      try {
        const missing = missingSpawnCommandError(this.spawnParameters.command, this.spawnParameters.env, this.spawnParameters.cwd)
        if (missing !== null) throw missing
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
        stopTimeout(timer)
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
          startMicrotask(() => { if (!this.closed) this.onmessage?.({ jsonrpc: '2.0', id: message.id, result }) })
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
