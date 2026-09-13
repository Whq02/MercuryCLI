#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { applyAppleTerminalReading, colorSgrSequences, readTeeFrames, teeBytes } from './appleTerminalReading.ts'
import { fixture, ROOT } from './viewportFixture.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'colour-depth-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'proof-home')
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const DIST = join(ROOT, 'dist', 'mercury.mjs')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 500) : ''}`)
}
function section(title: string): void {
  console.log('\n' + title)
}

console.log('prove-terminal-colour-depth — one answer to 24-bit colour, and every painter reads it')

const colorize = await import('../../src/ink/colorize.ts')
const profile = await import('../../src/ink/session/terminalProfile.ts')
const cellGrid = await import('../../src/ink/cell-grid.ts')
const palette = await import('../../src/components/mercuryPalette.ts')
const colorDiff = await import('../../src/native-ts/color-diff/index.ts')
const chalk = (await import('chalk')).default

section('§1 the fingerprint decides: COLORTERM or a known truecolor terminal, never the name Apple_Terminal alone')
{
  const fp = colorize.truecolorFingerprint
  check('Apple Terminal 455 with no COLORTERM carries no fingerprint', fp({ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '455' }) === null)
  check('Apple Terminal 465 with no COLORTERM carries none either (the name decides nothing)', fp({ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '465' }) === null)
  check('COLORTERM=truecolor is the fingerprint', fp({ TERM_PROGRAM: 'Apple_Terminal', COLORTERM: 'truecolor' }) === 'COLORTERM=truecolor')
  check('COLORTERM=24bit counts', fp({ TERM: 'xterm-256color', COLORTERM: '24bit' }) === 'COLORTERM=24bit')
  check('a bare xterm-256color carries none', fp({ TERM: 'xterm-256color' }) === null)
  check('tmux inside an unadvertised terminal carries none', fp({ TERM: 'screen-256color', TMUX: '/tmp/tmux-1/default,1,0' }) === null)
  check('the VS Code terminal is named', fp({ TERM: 'xterm-256color', TERM_PROGRAM: 'vscode' }) === 'TERM_PROGRAM=vscode')
  check('Windows Terminal is named', fp({ TERM: 'xterm-256color', WT_SESSION: 'a' }) !== null)
  check('iTerm2 is named', fp({ TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' }) === 'TERM_PROGRAM=iTerm.app')
  check('WezTerm and Ghostty are named', fp({ TERM: 'xterm-256color', TERM_PROGRAM: 'WezTerm' }) !== null && fp({ TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty' }) !== null)
  check('Kitty is named by TERM or its window id', fp({ TERM: 'xterm-kitty' }) !== null && fp({ TERM: 'xterm-256color', KITTY_WINDOW_ID: '3' }) !== null)
  check('the depth words are spoken', colorize.colorDepthWhy().length > 20, colorize.colorDepthWhy())
  const src = readFileSync(join(ROOT, 'src', 'ink', 'colorize.ts'), 'utf8')
  check('the fingerprint boost runs before the flag and the tmux clamp', src.includes('CHALK_BOOSTED_FOR_FINGERPRINT = ') && src.includes('CHALK_CLAMPED_FOR_MERCURY = ') && src.includes('CHALK_CLAMPED_FOR_TMUX = ') && src.indexOf('CHALK_BOOSTED_FOR_FINGERPRINT = ') < src.indexOf('CHALK_CLAMPED_FOR_MERCURY = ') && src.indexOf('CHALK_CLAMPED_FOR_MERCURY = ') < src.indexOf('CHALK_CLAMPED_FOR_TMUX = '))
  check('no unconditional level-2 boost remains in the ladder', !/if \(chalk\.level === 2\) \{\s*chalk\.level = 3/.test(src))
}

section('§2 the terminal profile row reads the same answer and names the terminals with the exact palette')
{
  const probe = { platform: 'darwin' as const, isTTY: true, syncOutput: true, extendedKeys: true, hyperlinks: true, progress: true }
  const apple = profile.resolveTerminalProfile({ env: { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }, ...probe })
  const row = apple.checks.find(c => c.id === 'truecolor')
  check('Apple Terminal without COLORTERM: the row is not met and names the absence', row !== undefined && !row.ok && row.evidence.includes('no known truecolor terminal'), row?.evidence)
  check('its remediation says Mercury paints in 256 colors there', (row?.remediation ?? '').includes('paints in 256 colors'), row?.remediation)
  check('the remediation names iTerm2, Ghostty, WezTerm, Kitty and Windows Terminal', /iTerm2.*Ghostty.*WezTerm.*Kitty.*Windows Terminal/.test(row?.remediation ?? ''), row?.remediation)
  check('the remediation names MERCURY_TRUECOLOR=1 as the forced depth', (row?.remediation ?? '').includes('MERCURY_TRUECOLOR=1'))
  const modern = profile.resolveTerminalProfile({ env: { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', COLORTERM: 'truecolor' }, ...probe })
  const modernRow = modern.checks.find(c => c.id === 'truecolor')
  check('Apple Terminal advertising COLORTERM=truecolor meets the row with the fingerprint as evidence', modernRow !== undefined && modernRow.ok && modernRow.evidence === 'COLORTERM=truecolor', modernRow?.evidence)
  const wez = profile.resolveTerminalProfile({ env: { TERM: 'xterm-256color', TERM_PROGRAM: 'WezTerm' }, ...probe })
  check('WezTerm with a plain TERM meets the row', wez.checks.find(c => c.id === 'truecolor')?.ok === true)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`\nprove-terminal-colour-depth: the render arms are SKIPPED — no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(failures === 0 ? 0 : 1)
}
if (!existsSync(DIST)) {
  console.log('\nprove-terminal-colour-depth: the render arms are SKIPPED — dist/mercury.mjs absent (bun run build.ts first)')
  process.exit(failures === 0 ? 0 : 1)
}
const node = Bun.which('node')
if (!node) throw new Error('node is required')

