import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import { McpServer, ResourceTemplate, inputRequired, type CallToolResult, type ServerContext, type McpRequestContext, type InputRequiredResult } from './sdk.js'
import { PERMISSION_MODES } from '../../../sdk/src/door.js'
import type { PermissionHandler } from '../../../sdk/src/runner.js'
import { AutomationBridge, type AutomationRun } from './automationBridge.js'

const id = z.string().uuid()
export const automationSchemas = {
  mercury_run: z.strictObject({ prompt: z.string().min(1), session_id: id.optional(), title: z.string().min(1).optional(), model: z.string().min(1).optional(), mode: z.enum(PERMISSION_MODES).optional() }),
  mercury_session_rows: z.strictObject({ session_id: id, limit: z.number().int().min(1).max(200).optional(), before: z.number().int().min(0).optional() }),
  mercury_sessions: z.strictObject({}),
  mercury_send: z.strictObject({ session_id: id, sender: z.string().min(1).max(200), message: z.string().min(1), message_id: id.optional() }),
  mercury_recall: z.strictObject({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
}

const json = (value: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value })
const failed = (error: unknown): CallToolResult => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })
const safely = async (action: () => Promise<Record<string, unknown>>): Promise<CallToolResult> => { try { return json(await action()) } catch (error) { return failed(error) } }
const form = (params: Parameters<PermissionHandler>[0]) => ({
  mode: 'form' as const,
  message: `${params.title ?? params.tool_name}\n${JSON.stringify(params.input)}${params.reason ? `\n${params.reason}` : ''}`,
  requestedSchema: { type: 'object' as const, properties: { allow: { type: 'boolean' as const, title: 'Allow this action' } }, required: ['allow'] },
})
const answer = (value: unknown): ReturnType<PermissionHandler> => {
  const parsed = z.object({ action: z.enum(['accept', 'decline', 'cancel']), content: z.object({ allow: z.boolean() }).optional() }).safeParse(value)
  return parsed.success && parsed.data.action === 'accept' && parsed.data.content?.allow === true
    ? { outcome: 'allow' }
    : { outcome: 'deny', message: 'Permission was not granted by the MCP host' }
}

type Ask = { params: Parameters<PermissionHandler>[0]; settle: (answer: Awaited<ReturnType<PermissionHandler>>) => void }
type Job = { input: string; controller: AbortController; event: Promise<void>; wake: () => void; ask?: Ask; result?: CallToolResult }
function arm(job: Job): void { job.event = new Promise(resolve => { job.wake = resolve }) }

