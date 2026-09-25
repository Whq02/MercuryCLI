#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, FRAMES, argAfter, makeTally } from '../daemon/dupline-world.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { jevReceiptWords } from '../../src/services/jev/jevSetting.ts'

const VSHOT = join(import.meta.dir, 'vshot.py')
const tally = makeTally('prove-popup-owns-keys-drive')
const KEEP = process.argv.includes('--keep')
const LEGS = new Set((argAfter('--legs') ?? 'jev,config,files,jev-compact').split(','))
const DEAD = 'http://127.0.0.1:9'
const ESC = '\x1b'
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const DOWN = '\x1b[B'
const JEV_TITLE = 'Mercury · jev'
const CONFIG_TITLE = 'Mercury · config'
const FILES_TITLE = 'Mercury · files'
const SURFACES_TITLE = 'Mercury — surfaces'
const SURFACES_FILTER = 'type to filter…'
const JEV_ON = jevReceiptWords({ enabled: true } as never)
const JEV_ON_HEAD = JEV_ON.split(' at ')[0] ?? JEV_ON
const SWITCH_ROW = '› Switch'
const CONFIG_JEV_ROW = '› JEV'
const COMPOSER_EMPTY = '❯ Type a prompt'

const driver = resolveCaptureDriver()
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const PYTHON = driver.python

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'popup-owns-keys-')))

type Cell = string | { c?: string } | null
type Grid = Cell[][]
const cellGlyph = (cell: Cell | undefined): string => (typeof cell === 'object' && cell !== null ? (cell.c ?? ' ') : String(cell ?? ' '))
const gridText = (grid: Grid): string => grid.map(row => row.map(c => cellGlyph(c)).join('')).join('\n')
const rowsOf = (frame: string | undefined): string[] => (frame ?? '').split('\n')
const has = (frame: string | undefined, needle: string): boolean => (frame ?? '').includes(needle)
const composerRow = (frame: string | undefined): string => rowsOf(frame).find(r => r.startsWith('│❯') || r.includes(COMPOSER_EMPTY)) ?? ''
const surfacesOpen = (frame: string | undefined): boolean => has(frame, SURFACES_TITLE) || has(frame, SURFACES_FILTER)

function popupCell(frame: string | undefined, mark: string): string {
  const row = rowsOf(frame).find(r => r.includes(mark))
  if (row === undefined) return ''
  const at = row.indexOf(mark)
  const end = row.indexOf('│', at)
  return row.slice(at, end < 0 ? undefined : end).trim()
}

type Region = { top: number; bottom: number; left: number; right: number }
function popupRegion(frame: string | undefined, title: string): Region | null {
  const rows = rowsOf(frame)
  const titleAt = rows.findIndex(r => r.includes(title))
  if (titleAt < 1) return null
  const titleRow = rows[titleAt] ?? ''
  const at = titleRow.indexOf(title)
  const left = titleRow.lastIndexOf('│', at)
  const right = titleRow.indexOf('│', at + title.length)
  if (left < 0 || right < 0) return null
  let bottom = titleAt
  for (let i = titleAt; i < rows.length; i++) {
    bottom = i
    if ((rows[i] ?? '')[left] === '╰') break
  }
  return { top: titleAt - 1, bottom, left, right }
}

function popupWords(frame: string | undefined, title: string): string {
  const region = popupRegion(frame, title)
  if (region === null) return ''
  const rows = rowsOf(frame)
  const inner: string[] = []
  for (let y = region.top; y <= region.bottom; y++) inner.push((rows[y] ?? '').slice(region.left + 1, region.right).trim())
  return inner.join(' ').replace(/\s+/g, ' ')
}

function composerBeside(frame: string | undefined, title: string): string {
  const rows = rowsOf(frame)
  const y = rows.findIndex(r => r.startsWith('│❯') || r.includes(COMPOSER_EMPTY))
  if (y < 0) return ''
  const row = rows[y] ?? ''
  const region = popupRegion(frame, title)
  if (region === null || y < region.top || y > region.bottom) return row
  return row.slice(0, region.left) + ' '.repeat(Math.max(0, region.right - region.left + 1)) + row.slice(region.right + 1)
}

