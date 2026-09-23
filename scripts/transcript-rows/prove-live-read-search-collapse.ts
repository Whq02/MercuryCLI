#!/usr/bin/env bun
import { strict as assert } from 'node:assert'
import type { Tools } from '../../src/Tool.ts'
import type { CollapsedReadSearchGroup, NormalizedAssistantMessage, NormalizedUserMessage, RenderableMessage } from '../../src/types/message.ts'
import { collapseReadSearchGroups, getSearchReadSummaryText, getToolUseIdsFromCollapsedGroup } from '../../src/utils/collapseReadSearch.ts'
import { applyGrouping } from '../../src/utils/groupToolUses.ts'

process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_DESKTOP_DRIVER = 'none'

const tools = [
  { name: 'Read', isSearchOrReadCommand: () => ({ isRead: true, isSearch: false }) },
  { name: 'Grep', isSearchOrReadCommand: () => ({ isRead: false, isSearch: true }) },
  { name: 'Glob', isSearchOrReadCommand: () => ({ isRead: false, isSearch: false, isList: true }) },
  { name: 'Bash', isSearchOrReadCommand: () => ({ isRead: false, isSearch: false }) },
] as unknown as Tools

const use = (n: number, name = 'Read', input: unknown = { file_path: `/fixture/file-${n}.txt` }): NormalizedAssistantMessage => ({
  type: 'assistant',
  uuid: `use-${n}`,
  timestamp: new Date(n).toISOString(),
  message: { id: 'response', role: 'assistant', content: [{ type: 'tool_use', id: `call-${n}`, name, input }] },
} as NormalizedAssistantMessage)
const result = (n: number, error = false): NormalizedUserMessage => ({
  type: 'user',
  uuid: `result-${n}`,
  timestamp: new Date(n).toISOString(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${n}`, content: error ? 'failed' : 'ok', is_error: error }] },
} as NormalizedUserMessage)
const summary = (g: CollapsedReadSearchGroup): string => getSearchReadSummaryText(g.searchCount, g.readCount, false, g.replCount, g, g.listCount)
const oneGroup = (rows: RenderableMessage[]): CollapsedReadSearchGroup => {
  assert.equal(rows.length, 1, `one row, got ${rows.map(m => m.type).join(', ')}`)
  assert.equal(rows[0]!.type, 'collapsed_read_search')
  return rows[0] as CollapsedReadSearchGroup
}
let failures = 0
let checks = 0
const check = (label: string, run: () => void): void => {
  checks++
  try { run(); console.log(`PASS ${label}`) }
  catch (error) { failures++; console.log(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`) }
}

for (const n of [2, 4, 9, 16]) {
  const uses = Array.from({ length: n }, (_, i) => use(i))
  const settled = oneGroup(collapseReadSearchGroups([...uses, ...uses.map((_, i) => result(i))], tools))
  for (const k of new Set([1, Math.ceil(n / 2), n])) {
    check(`${k} of ${n} reads in progress keep the whole run in one counted row`, () => {
      const inProgress = new Set(uses.slice(n - k).map((_, i) => `call-${n - k + i}`))
      const live = oneGroup(collapseReadSearchGroups([...uses, ...uses.slice(0, n - k).map((_, i) => result(i))], tools, inProgress))
      assert.equal(live.readCount, n)
      assert.equal(live.uuid, settled.uuid)
      assert.equal(summary(live), `Read ${n} files`)
      assert.equal(summary(live), summary(settled))
      assert.deepEqual(getToolUseIdsFromCollapsedGroup(live), getToolUseIdsFromCollapsedGroup(settled))
    })
  }
}

check('each appended read updates the same row and retains every member exactly once', () => {
  for (let n = 2; n <= 16; n++) {
    const uses = Array.from({ length: n }, (_, i) => use(i))
    const group = oneGroup(collapseReadSearchGroups(uses, tools, new Set(uses.map((_, i) => `call-${i}`))))
    assert.equal(group.uuid, 'collapsed-use-0')
    assert.equal(group.readCount, n)
    assert.equal(new Set(getToolUseIdsFromCollapsedGroup(group)).size, n)
  }
})

