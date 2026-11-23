#!/usr/bin/env bun


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
  check("the vendored pattern is non-unicode-mode (flags 'g' alone) — the premise", vendored.flags === 'g', `flags are ${vendored.flags}; the emoji-regex package changed, so re-check how EMOJI_CLUSTER_RE is built in src/screen/renderer/stringWidth.ts`)
  const withU = new RegExp(`^(?:${vendored.source})$`, 'u')
  const noU = new RegExp(`^(?:${vendored.source})$`)
  check('POISON mechanism: the source compiled under u fails every astral cluster; without u it matches them', ['👍', '👍🏽', '🇺🇸', '👨‍💻'].every(s => !withU.test(s) && noU.test(s)), 'the emoji-regex pattern no longer behaves as this proof assumes; re-check how EMOJI_CLUSTER_RE is compiled in src/screen/renderer/stringWidth.ts (it must stay without the u flag)')
  const { __correctedWidthForTest: width } = await import('../../src/screen/renderer/stringWidth.ts')
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
    check(`corrected width of ${JSON.stringify(s)} is ${expected}`, width(s) === expected, `got ${width(s)}; change correctedWidth, clusterWidth and emojiClusterWidth in src/screen/renderer/stringWidth.ts so this cluster measures ${expected} cells`)
  }
}

process.exit(failures === 0 ? 0 : 1)
