#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { z } from 'zod/v4'
import { buildTool, getEmptyToolPermissionContext, type Tool } from '../../src/Tool.ts'
import { getToolSchemaCache } from '../../src/utils/toolSchemaCache.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_TOOLSEARCH_COOCCUR = '0'
delete process.env.NODE_ENV
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { searchToolsWithKeywords, clearToolSearchDescriptionCache } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { formatDeferredToolLine } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function fixture(name: string, description = '', searchHint = '', searchKeywords?: readonly string[]): Tool {
  return buildTool({
    name, searchHint, searchKeywords, shouldDefer: true, maxResultSizeChars: 1000,
    inputSchema: z.object({}), isEnabled: () => true,
    prompt: async () => description, description: async () => description,
    call: async () => ({ data: '' }),
    mapToolResultToToolResultBlockParam: (data: string, id: string) => ({ type: 'tool_result' as const, tool_use_id: id, content: data }),
  })
}
async function search(query: string, tools: Tool[]): Promise<string[]> {
  clearToolSearchDescriptionCache()
  return searchToolsWithKeywords(query, tools, tools, tools.length)
}

console.log('§1 private keywords participate in ordinary and required-term search')
const sentinel = 'privatequartz'
const plain = fixture('Indexed', 'A plain operation.', 'a plain purpose')
const indexed = { ...plain, searchKeywords: [sentinel.toUpperCase(), sentinel, 'compound phrase', 'a.b'] } as Tool
check('without the index the canary is not discoverable', same(await search(sentinel, [plain]), []))
check('a keyword alone finds its tool, case-insensitively', same(await search(sentinel, [indexed]), ['Indexed']))
check('a required keyword admits its tool even when absent from name, hint and description', same(await search(`+${sentinel}`, [plain, indexed]), ['Indexed']))
check('all required terms must match', same(await search(`+${sentinel} +missing`, [indexed]), []))
check('a word within a keyword phrase matches', same(await search('+phrase', [indexed]), ['Indexed']))
check('keyword matching keeps word boundaries', same(await search(`${sentinel}ite`, [indexed]), []))
check('keyword punctuation is literal, not a regexp', same(await search('+a.b', [indexed]), ['Indexed']) && same(await search('axb', [indexed]), []))
check('an exact tool name still wins alone', same(await search('Indexed', [indexed, fixture('Other', '', '', ['Indexed'])]), ['Indexed']))

console.log('§2 a keyword has the hint weight, once per query term')
const keyword = fixture('KeywordOnly', '', '', [sentinel, sentinel.toUpperCase()])
const hint = fixture('HintOnly', '', sentinel)
const described = fixture('DescriptionOnly', `${sentinel} amber`)
check('keyword +4 ties two description terms at +2 each, in insertion order', same(await search(`${sentinel} amber`, [described, keyword]), ['DescriptionOnly', 'KeywordOnly']) && same(await search(`${sentinel} amber`, [keyword, described]), ['KeywordOnly', 'DescriptionOnly']))
check('keyword and hint have equal weight', same(await search(sentinel, [hint, keyword]), ['HintOnly', 'KeywordOnly']) && same(await search(sentinel, [keyword, hint]), ['KeywordOnly', 'HintOnly']))
const both = { ...keyword, searchHint: sentinel } as Tool
check('a term in both hint and keywords earns +4 only once', same(await search(sentinel, [hint, both]), ['HintOnly', 'KeywordOnly']))
const named = fixture('Privatequartzish')
const oneDescription = fixture('OneDescription', sentinel)
check('the name substring +5 still beats the keyword +4, which beats description +2', same(await search(sentinel, [oneDescription, keyword, named]), ['Privatequartzish', 'KeywordOnly', 'OneDescription']))

console.log('§3 tools without keywords keep their old ranking')
const legacy = [fixture('ArchivePack'), fixture('HintPack', '', 'archive'), fixture('DescriptionPack', 'archive'), fixture('TiedPack', 'archive')]
for (const [query, expected] of [
  ['archive', ['ArchivePack', 'HintPack', 'DescriptionPack', 'TiedPack']],
  ['+archive', ['ArchivePack', 'HintPack', 'DescriptionPack', 'TiedPack']],
  ['HintPack', ['HintPack']],
  ['absent', []],
] as const) {
  const result = await search(query, legacy)
  check(`${query}: the legacy order is unchanged`, same(result, expected), result.join(', '))
}
check('an absent keyword bag and an empty one rank identically', same(await search('archive', legacy), await search('archive', legacy.map(tool => ({ ...tool, searchKeywords: [] }) as Tool))))

console.log('§4 keywords never enter the model-facing roster, description or definition')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
runSwarmCommand('on')
const { getAllBaseTools } = await import('../../src/tools.ts')
const tools = [...getAllBaseTools()]
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
if (!tools.some(tool => tool.name === 'Computer')) tools.push(ComputerTool)
const names = ['Crewmate', 'CrewBoard', 'AskUserQuestion', 'Browser', 'Computer', 'Git', 'Inspect', 'Journey', 'Retain', 'Service', 'Structure', 'WebFetch', 'Workflow']
check('all thirteen rewritten tools carry a private keyword bag', names.every(name => tools.find(tool => tool.name === name)?.searchKeywords?.length))
for (const original of [plain, ...tools.filter(tool => names.includes(tool.name))]) {
  const tagged = { ...original, searchKeywords: [...(original.searchKeywords ?? []), sentinel] } as Tool
  const bare = { ...original, searchKeywords: undefined } as Tool
  const options = { tools: [...tools, tagged], agents: [], getToolPermissionContext: async () => getEmptyToolPermissionContext() }
  check(`${original.name}: roster text ignores keywords in both postures`, [false, true].every(unattended => formatDeferredToolLine(tagged, unattended) === formatDeferredToolLine(bare, unattended) && !formatDeferredToolLine(tagged, unattended).includes(sentinel)))
  const description = await tagged.prompt(options)
  check(`${original.name}: description ignores keywords`, description === await bare.prompt(options) && !description.includes(sentinel))
  for (const model of ['claude-fable-5-1', 'gemini-4-argon']) {
    getToolSchemaCache().clear()
    const before = await toolToAPISchema(bare, { ...options, model, deferLoading: true })
    getToolSchemaCache().clear()
    const after = await toolToAPISchema(tagged, { ...options, model, deferLoading: true })
    const wire = JSON.stringify(after)
    check(`${original.name}/${model}: complete wire definition ignores keywords`, same(before, after) && !wire.includes(sentinel) && !wire.includes('searchKeywords'))
  }
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
