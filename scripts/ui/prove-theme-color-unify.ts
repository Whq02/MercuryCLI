#!/usr/bin/env bun
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

console.log('============================================================')
console.log(' theme chart color unified onto ink/colorize (HB-0212)')
console.log('============================================================')

section('source: chalkForChart is gone; themeColorToAnsi delegates to colorize')

section('behaviour: chart series === legend bullet (the desync is closed)')

;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  MERCURY_DEMO: false,
}
process.env.FORCE_COLOR = '3'

const theme = (await import(join(root, 'src', 'utils', 'theme.ts'))) as {
  getTheme: (n: string) => Record<string, string>
  themeColorToAnsi: (c: string) => string
}
const colorizeMod = (await import(join(root, 'src', 'ink', 'colorize.ts'))) as {
  applyColor: (text: string, color: string) => string
  colorize: (text: string, color: string, type: 'foreground' | 'background') => string
}

const bulletEsc = (c: string): string => {
  const wrapped = colorizeMod.applyColor('X', c)
  return wrapped.slice(0, wrapped.indexOf('X'))
}
const oldChartEsc = (themeColor: string): string => {
  const escFor = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`
  const m = themeColor.match(/rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)/)
  if (m) return escFor(parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10))
  const h = themeColor.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  if (h) {
    const full = h[1]!.length === 3 ? h[1]!.replace(/(.)/g, '$1$1') : h[1]!
    return escFor(parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16))
  }
  return '\x1b[35m'
}

const THEMES = ['dark', 'true-black', 'not-a-theme']
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
check(`FIXED chart series === legend bullet for ALL ${total} (theme × field) cells`, agree === total, `themeColorToAnsi in src/utils/theme.ts must give the same escape as applyColor in src/ink/colorize.ts; ${agree}/${total}`)

const ansiCases = ['ansi:red', 'ansi:blueBright']
let oldDesynced = 0
let newAgreed = 0
for (const c of ansiCases) {
  if (oldChartEsc(c) !== bulletEsc(c)) oldDesynced++
  if (theme.themeColorToAnsi(c) === bulletEsc(c)) newAgreed++
}
check('the OLD rgb/hex-only chart path DESYNCED on ansi: colors (magenta vs the real color)', oldDesynced === ansiCases.length, 'the old-path stand-in oldChartEsc in this script no longer differs from applyColor in src/ink/colorize.ts for ansi: colors; check applyColor')
check('the NEW colorize path AGREES with the legend on those same ansi: colors', newAgreed === ansiCases.length, 'themeColorToAnsi in src/utils/theme.ts must delegate to colorize in src/ink/colorize.ts so ansi: colors match the legend bullet')
check('the OLD chart path actually returned the magenta fallback for an ansi: color', oldChartEsc('ansi:blueBright') === '\x1b[35m', 'oldChartEsc in this script must return the magenta fallback for an ansi: color; the stand-in was edited')
check('the NEW chart path does NOT return magenta for that ansi: color', theme.themeColorToAnsi('ansi:blueBright') !== '\x1b[35m', 'themeColorToAnsi in src/utils/theme.ts must not fall back to magenta; it must delegate to colorize in src/ink/colorize.ts')

for (const channel of ['foreground', 'background'] as const) {
  for (const name of ['not-a-color', ...Object.getOwnPropertyNames(Object.prototype)]) {
    const color = `ansi:${name}`
    try {
      check(`${channel} ignores invalid ${color}`, colorizeMod.colorize('X', color, channel) === 'X', 'colorize in src/ink/colorize.ts must return the text unchanged for an unknown ansi: name')
    } catch (error) {
      check(`${channel} ignores invalid ${color}`, false, 'colorize in src/ink/colorize.ts must not throw for an unknown ansi: name; ' + String(error))
    }
  }
}
check('named foreground keeps its escape bytes', colorizeMod.colorize('X', 'ansi:red', 'foreground') === '\x1b[31mX\x1b[39m', 'colorize in src/ink/colorize.ts must wrap ansi:red foreground in 31m and 39m')
check('named background keeps its escape bytes', colorizeMod.colorize('X', 'ansi:red', 'background') === '\x1b[41mX\x1b[49m', 'colorize in src/ink/colorize.ts must wrap ansi:red background in 41m and 49m')

section('behaviour: NO_COLOR (chalk level 0) — no magenta leak, chart === legend')
const childScript =
  `globalThis.MACRO={VERSION:'1.0.0',ISSUES_EXPLAINER:'',PACKAGE_URL:'',README_URL:'',IS_DEV:false,MERCURY_DEMO:false};` +
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
check('at NO_COLOR, the chart series leaks NO magenta for any color', colorsL0.length > 0 && noLeak === colorsL0.length, `themeColorToAnsi in src/utils/theme.ts must give no escape at NO_COLOR; ${noLeak}/${colorsL0.length}`)
check('at NO_COLOR, the chart series === the legend bullet (both bare) for every color', colorsL0.length > 0 && agreeL0 === colorsL0.length, `themeColorToAnsi in src/utils/theme.ts and applyColor in src/ink/colorize.ts must agree at NO_COLOR; ${agreeL0}/${colorsL0.length}`)
check('at NO_COLOR, a valid color yields an EMPTY escape (matches the old chalkForChart)', parsed['#DE4A35']?.series === '', 'themeColorToAnsi in src/utils/theme.ts must return an empty string at NO_COLOR for a valid color')

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0212 — theme chart color unified onto colorize')
  process.exit(0)
} else {
  console.log(` ❌ HB-0212 — ${failures} check(s) failed`)
  process.exit(1)
}
