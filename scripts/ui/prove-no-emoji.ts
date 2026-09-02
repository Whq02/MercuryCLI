#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-no-emoji.ts
//  PROOF (a ratchet): the "no emoji — mascot is <Crab/>" HARD rule of the TUI
//  is locked mechanically here (the wards engine, src/utils/wards/wards.ts,
//  mirrors the same EMOJI class at edit time):
//  scan every live TUI surface (src/components, src/screens, src/commands)
//  for TRUE-emoji codepoints in non-comment lines — the pictographic blocks
//  U+1F300–U+1FAFF plus the emoji-presentation selector U+FE0F — and fail on
//  any hit. The sanctioned GLYPH vocabulary (✳ ● ◐ │ …) lives in the dingbat/
//  geometric ranges and is deliberately NOT matched here; its own width/SoT
//  discipline is scripts/ui/prove-glyph-width.ts + the glyphs.ts vocabulary.
//
//  Current state at introduction: ZERO hits — so this is a
//  zero-allowlist floor, not a frozen-debt ratchet. Keep it that way: a
//  legitimate pictograph belongs nowhere in this TUI.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-no-emoji.ts
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const TREES = ['src/components', 'src/screens', 'src/commands']

// True-emoji blocks: Misc Symbols & Pictographs → Symbols for Legacy Computing
// (U+1F300–U+1FAFF covers 1F300 pictographs, 1F600 emoticons, 1F680 transport,
// 1F900 supplemental, 1FA70 extended-A) + the emoji variation selector.
const EMOJI = /[\u{1F300}-\u{1FAFF}]|\u{FE0F}/u

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (e === 'node_modules' || e === '__snapshots__') continue
      walk(p, out)
    } else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
      out.push(p)
    }
  }
}

function isComment(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' no-emoji — pictograph floor over the live TUI trees')
console.log('============================================================')

const offenders: string[] = []
for (const tree of TREES) {
  const files: string[] = []
  walk(join(ROOT, tree), files)
  for (const abs of files) {
    const rel = relative(ROOT, abs).split('\\').join('/')
    const lines = readFileSync(abs, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (isComment(line)) continue
      if (EMOJI.test(line)) offenders.push(`${rel}:${i + 1}`)
    }
  }
}

check(
  'zero true-emoji codepoints in live TUI sources (components/screens/commands)',
  offenders.length === 0,
  offenders.length ? `offenders:\n      - ${offenders.join('\n      - ')}` : 'clean',
)

// ── §2 TEXT-PRESENTATION census (small-fix bundle item 10) ──────────────────
// Codepoints that carry the Unicode Emoji property but live OUTSIDE the
// pictographic planes §1 bans (BMP dingbats/symbols: ✳ ⚠ ℹ ▶ …) default to
// COLOUR EMOJI in Windows Terminal unless followed by U+FE0E (VARIATION
// SELECTOR-15, the text-presentation selector) — the operator's screenshot
// showed the thinking token's ✳ rendering as an emoji. The census: every
// such codepoint in a rendered-TUI source line must be IMMEDIATELY followed
// by \uFE0E (either the literal selector or the '\uFE0E' escape on the same
// glyph token). Derived from Unicode emoji-data.txt (Emoji=Yes), curated to
// the BMP; the pictographic planes stay §1's business.
// (©/®/™ — 00A9/00AE/2122 — are emoji-ELIGIBLE by the data file but stay in
// terminal text fonts (Latin-1/letterlike, never routed to the emoji font),
// and they appear inside non-rendered data strings (the macOS option-key
// alphabet); they are deliberately OUT of this census. Widen if the field
// ever shows one painted as emoji.)
const EMOJI_ELIGIBLE_BMP: Array<[number, number]> = [
  [0x203c, 0x203c], [0x2049, 0x2049],
  [0x2139, 0x2139], [0x2194, 0x2199], [0x21a9, 0x21aa],
  [0x231a, 0x231b], [0x2328, 0x2328], [0x23cf, 0x23cf], [0x23e9, 0x23f3],
  [0x23f8, 0x23fa], [0x24c2, 0x24c2], [0x25aa, 0x25ab], [0x25b6, 0x25b6],
  [0x25c0, 0x25c0], [0x25fb, 0x25fe], [0x2600, 0x2604], [0x260e, 0x260e],
  [0x2611, 0x2611], [0x2614, 0x2615], [0x2618, 0x2618], [0x261d, 0x261d],
  [0x2620, 0x2620], [0x2622, 0x2623], [0x2626, 0x2626], [0x262a, 0x262a],
  [0x262e, 0x262f], [0x2638, 0x263a], [0x2640, 0x2640], [0x2642, 0x2642],
  [0x2648, 0x2653], [0x265f, 0x2660], [0x2663, 0x2663], [0x2665, 0x2666],
  [0x2668, 0x2668], [0x267b, 0x267b], [0x267e, 0x267f], [0x2692, 0x2697],
  [0x2699, 0x2699], [0x269b, 0x269c], [0x26a0, 0x26a1], [0x26a7, 0x26a7],
  [0x26aa, 0x26ab], [0x26b0, 0x26b1], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26c8, 0x26c8], [0x26ce, 0x26cf], [0x26d1, 0x26d1], [0x26d3, 0x26d4],
  [0x26e9, 0x26ea], [0x26f0, 0x26f5], [0x26f7, 0x26fa], [0x26fd, 0x26fd],
  [0x2702, 0x2702], [0x2705, 0x2705], [0x2708, 0x270d], [0x270f, 0x270f],
  [0x2712, 0x2712], [0x2714, 0x2714], [0x2716, 0x2716], [0x271d, 0x271d],
  [0x2721, 0x2721], [0x2728, 0x2728], [0x2733, 0x2734], [0x2744, 0x2744],
  [0x2747, 0x2747], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2763, 0x2764], [0x2795, 0x2797], [0x27a1, 0x27a1],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2934, 0x2935], [0x2b05, 0x2b07],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x3030, 0x3030],
  [0x303d, 0x303d], [0x3297, 0x3297], [0x3299, 0x3299],
]
const isEligible = (cp: number): boolean =>
  EMOJI_ELIGIBLE_BMP.some(([lo, hi]) => cp >= lo && cp <= hi)