function outsidePopupSame(before: string | undefined, after: string | undefined, title: string): { same: boolean; detail: string } {
  const a = popupRegion(before, title)
  const b = popupRegion(after, title)
  if (a === null || b === null) return { same: false, detail: a === null ? 'no popup in the frame before the key' : 'no popup in the frame after the key' }
  const top = Math.min(a.top, b.top)
  const bottom = Math.max(a.bottom, b.bottom)
  const left = Math.min(a.left, b.left)
  const right = Math.max(a.right, b.right)
  const blanked = (frame: string | undefined): string[] =>
    rowsOf(frame).map((row, y) => (y >= top && y <= bottom ? row.slice(0, left) + ' '.repeat(Math.max(0, right - left + 1)) + row.slice(right + 1) : row))
  const xa = blanked(before)
  const xb = blanked(after)
  const diffs: string[] = []
  for (let y = 0; y < Math.max(xa.length, xb.length); y++) {
    if ((xa[y] ?? '') !== (xb[y] ?? '')) diffs.push(`row ${y}\n    before: ${(xa[y] ?? '').trimEnd()}\n    after:  ${(xb[y] ?? '').trimEnd()}`)
  }
  return { same: diffs.length === 0, detail: diffs.slice(0, 4).join('\n') }
}

function seedWorld(name: string): { home: string; cwd: string } {
  const home = join(scratch, `home-${name}`)
  const cwd = join(scratch, `cwd-${name}`, 'fixture-cwd')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  writeFileSync(join(cwd, 'src', 'alpha.ts'), 'export const alpha = 1\n')
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipSovereignConsentPrompt: true, prefersReducedMotion: true, spinnerTipsEnabled: false }, null, 2))
  return { home, cwd }
}

const jevStored = (home: string): Record<string, unknown> | undefined => {
  const file = join(home, '.mercury.json')
  if (!existsSync(file)) return undefined
  return (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>).jev as Record<string, unknown> | undefined
}

function driveEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_FULLSCREEN: '1',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER: 'clam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_JEV_BASE: 'http://127.0.0.1:1',
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
    ANTHROPIC_BASE_URL: DEAD,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
    MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
    MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
    MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
    MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`,
    MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
    MERCURY_DEEPSEEK_API_BASE: DEAD,
    BROWSER: '/usr/bin/true',
    SHELL: existsSync('/bin/bash') ? '/bin/bash' : (process.env.SHELL ?? '/bin/sh'),
  }
  for (const key of ['NODE_ENV', 'MERCURY_DEMO', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'TYPESAFE_API_KEY', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'TERMINAL_EMULATOR']) {
    delete env[key]
  }
  return env
}

type Capture = { marks: Record<string, string>; sends: number; receipts: number; stderr: string; endReason: string; status: number | null }
async function capture(name: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<Capture> {
  const cfgPath = join(scratch, `${name}.cfg.json`)
  const outPath = join(scratch, `${name}.grid.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const status = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(PYTHON, [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(240_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(deadline)
      resolve(code)
    })
  })
  if (!existsSync(outPath)) throw new Error(`the capture wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  marks.final = gridText(payload.grid)
  if (FRAMES) {
    mkdirSync(FRAMES, { recursive: true })
    for (const [label, frame] of Object.entries(marks)) writeFileSync(join(FRAMES, `${name}-${label}.txt`), `${frame}\n`)
  }
  return { marks, sends: (cfg.sends as unknown[]).length, receipts: payload.sendReceipts?.length ?? 0, stderr: stderr.join(''), endReason: payload.endReason ?? '', status }
}

const gated = (data: string, awaitText: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ data, atTick: 999, awaitText, requireAwait: true, minTick: 1, awaitSettleTicks: 3, ...extra })
const after = (data: string, ticks: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ data, afterPrevTicks: ticks, ...extra })
const awaitOr = (data: string, awaitText: string, deadlineTicks: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ data, awaitText, afterPrevTicks: deadlineTicks, minTick: 1, awaitSettleTicks: 3, awaitStableTicks: 2, ...extra })
const boot = (): Array<Record<string, unknown>> => [
  gated('\r', 'New Session', { minTick: 5, awaitStableTicks: 6, awaitSettleTicks: 4 }),
  gated('\x1b[I', 'shortcuts', { minTick: 2, awaitSettleTicks: 6 }),
  gated('', '← back', { minTick: 2, awaitSettleTicks: 6, mark: 'land' }),
]
const cfgFor = (cols: number, rows: number, cwd: string, sends: Array<Record<string, unknown>>): Record<string, unknown> => ({
  cols,
  rows,
  total: 400,
  cwd,
  argv: ['node', DIST],
  sends,
  stableTicks: 4,
})
const dueDetail = (cap: Capture): string => `${cap.receipts}/${cap.sends} · status ${cap.status} · end ${cap.endReason} · ${cap.stderr.slice(-300)}`

async function jevLeg(name: string, cols: number, rows: number): Promise<void> {
  const { home, cwd } = seedWorld(name)
  const cap = await capture(`${name}-${cols}x${rows}`, cfgFor(cols, rows, cwd, [
    ...boot(),
    after('/jev', 2),
    after('\r', 3),
    gated('', JEV_TITLE, { awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'open' }),
    after(LEFT, 1),
    awaitOr('', JEV_ON_HEAD, 12, { mark: 'after-left' }),
    after(ESC, 1),
    after('', 8, { mark: 'closed' }),
  ]), driveEnv(home))
  const m = cap.marks
  const tag = `${name} ${cols}x${rows}`
  tally.section(`${tag} · /jev over the cockpit: ← on the Switch row flips the switch, the surfaces index stays shut, nothing beneath moves`)
  tally.check(`${tag} J1 every send became due`, cap.receipts === cap.sends && cap.status === 0, dueDetail(cap))
  tally.check(`${tag} J2 the popup opened on the Switch row reading off`, has(m.open, JEV_TITLE) && popupCell(m.open, SWITCH_ROW).endsWith('off'), popupCell(m.open, SWITCH_ROW) || '(no Switch row)')
  tally.check(`${tag} J3 no surfaces index before the key`, !surfacesOpen(m.open))
  const receipt = popupWords(m['after-left'], JEV_TITLE)
  tally.check(`${tag} J4 ← flipped the switch: the Switch row reads on and the receipt's words read whole across the popup's rows`, popupCell(m['after-left'], SWITCH_ROW).endsWith('on') && receipt.includes(JEV_ON), `${popupCell(m['after-left'], SWITCH_ROW) || '(no Switch row)'} · ${receipt.slice(receipt.indexOf(JEV_ON_HEAD)).slice(0, 160) || '(no receipt)'}`)
  tally.check(`${tag} J5 ← did not open the surfaces index beneath; the popup is still open`, !surfacesOpen(m['after-left']) && has(m['after-left'], JEV_TITLE), rowsOf(m['after-left']).filter(r => r.includes(SURFACES_TITLE) || r.includes(SURFACES_FILTER)).join(' | ') || 'popup gone')
  const outside = outsidePopupSame(m.open, m['after-left'], JEV_TITLE)
  tally.check(`${tag} J6 every row outside the popup is byte-identical before and after ←`, outside.same, outside.detail)
  const besideOpen = composerBeside(m.open, JEV_TITLE)
  const besideAfter = composerBeside(m['after-left'], JEV_TITLE)
  tally.check(`${tag} J7 the composer beneath still reads its empty prompt in the columns the popup leaves visible, unchanged by ←`, besideAfter.includes(COMPOSER_EMPTY) && besideAfter === besideOpen, `${besideAfter.trimEnd() || '(no composer row)'}${besideAfter === besideOpen ? '' : `\n    before: ${besideOpen.trimEnd()}`}`)
  tally.check(`${tag} J8 esc closed the popup and no surfaces index stands; the composer reads as at landing`, !has(m.closed, JEV_TITLE) && !surfacesOpen(m.closed) && composerRow(m.closed) === composerRow(m.land), composerRow(m.closed).trimEnd() || '(no composer row)')
  tally.check(`${tag} J9 the flip persisted through the owner: the home's JEV switch is on`, jevStored(home)?.enabled === true, JSON.stringify(jevStored(home)))
  if (KEEP) console.log(`world kept: ${home} ${cwd}`)
}

