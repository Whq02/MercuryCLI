#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-theme-color-unify.ts
//  PROOF for: themeColorToAnsi (the /stats token-chart SERIES color,
//  Stats.tsx:977) kept a PRIVATE chalk path (chalkForChart) + its own rgb()/hex
//  parsers, parallel to ink/colorize (the path applyColor uses for the sibling
//  LEGEND bullets, Stats.tsx:996). The two desynced: chalkForChart pinned 256
//  colors on Apple_Terminal (vs the fork's truecolor legend) AND, having only
//  rgb()/hex matchers, dropped every `ansi:` theme color to a magenta fallback
//  while colorize resolved it correctly.
//
//  Fix: themeColorToAnsi now delegates to colorize('X', c, 'foreground') and
//  slices the bare opening escape — ONE source of truth with the legend.
//
//  Escape-sequence-level proof (NOT vshot — pyte can't distinguish 256 vs
//  truecolor or magenta-vs-blue). theme.ts + colorize.ts are bun-loadable under
//  the fork MACRO sim. Replicates the EXACT Stats.tsx invocation: chart series
//  themeColorToAnsi(c) vs sliced legend bullet applyColor('X', c).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-theme-color-unify.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const themeSrc = readFileSync(join(root, 'src', 'utils', 'theme.ts'), 'utf-8')