/** Offending positions: eligible codepoint NOT immediately followed by VS15
 *  (literal) or the `\uFE0E`/`\ufe0e` ESCAPE spelling in source text. */
export function bareEligiblePositions(line: string): number[] {
  const out: number[] = []
  const chars = [...line]
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]!.codePointAt(0)!
    if (!isEligible(cp)) continue
    const next = chars[i + 1]
    if (next === '\uFE0E') continue
    const rest = line.slice(chars.slice(0, i + 1).join('').length)
    if (/^\\u[fF][eE]0[eE]/.test(rest)) continue
    out.push(i)
  }
  return out
}

// The census trees: the §1 TUI trees plus the rendered-token estates that
// feed them (cockpit row builders, model-deprecation marker, resource
// summaries, the shared constants).
const CENSUS_TREES = [
  ...TREES,
  'src/utils/cockpit',
  'src/utils/model',
  'src/services/resources',
  'src/constants',
]
const bare: string[] = []
for (const tree of CENSUS_TREES) {
  const files: string[] = []
  walk(join(ROOT, tree), files)
  for (const abs of files) {
    const rel = relative(ROOT, abs).split('\\').join('/')
    const lines = readFileSync(abs, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (isComment(line)) continue
      if (bareEligiblePositions(line).length > 0) bare.push(`${rel}:${i + 1}`)
    }
  }
}
check(
  'every emoji-eligible glyph in the rendered estates carries VS15 (U+FE0E, text presentation)',
  bare.length === 0,
  bare.length ? `bare:\n      - ${bare.join('\n      - ')}` : 'clean',
)

// Poison controls: the checker itself must bite — a bare ✳ trips it, the
// selector-carrying forms do not.
check('poison: a bare \\u2733 trips the checker', bareEligiblePositions("const G = '\u2733'").length === 1)
check('poison: a bare \\u26A0 trips the checker', bareEligiblePositions("glyph: '\u26a0',").length === 1)
check('control: \\u2733 + literal VS15 passes', bareEligiblePositions("const G = '\u2733\ufe0e'").length === 0)
check('control: \\u2733 + escape spelling passes', bareEligiblePositions("const G = '\u2733\\uFE0E'").length === 0)
check('control: the sanctioned non-eligible vocabulary never trips (✻ ✶ ✦ ✓ ✎ ❯ ⚑ ▲)', bareEligiblePositions('✻ ✶ ✦ ✓ ✎ ❯ ⚑ ▲').length === 0)

console.log(failures === 0 ? '\nALL NO-EMOJI PROOFS PASS' : `\n${failures} PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