async function configLeg(): Promise<void> {
  const { home, cwd } = seedWorld('config')
  const cap = await capture('config-178x51', cfgFor(178, 51, cwd, [
    ...boot(),
    after('/config', 2),
    after('\r', 3),
    gated('', CONFIG_TITLE, { awaitSettleTicks: 4, awaitStableTicks: 3 }),
    after('JEV', 2),
    after(DOWN, 4),
    gated('', CONFIG_JEV_ROW, { awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'row' }),
    after(RIGHT, 1),
    after('', 8, { mark: 'after-right' }),
    after('\r', 1),
    after('', 8, { mark: 'closed' }),
  ]), driveEnv(home))
  const m = cap.marks
  tally.section('config 178x51 · /config on its JEV row: → flips the one switch, the surfaces index stays shut, nothing beneath moves')
  tally.check('config C1 every send became due', cap.receipts === cap.sends && cap.status === 0, dueDetail(cap))
  tally.check('config C2 the typed filter reached the JEV row, selected and off', has(m.row, CONFIG_TITLE) && popupCell(m.row, CONFIG_JEV_ROW).endsWith('off'), popupCell(m.row, CONFIG_JEV_ROW) || '(no JEV row)')
  tally.check('config C3 → flipped JEV on inside the popup and opened no surfaces index', popupCell(m['after-right'], CONFIG_JEV_ROW).endsWith('on') && has(m['after-right'], CONFIG_TITLE) && !surfacesOpen(m['after-right']), popupCell(m['after-right'], CONFIG_JEV_ROW) || '(no JEV row)')
  const outside = outsidePopupSame(m.row, m['after-right'], CONFIG_TITLE)
  tally.check('config C4 every row outside the popup is byte-identical before and after →', outside.same, outside.detail)
  tally.check('config C5 the composer beneath still reads its empty prompt', composerRow(m['after-right']).includes(COMPOSER_EMPTY) && composerRow(m['after-right']) === composerRow(m.row), composerRow(m['after-right']).trimEnd() || '(no composer row)')
  tally.check("config C6 ↵ saved and closed the popup; the home's JEV switch is on; no surfaces index", !has(m.closed, CONFIG_TITLE) && !surfacesOpen(m.closed) && jevStored(home)?.enabled === true, `${JSON.stringify(jevStored(home))} · ${has(m.closed, CONFIG_TITLE) ? 'popup still open' : 'popup closed'}`)
  if (KEEP) console.log(`world kept: ${home} ${cwd}`)
}

async function filesLeg(): Promise<void> {
  const { home, cwd } = seedWorld('files')
  const cap = await capture('files-178x51', cfgFor(178, 51, cwd, [
    ...boot(),
    after('/files', 2),
    after('\r', 3),
    gated('', FILES_TITLE, { awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'open' }),
    after(LEFT, 1),
    after('', 6, { mark: 'after-left' }),
    after(RIGHT, 1),
    after('', 6, { mark: 'after-right' }),
    after(ESC, 1),
    after('', 8, { mark: 'closed' }),
  ]), driveEnv(home))
  const m = cap.marks
  tally.section('files 178x51 · the files menu: ← and → stay inside the menu, the surfaces index stays shut, nothing beneath moves')
  tally.check('files F1 every send became due', cap.receipts === cap.sends && cap.status === 0, dueDetail(cap))
  tally.check('files F2 the menu opened over the chat', has(m.open, FILES_TITLE) && !surfacesOpen(m.open))
  tally.check('files F3 ← kept the menu open and opened no surfaces index', has(m['after-left'], FILES_TITLE) && !surfacesOpen(m['after-left']), rowsOf(m['after-left']).filter(r => r.includes(SURFACES_TITLE)).join(' | ') || 'menu gone')
  tally.check('files F4 → kept the menu open and opened no surfaces index', has(m['after-right'], FILES_TITLE) && !surfacesOpen(m['after-right']), rowsOf(m['after-right']).filter(r => r.includes(SURFACES_TITLE)).join(' | ') || 'menu gone')
  const outsideLeft = outsidePopupSame(m.open, m['after-left'], FILES_TITLE)
  tally.check('files F5 every row outside the menu is byte-identical before and after ←', outsideLeft.same, outsideLeft.detail)
  const outsideRight = outsidePopupSame(m['after-left'], m['after-right'], FILES_TITLE)
  tally.check('files F6 every row outside the menu is byte-identical before and after →', outsideRight.same, outsideRight.detail)
  tally.check('files F7 the composer beneath still reads its empty prompt', composerRow(m['after-right']).includes(COMPOSER_EMPTY) && composerRow(m['after-right']) === composerRow(m.open), composerRow(m['after-right']).trimEnd() || '(no composer row)')
  tally.check('files F8 esc closed the menu; no surfaces index; the composer reads as at landing', !has(m.closed, FILES_TITLE) && !surfacesOpen(m.closed) && composerRow(m.closed) === composerRow(m.land), composerRow(m.closed).trimEnd() || '(no composer row)')
  if (KEEP) console.log(`world kept: ${home} ${cwd}`)
}

if (LEGS.has('jev')) await jevLeg('jev', 178, 51)
if (LEGS.has('config')) await configLeg()
if (LEGS.has('files')) await filesLeg()
if (LEGS.has('jev-compact')) await jevLeg('jev-compact', 100, 30)

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`scratch kept: ${scratch}`)
tally.finish()
