#!/usr/bin/env bun
import chalk from 'chalk'
import { Cursor } from '../../src/screen/composer/vim/textCursor.js'

chalk.level = 1

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
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
  check('ON phase carries the inverse attribute', on.includes(INVERSE_ON), '', 'Cursor.render in src/screen/composer/vim/textCursor.ts must pass the caret cell through the style function it is given')
  check('OFF phase carries NO inverse attribute', !off.includes(INVERSE_ON), '', 'Cursor.render in src/screen/composer/vim/textCursor.ts must not add styling of its own to the caret cell')
  check(
    'stripped, the phases are byte-identical (a blink moves no text)',
    stripAnsi(on) === stripAnsi(off),
    JSON.stringify({ on: stripAnsi(on), off: stripAnsi(off) }),
    'Cursor.render in src/screen/composer/vim/textCursor.ts must change only the SGR of the caret cell between phases, never the text',
  )
  const onMid = Cursor.fromText('hello', 40, 2).render(' ', '', s => chalk.inverse(s))
  const offMid = Cursor.fromText('hello', 40, 2).render(' ', '', s => s)
  check('covered character kept on the ON phase', stripAnsi(onMid) === 'hello', '', 'Cursor.render in src/screen/composer/vim/textCursor.ts must keep the character under a mid-text caret')
  check('covered character kept on the OFF phase', offMid === 'hello', '', 'Cursor.render in src/screen/composer/vim/textCursor.ts must keep the character under a mid-text caret when the style function is the identity')
  check(
    'mid-text phases stripped-identical',
    stripAnsi(onMid) === stripAnsi(offMid),
    '',
    'Cursor.render in src/screen/composer/vim/textCursor.ts must give both phases the same text when the caret sits mid-text',
  )
}

section('B. the strip width law — off phase paints a same-width cell')
{
  const { caretLens } = await import('../../src/screen/concourse/lineDraft.js')
  const { GLYPH } = await import('../../src/screen/theme/glyphs.js')
  check('the caret block is one cell wide', [...(GLYPH.caretBlock as string)].length === 1, '', 'caretBlock in src/screen/theme/glyphs.ts must stay a single character')
  const atEnd = caretLens({ text: 'launch two', caret: 10 }, 40)
  check('end-of-line lens exposes the empty at-cell (block ↔ space swap point)', atEnd.at === '', '', 'caretLens in src/screen/concourse/lineDraft.ts must return an empty at for a caret at the end of the text')
  const mid = caretLens({ text: 'launch two', caret: 3 }, 40)
  check('mid-text lens exposes the covered character (painted on BOTH phases)', mid.at === 'n', '', 'caretLens in src/screen/concourse/lineDraft.ts must return the character under a mid-text caret as at')
}


if (failures > 0) {
  console.error(`\n❌ ${failures} CARET-BLINK PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL CARET-BLINK PROOFS PASS')
