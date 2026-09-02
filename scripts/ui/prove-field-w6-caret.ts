#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-field-w6-caret.ts
//  TASK-018 wave 6 (input-encoding-and-ime) — the composer caret no longer
//  overshoots when an inserted mark composes with the character before it.
//
//  Cursor.modifyText normalises the whole document to NFC but used to advance
//  the caret by `start + insertString.normalize('NFC').length` — the insertion
//  measured ALONE. When the insertion composes with the character before the
//  caret, the join absorbs code units that isolated length does not know
//  about, so the caret landed one position too far right and the next keystroke
//  inserted after the wrong character. The fix measures the caret against the
//  normalised PREFIX-plus-insertion.
//
//  Pure Cursor/MeasuredText surface — no width or vendored regex, so it runs
//  the same under bun or node.
//  Run: ~/.bun/bin/bun run scripts/ui/prove-field-w6-caret.ts
// ============================================================================
import { Cursor } from '../../src/utils/Cursor.js'

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const RING = String.fromCodePoint(0x030a) // COMBINING RING ABOVE
const ACUTE = String.fromCodePoint(0x0301) // COMBINING ACUTE ACCENT
const A_RING = String.fromCodePoint(0x00e5) // å (a + ring, precomposed)
const E_ACUTE = String.fromCodePoint(0x00e9) // é (e + acute, precomposed)
const JAMO_L = String.fromCodePoint(0x1100) // HANGUL CHOSEONG KIYEOK
const JAMO_V = String.fromCodePoint(0x1161) // HANGUL JUNGSEONG A
const GA = String.fromCodePoint(0xac00) // 가 (L + V, precomposed syllable)

// Each case: start text, caret offset, the inserted string, the caret the
// edit OUGHT to return, and the document it OUGHT to hold.
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

// The defect's own signature: the OLD arithmetic (start + insert-alone length)
// returns 2 for the composing case, one past the truth.
console.log('§2 — POISON: the isolated-insert arithmetic is gone')
{
  const composing = Cursor.fromText('abc', 80, 1).insert(RING)
  check('the composing insert does NOT return the isolated-length caret (2)', composing.offset !== 2, `got ${composing.offset}`)
}

process.exit(failures === 0 ? 0 : 1)
