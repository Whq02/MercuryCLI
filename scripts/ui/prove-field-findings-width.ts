#!/usr/bin/env bun
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

process.exit(failures === 0 ? 0 : 1)
