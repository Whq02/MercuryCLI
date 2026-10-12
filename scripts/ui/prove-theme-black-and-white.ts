#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { colorSgrSequences, readTeeFrames } from './appleTerminalReading.ts'
import { fixture, ROOT } from './viewportFixture.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'theme-black-and-white-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'proof-home')
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_THEME_PIN
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const DIST = join(ROOT, 'dist', 'mercury.mjs')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const FRAMES = argAfter('--frames')
const KEEP = process.env.THEME_BLACK_AND_WHITE_KEEP === '1'
const ESC = '\x1b'
const UP = `${ESC}[A`
const DOWN = `${ESC}[B`
const RIGHT = `${ESC}[C`

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 500) : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('prove-theme-black-and-white — the no-colour rendering as a chosen appearance')

const themeMod = await import('../../src/utils/theme.ts')
const colorize = await import('../../src/ink/colorize.ts')
const tokensMod = await import('../../src/utils/mercuryTokens.ts')
const systemMod = await import('../../src/utils/systemTheme.ts')
const chalk = (await import('chalk')).default

section('§1 the roster: Black and white is the third appearance, reachable and pinnable, never the default')
{
  check('THEME_NAMES is dark · true-black · mono', JSON.stringify(themeMod.THEME_NAMES) === JSON.stringify(['dark', 'true-black', 'mono']), JSON.stringify(themeMod.THEME_NAMES))
  check('the reachable settings equal the roster', JSON.stringify(themeMod.REACHABLE_THEME_SETTINGS) === JSON.stringify(themeMod.THEME_NAMES))
  check('the settings vocabulary carries it after auto', JSON.stringify(themeMod.THEME_SETTINGS) === JSON.stringify(['auto', 'dark', 'true-black', 'mono']))
  check('the one name is mono and isMonochromeTheme answers it alone', themeMod.MONO_THEME_NAME === 'mono' && themeMod.isMonochromeTheme('mono') && !themeMod.isMonochromeTheme('dark') && !themeMod.isMonochromeTheme('true-black') && !themeMod.isMonochromeTheme('not-a-theme'))
  check('the default stays True Black', systemMod.DEFAULT_THEME_SETTING === 'true-black')
  const theme = themeMod.getTheme('mono')
  check('getTheme(mono) resolves every role (the roles are moot at depth 0 but never empty)', Object.values(theme).every(v => typeof v === 'string' && v.length > 0))
  const tokens = tokensMod.resolveMercuryTokens('mono', '#DD4444')
  check('the semantic tokens resolve completely', tokensMod.listUnresolvedTokenRoles(tokens).length === 0, tokensMod.listUnresolvedTokenRoles(tokens).join(','))
  check('it is not a dark family: no painted canvas', !tokensMod.isDarkThemeFamily('mono') && tokens.canvas === undefined)
  const oasis = await import('../../src/utils/cockpit/oasisBg.ts')
  delete process.env.MERCURY_OASIS_BG
  process.env.TERM = 'xterm-256color'
  check('the ground owner never paints OSC 11 under it (the terminal keeps its own ground)', oasis.oasisBgEnabled(true, 'mono') === false)
  const picker = readFileSync(join(ROOT, 'src/components/ThemePicker.tsx'), 'utf8')
  check('the one label owner names the row Black and white and the picker reads it', readFileSync(join(ROOT, 'src/utils/theme.ts'), 'utf8').includes("mono: 'Black and white'") && picker.includes('THEME_LABELS_BY_SETTING: Record<string, string> = THEME_LABELS') && themeMod.themeLabel('mono') === 'Black and white' && themeMod.themeLabel('dark') === 'Oasis dark')
  check('the /config submenu reads the same owner', readFileSync(join(ROOT, 'src/components/Settings/Config.tsx'), 'utf8').includes("{ auto: 'auto', ...THEME_NAMES_BY_SETTING }"))
  check('the first-run fitting offers it', readFileSync(join(ROOT, 'src/components/Onboarding.tsx'), 'utf8').includes("value: 'mono'"))
  const provider = readFileSync(join(ROOT, 'src/components/design-system/ThemeProvider.tsx'), 'utf8')
  check('the root provider applies the depth in the render that carries the theme and restores it on unmount', provider.includes('if (ownsColorDepth) setMonochromeTheme(isMonochromeTheme(resolvedTheme))') && provider.includes('useLayoutEffect(') && provider.includes('setMonochromeTheme(false)'))
  check('the diff highlighter stands down whenever the depth is 0 (the native renderer writes its own colour bytes)', readFileSync(join(ROOT, 'src/components/StructuredDiff.tsx'), 'utf8').includes('|| colorStripped()') && colorize.colorStripped() === (chalk.level === 0))
}

