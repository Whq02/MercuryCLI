#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'resumed-agent-home-'))
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

const { planToolPayload, clearToolRosterLatches, clearToolRosterRestore, pendingToolRosterRestore } = await import('../../src/services/providers/toolEconomy.ts')
const { boundPrefixRecordToEmit, restoreBoundPrefixFromMessages, resetBoundPrefixEmitted } = await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
const { getSystemPromptSectionCache, setSystemPromptSectionCacheEntry, clearSystemPromptSectionState } = await import('../../src/bootstrap/state.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { z } = await import('zod/v4')

const model = 'claude-fable-5-1'
const tool = (name: string, description: string) => ({
  name,
  inputSchema: z.object({ q: z.string() }),
  inputJSONSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  prompt: async () => description,
  description: async () => description,
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  shouldDefer: false,
  ...(name.startsWith('mcp__') ? { isMcp: true, mcpInfo: { serverName: 'srv' } } : {}),
})
const mainOwner = 'main-conversation'
const agentOwner = 'agent-a1'
const secondAgentOwner = 'agent-a2'
const mainMessages = [{ type: 'user', uuid: 'u-main', message: { role: 'user', content: 'main first' } }]
const agentMessages = [{ type: 'user', uuid: 'u-agent', message: { role: 'user', content: 'agent first' } }]
const secondAgentMessages = [{ type: 'user', uuid: 'u-agent-2', message: { role: 'user', content: 'second agent first' } }]
const plan = (owner: string, messages: unknown[], tools: unknown[]) =>
  planToolPayload({ model, tools: tools as never, messages: messages as never, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], source: 'prove', latchKey: owner })
const schemas = (value: Awaited<ReturnType<typeof planToolPayload>>) => Promise.all(value.roster.map(t => toolToAPISchema(t, {
  model,
  tools: value.roster,
  getToolPermissionContext: async () => getEmptyToolPermissionContext(),
  agents: [],
  deferLoading: value.deferredNames.has(t.name),
  conversationKey: value.conversationKey,
})))
const names = (value: Awaited<ReturnType<typeof planToolPayload>>): string => j(value.roster.map(t => t.name))
const freshProcess = () => { clearToolRosterLatches(); clearToolRosterRestore(); clearToolSchemaCache(); clearSystemPromptSectionState(); resetBoundPrefixEmitted() }
const persist = (row: unknown): unknown => JSON.parse(j(row))

section('§1 process 1 — every conversation owner writes its own first-exchange record; an agent\'s record is the roster alone')
freshProcess()
setSystemPromptSectionCacheEntry('memory', 'the memory as first seen', null)
const pool1 = [tool('Read', 'Read a file'), tool('Bash', 'Run a command'), tool('mcp__srv__lookup', 'Look up a record (server description v1)')]
const main1 = await plan(mainOwner, mainMessages, pool1)
const mainDefs1 = await schemas(main1)
const agent1 = await plan(agentOwner, agentMessages, pool1)
const agentDefs1 = await schemas(agent1)
const second1 = await plan(secondAgentOwner, secondAgentMessages, [pool1[0]!, pool1[2]!])
const secondDefs1 = await schemas(second1)
check('the main and the agent conversations froze the same three-tool roster; the second agent its own two', names(main1) === j(['Read', 'Bash', 'mcp__srv__lookup']) && names(agent1) === names(main1) && names(second1) === j(['Read', 'mcp__srv__lookup']), `${names(main1)} / ${names(agent1)} / ${names(second1)}`)
const mainRecord = await boundPrefixRecordToEmit(mainOwner, mainMessages as never, model)
const agentRecord = await boundPrefixRecordToEmit(agentOwner, agentMessages as never, model, { rosterOnly: true })
const secondRecord = await boundPrefixRecordToEmit(secondAgentOwner, secondAgentMessages as never, model, { rosterOnly: true })
const mainData = mainRecord?.attachment as { type: string; boundKey: string; roster: Array<{ name: string; definition?: string }>; sections: unknown[]; systemContext: Record<string, string> } | undefined
const agentData = agentRecord?.attachment as { type: string; boundKey: string; roster: Array<{ name: string; definition?: string }>; sections: unknown[]; systemContext: Record<string, string> } | undefined
check('the main conversation wrote its record with the cached sections', mainData?.type === 'bound_prefix' && mainData.sections.some(s => (s as { name: string }).name === 'memory'), j(mainData?.sections))
check('the agent conversation wrote its own record under its own key: the roster and each definition as sent, no sections and no system context', agentData?.type === 'bound_prefix' && agentData.boundKey.startsWith(`${agentOwner}|u-agent|`) && j(agentData.roster.map(t => t.name)) === names(agent1) && agentData.roster.every(t => typeof t.definition === 'string') && agentData.sections.length === 0 && Object.keys(agentData.systemContext).length === 0, j({ key: agentData?.boundKey, sections: agentData?.sections.length }))
check('a second emit for the same agent conversation is null (one record per conversation)', (await boundPrefixRecordToEmit(agentOwner, agentMessages as never, model, { rosterOnly: true })) === null)
const persistedMain = persist(mainRecord)
const persistedAgent = persist(agentRecord)
const persistedSecond = persist(secondRecord)

