#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'late-connector-home-'))
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_TOOL_SEARCH = 'tst'
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

const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { getDeferredToolsDelta } = await import('../../src/utils/toolSearch.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
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
const read = tool('Read')
const remote = tool('mcp__connector__lookup', { isMcp: true, mcpInfo: { serverName: 'connector' }, shouldDefer: true })
const builtinDeferrable = tool('Browser', { shouldDefer: true })
const pending = { callSite: 'attachments_main' as const, hasPendingMcpServers: true }
const settled = { callSite: 'attachments_main' as const, hasPendingMcpServers: false }

section('§1 a resumed process whose connector has not reconnected yet writes no removal row for the connector\'s tool')
{
  const firstProcessPool = [ToolSearchTool, read, remote]
  const announced = getDeferredToolsDeltaAttachment(firstProcessPool as never, model, [])
  check('process 1: the connector\'s deferred tool is announced once (a persisted delta row)', announced.length === 1 && announced[0]!.type === 'deferred_tools_delta' && (announced[0] as { addedNames: string[] }).addedNames.includes('mcp__connector__lookup'), j(announced))
  const history = [createAttachmentMessage(announced[0]!)]
  const resumedPoolBeforeReconnect = [ToolSearchTool, read]
  const delta = getDeferredToolsDelta(resumedPoolBeforeReconnect as never, history as never, pending)
  check('process 2 (the connector still connecting): no removal row is written for a tool whose server is merely late', delta === null || delta.removedNames.length === 0, `delta=${j(delta)}`)
  const rows = getDeferredToolsDeltaAttachment(resumedPoolBeforeReconnect as never, model, history as never, pending)
  const removal = rows.find(r => r.type === 'deferred_tools_delta') as { removedNames?: string[]; body?: string } | undefined
  check('process 2: the attachment road writes no "no longer available" row before the reconnect', removal === undefined || (removal.removedNames ?? []).length === 0, `body=${j(removal?.body)}`)
  const reconnected = getDeferredToolsDelta(firstProcessPool as never, [...history, ...rows.map(r => createAttachmentMessage(r))] as never, settled)
  check('process 2, after the reconnect: the tool is not announced a second time (its first announcement still stands)', reconnected === null || !reconnected.addedNames.includes('mcp__connector__lookup'), `re-announced=${j(reconnected?.addedNames)}`)
}

section('§2 the hold is for connectors only, and only while a server is still connecting')
{
  const announcedBoth = getDeferredToolsDeltaAttachment([ToolSearchTool, read, remote, builtinDeferrable] as never, model, [])
  const history = [createAttachmentMessage(announcedBoth[0]!)]
  const withoutBuiltin = getDeferredToolsDelta([ToolSearchTool, read, remote] as never, history as never, pending)
  check('a deferrable tool that is not a connector\'s and left the pool is still reported removed while servers are pending', withoutBuiltin !== null && withoutBuiltin.removedNames.includes('Browser') && !withoutBuiltin.removedNames.includes('mcp__connector__lookup'), j(withoutBuiltin))
  const gone = getDeferredToolsDelta([ToolSearchTool, read] as never, history as never, settled)
  check('once every server has settled, a connector tool that is really gone is reported removed', gone !== null && gone.removedNames.includes('mcp__connector__lookup') && gone.removedNames.includes('Browser'), j(gone))
  const goneNoContext = getDeferredToolsDelta([ToolSearchTool, read] as never, history as never)
  check('a scan with no context behaves as settled (the removal is written)', goneNoContext !== null && goneNoContext.removedNames.includes('mcp__connector__lookup'), j(goneNoContext))
}

console.log(`\n${failures === 0 ? '✅' : '❌'} late connector removal hold: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
