#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_MODEL']) delete process.env[k]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'toolsearch-misses-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool } = await import('../../src/tools.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

const MODEL = 'claude-sonnet-5-5'
const permissionContext = getEmptyToolPermissionContext()
const pool: Tool[] = [...assembleToolPool(permissionContext, [])]
const first = createUserMessage({ content: 'begin' }) as Message
check('the pool offers TaskStop, Sleep and Read', ['TaskStop', 'Sleep', 'Read'].every(name => pool.some(tool => tool.name === name)))
const context = (pendingServers: string[] = []) => ({
  messages: [first],
  options: { tools: pool, engineModel: MODEL },
  getAppState: () => ({ toolPermissionContext: { ...permissionContext, mode: 'default' }, mcp: { clients: pendingServers.map(name => ({ name, type: 'pending' })) } }),
})
type Data = { matches: string[]; query: string; total_deferred_tools: number; unresolved?: string[]; resolved?: string[]; suggestions?: string[]; pending_mcp_servers?: string[]; match_lines?: string[] }
const search = async (query: string, pending: string[] = []): Promise<Data> => (await ToolSearchTool.call({ query, max_results: 5 }, context(pending) as never)).data as Data
const content = (data: Data): unknown => ToolSearchTool.mapToolResultToToolResultBlockParam(data as never, 'toolu_misses').content
const totalDeferred = (await search('select:Sleep')).total_deferred_tools

section('§1 E1 — a select with a miss loads nothing and names the miss, the closest name and the exact retry')
{
  const data = await search('select:TaskStop,Slep')
  check('matches is empty: nothing was loaded', data.matches.length === 0, data.matches.join(','))
  check("unresolved lists the miss", JSON.stringify(data.unresolved) === JSON.stringify(['Slep']), JSON.stringify(data.unresolved))
  check('the name that resolved is recorded but not loaded', JSON.stringify(data.resolved) === JSON.stringify(['TaskStop']), JSON.stringify(data.resolved))
  check('the closest name is suggested', JSON.stringify(data.suggestions) === JSON.stringify(['Sleep']), JSON.stringify(data.suggestions))
  check('total_deferred_tools is the drawer\'s count', data.total_deferred_tools === totalDeferred)
  check('the query rides back', data.query === 'select:TaskStop,Slep')
  const text = content(data)
  check('the content is E1\'s first example, word for word', text === 'Nothing was loaded: this session has no tool named "Slep". Did you mean "Sleep"? Retry with the names as the "Deferred tools:" list spells them: "select:TaskStop,Sleep".', String(text))
  const twice = await search('select:Slep,Raed')
  check('two misses: both named, both suggested, the retry carries both', content(twice) === 'Nothing was loaded: this session has no tool named "Slep" or "Raed". Did you mean "Sleep" or "Read"? Retry with the names as the "Deferred tools:" list spells them: "select:Sleep,Read".', String(content(twice)))
  const three = await search('select:Slep,Raed,Grpe')
  check('three misses read A, B or C', String(content(three)).startsWith('Nothing was loaded: this session has no tool named "Slep", "Raed" or "Grpe". Did you mean "Sleep", "Read" or "Grep"?'), String(content(three)))
}

section('§2 E1 without a suggestion')
{
  const data = await search('select:Frobnicate')
  check('matches is empty and unresolved names the miss', data.matches.length === 0 && JSON.stringify(data.unresolved) === JSON.stringify(['Frobnicate']))
  check('no suggestion rides when no name is close', data.suggestions === undefined)
  check('the content is E1\'s second example, word for word', content(data) === 'Nothing was loaded: this session has no tool named "Frobnicate". Retry with the names as the "Deferred tools:" list spells them.', String(content(data)))
  const mixed = await search('select:Slep,Frobnicate')
  check('one miss with a suggestion and one without: no "Did you mean" (every miss needs one), the plain retry', content(mixed) === 'Nothing was loaded: this session has no tool named "Slep" or "Frobnicate". Retry with the names as the "Deferred tools:" list spells them.', String(content(mixed)))
}

section('§3 E2 — a keyword query that matches nothing')
{
  const data = await search('zebra quasar')
  check('matches is empty and no unresolved field rides', data.matches.length === 0 && data.unresolved === undefined)
  check('the content is E2, word for word', content(data) === 'No deferred tool matches "zebra quasar"; nothing was loaded. Every tool you can load is in the "Deferred tools:" list with what it is for — pick one there and load it with "select:<name>".', String(content(data)))
  const pending = await search('zebra quasar', ['filesys'])
  check('with a server still connecting, today\'s sentence follows unchanged', content(pending) === 'No deferred tool matches "zebra quasar"; nothing was loaded. Every tool you can load is in the "Deferred tools:" list with what it is for — pick one there and load it with "select:<name>". MCP servers still connecting: filesys — their tools will become available shortly; the search may be retried.', String(content(pending)))
  check('the stored shape of a .28 no-match result renders E2 too', content({ matches: [], query: 'x', total_deferred_tools: 0 }) === 'No deferred tool matches "x"; nothing was loaded. Every tool you can load is in the "Deferred tools:" list with what it is for — pick one there and load it with "select:<name>".')
}

section('§4 the roads that do not move')
{
  const sleep = await search('select:Sleep')
  check('select:Sleep still loads Sleep', JSON.stringify(sleep.matches) === JSON.stringify(['Sleep']) && sleep.unresolved === undefined)
  check('…and its content is the tool_reference block', JSON.stringify(content(sleep)) === JSON.stringify([{ type: 'tool_reference', tool_name: 'Sleep' }]), JSON.stringify(content(sleep)))
  const read = await search('select:Read')
  check('select:Read still resolves (the harmless no-op for a loaded tool)', JSON.stringify(read.matches) === JSON.stringify(['Read']) && JSON.stringify(content(read)) === JSON.stringify([{ type: 'tool_reference', tool_name: 'Read' }]))
  const both = await search('select:TaskStop,Sleep')
  check('a select whose names all resolve loads them all, in query order', JSON.stringify(both.matches) === JSON.stringify(['TaskStop', 'Sleep']))
  const keyword = await search('wait pause for a duration')
  check('a keyword search still answers with references and match lines', keyword.matches.length > 0 && Array.isArray(keyword.match_lines) && Array.isArray(content(keyword)))
  check('the data object keeps its three required fields', ['matches', 'query', 'total_deferred_tools'].every(key => key in sleep))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