console.log('============================================================')
console.log(' theme chart color unified onto ink/colorize (HB-0212)')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
section('source: chalkForChart is gone; themeColorToAnsi delegates to colorize')
check('the private chalkForChart const is deleted', !/const chalkForChart\s*=/.test(themeSrc))
check('the chalk/Chalk import is gone (was unused after the deletion)', !/import chalk.*from 'chalk'/.test(themeSrc) && !/\bnew Chalk\(/.test(themeSrc))
check("the now-unused env import is gone (env.terminal was chalkForChart's only use)", !/import \{ env \} from '\.\/env\.js'/.test(themeSrc))
check('colorize is imported', /import \{ colorize \} from '\.\.\/ink\/colorize\.js'/.test(themeSrc))
// Pin re-cut onto the landed spelling (the sentinel is '\x00' and the
// painted slice guards an absent/leading sentinel) — same invariant: the
// opening escape comes from the shared colouriser and is returned BARE.
check('themeColorToAnsi routes through colorize and slices the bare opening escape', /export function themeColorToAnsi\(themeColor: string\): string \{[\s\S]{0,400}colorize\(sentinel, themeColor, 'foreground'\)[\s\S]{0,200}painted\.slice\(0, idx\)/.test(themeSrc))
// refute caught: a `esc || '\x1b[35m'` floor leaks MAGENTA into a
// NO_COLOR chart (colorize emits no escape at level 0 for VALID colors too) AND
// re-desyncs from the floorless legend. The fix returns the slice BARE.
check('NO magenta floor (the floor would leak into a no-color chart + re-desync)', !/\\x1b\[35m/.test(themeSrc))

// ───────────────────────────────────────────────────────────────────────────
section('behaviour: chart series === legend bullet (the desync is closed)')

// fork MACRO sim so the build stamp/getTheme() resolve; truecolor like the fork.
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  IS_DEMO: false,
}
process.env.FORCE_COLOR = '3'

const theme = (await import(join(root, 'src', 'utils', 'theme.ts'))) as {
  getTheme: (n: string) => Record<string, string>
  themeColorToAnsi: (c: string) => string
}
const colorizeMod = (await import(join(root, 'src', 'ink', 'colorize.ts'))) as {
  applyColor: (text: string, color: string) => string
}

// the bare opening escape the LEGEND bullet uses (Stats.tsx:996 applyColor path)
const bulletEsc = (c: string): string => {
  const wrapped = colorizeMod.applyColor('X', c)
  return wrapped.slice(0, wrapped.indexOf('X'))
}
// a faithful mirror of the DELETED chalkForChart escFor: rgb()/hex ONLY, magenta
// fallback, NO ansi: handling — to demonstrate the desync that existed.
const oldChartEsc = (themeColor: string): string => {
  const escFor = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`
  const m = themeColor.match(/rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)/)
  if (m) return escFor(parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10))
  const h = themeColor.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  if (h) {
    const full = h[1]!.length === 3 ? h[1]!.replace(/(.)/g, '$1$1') : h[1]!
    return escFor(parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16))
  }
  return '\x1b[35m' // magenta fallback — the bug for ansi: colors
}

const THEMES = ['dark', 'dark-ansi', 'light', 'light-ansi']
const FIELDS = ['suggestion', 'success', 'warning']
let agree = 0
let total = 0
for (const name of THEMES) {
  const th = theme.getTheme(name)
  for (const field of FIELDS) {
    const c = th[field]
    if (!c) continue
    total++
    if (theme.themeColorToAnsi(c) === bulletEsc(c)) agree++
  }
}
check(`FIXED chart series === legend bullet for ALL ${total} (theme × field) cells`, agree === total, `${agree}/${total}`)

// the desync demonstrably existed (the OLD rgb/hex-only path) and is now closed.
const ansiCases = [theme.getTheme('dark-ansi').suggestion!, theme.getTheme('light-ansi').suggestion!]
let oldDesynced = 0
let newAgreed = 0
for (const c of ansiCases) {
  if (oldChartEsc(c) !== bulletEsc(c)) oldDesynced++ // old chart magenta vs bullet ansi-color
  if (theme.themeColorToAnsi(c) === bulletEsc(c)) newAgreed++
}
check('the OLD rgb/hex-only chart path DESYNCED on ansi: colors (magenta vs the real color)', oldDesynced === ansiCases.length)
check('the NEW colorize path AGREES with the legend on those same ansi: colors', newAgreed === ansiCases.length)
check('the OLD chart path actually returned the magenta fallback for an ansi: color', oldChartEsc('ansi:blueBright') === '\x1b[35m')
check('the NEW chart path does NOT return magenta for that ansi: color', theme.themeColorToAnsi('ansi:blueBright') !== '\x1b[35m')

// ───────────────────────────────────────────────────────────────────────────
section('behaviour: NO_COLOR (chalk level 0) — no magenta leak, chart === legend')
// chalk's level is fixed at module load from env, so the NO_COLOR regime needs
// a FRESH process. Replicate the production condition: NO_COLOR=1, FORCE_COLOR=0.
const childScript =
  `globalThis.MACRO={VERSION:'1.0.0',ISSUES_EXPLAINER:'',PACKAGE_URL:'',README_URL:'',IS_DEV:false,IS_DEMO:false};` +
  `const t=await import(${JSON.stringify(join(root, 'src', 'utils', 'theme.ts'))});` +
  `const c=await import(${JSON.stringify(join(root, 'src', 'ink', 'colorize.ts'))});` +
  `const out={};for(const color of ['#DE4A35','rgb(87,105,247)','ansi:blueBright']){` +
  `const series=t.themeColorToAnsi(color);const bw=c.applyColor('X',color);` +
  `out[color]={series,bullet:bw.slice(0,bw.indexOf('X'))};}` +
  `console.log('RESULT'+JSON.stringify(out));`
let parsed: Record<string, { series: string; bullet: string }> = {}
try {
  const raw = execFileSync(process.execPath, ['-e', childScript], {
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf-8',
  })
  const line = raw.split('\n').find(l => l.startsWith('RESULT'))
  if (line) parsed = JSON.parse(line.slice('RESULT'.length))
} catch (e) {
  check('NO_COLOR child process ran', false, String(e).slice(0, 80))
}
let noLeak = 0
let agreeL0 = 0
const colorsL0 = Object.keys(parsed)
for (const color of colorsL0) {
  const { series, bullet } = parsed[color]!
  if (!series.includes('\x1b[35m') && !series.includes('[35m')) noLeak++
  if (series === bullet) agreeL0++
}
check('at NO_COLOR, the chart series leaks NO magenta for any color', colorsL0.length > 0 && noLeak === colorsL0.length, `${noLeak}/${colorsL0.length}`)
check('at NO_COLOR, the chart series === the legend bullet (both bare) for every color', colorsL0.length > 0 && agreeL0 === colorsL0.length, `${agreeL0}/${colorsL0.length}`)
check('at NO_COLOR, a valid color yields an EMPTY escape (matches the old chalkForChart)', parsed['#DE4A35']?.series === '')

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0212 — theme chart color unified onto colorize')
  process.exit(0)
} else {
  console.log(` ❌ HB-0212 — ${failures} check(s) failed`)
  process.exit(1)
}
