#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-field-findings-width.ts
// TASK-017 SUPPLEMENT 3 fixes — the width oracle. A pure
//  drive of the primitive plus the source seam.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-field-findings-width.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── §1 · WG-1: the emoji cluster branch matches the clusters it was built for
// Finding WG-1 (important): the vendored emoji-regex ships flags 'g' alone and
// spells astral emoji as surrogate escapes; the oracle compiled that source
// under 'u', so every astral cluster fell through to the per-code-point sum —
// 👍🏽 = 4, 👨‍💻 = 4, 👩‍👩‍👦 = 6 — while the grid paints 2. Under bun the public
// door answers through Bun.stringWidth (the shipped node path never runs), so
// the corrected path is driven through its test seam.
console.log('§1 WG-1 — astral emoji clusters measure the two cells the grid paints')
{
  const emojiRegexFactory = (await import('emoji-regex')).default
  const vendored = emojiRegexFactory()
  check("the vendored pattern is non-unicode-mode (flags 'g' alone) — the premise", vendored.flags === 'g')
  const withU = new RegExp(`^(?:${vendored.source})$`, 'u')
  const noU = new RegExp(`^(?:${vendored.source})$`)
  check('POISON mechanism: the source compiled under u fails every astral cluster; without u it matches them', ['👍', '👍🏽', '🇺🇸', '👨‍💻'].every(s => !withU.test(s) && noU.test(s)))
  const { __correctedWidthForTest: width } = await import('../../src/ink/stringWidth.ts')
  const cases: Array<[string, number]> = [
    ['👍', 2],
    ['👍🏽', 2],
    ['🇺🇸', 2],
    ['👨‍💻', 2],
    ['👩‍👩‍👦', 2],
    ['⚠️', 2],
    // A keycap sequence (digit + VS16 + U+20E3) paints as an emoji cell pair;
    // the digit with the bare selector and no keycap stays one cell.
    ['1️⃣', 2],
    ['1️', 1],
    ['✔', 1],
    ['🇺', 1],
    ['ab', 2],
    ['漢字', 4],
  ]
  for (const [s, expected] of cases) {
    check(`corrected width of ${JSON.stringify(s)} is ${expected}`, width(s) === expected, `got ${width(s)}`)
  }
  const oracle = read('src/ink/stringWidth.ts')
  check('the anchored copy inherits the vendored flags minus the global one', oracle.includes("return new RegExp(`^(?:${vendored.source})$`, vendored.flags.replace('g', ''))"))
  check("POISON: the 'u' spelling is gone", !oracle.includes("emojiRegexFactory().source})$`, 'u')"))
}
// NEEDS-REAL-BOX: type 🇺🇸 then 👍🏽 alone in the composer in Windows Terminal —
// the block caret parks immediately after the glyph, no gap.

process.exit(failures === 0 ? 0 : 1)
