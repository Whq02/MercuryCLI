#!/usr/bin/env bun
import fc from 'fast-check'
import { lineWidth } from '../../src/screen/renderer/line-width-cache.ts'
import { stringWidth } from '../../src/screen/renderer/stringWidth.ts'

const WHERE = 'lineWidth in src/screen/renderer/line-width-cache.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const shown = (text: string): string => JSON.stringify(text.length > 24 ? `${text.slice(0, 24)}…` : text).replace(/[^\x20-\x7e]/g, char => `\\u{${char.codePointAt(0)!.toString(16)}}`)

console.log('§1 the width of a line, in terminal cells')
{
  const table: Array<[string, number, string]> = [
    ['', 0, 'the empty line'],
    ['a', 1, 'one letter'],
    ['hello world', 11, 'plain words'],
    ['   ', 3, 'spaces'],
    ['caf\u00e9', 4, 'an accented letter in one code point'],
    ['cafe\u0301', 4, 'the same letter with a combining accent'],
    ['e\u0301\u0302', 1, 'one letter under two combining marks'],
    ['\u65e5\u672c\u8a9e', 6, 'three wide characters'],
    ['\ud55c\uae00', 4, 'two wide syllables'],
    ['\uff41\uff42', 4, 'two full-width letters'],
    ['\uff71\uff72\uff73', 3, 'three half-width kana'],
    ['\u3000', 2, 'the wide space'],
    ['\u00a0', 1, 'the no-break space'],
    ['\u{1F600}', 2, 'an emoji'],
    ['\u{1F44D}\u{1F3FD}', 2, 'an emoji with a skin tone'],
    ['\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}', 2, 'four emoji joined into one'],
    ['\u{1F1EF}\u{1F1F5}', 2, 'a flag'],
    ['\u2764\ufe0f', 2, 'a heart shown as an emoji'],
    ['\u2665', 1, 'a heart shown as text'],
    ['\u2713', 1, 'a check mark'],
    ['\u276f prompt', 8, 'a prompt mark and a word'],
    ['\u2500\u2502\u256d\u256f', 4, 'four box-drawing characters'],
    ['a\u200bb', 2, 'two letters around a zero-width space'],
    ['\u200b', 0, 'a zero-width space alone'],
    ['\t', 0, 'a tab'],
    ['\u0000', 0, 'a NUL'],
    ['a\nb', 2, 'two letters around a line feed'],
    ['\u001b[31mred\u001b[0m', 3, 'a word inside colour sequences'],
    ['\u001b]8;;https://x.y\u0007link\u001b]8;;\u0007', 4, 'a word inside a hyperlink sequence'],
    ['x'.repeat(300), 300, 'three hundred letters'],
  ]
  for (const [line, cells, name] of table) {
    const got = lineWidth(line)
    check(`${name}: ${cells}`, got === cells, `${shown(line)} measured ${got}; ${WHERE} answers the cells the line takes on the screen`)
  }
}

console.log('§2 asking again')
{
  const line = 'the same line, asked twice \u65e5\u672c'
  const first = lineWidth(line)
  const again = [lineWidth(line), lineWidth(`${line}`), lineWidth(line.slice(0))]
  check('the same line always measures the same', again.every(width => width === first) && first === 31, `${first} then ${again.join(',')}`)
  const many = Array.from({ length: 5000 }, (_, n) => `line ${n} \u65e5`)
  const widths = many.map(lineWidth)
  check('five thousand different lines each measure right', widths.every((width, n) => width === `line ${n} `.length + 2), `first wrong at ${widths.findIndex((width, n) => width !== `line ${n} `.length + 2)}`)
  check('and the first of them measures the same when asked again afterwards', lineWidth(many[0]!) === widths[0] && lineWidth(many[4999]!) === widths[4999] && lineWidth(line) === first, `${WHERE} must answer the same width however many lines it has been asked about`)
}

console.log('§3 the law: it is the string width, for any line')
{
  const parts = fc.oneof(
    fc.string(),
    fc.string({ unit: 'grapheme' }),
    fc.constantFrom('\u65e5', '\u{1F600}', 'e\u0301', '\u200b', '\u001b[1m', '\u001b[0m', '\uff41', '\t', ' ', '\u2500'),
  )
  const lines = fc.array(parts, { maxLength: 12 }).map(pieces => pieces.join(''))
  const law = fc.check(fc.property(lines, line => lineWidth(line) === stringWidth(line) && lineWidth(line) === stringWidth(line)), { numRuns: 2000 })
  check('on two thousand generated lines it equals stringWidth of the line, asked once and asked again', !law.failed, `counterexample ${law.counterexample ? shown(String(law.counterexample[0])) : ''}; ${WHERE} must agree with stringWidth in src/screen/renderer/stringWidth.ts on every line`)
  const whole = fc.check(fc.property(lines, line => Number.isInteger(lineWidth(line)) && lineWidth(line) >= 0), { numRuns: 500 })
  check('the width is always a whole number, never below zero', !whole.failed, `counterexample ${whole.counterexample ? shown(String(whole.counterexample[0])) : ''}`)
}

if (failures > 0) {
  console.error(`\nprove-line-width-cache-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-line-width-cache-behaviour: all green')