section('§2 the depth switch: the theme strips every colour and keeps the terminal’s own ink weight — bold, dim and reverse stay')
{
  const detected = colorize.DETECTED_CHALK_LEVEL
  check('the detected depth is recorded after the load-time ladder', detected === chalk.level, `${detected} vs ${chalk.level}`)
  check('off at load', colorize.monochromeThemeActive() === false)
  const sample = 'ink'
  chalk.level = 3
  const coloured = colorize.colorize(sample, 'rgb(221, 68, 68)', 'foreground')
  check('at depth 3 the colouriser paints (the control)', coloured !== sample)
  chalk.level = detected
  check('switching on reports a change, leaves the detected depth alone and reads as stripped', colorize.setMonochromeTheme(true) === true && chalk.level === detected && colorize.monochromeThemeActive() && colorize.colorStripped())
  check('switching on again is a no-op', colorize.setMonochromeTheme(true) === false && chalk.level === detected)
  chalk.level = 3
  check('the colouriser returns the text untouched for rgb, hex, ansi256 and named colours, even at depth 3', [colorize.colorize(sample, 'rgb(221, 68, 68)', 'foreground'), colorize.colorize(sample, '#dd4444', 'background'), colorize.colorize(sample, 'ansi256(196)', 'foreground'), colorize.colorize(sample, 'ansi:red', 'foreground')].every(s => s === sample))
  const weighted = colorize.applyTextStyles(sample, { bold: true, dim: true, inverse: true, color: '#dd4444', backgroundColor: '#000000' })
  check('bold, dim and inverse stay — the terminal’s own ink; only the colour goes', weighted === chalk.dim(chalk.bold(chalk.inverse(sample))) && weighted !== sample && !/\x1b\[(3[0-8]|4[0-8]|9[0-7]|10[0-7])/.test(weighted), JSON.stringify(weighted))
  chalk.level = detected
  check('the palette reads as collapsed and 24-bit as inactive', colorize.paletteCollapsed() && !colorize.truecolorActive())
  check('the depth words name the theme', colorize.colorDepthWhy() === 'the Black and white theme paints no colour', colorize.colorDepthWhy())
  check('switching off hands the colour back', colorize.setMonochromeTheme(false) === true && chalk.level === detected && !colorize.monochromeThemeActive() && colorize.colorStripped() === (chalk.level === 0))
  check('switching off again is a no-op', colorize.setMonochromeTheme(false) === false)
  check('the depth words are the ladder’s own again', colorize.colorDepthWhy() !== 'the Black and white theme paints no colour')
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`\nprove-theme-black-and-white: the product arms are SKIPPED — no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(failures === 0 ? 0 : 1)
}
if (!existsSync(DIST)) {
  console.log('\nprove-theme-black-and-white: the product arms are SKIPPED — dist/mercury.mjs absent (bun run build.ts first)')
  process.exit(failures === 0 ? 0 : 1)
}
const node = Bun.which('node')
if (!node) throw new Error('node is required')

type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = Cell[][]
type Mark = { label: string; grid: Grid; atTick: number }
type Arm = { name: string; marks: Mark[]; frames: Array<{ tick: number; data: Uint8Array }>; status: number | null; log: string; config: string }

async function capture(name: string, storedTheme: string, sends: Array<Record<string, unknown>>, total: number, extra: Record<string, string | undefined> = {}): Promise<Arm> {
  const world = fixture(scratch)
  const cfgPath = join(world.config, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg.theme = storedTheme
  writeFileSync(cfgPath, JSON.stringify(cfg))
  writeFileSync(join(world.config, 'settings.json'), JSON.stringify({ view: { reducedMotion: true }, activity: { tips: { enabled: false } } }))
  const env: NodeJS.ProcessEnv = { ...world.env, MERCURY_CRITTER: 'clam', MERCURY_BOOT_PREFLIGHT: '0' }
  delete env.MERCURY_HOME
  delete env.MERCURY_THEME_PIN
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const tee = join(scratch, `${name}.tee.bin`)
  env.VSHOT_TEE = tee
  const out = join(scratch, `${name}.json`)
  const cfgFile = join(scratch, `${name}.capture.json`)
  writeFileSync(cfgFile, JSON.stringify({ argv: [node, DIST], cwd: world.cwd, cols: 120, rows: 40, total, sends, readyText: 'Type a prompt', readySettleTicks: 3, out }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgFile], { cwd: world.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', bytes => { log += String(bytes) })
  child.stderr.on('data', bytes => { log += String(bytes) })
  const status = await new Promise<number | null>(resolveStatus => {
    const wall = setTimeout(() => { log += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(total * 200 + 90_000))
    child.once('error', error => { log += String(error) })
    child.once('close', code => { clearTimeout(wall); resolveStatus(code) })
  })
  writeFileSync(join(scratch, `${name}.log`), log)
  const payload = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }) : null
  const marks = payload?.marks ?? []
  const frames = existsSync(tee) ? readTeeFrames(readFileSync(tee)) : []
  if (status !== 0) console.log(`  ── ${name}: capture exit ${status}\n${log.trim().split('\n').slice(-12).join('\n')}`)
  return { name, marks, frames, status, log, config: cfgPath }
}

const textOf = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').replace(/\s+$/, ''))
const colouredCells = (grid: Grid): number => grid.flat().filter(cell => (cell.fg !== 'default' || cell.bg !== 'default') && cell.c !== undefined).length
const boldCells = (grid: Grid): number => grid.flat().filter(cell => cell.bold).length
const markOf = (arm: Arm, label: string): Mark | undefined => arm.marks.find(m => m.label === label)
const bytesBetween = (arm: Arm, fromLabel: string | null, toLabel: string | null): Uint8Array => {
  const from = fromLabel === null ? 0 : (markOf(arm, fromLabel)?.atTick ?? Number.MAX_SAFE_INTEGER)
  const to = toLabel === null ? Number.MAX_SAFE_INTEGER : (markOf(arm, toLabel)?.atTick ?? 0)
  return Buffer.concat(arm.frames.filter(f => f.tick >= from && f.tick < to).map(f => Buffer.from(f.data)))
}
const colourSgrCount = (bytes: Uint8Array): number => colorSgrSequences(bytes).length
const writeFrames = (arm: Arm): void => {
  if (FRAMES === undefined) return
  mkdirSync(FRAMES, { recursive: true })
  for (const m of arm.marks) writeFileSync(join(FRAMES, `${arm.name}-120x40-${m.label}.txt`), textOf(m.grid).join('\n') + '\n')
}
const gate = { requireAwait: true, minTick: 2, awaitSettleTicks: 3 }

section('§3 the built product with the theme stored: a terminal that advertises 24-bit colour receives none')
const stored = await capture('stored-mono', 'mono', [
  { ...gate, awaitText: '↑↓ choose', awaitSettleTicks: 5, data: '\r', mark: 'boot' },
  { ...gate, awaitText: 'Type a prompt', awaitSettleTicks: 12, awaitStableTicks: 3, data: '', mark: 'session' },
  { ...gate, awaitText: 'Type a prompt', data: '/help' },
  { ...gate, awaitText: '❯ /help', awaitStableTicks: 2, data: '\r' },
  { ...gate, awaitText: 'custom-commands', awaitStableTicks: 3, data: '', mark: 'help' },
  { ...gate, awaitText: 'custom-commands', data: RIGHT },
  { ...gate, awaitText: 'custom-commands', awaitSettleTicks: 4, awaitStableTicks: 3, data: '', mark: 'help-commands' },
  { ...gate, awaitText: 'custom-commands', data: ESC },
  { ...gate, awaitText: 'Type a prompt', awaitPattern: '\\A(?![\\s\\S]*custom-commands)', awaitSettleTicks: 3, data: '' },
  { ...gate, awaitText: 'Type a prompt', data: '/appearance' },
  { ...gate, awaitText: '❯ /appearance', awaitStableTicks: 2, data: '\r' },
  { ...gate, awaitText: '❯ 3. Black and white', awaitStableTicks: 3, data: '', mark: 'picker' },
  { ...gate, awaitText: '❯ 3. Black and white', data: UP },
  { ...gate, awaitText: '❯ 2. True Black', awaitStableTicks: 3, data: '', mark: 'preview-true-black' },
  { ...gate, awaitText: '❯ 2. True Black', data: ESC },
  { ...gate, awaitText: 'Appearance center dismissed', awaitStableTicks: 3, data: '', mark: 'restored' },
], 420)
writeFrames(stored)
{
  const session = markOf(stored, 'session')
  const picker = markOf(stored, 'picker')
  const preview = markOf(stored, 'preview-true-black')
  const restored = markOf(stored, 'restored')
  check('the drive delivered every send (exit 0)', stored.status === 0, `exit ${stored.status}`)
  check('the session frame paints no colour in any cell', session !== undefined && colouredCells(session.grid) === 0, session ? `${colouredCells(session.grid)} coloured cells` : 'no session mark')
  const boot = markOf(stored, 'boot')
  check('the Boot face is plain too', boot !== undefined && colouredCells(boot.grid) === 0, boot ? `${colouredCells(boot.grid)} coloured` : 'no boot mark')
  check('the runtime’s bytes from the Boot face to the session carry no colour sequence (24-bit or 256; the direct splash before the runtime keeps its own capability law)', colourSgrCount(bytesBetween(stored, 'boot', 'session')) === 0, `${colourSgrCount(bytesBetween(stored, 'boot', 'session'))} colour sequences`)
  check('nor do the bytes that open the picker', colourSgrCount(bytesBetween(stored, 'session', 'picker')) === 0, `${colourSgrCount(bytesBetween(stored, 'session', 'picker'))} colour sequences`)
  check('/appearance lists the three rows with Black and white focused', picker !== undefined && textOf(picker.grid).some(l => l.includes('Oasis dark')) && textOf(picker.grid).some(l => l.includes('True Black')) && textOf(picker.grid).some(l => /[❯>] .*Black and white/.test(l)), picker ? textOf(picker.grid).filter(l => /Black and white|True Black|Oasis dark/.test(l)).join(' | ') : 'no picker mark')
  check('the picker frame is still plain (the demo diff included)', picker !== undefined && colouredCells(picker.grid) === 0, picker ? `${colouredCells(picker.grid)} coloured cells` : 'no picker mark')
  check('the status line says the syntax colour is absent on this appearance', picker !== undefined && textOf(picker.grid).some(l => l.includes('no colour on Black and white')), picker ? textOf(picker.grid).filter(l => l.includes('Syntax')).join(' | ') : 'no picker mark')
  check('↑ previews True Black: colour returns to the frame', preview !== undefined && colouredCells(preview.grid) > 0 && colourSgrCount(bytesBetween(stored, 'picker', 'preview-true-black')) > 0, preview ? `${colouredCells(preview.grid)} coloured cells · ${colourSgrCount(bytesBetween(stored, 'picker', 'preview-true-black'))} colour sequences` : 'no preview mark')
  check('esc releases the preview: the frame is plain again and the picker is gone', restored !== undefined && colouredCells(restored.grid) === 0 && !textOf(restored.grid).some(l => l.includes('Oasis dark')), restored ? `${colouredCells(restored.grid)} coloured cells` : 'no restored mark')
  check('the stored theme is untouched by the preview', (JSON.parse(readFileSync(stored.config, 'utf8')) as { theme?: string }).theme === 'mono')
}

section('§3b the one distinction that carries meaning survives: the /help tab bar marks its active tab in bold and reverse with no colour anywhere')
{
  const help = markOf(stored, 'help')
  const commands = markOf(stored, 'help-commands')
  const tabRow = (grid: Grid): Cell[] | undefined => grid.find(row => { const text = row.map(c => c.c || ' ').join(''); return text.includes(' general ') && text.includes(' custom-commands ') })
  const cellsOf = (row: Cell[] | undefined, word: string): Cell[] => {
    if (row === undefined) return []
    const text = row.map(c => c.c || ' ').join('')
    const at = text.indexOf(word)
    return at < 0 ? [] : row.slice(at, at + word.length)
  }
  const marked = (cells: Cell[]): boolean => cells.length > 0 && cells.every(c => c.bold && c.rev)
  const plain = (cells: Cell[]): boolean => cells.length > 0 && cells.every(c => !c.bold && !c.rev)
  check('/help opened in Black and white with its four tabs on one row', help !== undefined && tabRow(help.grid) !== undefined, help ? textOf(help.grid).slice(0, 6).join(' | ') : 'no help mark')
  check('the help frame paints no colour in any cell', help !== undefined && colouredCells(help.grid) === 0, help ? `${colouredCells(help.grid)} coloured cells` : 'no help mark')
  check('the active tab (general) is bold and reverse; the others are neither', help !== undefined && marked(cellsOf(tabRow(help.grid), 'general')) && plain(cellsOf(tabRow(help.grid), 'commands')) && plain(cellsOf(tabRow(help.grid), 'shortcuts')), help ? JSON.stringify(cellsOf(tabRow(help.grid), 'general').map(c => [c.c, c.bold, c.rev])) : 'no help mark')
  check('→ moves the mark to the commands tab and general goes plain', commands !== undefined && marked(cellsOf(tabRow(commands.grid), 'commands')) && plain(cellsOf(tabRow(commands.grid), 'general')), commands ? JSON.stringify(cellsOf(tabRow(commands.grid), 'commands').map(c => [c.c, c.bold, c.rev])) : 'no help-commands mark')
  check('the bytes that opened /help and moved the tab carry no colour sequence', colourSgrCount(bytesBetween(stored, 'session', 'picker')) === 0, `${colourSgrCount(bytesBetween(stored, 'session', 'picker'))} colour sequences`)
}

section('§4 the built product on True Black: the row previews live, enter saves it, and the next boot is plain')
const chosen = await capture('chosen-mono', 'true-black', [
  { ...gate, awaitText: '↑↓ choose', awaitSettleTicks: 5, data: '\r', mark: 'boot' },
  { ...gate, awaitText: 'Type a prompt', awaitSettleTicks: 12, awaitStableTicks: 3, data: '', mark: 'session' },
  { ...gate, awaitText: 'Type a prompt', data: '/appearance' },
  { ...gate, awaitText: '❯ /appearance', awaitStableTicks: 2, data: '\r' },
  { ...gate, awaitText: '❯ 2. True Black', awaitStableTicks: 3, data: '', mark: 'picker' },
  { ...gate, awaitText: '❯ 2. True Black', data: DOWN },
  { ...gate, awaitText: '❯ 3. Black and white', awaitStableTicks: 3, data: '', mark: 'preview-mono' },
  { ...gate, awaitText: '❯ 3. Black and white', data: '\r' },
  { ...gate, awaitText: 'Theme set to Black and white', awaitStableTicks: 3, data: '', mark: 'saved' },
], 420)
writeFrames(chosen)
{
  const session = markOf(chosen, 'session')
  const picker = markOf(chosen, 'picker')
  const preview = markOf(chosen, 'preview-mono')
  const saved = markOf(chosen, 'saved')
  check('the drive delivered every send (exit 0)', chosen.status === 0, `exit ${chosen.status}`)
  check('the True Black session paints colour (the control)', session !== undefined && colouredCells(session.grid) > 0)
  check('the picker opens focused on True Black with Black and white one row below', picker !== undefined && textOf(picker.grid).some(l => /[❯>] .*True Black/.test(l)) && textOf(picker.grid).some(l => l.includes('Black and white')), picker ? textOf(picker.grid).filter(l => /Black and white|True Black/.test(l)).join(' | ') : 'no picker mark')
  check('↓ onto Black and white previews it: every cell loses its colour at once', preview !== undefined && colouredCells(preview.grid) === 0, preview ? `${colouredCells(preview.grid)} coloured` : 'no preview mark')
  check('the bytes after the preview carry no colour sequence', colourSgrCount(bytesBetween(chosen, 'preview-mono', null)) === 0, `${colourSgrCount(bytesBetween(chosen, 'preview-mono', null))} colour sequences`)
  check('enter saves it: the receipt names Black and white, never the stored spelling, and the frame stays plain', saved !== undefined && textOf(saved.grid).some(l => l.includes('Theme set to Black and white')) && !textOf(saved.grid).some(l => l.includes('Theme set to mono')) && colouredCells(saved.grid) === 0, saved ? textOf(saved.grid).filter(l => l.includes('Theme set')).join(' | ') : 'no saved mark')
  check('the config home now stores mono', (JSON.parse(readFileSync(chosen.config, 'utf8')) as { theme?: string }).theme === 'mono')
}

section('§5 the fallback itself: NO_COLOR on True Black paints no colour anywhere, the picker’s demo diff included')
const noColor = await capture('no-color', 'true-black', [
  { ...gate, awaitText: '↑↓ choose', awaitSettleTicks: 5, data: '\r', mark: 'boot' },
  { ...gate, awaitText: 'Type a prompt', awaitSettleTicks: 12, awaitStableTicks: 3, data: '', mark: 'session' },
  { ...gate, awaitText: 'Type a prompt', data: '/appearance' },
  { ...gate, awaitText: '❯ /appearance', awaitStableTicks: 2, data: '\r' },
  { ...gate, awaitText: '❯ 2. True Black', awaitStableTicks: 3, data: '', mark: 'picker' },
  { ...gate, awaitText: '❯ 2. True Black', data: ESC },
  { ...gate, awaitText: 'Appearance center dismissed', awaitStableTicks: 2, data: '', mark: 'closed' },
], 420, { NO_COLOR: '1', FORCE_COLOR: undefined })
writeFrames(noColor)
{
  const session = markOf(noColor, 'session')
  const picker = markOf(noColor, 'picker')
  check('the drive delivered every send (exit 0)', noColor.status === 0, `exit ${noColor.status}`)
  check('the NO_COLOR session is plain', session !== undefined && colouredCells(session.grid) === 0, session ? `${colouredCells(session.grid)} coloured cells` : 'no session mark')
  check('the picker’s demo diff is plain too (the +/- renderer, never the native colour bytes)', picker !== undefined && colouredCells(picker.grid) === 0 && textOf(picker.grid).some(l => l.includes("-  return 'Hello, ' + name")), picker ? `${colouredCells(picker.grid)} coloured cells` : 'no picker mark')
  check('no colour sequence reaches the terminal at all (the direct splash honours NO_COLOR itself)', colourSgrCount(bytesBetween(noColor, null, null)) === 0, `${colourSgrCount(bytesBetween(noColor, null, null))} colour sequences`)
}

if (!KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\n  kept: ${scratch}`)
console.log(failures === 0 ? '\n✅ the Black and white theme: the no-colour rendering, chosen' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
