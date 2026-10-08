import { isDeepStrictEqual } from 'node:util'
import { armScratch, check, cleanup, finish, writeProject } from './lspProofDoor.ts'

const scratch = armScratch('lsp-retired-name')
const root = writeProject(scratch, 'project', {})
const { enterRoot, makeContext, drive } = await import('../ast-tools/lib/harness.ts')
await enterRoot(root)
const available = await import('../../src/tools/LSPTool/LSPTool.ts')
if (!('LSP_TOOLS' in available)) {
  check('a saved callable name becomes generically unknown while its roster gains the seven tools', false)
  cleanup(scratch)
  finish('prove-lsp-retired-name')
}
const { LSP_TOOLS } = available
const { getEmptyToolPermissionContext, findToolByName } = await import('../../src/Tool.ts')
const { gateToolCall } = await import('../../src/services/providers/toolCallGate.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { clearToolRosterLatches, clearToolRosterRestore, conversationRosterKey, planToolPayload } = await import('../../src/services/providers/toolEconomy.ts')
const { restoreBoundPrefixFromMessages } = await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
const { isDeferredToolFor } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.ts')
const { entryToRecord, recordToEntry } = await import('../../src/fabric/entryCodec.ts')
const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
const names = LSP_TOOLS.map(tool => tool.name)
const context = await makeContext(LSP_TOOLS)
for (const operation of ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'goToImplementation', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls', 'diagnostics', 'rename', 'codeActions', 'switchSourceHeader', 'typeDefinition', 'serverStatus', 'workspaceDiagnostics', 'pathRename', 'fixDiagnostic', 'formatDocument', 'formatRange', 'organizeImports', 'capabilities', 'rawRequest', 'moveSymbol']) {
  const input = { operation }
  const old = await drive({ name: 'LSP' }, input, context)
  const nonsense = await drive({ name: 'XYZ' }, input, context)
  check(`${operation}: unknown-tool execution is generic`, old.isError && nonsense.isError && old.text.replaceAll('LSP', 'XYZ') === nonsense.text, old.text)
  const wire = gateToolCall(LSP_TOOLS, { id: 'saved-call', name: 'LSP', argumentsRaw: JSON.stringify(input), malformed: false })
  check(`${operation}: unknown-tool wire gate is generic`, !wire.ok && wire.refusal.reason === 'No such tool available: LSP')
}
const permission = getEmptyToolPermissionContext()
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_ANTHROPIC_OAUTH_BASE
const model = 'claude-sonnet-5-5'
const first = createUserMessage({ content: 'fixture conversation' })
const beforeDefinition = JSON.stringify({ name: 'Before', description: 'unchanged before', input_schema: { type: 'object', properties: {} } })
const afterDefinition = JSON.stringify({ name: 'After', description: 'unchanged after', input_schema: { type: 'object', properties: {} } })
const savedDefinition = JSON.stringify({ name: 'LSP', description: 'saved language-service definition', input_schema: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'] }, eager_input_streaming: true })
for (const enabled of [true, false]) for (const deferred of [true, false]) {
  clearToolRosterLatches()
  clearToolRosterRestore()
  const record = createAttachmentMessage({ type: 'bound_prefix', boundKey: conversationRosterKey('restored', [first], model), rosterEnabled: enabled, roster: [{ name: 'Before', deferred: false, definition: beforeDefinition }, { name: 'LSP', deferred, definition: savedDefinition }, { name: 'After', deferred: true, definition: afterDefinition }], sections: [], systemContext: {} })
  const messages = [first, record]
  restoreBoundPrefixFromMessages(messages, { rosterOnly: true })
  const plan = await planToolPayload({ model, tools: [...LSP_TOOLS, ToolSearchTool], messages, latchKey: 'restored', getToolPermissionContext: async () => permission, agents: [] })
  check(`restore ${enabled}/${deferred}: successors occupy the original position`, isDeepStrictEqual(plan.roster.slice(0, 9).map(tool => tool.name), ['Before', ...names, 'After']), plan.roster.map(tool => tool.name).join(', '))
  check(`restore ${enabled}/${deferred}: missing callable name declares the prefix change`, isDeepStrictEqual(plan.restoredMissingTools, ['LSP']) && !plan.roster.some(tool => tool.name === 'LSP'))
  check(`restore ${enabled}/${deferred}: exact deferral marks and their readers agree`, LSP_TOOLS.every(tool => plan.deferredNames.has(tool.name) === (enabled && (tool.name === 'LspRead' ? deferred : true)) && isDeferredToolFor(tool, model, undefined, messages) === (enabled && (tool.name === 'LspRead' ? deferred : true))))
  for (const [name, definition] of [['Before', beforeDefinition], ['After', afterDefinition]]) {
    const schema = await toolToAPISchema(plan.roster.find(tool => tool.name === name)!, { tools: plan.roster, agents: [], model, getToolPermissionContext: async () => permission, conversationKey: plan.conversationKey })
    check(`restore ${enabled}/${deferred}: ${name} definition is byte-preserved`, JSON.stringify(schema) === definition)
  }
  const schema = await toolToAPISchema(plan.roster.find(tool => tool.name === 'LspRead')!, { tools: plan.roster, agents: [], model, getToolPermissionContext: async () => permission, conversationKey: plan.conversationKey })
  check(`restore ${enabled}/${deferred}: the read tool never receives the saved definition`, JSON.stringify(schema) !== savedDefinition && schema.name === 'LspRead')
}
const savedEntries = [
  { type: 'assistant', uuid: 'saved-assistant', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'assistant', model, content: [{ type: 'tool_use', id: 'saved-call', name: 'LSP', input: { operation: 'rename', filePath: '/fixture/lib.ts', line: 1, character: 14, newName: 'spend', plan: 'lsp-0123456789ab' } }] } },
  { type: 'user', uuid: 'saved-result', timestamp: '2026-10-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'saved-call', content: 'Preview only — nothing written. plan: lsp-0123456789ab', is_error: false }] } },
]
let ordinal = 0
for (const entry of savedEntries) {
  const record = entryToRecord(entry, { sessionId: 'fixture-session' as never, nextOrdinal: () => ordinalOf(++ordinal), observedAt: entry.timestamp, source: { channel: 'fixture' } as never })
  check(`saved ${entry.type} entry round-trips byte-for-byte as JSON`, isDeepStrictEqual(JSON.parse(JSON.stringify(recordToEntry(record))), entry), JSON.stringify(recordToEntry(record)))
}
const shim = findToolForRender(LSP_TOOLS, 'LSP')
check('saved rows use the generic absent-tool shim, not a live alias', shim.name === 'LSP' && findToolByName(LSP_TOOLS, 'LSP') === undefined && !LSP_TOOLS.includes(shim))
let refused = false
try { await shim.call({} as never) } catch { refused = true }
check('the render shim cannot execute', refused)
clearToolRosterLatches()
clearToolRosterRestore()
cleanup(scratch)
finish('prove-lsp-retired-name')
