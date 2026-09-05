#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { GLYPH, branchChip, branchChipWidth } = await import('../../src/components/mercury-ui/glyphs.ts')
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

section('§2 the census: one owner spells the chip')
{
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : []
    })
  const EXEMPT = new Set(['src/components/mercury-ui/glyphs.ts', 'src/components/MercuryPrBadge.tsx'])
  const spellers = walk(join(ROOT, 'src'))
    .map(f => f.slice(ROOT.length + 1))
    .filter(f => !EXEMPT.has(f) && /GLYPH\.branch\b/.test(readFileSync(join(ROOT, f), 'utf8')))
  check('no painter under src/ reads GLYPH.branch itself (the chip owner and the PR badge excepted)', spellers.length === 0, spellers.join(', '))
  const painters = walk(join(ROOT, 'src')).map(f => f.slice(ROOT.length + 1)).filter(f => /\bbranchChip\(/.test(readFileSync(join(ROOT, f), 'utf8')) && f !== 'src/components/mercury-ui/glyphs.ts')
  check('the painters read the owner (the frame, the footer, the tag bar, the deck, the home, the settings screen, the health rows, the concourse, the fullscreen, the realms)', painters.length >= 10, `${painters.length}: ${painters.join(', ')}`)
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