type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = Cell[][]
type Arm = { name: string; marks: Map<string, Grid>; bytes: Uint8Array; enterScreen: Uint8Array; status: number | null; log: string }

async function capture(name: string, extra: Record<string, string | undefined>): Promise<Arm> {
  const world = fixture(scratch)
  const cfgPath = join(world.config, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg.hasCompletedOnboarding = false
  cfg.optionAsMetaKeyInstalled = true
  writeFileSync(cfgPath, JSON.stringify(cfg))
  writeFileSync(join(world.config, 'settings.json'), JSON.stringify({ prefersReducedMotion: true }))
  const env: NodeJS.ProcessEnv = { ...world.env, TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '455' }
  delete env.COLORTERM
  delete env.FORCE_COLOR
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const tee = join(scratch, `${name}.tee.bin`)
  env.VSHOT_TEE = tee
  const out = join(scratch, `${name}.json`)
  const gate = { requireAwait: true, minTick: 3, awaitSettleTicks: 5 }
  const sends = [
    { ...gate, awaitText: '↑↓ preview', data: '', mark: 'theme' },
    { ...gate, awaitText: '↑↓ preview', data: '\r' },
    { ...gate, awaitText: '↵ continue', data: '\r' },
    { ...gate, awaitText: '↑↓ choose', data: '', mark: 'boot' },
    { ...gate, awaitText: '↑↓ choose', data: '\r' },
    { ...gate, awaitText: 'Type a prompt', awaitSettleTicks: 12, data: '', mark: 'session' },
  ]
  const cfgFile = join(scratch, `${name}.capture.json`)
  writeFileSync(cfgFile, JSON.stringify({ argv: [node, DIST], cwd: world.cwd, cols: 120, rows: 40, total: 450, sends, readyText: 'Type a prompt', readySettleTicks: 3, out }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgFile], { cwd: world.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', bytes => { log += String(bytes) })
  child.stderr.on('data', bytes => { log += String(bytes) })
  const status = await new Promise<number | null>(resolveStatus => {
    const wall = setTimeout(() => { log += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(180_000))
    child.once('error', error => { log += String(error) })
    child.once('close', code => { clearTimeout(wall); resolveStatus(code) })
  })
  writeFileSync(join(scratch, `${name}.log`), log)
  const payload = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { marks?: Array<{ label: string; grid: Grid; atTick: number }> }) : null
  const marks = new Map<string, Grid>((payload?.marks ?? []).map(m => [m.label, m.grid]))
  const themeTick = (payload?.marks ?? []).find(m => m.label === 'theme')?.atTick ?? 0
  const frames = existsSync(tee) ? readTeeFrames(readFileSync(tee)) : []
  const enterScreen = Buffer.concat(frames.filter(f => f.tick < themeTick).map(f => Buffer.from(f.data)))
  const bytes = Buffer.concat(frames.filter(f => f.tick >= themeTick).map(f => Buffer.from(f.data)))
  return { name, marks, bytes, enterScreen, status, log }
}

const textOf = (grid: Grid): string => grid.map(row => row.map(cell => cell.c || ' ').join('')).join('\n')
const halfBlocks = (grid: Grid): number => grid.flat().filter(cell => cell.c === '▀' || cell.c === '▄').length
const mascotRows = (grid: Grid): number[] => grid.map((row, y) => (row.filter(cell => cell.c === '▀' || cell.c === '▄').length >= 3 ? y : -1)).filter(y => y >= 0)
const rowsToCompare = (mark: string, grid: Grid): number[] => (mark === 'session' ? mascotRows(grid) : grid.map((_, y) => y))

const apple = await capture('apple-256', {})
const full = await capture('apple-truecolor', { COLORTERM: 'truecolor' })
const clamped = await capture('truecolor-clamped', { COLORTERM: 'truecolor', MERCURY_TRUECOLOR: '0' })

section('§3 the journeys ran: the first-run theme screen, the boot face and a session on each arm')
for (const arm of [apple, full, clamped]) {
  check(`${arm.name}: the capture ended cleanly`, arm.status === 0, arm.log.slice(-600))
  check(`${arm.name}: the three marks were taken`, ['theme', 'boot', 'session'].every(m => arm.marks.has(m)), [...arm.marks.keys()].join(','))
  const theme = arm.marks.get('theme')
  const text = theme ? textOf(theme) : ''
  check(`${arm.name}: the theme screen shows the rows, the mascot and the code preview`, text.includes('Oasis dark') && text.includes('True Black') && text.includes('bootHelm') && theme !== undefined && halfBlocks(theme) > 20, text.slice(0, 300))
  const session = arm.marks.get('session')
  check(`${arm.name}: the session header carries the mascot`, session !== undefined && mascotRows(session).length >= 5)
}

section('§4 with TERM_PROGRAM=Apple_Terminal and COLORTERM unset no 24-bit sequence leaves the process; the paint is 256-colour')
{
  const seqs = colorSgrSequences(apple.bytes)
  const raw24 = seqs.filter(s => s.kind === '24-bit')
  check('no 38;2 / 48;2 sequence from the first-run theme screen through the boot face to the session', raw24.length === 0, `${raw24.length} found, first ${JSON.stringify(raw24.slice(0, 3))}`)
  check('256-colour sequences carry the paint', seqs.filter(s => s.kind === '256').length > 100, `${seqs.length} colour sequences`)
  const read = applyAppleTerminalReading(apple.bytes)
  check('Apple Terminal reads every byte exactly as a 24-bit terminal would (the reading is a no-op)', Buffer.compare(Buffer.from(read), Buffer.from(apple.bytes)) === 0)
  const enter24 = colorSgrSequences(apple.enterScreen).filter(s => s.kind === '24-bit').length
  check('the enter screen before the first-run screen paints in 256 colours too (no 38;2 / 48;2 across the whole boot)', enter24 === 0, `${enter24} 24-bit sequences before the first-run screen`)
}

section('§5 with COLORTERM=truecolor the same screens paint at full depth')
{
  const seqs = colorSgrSequences(full.bytes)
  check('24-bit sequences are present', seqs.filter(s => s.kind === '24-bit').length > 100, `${seqs.length} colour sequences`)
  const read = applyAppleTerminalReading(full.bytes)
  check('Apple Terminal 455 would read that stream differently (the misparse the fix removes)', Buffer.compare(Buffer.from(read), Buffer.from(full.bytes)) !== 0)
}

section('§6 the 256-colour cells are the nearest of the truecolour palette, cell for cell')
{
  const inkIndex = (hex: string): number => {
    const saved = chalk.level
    chalk.level = 2
    try {
      return Number(/38;5;(\d+)m/.exec(chalk.hex(`#${hex}`)('x'))?.[1] ?? -1)
    } finally {
      chalk.level = saved
    }
  }
  const rgbOf = (hex: string): [number, number, number] => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
  const hexOf = (n: number): string => (cellGrid.xterm256ToRgb(n) ?? [0, 0, 0]).map(v => v.toString(16).padStart(2, '0')).join('')
  const nearest = (hex: string): Set<string> => {
    const [r, g, b] = rgbOf(hex)
    return new Set([hexOf(inkIndex(hex)), hexOf(colorDiff.__test.quantizeToAnsi256(r, g, b)), hexOf(cellGrid.rgbToXterm256(r, g, b))])
  }
  const canvases = new Set([palette.groundFamilyFor('dark').NIGHT, palette.groundFamilyFor('true-black').NIGHT].map(c => c.replace('#', '').toLowerCase()))
  const isHex = (v: string): boolean => /^[0-9a-f]{6}$/.test(v)
  const palette256 = new Set(Array.from({ length: 240 }, (_, i) => hexOf(i + 16)))
  const diffRows = (grid: Grid): Set<number> => {
    const rules = grid.map((row, y) => (row.filter(cell => cell.c === '╌').length > 20 ? y : -1)).filter(y => y >= 0)
    const out = new Set<number>()
    if (rules.length >= 2) for (let y = rules[0]!; y <= rules[rules.length - 1]!; y++) out.add(y)
    return out
  }
  for (const mark of ['theme', 'boot', 'session']) {
    const a = apple.marks.get(mark)
    const f = full.marks.get(mark)
    if (!a || !f) continue
    let glyphMismatch = 0
    let coloured = 0
    const wrong: string[] = []
    let groundDropped = 0
    const rows = rowsToCompare(mark, f)
    const preview = mark === 'theme' ? diffRows(f) : new Set<number>()
    const previewPairs = new Map<string, string>()
    const previewWrong: string[] = []
    let previewCells = 0
    check(`${mark}: the rows compared are the same rows on both arms (${rows.length})`, rows.length > 0 && rows.join() === rowsToCompare(mark, a).join(), `${rows.join()} vs ${rowsToCompare(mark, a).join()}`)
    for (const y of rows) {
      for (let x = 0; x < (f[y]?.length ?? 0); x++) {
        const fc = f[y]![x]!
        const ac = a[y]?.[x]
        if (!ac) continue
        if ((fc.c || ' ') !== (ac.c || ' ')) { glyphMismatch++; continue }
        if (preview.has(y)) {
          previewCells++
          for (const plane of ['fg', 'bg'] as const) {
            if (isHex(ac[plane]) && !palette256.has(ac[plane])) previewWrong.push(`${y}:${x} ${plane} ${ac[plane]} is not a 256-palette entry`)
          }
          const key = `${fc.fg}/${fc.bg}`
          const seen = previewPairs.get(key)
          const got = `${ac.fg}/${ac.bg}`
          if (seen === undefined) previewPairs.set(key, got)
          else if (seen !== got) previewWrong.push(`${y}:${x} ${key} painted ${got} after ${seen}`)
          continue
        }
        for (const plane of ['fg', 'bg'] as const) {
          const want = fc[plane]
          const got = ac[plane]
          if (!isHex(want)) {
            if (want !== got) wrong.push(`${mark} ${y}:${x} ${plane} ${want}→${got}`)
            continue
          }
          coloured++
          if (plane === 'bg' && got === 'default' && canvases.has(want)) { groundDropped++; continue }
          if (!nearest(want).has(got)) wrong.push(`${mark} ${y}:${x} ${plane} ${want}→${got} (nearest ${[...nearest(want)].join('/')})`)
        }
      }
    }
    check(`${mark}: the glyphs match cell for cell`, glyphMismatch === 0, `${glyphMismatch} cells differ`)
    check(`${mark}: every coloured cell is the nearest 256 index of its truecolour value (${coloured} planes read, ${groundDropped} estate-ground cells on the terminal's own ground)`, coloured > 50 && wrong.length === 0, wrong.slice(0, 6).join(' · '))
    if (mark === 'theme') {
      check(`theme: the code preview (${previewCells} cells, the colour module's own 256 theme) paints palette entries only and keeps its colour structure`, previewCells > 100 && previewWrong.length === 0, previewWrong.slice(0, 6).join(' · '))
    }
  }
}

section('§7 MERCURY_TRUECOLOR=0 on a truecolour terminal downgrades everywhere, to the same 256-colour frames')
{
  const seqs = colorSgrSequences(clamped.bytes)
  check('no 38;2 / 48;2 sequence with the clamp', seqs.filter(s => s.kind === '24-bit').length === 0)
  for (const mark of ['theme', 'boot', 'session']) {
    const a = apple.marks.get(mark)
    const c = clamped.marks.get(mark)
    if (!a || !c) continue
    let differ = 0
    for (const y of rowsToCompare(mark, a)) {
      for (let x = 0; x < (a[y]?.length ?? 0); x++) {
        const p = a[y]![x]!
        const q = c[y]?.[x]
        if (!q || (p.c || ' ') !== (q.c || ' ') || p.fg !== q.fg || p.bg !== q.bg || p.bold !== q.bold || p.rev !== q.rev) differ++
      }
    }
    check(`${mark}: the clamped frame equals the unadvertised terminal's frame`, differ === 0, `${differ} cells differ`)
  }
}

if (failures === 0) {
  rmSync(scratch, { recursive: true, force: true })
  console.log('\nprove-terminal-colour-depth: all green')
  process.exit(0)
}
console.log(`\nprove-terminal-colour-depth: ${failures} FAILURE(S) — captures kept under ${scratch}`)
process.exit(1)
