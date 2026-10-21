/// <reference lib="esnext.disposable" preserve="true" />
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { EffortLevel, PermissionMode } from './door.js'
import type { InputBlock, JsonSchema } from './rows.js'
import type { RunOptions } from './client.js'
import type { ResultOf } from './wire.js'
import { validate } from './validate.js'
import { VERSION } from './version.js'

export type AgentDefinition = { description: string; prompt: string; model?: string; effort?: EffortLevel | number; tools?: string[]; disallowedTools?: string[]; permissionMode?: PermissionMode; instructionProfile?: 'auto' | 'native'; mcpServers?: unknown[]; hooks?: unknown; maxTurns?: number; skills?: string[]; initialPrompt?: string; standingRule?: string; memory?: 'user' | 'project' | 'local'; background?: boolean; isolation?: 'worktree' }
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  if (!definition.description.trim() || !definition.prompt.trim()) throw new Error('an agent needs description and prompt')
  return { ...definition }
}
export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
export type ToolContext = { signal: AbortSignal }
export type ToolDefinition<T = Record<string, unknown>> = { name: string; description: string; inputSchema: JsonSchema; execute(input: T, context: ToolContext): ToolResult | string | Promise<ToolResult | string> }
export function defineTool<T = Record<string, unknown>>(definition: ToolDefinition<T>): ToolDefinition<T> {
  if (!definition.name.trim()) throw new Error('a tool needs a name')
  return definition
}

export async function serveTools(tools: readonly ToolDefinition[], name = 'sdk-tools') {
  if (new Set(tools.map(t => t.name)).size !== tools.length) throw new Error('duplicate tool name')
  const token = randomBytes(32).toString('hex')
  const pending = new Map<unknown, AbortController>()
  const cancel = () => { for (const controller of pending.values()) controller.abort(); pending.clear() }
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) { res.writeHead(403).end(); return }
    if (req.method === 'DELETE') { cancel(); res.writeHead(200).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let id: unknown = null
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      id = message.id
      if (message.method === 'notifications/cancelled') pending.get(message.params?.requestId)?.abort(message.params?.reason)
      if (id === undefined) { res.writeHead(202).end(); return }
      let result: unknown
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: VERSION } }
      else if (message.method === 'ping') result = {}
      else if (message.method === 'tools/list') result = { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
      else if (message.method === 'tools/call') {
        const tool = tools.find(t => t.name === message.params.name)
        if (!tool) throw new Error('unknown tool')
        const issues = validate(tool.inputSchema, message.params.arguments ?? {})
        if (issues.length) throw new Error(JSON.stringify(issues))
        const controller = new AbortController()
        pending.set(id, controller)
        const abort = () => controller.abort()
        res.once('close', abort)
        try {
          const value = await tool.execute(message.params.arguments ?? {}, { signal: controller.signal })
          result = typeof value === 'string' ? { content: [{ type: 'text', text: value }] } : value
        } catch (error) { result = { content: [{ type: 'text', text: String(error) }], isError: true } }
        finally { pending.delete(id); res.off('close', abort) }
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method' } })); return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    } catch (error) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: String(error) } })) }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as { port: number }
  const config = { type: 'http' as const, url: `http://127.0.0.1:${address.port}`, headers: { Authorization: `Bearer ${token}` } }
  const close = async () => { cancel(); if (!server.listening) return; await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections() }) }
  return { config, mcp: JSON.stringify({ mcpServers: { [name]: config } }), cancel, close, [Symbol.asyncDispose]: close }
}

export type ToolServer = Awaited<ReturnType<typeof serveTools>>
export function withTools<T extends RunOptions>(options: T, server: ToolServer): T {
  const names = (options.tools ?? []).map(tool => `mcp__sdk-tools__${tool.name}`)
  const allowedTools = options.autoAllowTools === false ? options.allowedTools : [...new Set([...(options.allowedTools ?? []), ...names])]
  const agentDefs = options.agentDefs === undefined ? undefined : Object.fromEntries(Object.entries(options.agentDefs).map(([name, definition]) => {
    if (options.autoAllowTools === false || typeof definition !== 'object' || definition === null) return [name, definition]
    const agent = definition as Record<string, unknown>
    return [name, Array.isArray(agent.tools) ? { ...agent, tools: [...new Set([...agent.tools, ...names])] } : { ...agent }]
  }))
  return { ...options, mcp: [...(options.mcp ?? []), server.mcp], allowedTools, agentDefs }
}

export function textBlock(text: string): Extract<InputBlock, { type: 'text' }> { return { type: 'text', text } }
export function imageBlock(data: Uint8Array | { path: string } | string, mediaType: string): Extract<InputBlock, { type: 'image' }> {
  return { type: 'image', media_type: mediaType, data: typeof data === 'string' ? data : Buffer.from('path' in data ? readFileSync(data.path) : data).toString('base64') }
}
export type AllowPermissionResult = Extract<ResultOf<'permission/request'>, { outcome: 'allow' }>
export type DenyPermissionResult = Extract<ResultOf<'permission/request'>, { outcome: 'deny' }>
export function allowPermission(options: Omit<AllowPermissionResult, 'outcome'> = {}): AllowPermissionResult {
  return { outcome: 'allow', ...options }
}
export function denyPermission(message?: string | Omit<DenyPermissionResult, 'outcome'>, options: Omit<DenyPermissionResult, 'outcome' | 'message'> = {}): DenyPermissionResult {
  if (typeof message === 'object' && message !== null) return { outcome: 'deny', ...message }
  return { outcome: 'deny', ...(message === undefined ? {} : { message }), ...options }
}
