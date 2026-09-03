#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-no-emoji.ts
//  PROOF (a ratchet): the "no emoji — mascot is <Crab/>" HARD rule of the TUI
//  is locked mechanically here (the wards engine, src/utils/wards/wards.ts,
//  mirrors the same EMOJI class at edit time):
//  scan every live TUI surface (src/components, src/screens, src/commands)
//  for TRUE-emoji codepoints in non-comment lines — the pictographic blocks
//  U+1F300–U+1FAFF plus the emoji-presentation selector U+FE0F — and fail on
//  any hit. The sanctioned GLYPH vocabulary (✻ ● ◐ │ …) lives in the dingbat/
//  geometric ranges and is deliberately NOT matched here; its own width/SoT
//  discipline is scripts/ui/prove-glyph-width.ts + the glyphs.ts vocabulary,
//  and the Unicode Emoji-PROPERTY census over everything painted (the
//  text-default dingbats a colour-font host still draws as pictographs) is
//  scripts/ui/prove-no-emoji-presentation.ts, against the vendored table.
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

// The Emoji-PROPERTY census (the BMP dingbats/symbols a colour-font host
// paints as pictographs — U+26A0, U+2733, U+2714, U+2139, U+25B6 …) lives in
// scripts/ui/prove-no-emoji-presentation.ts: every painted string, template
// chunk, JSX text and figures symbol across src, judged against the vendored
// Unicode table, under bun AND node. The hand-curated range list that once
// sat here was a subset of that table and is retired in its favour.

console.log(failures === 0 ? '\nALL NO-EMOJI PROOFS PASS' : `\n${failures} PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
