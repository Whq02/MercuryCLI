#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'held-joiner-home-'))
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_TOOL_SEARCH = '0'
delete process.env.ANTHROPIC_BASE_URL

const j = (v: unknown): string => JSON.stringify(v)
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { planToolPayload, clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { getHeldToolsAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { isNullRenderingAttachment } = await import('../../src/components/messages/nullRenderingAttachments.ts')
const { isLoggableMessage } = await import('../../src/utils/sessionStorage/chain.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { z } = await import('zod/v4')

const model = 'claude-fable-5-1'
const tool = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  inputSchema: z.object({}).passthrough(),
  inputJSONSchema: { type: 'object', properties: {} },
  prompt: async () => `${name} tool`,
  description: async () => `${name} tool`,
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  shouldDefer: false,
  ...over,
})
const search = tool(TOOL_SEARCH_TOOL_NAME)
const read = tool('Read')
const late = tool('LateBuiltin')
const connector = tool('mcp__srv__lookup', { isMcp: true, mcpInfo: { serverName: 'srv' }, shouldDefer: true })
const owner = 'held-joiner'
const messages: unknown[] = [{ type: 'user', uuid: 'u-held-first', message: { role: 'user', content: 'first' } }]
const plan = (tools: unknown[], msgs: unknown[] = messages) =>
  planToolPayload({ model, tools: tools as never, messages: msgs as never, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], source: 'prove', latchKey: owner })
const names = (value: Awaited<ReturnType<typeof planToolPayload>>): string => j(value.roster.map(t => t.name))

section('§1 a tool that joins a non-deferring conversation is held out of the frozen roster, and the model is told on its next turn')
clearToolRosterLatches()
const p1 = await plan([search, read])
check('the first request froze the roster without ToolSearch (search off by policy)', names(p1) === j(['Read']), names(p1))
check('nothing is announced while nothing is held', getHeldToolsAttachment(owner, messages as never).length === 0)
const p2 = await plan([search, read, late, connector])
check('two joiners after the first request are held: the roster stays byte-identical', names(p2) === names(p1), names(p2))
const rows = getHeldToolsAttachment(owner, messages as never)
const row = rows[0] as { type: string; names: string[]; body: string } | undefined
check('one persisted row names the held tools, sorted', rows.length === 1 && row?.type === 'held_tools' && j(row.names) === j(['LateBuiltin', 'mcp__srv__lookup']), j(rows))
check('the row tells the model the tools are held until the next compaction or /clear and cannot be called yet', row !== undefined && row.body.includes('held out of your tool list until the next compaction or /clear') && row.body.includes('cannot be called yet') && row.body.includes('LateBuiltin') && row.body.includes('mcp__srv__lookup'), row?.body)
const message = createAttachmentMessage(row as never)
const wire = normalizeAttachmentForAPI(row as never)
check('the row reaches the model as one reminder row and persists on the transcript, never painted', wire.length === 1 && j(wire[0]).includes('held out of your tool list') && isLoggableMessage(message) && isNullRenderingAttachment(message), `wire=${wire.length}`)
const history = [...messages, message]
check('the hold is announced once: with the row in the history nothing is announced again', getHeldToolsAttachment(owner, history as never).length === 0)
const p3 = await plan([search, read, late, connector], history)
check('the announcement moves nothing on the wire: the roster after it is byte-identical', names(p3) === names(p1), names(p3))
const p4 = await plan([search, read, late, connector, tool('Another')], history)
check('a later joiner is announced on its own, without repeating the earlier ones', j((getHeldToolsAttachment(owner, history as never)[0] as { names?: string[] } | undefined)?.names) === j(['Another']) && names(p4) === names(p1))

section('§2 the hold is per conversation, and a joiner a deferring latch appends deferred is not held')
const other = [{ type: 'user', uuid: 'u-held-other', message: { role: 'user', content: 'another chat' } }]
const o1 = await plan([search, read, late], other)
check('another conversation of the same owner decides fresh and announces nothing', names(o1) === j(['Read', 'LateBuiltin']) && getHeldToolsAttachment(owner, other as never).length === 0, names(o1))
process.env.MERCURY_TOOL_SEARCH = 'tst'
clearToolRosterLatches()
const otherConnector = tool('mcp__srv__other', { isMcp: true, mcpInfo: { serverName: 'srv' }, shouldDefer: true })
const d1 = await plan([search, read, connector])
const d2 = await plan([search, read, connector, otherConnector])
check('under a deferring latch a deferrable joiner is appended deferred, so it is not held and not announced', d1.enabled && names(d2) === j([TOOL_SEARCH_TOOL_NAME, 'Read', 'mcp__srv__lookup', 'mcp__srv__other']) && d2.deferredNames.has('mcp__srv__other') && getHeldToolsAttachment(owner, messages as never).length === 0, `${names(d2)} enabled=${d1.enabled}`)
const d3 = await plan([search, read, connector, otherConnector, late])
check('…while a non-deferrable joiner under the same latch is held and announced', names(d3) === names(d2) && j((getHeldToolsAttachment(owner, messages as never)[0] as { names?: string[] } | undefined)?.names) === j(['LateBuiltin']), names(d3))
clearToolRosterLatches()
check('clearing the latches forgets the hold too', getHeldToolsAttachment(owner, messages as never).length === 0)

console.log(`\n${failures === 0 ? '✅' : '❌'} held joiner announced: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
