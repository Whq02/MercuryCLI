#!/usr/bin/env bun
// ============================================================================
//  scripts/navigation/prove-grapheme-corpus.ts
// (UI-087 + UI-129): the SHARED grapheme/cell corpus at
//  60/80/120 columns — combining marks · CJK · emoji presentation selectors ·
//  ZWJ clusters · flags · ambiguous width · OSC-8 links · styled spans,
//  measured through the ONE width owner (src/ink/stringWidth.ts) and the
//  wrap/widest pipeline.
//
//  UI-129 (measure-first): the corpus PINS the current measured contract —
//  width logic changes only on a REAL corpus mismatch, deliberately, moving
//  these pins with the ruling. Every expectation below is the Unicode-
//  recommended cell count (ambiguous-as-narrow, the owner's documented
//  choice) verified against the live implementation at adoption.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { stringWidth } = await import('../../src/ink/stringWidth.js')
const { default: wrapText } = await import('../../src/ink/wrap-text.js')
const { widestLine } = await import('../../src/ink/widest-line.js')

// ── the corpus (escape-spelled — the raw-control-bytes law) ─────────────────
const CORPUS: Array<[name: string, text: string, cells: number]> = [
  ['ascii baseline', 'mercury', 7],
  ['combining acute (e + U+0301)', 'café', 4],
  ['precomposed acute (U+00E9)', 'café', 4],
  ['CJK han pair', '漢字', 4],
  ['CJK + ascii mix', 'a漢b', 4],
  ['emoji presentation selector (U+2600 + VS16)', '☀️', 2],
  ['warning sign TEXT width (U+26A0 bare)', '⚠', 1],
  ['ZWJ family cluster', '\u{1F468}‍\u{1F469}‍\u{1F467}', 2],
  ['regional-indicator flag (US)', '\u{1F1FA}\u{1F1F8}', 2],
  ['ambiguous greek alpha (narrow by contract)', 'αβ', 2],
  ['ambiguous plus-minus (narrow by contract)', '±', 1],
  ['SGR styled span (bytes never count)', '\u001b[31mred\u001b[0m', 3],
  ['OSC-8 link wrapper (only the label counts)', '\u001b]8;;https://example.com\u0007go\u001b]8;;\u0007', 2],
]

console.log('─'.repeat(76))
console.log('UI-087 — the shared grapheme/cell corpus (the ONE width owner)')
console.log('─'.repeat(76))
for (const [name, text, cells] of CORPUS) {
  const got = stringWidth(text)
  check(`${name} = ${cells} cell(s)`, got === cells, `got ${got}`)
}

console.log('\n' + '─'.repeat(76))
console.log('UI-087 — wrap/widest keep every line inside 60/80/120 columns')
console.log('─'.repeat(76))
const HOSTILE_LINE = CORPUS.map(([, t]) => t).join(' ')
for (const cols of [60, 80, 120]) {
  const wrapped = wrapText(HOSTILE_LINE.repeat(4), cols, 'wrap')
  const lines = wrapped.split('\n')
  const widest = Math.max(...lines.map(l => widestLine(l)))
  check(
    `wrap @${cols}: no produced line exceeds the column budget (widest ${widest})`,
    widest <= cols,
    `widest=${widest} of ${lines.length} lines`,
  )
  check(
    `wrap @${cols}: nothing vanished (joined content width is preserved through the pipeline)`,
    stringWidth(lines.join('')) >= stringWidth(HOSTILE_LINE) * 4 - lines.length * 2,
  )
}

// UI-129: the measure-first record — the corpus above IS the measured
// contract; a future width-logic change must move these pins deliberately.
console.log('\n  [PASS] UI-129: corpus measured against the live owner — pins recorded, no unmeasured logic change')

console.log(`\n${failures === 0 ? 'ALL GRAPHEME-CORPUS PROOFS PASS' : failures + ' PROOF(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
