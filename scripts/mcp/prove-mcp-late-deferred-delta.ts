#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../../src/Tool.ts'
import type { Message } from '../../src/types/message.ts'
import type { Attachment } from '../../src/utils/attachments/types.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of ['MERCURY_BARE', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE']) delete process.env[name]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1/openai/v1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1/openai/chatgpt'
const workspace = join(proofHome, 'workspace')
mkdirSync(workspace)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(workspace)
bootstrap.setCwdState(workspace)
bootstrap.setProjectRoot(workspace)
bootstrap.setSessionTrustAccepted(true)
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getAttachments } = await import('../../src/utils/attachments/orchestrator.ts')
const model = 'gpt-6-astra'
const fixtureTool = (server: string): Tool => ({
  name: `mcp__${server}__echo`,
  isMcp: true,
  mcpInfo: { serverName: server, toolName: 'echo' },
  prompt: async () => 'Echo a fixture value',
  description: async () => 'Echo a fixture value',
  inputSchema: z.object({ value: z.string() }),
  inputJSONSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  isEnabled: () => true,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  userFacingName: () => 'echo',
  call: async () => ({ data: 'fixture' }),
}) as unknown as Tool
let appState = getDefaultAppState()
const context = (tools: Tool[], messages: Message[]): ToolUseContext => ({
  options: { commands: [], tools, engineModel: model, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
  abortController: new AbortController(),
  messages,
  readFileState: createFileStateCacheWithSizeLimit(100),
  loadedNestedMemoryPaths: new Set(),
  nestedMemoryAttachmentTriggers: new Set(),
}) as unknown as ToolUseContext
const collect = (tools: Tool[], messages: Message[]) => getAttachments(null, context(tools, messages), [], messages, undefined, { localSubmission: true })
const deltas = (rows: Attachment[]) => rows.filter((row): row is Extract<Attachment, { type: 'deferred_tools_delta' }> => row.type === 'deferred_tools_delta')
const recorded = (attachment: Attachment): Message => ({ type: 'attachment', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), attachment }) as Message
const existing = fixtureTool('existing')
const joined = fixtureTool('runpod')
const opening: Message[] = [createUserMessage({ content: 'begin' })]
const firstRows = await collect([ToolSearchTool, existing], opening)
const first = deltas(firstRows)
assert.equal(first.length, 1)
assert.deepEqual(first[0]!.addedNames, [existing.name])
console.log('[PASS] the opening turn announces the existing deferred MCP tool')
const later: Message[] = [...opening, ...firstRows.map(recorded), createAssistantMessage({ content: 'done' }), createUserMessage({ content: 'a new server joined' })]
const addedRows = await collect([ToolSearchTool, existing, joined], later)
const added = deltas(addedRows)
assert.equal(added.length, 1, 'a later turn must announce its newly joined deferred MCP tool')
assert.deepEqual(added[0]!.addedNames, [joined.name])
assert.deepEqual(added[0]!.removedNames, [])
console.log('[PASS] after an assistant reply, only the newly joined deferred tool is announced')
const wire = JSON.stringify(addedRows.flatMap(normalizeAttachmentForAPI))
assert.ok(wire.includes('Deferred tools:') && wire.includes(joined.name))
assert.ok(!wire.includes('input_schema') && !wire.includes('inputJSONSchema'))
console.log('[PASS] the later announcement reaches the model without loading its schema')
const seen = [...later, ...addedRows.map(recorded), createAssistantMessage({ content: 'noted' })]
assert.deepEqual(deltas(await collect([ToolSearchTool, existing, joined], seen)), [])
console.log('[PASS] an unchanged later roster is not announced twice')
const removed = deltas(await collect([ToolSearchTool, existing], seen))
assert.equal(removed.length, 1)
assert.deepEqual(removed[0]!.addedNames, [])
assert.deepEqual(removed[0]!.removedNames, [joined.name])
console.log('[PASS] a later disconnection announces only the removed deferred tool')
console.log('prove-mcp-late-deferred-delta: ALL LAWS HOLD')
process.exit(0)
