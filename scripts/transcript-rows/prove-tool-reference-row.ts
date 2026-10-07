#!/usr/bin/env bun
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

const project = await import('../../src/rows/project.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')

section('§1 toolResultText renders a tool_reference block by name')
{
  check("one reference renders as '[tool_reference: Sleep]'", project.toolResultText([{ type: 'tool_reference', tool_name: 'Sleep' }]) === '[tool_reference: Sleep]', JSON.stringify(project.toolResultText([{ type: 'tool_reference', tool_name: 'Sleep' }])))
  check('two references join with a newline', project.toolResultText([{ type: 'tool_reference', tool_name: 'TaskStop' }, { type: 'tool_reference', tool_name: 'Sleep' }]) === '[tool_reference: TaskStop]\n[tool_reference: Sleep]')
  check('a text block is unchanged', project.toolResultText([{ type: 'text', text: 'four' }]) === 'four')
  check('a text block beside a reference keeps its place', project.toolResultText([{ type: 'text', text: 'note' }, { type: 'tool_reference', tool_name: 'Sleep' }]) === 'note\n[tool_reference: Sleep]')
  check("an image block still renders as '[image]'", project.toolResultText([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }]) === '[image]')
  check('a string result is itself', project.toolResultText('plain') === 'plain')
  check('a reference without a name renders nothing', project.toolResultText([{ type: 'tool_reference' }]) === '')
}

section('§2 the tool_result row of a ToolSearch result carries the references as its output')
{
  const scope = { session_id: 'sess-1', turn: 1 }
  const block = ToolSearchTool.mapToolResultToToolResultBlockParam({ matches: ['Sleep'], query: 'select:Sleep', total_deferred_tools: 39 } as never, 'toolu_1')
  const rows = project.toolResultRowsOf(scope, [block])
  check('one row', rows.length === 1)
  check("the row's output reads '[tool_reference: Sleep]' and its status is ok", rows[0]?.type === 'tool_result' && rows[0].call_id === 'toolu_1' && rows[0].status === 'ok' && rows[0].output === '[tool_reference: Sleep]', JSON.stringify(rows[0]))
  const two = project.toolResultRowsOf(scope, [ToolSearchTool.mapToolResultToToolResultBlockParam({ matches: ['TaskStop', 'Sleep'], query: 'select:TaskStop,Sleep', total_deferred_tools: 39 } as never, 'toolu_2')])
  check('a two-tool select gives two lines', two[0]?.output === '[tool_reference: TaskStop]\n[tool_reference: Sleep]', JSON.stringify(two[0]))
  const miss = project.toolResultRowsOf(scope, [ToolSearchTool.mapToolResultToToolResultBlockParam({ matches: [], query: 'select:TaskStop,Slep', total_deferred_tools: 39, unresolved: ['Slep'], resolved: ['TaskStop'], suggestions: ['Sleep'] } as never, 'toolu_3')])
  check('a miss row carries the E1 text', typeof miss[0]?.output === 'string' && miss[0].output.startsWith('Nothing was loaded: this session has no tool named "Slep".'), JSON.stringify(miss[0]))
  check('the stored content stays tool_reference blocks (the row text is a rendering, not the record)', Array.isArray(block.content) && (block.content as Array<{ type: string }>).every(item => item.type === 'tool_reference'))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
