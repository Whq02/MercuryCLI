#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const source = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

const { STARTUP_MENU, menuRowWarning } = await import('../../src/substrate/startupMenu.ts')
const { STILLS, composeSovereignMenu, readStill, renderStill, stillPath, SOVEREIGN_ROW_ENV } = await import('./sovereign-menu-stills.ts')

const WORDS = 'nothing asks or stops you — every action runs as you'
const AMBER = '\x1b[38;2;219;161;61m'
const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
const sovereignRow = STARTUP_MENU.find(row => row.env === SOVEREIGN_ROW_ENV)

section('§1 the one warning: the Sovereign mode row alone carries it, and only while it reads on')
{
  check('the Sovereign mode row declares the warning words', sovereignRow?.warnWhenOn === WORDS, JSON.stringify(sovereignRow?.warnWhenOn))
  check('no other row warns (the owner approved the warning line and nothing else)', STARTUP_MENU.every(row => row.env === SOVEREIGN_ROW_ENV || row.warnWhenOn === undefined), STARTUP_MENU.filter(row => row.warnWhenOn !== undefined).map(row => row.env).join(','))
  check('the row reads on at its one option: the warning is the words', sovereignRow !== undefined && menuRowWarning(sovereignRow, '1') === WORDS)
  check('the row at its default (off) warns nothing', sovereignRow !== undefined && menuRowWarning(sovereignRow, null) === null)
  check('a value that is not one of the row\'s choices warns nothing', sovereignRow !== undefined && menuRowWarning(sovereignRow, '0') === null && menuRowWarning(sovereignRow, 'true') === null)
  check('the words fit the control plane at the narrowest wide tier (110 columns) in one line, never clipped', `▲ ${WORDS}`.length <= 56, String(`▲ ${WORDS}`.length))
  check('nothing else about the row moved: label, option, default and summary stand', sovereignRow?.label === 'Sovereign mode' && sovereignRow.kind === 'toggle' && sovereignRow.options.join(',') === '1' && sovereignRow.defaultLabel === 'off' && sovereignRow.summary === 'no permission question is asked — not for files, commands, or computer use; you take the wheel', JSON.stringify(sovereignRow))
}

section('§2 the stored frames: 120×40 (the wide tier) and 80×24 (the classic tier) byte-match the live composition')
for (const still of STILLS) {
  const live = renderStill(still.compose())
  const written = readStill(still.id)
  if (written === null) {
    check(`${still.id}: fixture present (bun scripts/ui/sovereign-menu-stills.ts --write)`, false, stillPath(still.id))
    continue
  }
  check(`${still.id}: the live composition byte-matches the written still`, live === written, 'regenerate on purpose: bun scripts/ui/sovereign-menu-stills.ts --write')
}

section('§3 the line sits directly under the row, once, in both tiers — and is absent while the row reads off')
for (const [cols, rows] of [[120, 40], [80, 24]] as const) {
  const on = composeSovereignMenu(cols, rows)
  const rowLine = /❯ Sovereign mode\s+on(\s|$)/
  const rowAt = on.findIndex(line => rowLine.test(line))
  const warnAt = on.findIndex(line => line.includes(`▲ ${WORDS}`))
  check(`${cols}×${rows} on: the Sovereign mode row is painted, selected, reading on`, rowAt >= 0, on.join('\n'))
  check(`${cols}×${rows} on: the warning line is the very next line`, warnAt === rowAt + 1, JSON.stringify({ rowAt, warnAt }))
  check(`${cols}×${rows} on: exactly one warning line in the frame`, on.filter(line => line.includes('▲')).length === 1)
  check(`${cols}×${rows} on: no line exceeds the frame`, on.every(line => strip(line).length <= cols), String(Math.max(...on.map(line => strip(line).length))))
  const off = composeSovereignMenu(cols, rows, { sovereign: 'off' })
  const offRowAt = off.findIndex(line => /❯ Sovereign mode\s+default \(off\)/.test(line))
  check(`${cols}×${rows} off: no warning line anywhere`, off.every(line => !line.includes('▲')))
  check(`${cols}×${rows} off: the row reads its default`, offRowAt >= 0)
  check(`${cols}×${rows} off: the line under the row is the next group or entry, not a warning`, offRowAt >= 0 && !(off[offRowAt + 1] ?? '').includes('▲') && strip(off[offRowAt + 1] ?? '').trim() !== `▲ ${WORDS}`)
}
{
  const micro = composeSovereignMenu(40, 8)
  check('the micro tier (below the 48×10 floor) keeps the row and its value and paints no warning line (the shred has no row to spare)', micro.some(line => line.includes('Sovereign mode')) && micro.every(line => !line.includes('▲')), micro.join('\n'))
}

section('§4 the colour: the warning token (amber), the theme\'s own warning colour, the product\'s warn glyph')
{
  const wide = composeSovereignMenu(120, 40, { color: true })
  const classic = composeSovereignMenu(80, 24, { color: true })
  for (const [name, frame] of [['120×40', wide], ['80×24', classic]] as const) {
    const line = frame.find(l => strip(l).includes(`▲ ${WORDS}`))
    check(`${name}: the warning line is painted in the warning token rgb(219, 161, 61)`, line !== undefined && line.includes(`${AMBER}▲ ${WORDS}`), line ? JSON.stringify(line) : 'no warning line')
  }
  check("the splash core's AMBERC is the theme's warning token", /const AMBERC = \[219, 161, 61\]/.test(source('assets/splash/splash-core.mjs')) && /warning: 'rgb\(219, 161, 61\)'/.test(source('src/utils/theme.ts')))
  check('the glyph is the product\'s warn lead (▲, width one)', /warn: '▲'/.test(source('src/components/mercury-ui/glyphs.ts')))
}

section('§5 both hosts paint it from the one registry fact, through the one composer')
{
  const core = source('assets/splash/splash-core.mjs')
  check('the composer paints an entry\'s warn under its row in the wide tier', /if \(r2\.warn\) \{\s*cRowEntry\.push\(-1\)\s*cRows\.push\(' ' \+ paint\(AMBERC\) \+ '▲ ' \+ r2\.warn \+ R\)/.test(core))
  check('…and in the classic tier', /if \(row\.warn\) \{\s*listEntry\.push\(-1\)\s*listLines\.push\('  ' \+ paint\(AMBERC\) \+ '▲ ' \+ row\.warn \+ R\)/.test(core))
  check('the baked registry carries the words on the Sovereign row and null on every other', (core.match(/"warnWhenOn":null/g) ?? []).length === STARTUP_MENU.length - 1 && core.includes(`"warnWhenOn":${JSON.stringify(WORDS)}`))
  check('the runtime Boot Menu face resolves the warning from the row and the value it shows (a pin or the saved choice)', source('src/components/BootSettingsScreen.tsx').includes('warn: menuRowWarning(row, envPinned ? (effective?.value ?? null) : (saved[row.env] ?? null))'))
  check('the launcher splash resolves it the same way from the baked row (a pin or the saved choice reading on)', source('assets/splash/mercury-splash.mjs').includes("warn: r2.warnWhenOn && readsAs !== null && r2.choices.some(c => c.v === readsAs && c.l === 'on') ? r2.warnWhenOn : null"))
  check('the bake carries the field', source('scripts/splash/bake-menu.mjs').includes('warnWhenOn: row.warnWhenOn ?? null'))
}

console.log(`\nsovereign menu warning: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
