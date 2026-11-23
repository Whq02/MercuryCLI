#!/usr/bin/env bun
export {}
let failures = 0
function check(label: string, cond: boolean, detail = '', failHint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && failHint ? ` — ${failHint}` : ''}`)
}

console.log('refusals — an outline never reuses different content or numbering')
{
  const { buildOutlineNumberedWindow } = await import('../../src/tools/read/outline.js')
  const before = await buildOutlineNumberedWindow('fixture.ts', 'export const first = 1', 1, 1, 1, false)
  const after = await buildOutlineNumberedWindow('fixture.ts', 'export const second = 2', 1, 1, 1, false)
  const moved = await buildOutlineNumberedWindow('fixture.ts', 'export const second = 2', 9, 1, 1, true)
  check('changed content cannot reuse the earlier outline', before?.includes('first') === true && after?.includes('second') === true && !after.includes('first'), '', 'fix the outlineCache key in buildOutlineNumberedWindow (src/tools/read/outline.ts) so it includes a hash of the content')
  check('changed line numbers and anchors cannot reuse a plain outline', moved !== null && /^9#[0-9a-f]+\t/.test(moved), '', 'fix the outlineCache key in buildOutlineNumberedWindow (src/tools/read/outline.ts) so it includes startLine and the anchored flag')
}

console.log(failures === 0 ? 'prove-stale-registry: GREEN' : `prove-stale-registry: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