check('the first running call already has the same card identity as the settled call', () => {
  const single = use(0)
  const live = oneGroup(collapseReadSearchGroups([single], tools, new Set(['call-0'])))
  const settled = oneGroup(collapseReadSearchGroups([single, result(0)], tools))
  assert.equal(live.readCount, 1)
  assert.equal(live.uuid, settled.uuid)
  assert.equal(summary(live), 'Read 1 file')
  assert.equal(summary(live), summary(settled))
  assert.deepEqual(collapseReadSearchGroups([single], tools), [single])
})

check('an unresolved history without a live set never claims the calls ran', () => {
  const uses = [use(0), use(1)]
  assert.deepEqual(collapseReadSearchGroups(uses, tools), uses)
})

check('a mixed live run has the same counts and summary as its settled run', () => {
  const uses = [use(0), use(1, 'Grep', { pattern: 'first' }), use(2, 'Glob', { pattern: '*' }), use(3, 'Bash', { command: 'pwd' })]
  const live = oneGroup(collapseReadSearchGroups(uses, tools, new Set(uses.map((_, i) => `call-${i}`))))
  const settled = oneGroup(collapseReadSearchGroups([...uses, ...uses.map((_, i) => result(i))], tools))
  assert.deepEqual([live.readCount, live.searchCount, live.listCount, live.bashCount], [1, 1, 1, 1])
  assert.equal(summary(live), summary(settled))
  assert.equal(live.bashCount, settled.bashCount)
})

check('repeated reads of one path keep the existing unique-file count', () => {
  const uses = [use(0), use(1, 'Read', { file_path: '/fixture/file-0.txt' })]
  assert.equal(oneGroup(collapseReadSearchGroups(uses, tools, new Set(['call-0', 'call-1']))).readCount, 1)
})

check('a failed result stays in the live and settled group for its existing marking', () => {
  const failed = result(0, true)
  const group = oneGroup(collapseReadSearchGroups([use(0), failed, use(1)], tools, new Set(['call-1'])))
  assert.equal(group.readCount, 2)
  assert.ok(group.messages.includes(failed))
  assert.ok(oneGroup(collapseReadSearchGroups([use(0), failed, use(1), result(1)], tools)).messages.includes(failed))
})

check('assistant text separates two runs without changing their order', () => {
  const text = { ...use(9), message: { ...use(9).message, content: [{ type: 'text', text: 'Next.' }] } } as NormalizedAssistantMessage
  const rows = collapseReadSearchGroups([use(0), use(1), text, use(2), use(3)], tools, new Set(['call-0', 'call-1', 'call-2', 'call-3']))
  assert.deepEqual(rows.map(r => r.type), ['collapsed_read_search', 'assistant', 'collapsed_read_search'])
  assert.equal(rows[1], text)
  assert.deepEqual(getToolUseIdsFromCollapsedGroup(rows[0] as CollapsedReadSearchGroup), ['call-0', 'call-1'])
  assert.deepEqual(getToolUseIdsFromCollapsedGroup(rows[2] as CollapsedReadSearchGroup), ['call-2', 'call-3'])
})

check('non-collapsible sibling groups keep their own renderer', () => {
  const groupedTools = [{ name: 'Other', renderGroupedToolUse: () => null, isSearchOrReadCommand: () => ({ isRead: false, isSearch: false }) }] as unknown as Tools
  const uses = [use(0, 'Other'), use(1, 'Other')]
  const live = applyGrouping(uses, groupedTools).messages
  const settled = applyGrouping([...uses, result(0), result(1)], groupedTools).messages
  assert.deepEqual(collapseReadSearchGroups(live, groupedTools, new Set(['call-0', 'call-1'])), live)
  assert.deepEqual(collapseReadSearchGroups(settled, groupedTools), settled)
})

console.log(`${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
