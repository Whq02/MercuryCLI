#!/usr/bin/env bun
export {}
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('refusals — an outline never reuses different content or numbering')
{
  const { buildOutlineNumberedWindow } = await import('../../src/tools/FileReadTool/outline.js')
  const before = await buildOutlineNumberedWindow('fixture.ts', 'export const first = 1', 1, 1, 1, false)
  const after = await buildOutlineNumberedWindow('fixture.ts', 'export const second = 2', 1, 1, 1, false)
  const moved = await buildOutlineNumberedWindow('fixture.ts', 'export const second = 2', 9, 1, 1, true)
  check('changed content cannot reuse the earlier outline', before?.includes('first') === true && after?.includes('second') === true && !after.includes('first'), `before ${JSON.stringify(before)} · after ${JSON.stringify(after)} · the outlineCache key in buildOutlineNumberedWindow (src/tools/FileReadTool/outline.ts) must include a hash of the content; a null reading means the grammar engine was unavailable (loadGrammarEngine), not a stale cache`)
  check('changed line numbers and anchors cannot reuse a plain outline', moved !== null && /^9#[0-9a-f]+\t/.test(moved), `moved ${JSON.stringify(moved)} · the outlineCache key in buildOutlineNumberedWindow (src/tools/FileReadTool/outline.ts) must include startLine and the anchored flag; a null reading means the grammar engine was unavailable (loadGrammarEngine)`)
}

console.log(failures === 0 ? 'prove-stale-registry: GREEN' : `prove-stale-registry: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
