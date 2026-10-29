import { z } from 'zod/v4'
import { McpServer, ResourceTemplate, type CallToolResult, type McpRequestContext } from './sdk.js'
import { PERMISSION_MODES } from '../../../sdk/src/door.js'
import { AutomationBridge } from './automationBridge.js'
import { AutomationPermissionRefusal } from './automationAccess.js'

const id = z.string().uuid()
const automationSchemas = {
  mercury_run: z.strictObject({ prompt: z.string().min(1), session_id: id.optional(), title: z.string().min(1).optional(), model: z.string().min(1).optional(), mode: z.enum(PERMISSION_MODES).optional() }),
  mercury_session_rows: z.strictObject({ session_id: id, limit: z.number().int().min(1).max(200).optional(), before: z.number().int().min(0).optional() }),
  mercury_sessions: z.strictObject({}),
  mercury_send: z.strictObject({ session_id: id, sender: z.string().min(1).max(200), message: z.string().min(1), message_id: id.optional() }),
  mercury_recall: z.strictObject({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
}

const json = (value: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value })
const safely = async (action: () => Promise<Record<string, unknown>>): Promise<CallToolResult> => {
  try { return json(await action()) }
  catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], ...(error instanceof AutomationPermissionRefusal ? { structuredContent: { code: error.code, message: error.message } } : {}) }
  }
}

export function automationServerFactory(bridge: AutomationBridge): { create: (context: McpRequestContext) => McpServer; close: () => Promise<void> } {
  return {
    create() {
      const server = new McpServer({ name: 'mercury', version: typeof MACRO !== 'undefined' ? MACRO.VERSION : '0' })
      server.registerTool('mercury_run', { description: 'Read an outside report in a client-owned session, only when this client may run. Never joins an operator session or grants permission. Returns SDK rows.', inputSchema: automationSchemas.mercury_run, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, (input, ctx) => safely(() => bridge.run(input, ctx.mcpReq.signal)))
      server.registerTool('mercury_session_rows', { description: 'Read the last rows of a session within this client’s reach; before pages backwards.', inputSchema: automationSchemas.mercury_session_rows, annotations: { readOnlyHint: true } }, input => safely(() => bridge.query({ op: 'rows', ...input })))
      server.registerTool('mercury_sessions', { description: 'List saved project sessions within this client’s reach.', inputSchema: automationSchemas.mercury_sessions, annotations: { readOnlyHint: true } }, () => safely(() => bridge.query({ op: 'sessions' })))
      server.registerTool('mercury_send', { description: 'Deliver an untrusted outside report from this client to an allowed session. Does not start a turn or answer as the operator. Reuse message_id when retrying.', inputSchema: automationSchemas.mercury_send, annotations: { readOnlyHint: false, destructiveHint: false } }, input => safely(() => bridge.query({ op: 'send', ...input })))
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
    close: () => bridge.close(),
  }
}
