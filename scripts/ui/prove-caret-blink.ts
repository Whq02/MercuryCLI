#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { Cursor } from '../../src/utils/Cursor.js'

chalk.level = 1

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const INVERSE_ON = '\x1b[7m'

section('A. the paint delta — the two phases differ only in the caret cell SGR')
{
  const on = Cursor.fromText('hello', 40, 5).render(' ', '', s => chalk.inverse(s))
  const off = Cursor.fromText('hello', 40, 5).render(' ', '', s => s)
  check('ON phase carries the inverse attribute', on.includes(INVERSE_ON))
  check('OFF phase carries NO inverse attribute', !off.includes(INVERSE_ON))
  check(
    'stripped, the phases are byte-identical (a blink moves no text)',
    stripAnsi(on) === stripAnsi(off),
    JSON.stringify({ on: stripAnsi(on), off: stripAnsi(off) }),
  )
  const onMid = Cursor.fromText('hello', 40, 2).render(' ', '', s => chalk.inverse(s))
  const offMid = Cursor.fromText('hello', 40, 2).render(' ', '', s => s)
  check('covered character kept on the ON phase', stripAnsi(onMid) === 'hello')
  check('covered character kept on the OFF phase', offMid === 'hello')
  check(
    'mid-text phases stripped-identical',
    stripAnsi(onMid) === stripAnsi(offMid),
  )
}

section('B. the strip width law — off phase paints a same-width cell')
{
  const { caretLens } = await import('../../src/components/concourse/lineDraft.js')
  const { GLYPH } = await import('../../src/components/mercury-ui/glyphs.js')
  check('the caret block is one cell wide', [...(GLYPH.caretBlock as string)].length === 1)
  const atEnd = caretLens({ text: 'launch two', caret: 10 }, 40)
  check('end-of-line lens exposes the empty at-cell (block ↔ space swap point)', atEnd.at === '')
  const mid = caretLens({ text: 'launch two', caret: 3 }, 40)
  check('mid-text lens exposes the covered character (painted on BOTH phases)', mid.at === 'n')
}

section('C. one owner, no second timer (source locks)')
{
  const root = join(import.meta.dir, '../../src')
  const textInput = readFileSync(join(root, 'components/TextInput.tsx'), 'utf8')
  const vimInput = readFileSync(join(root, 'components/VimTextInput.tsx'), 'utf8')
  const strips = readFileSync(join(root, 'components/concourse/ConcourseStrips.tsx'), 'utf8')
  const useBlinkSrc = readFileSync(join(root, 'hooks/useBlink.ts'), 'utf8')
  for (const [name, src] of [
    ['TextInput', textInput],
    ['VimTextInput', vimInput],
    ['ConcourseStrips', strips],
  ] as const) {
    check(`${name} consumes the ONE blink owner (useBlink)`, src.includes("from '../hooks/useBlink.js'") || src.includes("from '../../hooks/useBlink.js'"))
    check(`${name} owns NO timer of its own (poison: a second timer)`, !/set(?:Interval|Timeout)\s*\(/.test(src))
  }
  check('useBlink rides useAnimationValue (the shared clock)', useBlinkSrc.includes('useAnimationValue'))
  check('useBlink owns NO timer of its own', !/set(?:Interval|Timeout)\s*\(/.test(useBlinkSrc))
  check(
    'a disabled blinker reads VISIBLE (byte-still law)',
    /enabled \? \(visible \?\? true\) : true/.test(useBlinkSrc),
  )
}

section('D. the focus gates — blink armed only while the composer is focused')
{
  const root = join(import.meta.dir, '../../src')
  const textInput = readFileSync(join(root, 'components/TextInput.tsx'), 'utf8')
  const vimInput = readFileSync(join(root, 'components/VimTextInput.tsx'), 'utf8')
  const strips = readFileSync(join(root, 'components/concourse/ConcourseStrips.tsx'), 'utf8')
  check(
    'TextInput arms on focus + shown + terminal focus + accessibility-off',
    /useBlink\(\s*props\.focus !== false &&\s*props\.showCursor !== false &&\s*terminalFocused &&\s*!accessibility,?\s*\)/.test(textInput),
  )
  check(
    'VimTextInput arms on focus + shown + terminal focus (its preserved accessibility inconsistency)',
    /useBlink\(\s*props\.focus !== false && props\.showCursor !== false && terminalFocused,?\s*\)/.test(vimInput),
  )
  check('the strip arms on its own focus alone', /useBlink\(focused\)/.test(strips))
  check(
    'the strip inversion still keys the phase (both caret cells)',
    (strips.match(/caretPhaseOn/g) ?? []).length >= 3,
  )
}

if (failures > 0) {
  console.error(`\n❌ ${failures} CARET-BLINK PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL CARET-BLINK PROOFS PASS')
