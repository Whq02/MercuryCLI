#!/usr/bin/env bun
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const failHint = ' — restore the fail and warn entries of GLYPH (distinct, width 1) in src/screen/theme/glyphs.ts'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : failHint}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

console.log('============================================================')
console.log(' MCP/LSP notif severity glyphs — a11y (HB-0181)')
console.log('============================================================')


section('glyphs: fail=✕ and warn=▲ are DISTINCT (so error≠warning color-stripped) + width-1')
const glyphs = (await import(join(root, 'src', 'screen', 'theme', 'glyphs.ts'))) as {
  GLYPH: Record<string, string>
  displayWidth: (s: string) => number
}
check('GLYPH.fail = ✕ (error tone)', glyphs.GLYPH.fail === '✕')
check('GLYPH.warn = ▲ (warning tone)', glyphs.GLYPH.warn === '▲')
check('the two glyphs DIFFER (error vs warning distinguishable with color stripped)', glyphs.GLYPH.fail !== glyphs.GLYPH.warn)
check('GLYPH.fail is display-width 1 (no EAW column drift)', glyphs.displayWidth(glyphs.GLYPH.fail!) === 1)
check('GLYPH.warn is display-width 1', glyphs.displayWidth(glyphs.GLYPH.warn!) === 1)


console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0181 — MCP/LSP notif severity glyphs (a11y) proven')
  process.exit(0)
} else {
  console.log(` ❌ HB-0181 — ${failures} check(s) failed`)
  process.exit(1)
}
