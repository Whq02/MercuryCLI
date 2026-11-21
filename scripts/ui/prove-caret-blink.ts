#!/usr/bin/env bun
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
  const { GLYPH } = await import('../../src/utils/glyphs.js')
  check('the caret block is one cell wide', [...(GLYPH.caretBlock as string)].length === 1)
  const atEnd = caretLens({ text: 'launch two', caret: 10 }, 40)
  check('end-of-line lens exposes the empty at-cell (block ↔ space swap point)', atEnd.at === '')
  const mid = caretLens({ text: 'launch two', caret: 3 }, 40)
  check('mid-text lens exposes the covered character (painted on BOTH phases)', mid.at === 'n')
}


if (failures > 0) {
  console.error(`\n❌ ${failures} CARET-BLINK PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL CARET-BLINK PROOFS PASS')
