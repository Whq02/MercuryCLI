#!/usr/bin/env bun
// ============================================================================
//  scripts/structure-tools/prove-structure-tools-toolsearch.ts — the brief's discovery law:
//  ordinary "find this structure" / "inspect this repository change" /
//  "run the relevant tests" requests SELECT the typed paths through
//  capability-aware ToolSearch (rank 1 among the deferred set) instead of
//  falling back to broad shell work.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { getAllBaseTools } = await import('../../src/tools.ts')
const { isDeferredTool } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { searchToolsWithKeywords } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const base = getAllBaseTools()
const searchable = base.filter(isDeferredTool)
const search = (query: string): Promise<string[]> =>
  searchToolsWithKeywords(query, searchable, searchable, searchable.length)

console.log('── lathe ToolSearch selection ──')
for (const [query, winner] of [
  ['find this code structure across languages', 'Structure'],
  ['search python go or rust code structurally', 'Structure'],
  ['rewrite a matched pattern in many files', 'Structure'],
  ['inspect this repository change on the host', 'Git'],
  ['watch a workflow run until it settles', 'Git'],
  ['page through a pull request diff', 'Git'],
  ['read a file at an exact ref', 'Git'],
  ['run the relevant tests for my changes', 'Test'],
  ['run the tests touched by changed files', 'Test'],
] as const) {
  const r = await search(query)
  check(`"${query}" → ${winner} first`, r[0] === winner, r.slice(0, 4).join(', ') || '(none)')
}

console.log(failures === 0 ? '\nLATHE TOOLSEARCH GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
