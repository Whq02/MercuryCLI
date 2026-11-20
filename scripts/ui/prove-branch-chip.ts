#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { GLYPH, branchChip, branchChipWidth } = await import('../../src/utils/glyphs.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')

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

section("§1 the owner's shape and width")
{
  check('the chip is the glyph, one space, the name', branchChip('main') === `${GLYPH.branch} main`, JSON.stringify(branchChip('main')))
  check('the chip of an empty name is the glyph and its space (a painter that colours the name apart)', branchChip('') === `${GLYPH.branch} `, JSON.stringify(branchChip('')))
  const long = 'lane/a-very-long-branch-name-with-many-segments'
  check('the width is the oracle\'s reading of the chip — never the name\'s length plus a guess', branchChipWidth(long) === stringWidth(branchChip(long)) && branchChipWidth(long) === stringWidth(GLYPH.branch) + 1 + stringWidth(long), `${branchChipWidth(long)}`)
  check('the glyph itself is one cell by the oracle (the chip never spends a hidden cell)', stringWidth(GLYPH.branch) === 1, `${stringWidth(GLYPH.branch)}`)
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
