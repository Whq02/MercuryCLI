#!/usr/bin/env bun
import { Cursor } from '../../src/utils/Cursor.js'

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const RING = String.fromCodePoint(0x030a)
const ACUTE = String.fromCodePoint(0x0301)
const A_RING = String.fromCodePoint(0x00e5)
const E_ACUTE = String.fromCodePoint(0x00e9)
const JAMO_L = String.fromCodePoint(0x1100)
const JAMO_V = String.fromCodePoint(0x1161)
const GA = String.fromCodePoint(0xac00)

const cases: Array<{ name: string; text: string; at: number; ins: string; caret: number; doc: string }> = [
  { name: 'combining ring composes with the preceding a', text: 'abc', at: 1, ins: RING, caret: 1, doc: A_RING + 'bc' },
  { name: 'precomposed a-ring does NOT compose (control)', text: 'abc', at: 1, ins: A_RING, caret: 2, doc: 'a' + A_RING + 'bc' },
  { name: 'Hangul jungseong composes L+V into one syllable', text: JAMO_L + 'QR', at: 1, ins: JAMO_V, caret: 1, doc: GA + 'QR' },
  { name: 'the overshoot used to jump a newline', text: 'e\nX', at: 1, ins: ACUTE, caret: 1, doc: E_ACUTE + '\nX' },
  { name: 'plain append at the end is unchanged', text: 'abc', at: 3, ins: 'Z', caret: 4, doc: 'abcZ' },
  { name: 'plain insert mid-line is unchanged', text: 'abc', at: 2, ins: 'X', caret: 3, doc: 'abXc' },
]

console.log('§1 — the caret lands after the inserted text in the NORMALISED document')
for (const c of cases) {
  const after = Cursor.fromText(c.text, 80, c.at).insert(c.ins)
  check(`${c.name}: caret ${c.caret}`, after.offset === c.caret, `got ${after.offset}`)
  check(`${c.name}: document`, after.text === c.doc, `got ${JSON.stringify(after.text)}`)
}

console.log('§2 — POISON: the isolated-insert arithmetic is gone')
{
  const composing = Cursor.fromText('abc', 80, 1).insert(RING)
  check('the composing insert does NOT return the isolated-length caret (2)', composing.offset !== 2, `got ${composing.offset}`)
}

process.exit(failures === 0 ? 0 : 1)
