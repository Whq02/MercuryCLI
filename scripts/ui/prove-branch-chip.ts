#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { GLYPH, branchChip } = await import('../../src/screen/theme/glyphs.ts')
const { stringWidth } = await import('../../src/screen/renderer/stringWidth.ts')

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
  check('the chip is the glyph, one space, the name', branchChip('main') === `${GLYPH.branch} main`, JSON.stringify(branchChip('main')) + ' — change branchChip in src/screen/theme/glyphs.ts to return GLYPH.branch, one space, then the name')
  check('the chip of an empty name is the glyph and its space (a painter that colours the name apart)', branchChip('') === `${GLYPH.branch} `, JSON.stringify(branchChip('')) + ' — change branchChip in src/screen/theme/glyphs.ts so an empty name still returns GLYPH.branch and its space')
  check('the glyph itself is one cell by the oracle (the chip never spends a hidden cell)', stringWidth(GLYPH.branch) === 1, `${stringWidth(GLYPH.branch)} — change GLYPH.branch in src/screen/theme/glyphs.ts to a glyph that stringWidth reads as one cell`)
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