section('§2 process 2 — the pool moved; the main and the resumed agent both re-send their first roster and definitions byte for byte')
freshProcess()
const pool2 = [tool('Read', 'Read a file'), tool('Bash', 'Run a command'), tool('mcp__srv__lookup', 'Look up a record (server description v2 after a reconnect)'), tool('LateBuiltin', 'A tool that joined the pool after the first exchange')]
check('a new process starts with no restore and no cached section', pendingToolRosterRestore() === null && getSystemPromptSectionCache().size === 0)
const agentKey = restoreBoundPrefixFromMessages([persistedAgent as never], { rosterOnly: true })
check('an agent restore arms its roster and seeds no section (its prompt is the definition\'s own)', agentKey === agentData?.boundKey && pendingToolRosterRestore()?.key === agentData?.boundKey && getSystemPromptSectionCache().size === 0, `${agentKey}; sections=${getSystemPromptSectionCache().size}`)
const mainKey = restoreBoundPrefixFromMessages([persistedMain as never])
check('the main restore seeds the sections and arms its roster beside the agent\'s', mainKey === mainData?.boundKey && getSystemPromptSectionCache().get('memory')?.value === 'the memory as first seen' && pendingToolRosterRestore()?.key === mainData?.boundKey)
const main2 = await plan(mainOwner, mainMessages, pool2)
const mainDefs2 = await schemas(main2)
check('the main conversation re-sends its first roster byte for byte — the joiner held, the recorded definition served', names(main2) === names(main1) && j(mainDefs2) === j(mainDefs1), `${names(main2)}; defs equal=${j(mainDefs2) === j(mainDefs1)}`)
const agent2 = await plan(agentOwner, agentMessages, pool2)
const agentDefs2 = await schemas(agent2)
check('the resumed agent conversation re-sends its first roster byte for byte', names(agent2) === names(agent1), `first ${names(agent1)} → resumed ${names(agent2)}`)
check('the resumed agent conversation re-sends its first MCP definition byte for byte', j(agentDefs2.find(t => t.name === 'mcp__srv__lookup')) === j(agentDefs1.find(t => t.name === 'mcp__srv__lookup')), `first ${j(agentDefs1.find(t => t.name === 'mcp__srv__lookup')?.description)} → resumed ${j(agentDefs2.find(t => t.name === 'mcp__srv__lookup')?.description)}`)
check('…and every definition of the resumed agent is the one first sent', j(agentDefs2) === j(agentDefs1))

section('§3 two agents restored back to back each keep their own record (one armed restore per conversation)')
freshProcess()
restoreBoundPrefixFromMessages([persistedAgent as never], { rosterOnly: true })
restoreBoundPrefixFromMessages([persistedSecond as never], { rosterOnly: true })
const agent3 = await plan(agentOwner, agentMessages, pool2)
const second3 = await plan(secondAgentOwner, secondAgentMessages, pool2)
const secondDefs3 = await schemas(second3)
check('the first agent restored still re-sends its roster after a second agent was restored', names(agent3) === names(agent1), `${names(agent3)}`)
check('the second agent re-sends its own two-tool roster and definitions', names(second3) === names(second1) && j(secondDefs3) === j(secondDefs1), `${names(second3)}`)

section('§4 a transcript that carries an agent\'s record beside the main\'s seeds the sections from the main\'s alone')
freshProcess()
const restored = restoreBoundPrefixFromMessages([persistedMain as never, persistedAgent as never])
check('the newest record is the key returned; the sections come from the record that carries them', restored === agentData?.boundKey && getSystemPromptSectionCache().get('memory')?.value === 'the memory as first seen', `${restored}; sections=${getSystemPromptSectionCache().size}`)
const main4 = await plan(mainOwner, mainMessages, pool2)
const agent4 = await plan(agentOwner, agentMessages, pool2)
check('both conversations re-send their rosters from one transcript', names(main4) === names(main1) && names(agent4) === names(agent1))
freshProcess()

section('§5 a request that prepends a context row (an agent thread carries no persisted user-context row) keys the same conversation as its own history')
const { conversationRosterKey } = await import('../../src/services/providers/toolEconomy.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const contextRow = createUserMessage({ content: 'the user context, prepended per request', isMeta: true })
const requestMessages = [contextRow, ...agentMessages]
check('the prepended row (a meta user row with a fresh uuid) never moves the conversation key', conversationRosterKey(agentOwner, requestMessages as never, model) === conversationRosterKey(agentOwner, agentMessages as never, model), `${conversationRosterKey(agentOwner, requestMessages as never, model)} vs ${conversationRosterKey(agentOwner, agentMessages as never, model)}`)
freshProcess()
const r1 = await plan(agentOwner, requestMessages, pool1)
const r2 = await plan(agentOwner, [createUserMessage({ content: 'the user context, prepended again', isMeta: true }), ...agentMessages], pool2)
check('two requests of one agent conversation, each with its own prepended row, ride ONE latch: the second re-sends the first roster and holds the joiner', names(r2) === names(r1) && names(r1) === j(['Read', 'Bash', 'mcp__srv__lookup']), `${names(r1)} → ${names(r2)}`)
const recordWithPrepend = await boundPrefixRecordToEmit(agentOwner, agentMessages as never, model, { rosterOnly: true })
check('the record the turn machine writes from the agent\'s own history finds the latch the request planned', recordWithPrepend !== null && (recordWithPrepend.attachment as { boundKey: string }).boundKey === conversationRosterKey(agentOwner, agentMessages as never, model))
freshProcess()

console.log(`\n${failures === 0 ? '✅' : '❌'} resumed agent roster: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
