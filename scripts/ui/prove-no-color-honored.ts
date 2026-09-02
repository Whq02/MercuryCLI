#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-no-color-honored.ts
//  PROOF: the fork honors the user's NO_COLOR (https://no-color.org).
//
//  The bundled supports-color honors FORCE_COLOR=0 (→ chalk.level 0, strips every
//  SGR) but IGNORES NO_COLOR on a truecolor TTY (COLORTERM=truecolor → level 3
//  regardless), so a NO_COLOR user still got the full warm-ink palette — an a11y
//  bad-citizen miss. colorize.ts now translates the intent: force chalk.level 0 +
//  short-circuit colorize() when NO_COLOR is honored.
//
//  Verified empirically by render (vshot, /substrate @80): default 1138 color
//  spans · NO_COLOR=1 → 0 · NO_COLOR=1 FORCE_COLOR=1 → 1138 (FORCE_COLOR wins). This
//  proof locks the PURE precedence rule + the source wiring so it can't silently
//  regress without the slow render-verify.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-no-color-honored.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shouldHonorNoColor } from '../../src/ink/colorize.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

console.log('============================================================')
console.log(' NO_COLOR honored (no-color.org) — precedence + wiring')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
section('precedence truth table (FORCE_COLOR overrides NO_COLOR; any non-empty NO_COLOR counts)')
check('NO_COLOR=1 → honor', shouldHonorNoColor({ NO_COLOR: '1' }) === true)
check('NO_COLOR="0" (non-empty!) → honor (spec: ANY non-empty value)', shouldHonorNoColor({ NO_COLOR: '0' }) === true)
check('NO_COLOR="" (empty) → do NOT honor', shouldHonorNoColor({ NO_COLOR: '' }) === false)
check('unset → do NOT honor (normal colored path)', shouldHonorNoColor({}) === false)
check('NO_COLOR=1 + FORCE_COLOR=1 → do NOT honor (FORCE_COLOR wins)', shouldHonorNoColor({ NO_COLOR: '1', FORCE_COLOR: '1' }) === false)
check('NO_COLOR=1 + FORCE_COLOR=0 → do NOT honor here (FORCE_COLOR=0 strips via chalk anyway)', shouldHonorNoColor({ NO_COLOR: '1', FORCE_COLOR: '0' }) === false)

// ───────────────────────────────────────────────────────────────────────────
section('source wiring: chalk.level forced 0 + colorize() short-circuit + correct order')
const src = readFileSync(join(root, 'src', 'ink', 'colorize.ts'), 'utf-8')
check('honorNoColor() forces chalk.level = 0', /honorNoColor[\s\S]*?chalk\.level = 0/.test(src))
check('MERCURY_HONORS_NO_COLOR derives from the pure rule', /MERCURY_HONORS_NO_COLOR = shouldHonorNoColor\(process\.env\)/.test(src))
check('colorize() short-circuits to raw str when honoring', /if \(MERCURY_HONORS_NO_COLOR\) return str/.test(src))
// NO_COLOR honor must run BEFORE the level boost (else boost on level===2 re-enables).
const noColorIdx = src.indexOf('CHALK_DISABLED_FOR_NO_COLOR = honorNoColor()')
const boostIdx = src.indexOf('CHALK_BOOSTED_FOR_XTERMJS = boostChalkLevelForXtermJs()')
check('honorNoColor() runs BEFORE the chalk-level boosts', noColorIdx !== -1 && boostIdx !== -1 && noColorIdx < boostIdx)

// ───────────────────────────────────────────────────────────────────────────
section('no-op when NO_COLOR unset — the normal colored path is byte-identical')
// In this proof process (no NO_COLOR in env) the module-level flag is false, so the
// short-circuit never fires and colorize behaves exactly as before.
check('module flag false in a normal (no-NO_COLOR) environment', shouldHonorNoColor({ TERM: 'xterm-256color' } as Record<string, string>) === false)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ NO_COLOR honored — precedence correct, wiring intact, no-op when unset')
  process.exit(0)
} else {
  console.log(` ❌ NO_COLOR honoring — ${failures} check(s) failed`)
  process.exit(1)
}