export function automationServerFactory(bridge: AutomationBridge): { create: (context: McpRequestContext) => McpServer; close: () => Promise<void> } {
  const waiting = new Map<string, Job>()
  const running = new Set<Job>()
  const run = async (input: AutomationRun, context: ServerContext, era: McpRequestContext['era'], canAsk: boolean): Promise<CallToolResult | InputRequiredResult> => {
    if (!canAsk) return safely(() => bridge.run(input, () => ({ outcome: 'deny', message: 'The MCP host cannot answer permission requests' }), context.mcpReq.signal))
    if (era === 'legacy') return safely(() => bridge.run(input, async (params, request) => {
      try { return await answer(await context.mcpReq.elicitInput(form(params), { signal: request.signal })) }
      catch { return { outcome: 'deny', message: 'The MCP host cannot answer this permission request' } }
    }, context.mcpReq.signal))
    const state = context.mcpReq.requestState()
    let job: Job
    if (state !== undefined) {
      if (typeof state !== 'string' || !waiting.has(state)) return failed('This permission request is no longer pending')
      job = waiting.get(state)!
      if (job.input !== JSON.stringify(input)) return failed('The prompt changed while its permission request was pending')
      waiting.delete(state)
      const ask = job.ask
      job.ask = undefined
      arm(job)
      ask?.settle(await answer(context.mcpReq.inputResponses?.permission))
    } else {
      job = { input: JSON.stringify(input), controller: new AbortController(), event: Promise.resolve(), wake: () => {} }
      arm(job)
      running.add(job)
      void safely(() => bridge.run(input, (params, request) => new Promise(resolve => {
        const settle = (value: Awaited<ReturnType<PermissionHandler>>): void => { request.signal.removeEventListener('abort', cancel); resolve(value) }
        const cancel = (): void => { job.ask = undefined; settle({ outcome: 'deny', message: 'The session withdrew the permission request' }); job.wake() }
        if (request.signal.aborted) { cancel(); return }
        request.signal.addEventListener('abort', cancel, { once: true })
        job.ask = { params, settle }
        job.wake()
      }), job.controller.signal)).then(result => {
        job.result = result
        job.wake()
        running.delete(job)
        for (const [key, held] of waiting) if (held === job) waiting.delete(key)
      })
    }
    const abort = (): void => job.controller.abort()
    context.mcpReq.signal.addEventListener('abort', abort, { once: true })
    try {
      while (!job.result && !job.ask) { await job.event; if (!job.result && !job.ask) arm(job) }
      if (job.result) return job.result
      const token = randomUUID()
      waiting.set(token, job)
      return inputRequired({ requestState: token, inputRequests: { permission: { method: 'elicitation/create', params: form(job.ask!.params) } } })
    } finally { context.mcpReq.signal.removeEventListener('abort', abort) }
  }
  return {
    create(context) {
      const server = new McpServer({ name: 'mercury', version: typeof MACRO !== 'undefined' ? MACRO.VERSION : '0' })
      server.registerTool('mercury_run', { description: 'Run a prompt in a fresh Mercury session or continue one by id. Uses the server’s permission mode; permission asks go to the MCP host. Returns SDK rows.', inputSchema: automationSchemas.mercury_run, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, (input, ctx) => run(input, ctx, context.era, (context.era === 'modern' ? (ctx.mcpReq.envelope as Record<string, { elicitation?: unknown }> | undefined)?.['io.modelcontextprotocol/clientCapabilities'] : server.server.getClientCapabilities())?.elicitation !== undefined))
      server.registerTool('mercury_session_rows', { description: 'Read the last rows of a project session; before pages backwards. Running and recent MCP sessions return SDK rows; saved sessions return transcript rows.', inputSchema: automationSchemas.mercury_session_rows, annotations: { readOnlyHint: true } }, input => safely(() => bridge.query({ op: 'rows', ...input })))
      server.registerTool('mercury_sessions', { description: 'List saved sessions of this project.', inputSchema: automationSchemas.mercury_sessions, annotations: { readOnlyHint: true } }, () => safely(() => bridge.query({ op: 'sessions' })))
      server.registerTool('mercury_send', { description: 'Deliver a message from the named sender into a live project session. Reuse message_id when retrying a delivery.', inputSchema: automationSchemas.mercury_send, annotations: { readOnlyHint: false, destructiveHint: false } }, input => safely(() => bridge.query({ op: 'send', ...input })))
      server.registerTool('mercury_recall', { description: 'Search project memory for pointers to facts, rulings and session notes.', inputSchema: automationSchemas.mercury_recall, annotations: { readOnlyHint: true } }, input => safely(() => bridge.query({ op: 'recall', ...input })))
      server.registerResource('project-records', new ResourceTemplate('mercury://{+path}', {
        list: async () => {
          const result = await bridge.query({ op: 'resources' })
          return { resources: result.resources as Array<{ uri: string; name: string; description: string; mimeType: string }> }
        },
      }), { description: 'Read-only Mercury project records, using the same references as Inspect.', mimeType: 'application/json' }, async uri => {
        const result = await bridge.query({ op: 'resource', ref: uri.href })
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result) }] }
      })
      return server
    },
    async close() {
      for (const job of running) job.controller.abort()
      waiting.clear()
      await bridge.close()
    },
  }
}
