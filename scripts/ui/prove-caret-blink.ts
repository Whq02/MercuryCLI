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
  check('ON phase carries the inverse attribute', on.includes(INVERSE_ON), 'Cursor.render in src/utils/Cursor.ts must apply the caret style callback it is given to the caret cell; output: ' + JSON.stringify(on))
  check('OFF phase carries NO inverse attribute', !off.includes(INVERSE_ON), 'Cursor.render in src/utils/Cursor.ts must paint no inverse SGR of its own when the style callback is the identity; output: ' + JSON.stringify(off))
  check(
    'stripped, the phases are byte-identical (a blink moves no text)',
    stripAnsi(on) === stripAnsi(off),
    'Cursor.render in src/utils/Cursor.ts must differ between phases only by the style callback, never in text: ' + JSON.stringify({ on: stripAnsi(on), off: stripAnsi(off) }),
  )
  const onMid = Cursor.fromText('hello', 40, 2).render(' ', '', s => chalk.inverse(s))
  const offMid = Cursor.fromText('hello', 40, 2).render(' ', '', s => s)
  check('covered character kept on the ON phase', stripAnsi(onMid) === 'hello', 'Cursor.render in src/utils/Cursor.ts must keep the character under a mid-text caret; got ' + JSON.stringify(stripAnsi(onMid)))
  check('covered character kept on the OFF phase', offMid === 'hello', 'Cursor.render in src/utils/Cursor.ts must keep the character under a mid-text caret; got ' + JSON.stringify(offMid))
  check(
    'mid-text phases stripped-identical',
    stripAnsi(onMid) === stripAnsi(offMid),
    'Cursor.render in src/utils/Cursor.ts must not change text between phases: ' + JSON.stringify({ on: stripAnsi(onMid), off: stripAnsi(offMid) }),
  )
}

section('B. the strip width law — off phase paints a same-width cell')
{
  const { caretLens } = await import('../../src/components/concourse/lineDraft.js')
  const { GLYPH } = await import('../../src/utils/glyphs.js')
  check('the caret block is one cell wide', [...(GLYPH.caretBlock as string)].length === 1, 'GLYPH.caretBlock in src/utils/glyphs.ts must be a single cell, or the blink shifts the line')
  const atEnd = caretLens({ text: 'launch two', caret: 10 }, 40)
  check('end-of-line lens exposes the empty at-cell (block ↔ space swap point)', atEnd.at === '', 'caretLens in src/components/concourse/lineDraft.ts must return an empty at for a caret past the last character; got ' + JSON.stringify(atEnd.at))
  const mid = caretLens({ text: 'launch two', caret: 3 }, 40)
  check('mid-text lens exposes the covered character (painted on BOTH phases)', mid.at === 'n', 'caretLens in src/components/concourse/lineDraft.ts must return the covered character as at for a mid-text caret; got ' + JSON.stringify(mid.at))
}


if (failures > 0) {
  console.error(`\n❌ ${failures} CARET-BLINK PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL CARET-BLINK PROOFS PASS')
