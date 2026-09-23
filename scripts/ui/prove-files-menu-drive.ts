#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DIST, FRAMES, argAfter, makeTally } from '../daemon/dupline-world.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { projectSlug } from '../../src/utils/sessionStoragePortable.ts'

const VSHOT = join(import.meta.dir, 'vshot.py')
const tally = makeTally('prove-files-menu-drive')
const KEEP = process.argv.includes('--keep')
const WORLDS = (argAfter('--worlds') ?? 'plain,git,off,small,hop').split(',')
const DEAD = 'http://127.0.0.1:9'
const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
const CLICK_BESIDE_PICKER = '\x1b[<0;140;25M\x1b[<0;140;25m'
const SHIFT_LEFT = '\x1b[1;2D'
const CTRL_G = '\x07'
const DOWN = '\x1b[B'
const TITLE = 'Mercury · files'
const HINT = '↑↓ move · ↵ open · → ← unfold · / filter · esc or click outside closes'
const FILES_BOX = ['╭────────────────────────────╮', '│ ▤ FILES · fixture-cwd      │', '│   ↵ or click · browse      │', '╰────────────────────────────╯']

if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const worldRoot = existsSync('/private/tmp') ? '/private/tmp/mw' : join(realpathSync(tmpdir()), 'mw')
mkdirSync(worldRoot, { recursive: true })
const scratch = realpathSync(mkdtempSync(join(worldRoot, 'file-tree-')))

type Cell = string | { c?: string; fg?: string; bg?: string; bold?: boolean } | null
type Grid = Cell[][]
const cellGlyph = (cell: Cell | undefined): string => (typeof cell === 'object' && cell !== null ? (cell.c ?? ' ') : String(cell ?? ' '))
const cellKey = (cell: Cell | undefined): string => (typeof cell === 'object' && cell !== null ? `${cell.c ?? ' '}|${cell.fg ?? ''}|${cell.bg ?? ''}|${cell.bold === true ? 'b' : ''}` : `${String(cell ?? ' ')}|||`)
const gridText = (grid: Grid): string => grid.map(row => row.map(c => cellGlyph(c)).join('')).join('\n')
const rowsOf = (frame: string | undefined): string[] => (frame ?? '').split('\n')
const rowWith = (frame: string | undefined, needle: string): string | undefined => rowsOf(frame).find(r => r.includes(needle))
const rowIndexWith = (frame: string | undefined, needle: string): number => rowsOf(frame).findIndex(r => r.includes(needle))
const railRows = (frame: string | undefined): string[] => rowsOf(frame).map(r => r.slice(0, 30).trimEnd())

function seedFixture(dir: string): void {
  const files: Record<string, string> = {
    'src/components/Alpha.tsx': 'export const alpha = 1\n',
    'src/components/Beta.tsx': 'export const beta = 2\n',
    'src/screens/Home.tsx': 'export const home = 3\n',
    'tests/smoke.ts': 'export const smoke = true\n',
    'vendor/pkg/index.js': 'module.exports = {}\n',
    'README.md': '# fixture\n',
    'build.ts': 'export {}\n',
    'package.json': '{ "name": "fixture-cwd", "private": true }\n',
  }
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
}

function gitWorld(dir: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', HOME: dir }
  const git = (...args: string[]): void => {
    const r = spawnSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture')
  writeFileSync(join(dir, 'README.md'), '# fixture\nchanged\n')
  writeFileSync(join(dir, 'src/components/Alpha.tsx'), 'export const alpha = 10\n')
  writeFileSync(join(dir, 'notes.txt'), 'untracked\n')
}

function seedWorld(name: string, opts: { git?: boolean; filesBox?: false }): { home: string; cwd: string } {
  const home = join(scratch, `home-${name}`)
  const cwd = join(scratch, `cwd-${name}`, 'fixture-cwd')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  seedFixture(cwd)
  if (opts.git) gitWorld(cwd)
  seedFirstRun(home, [cwd])
  const settings: Record<string, unknown> = { skipSovereignConsentPrompt: true }
  if (opts.filesBox === false) settings.filesBox = false
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings, null, 2))
  return { home, cwd }
}

function seedHopWorld(name: string): { home: string; cwdA: string; cwdB: string } {
  const home = join(scratch, `home-${name}`)
  const cwdA = join(scratch, `cwd-${name}`, 'fixture-cwd')
  const cwdB = join(scratch, `cwd-${name}`, 'other-cwd')
  for (const dir of [home, cwdA, cwdB]) mkdirSync(dir, { recursive: true })
  seedFixture(cwdA)
  for (const [rel, body] of Object.entries({ 'lib/Gamma.ts': 'export const gamma = 3\n', 'NOTES.md': '# other\n', 'other.json': '{}\n' })) {
    mkdirSync(join(cwdB, rel, '..'), { recursive: true })
    writeFileSync(join(cwdB, rel), body)
  }
  seedFirstRun(home, [cwdA, cwdB])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipSovereignConsentPrompt: true }, null, 2))
  const sessionId = '00000000-dddd-4000-8000-000000000002'
  const file = join(home, 'projects', projectSlug(cwdB), `${sessionId}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    entrypoint: 'cli',
    cwd: cwdB,
    sessionId,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    timestamp: new Date().toISOString(),
    ...extra,
  })
  writeFileSync(
    file,
    encodeSeedTranscript(
      [
        row({ type: 'user', message: { role: 'user', content: 'an old chat in the other folder' } }),
        row({ type: 'assistant', message: { id: 'msg_other', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
      ] as never,
      sessionId,
    ),
  )
  const at = new Date(Date.now() - 60 * 60_000)
  utimesSync(file, at, at)
  return { home, cwdA, cwdB }
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
  for (const key of ['NODE_ENV', 'MERCURY_DEMO', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'TERMINAL_EMULATOR']) {
    delete env[key]
  }
  return env
}

type Capture = { marks: Record<string, string>; grids: Record<string, Grid>; sends: number; receipts: number; stderr: string; endReason: string; status: number | null }
async function capture(name: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<Capture> {
  const cfgPath = join(scratch, `${name}.cfg.json`)
  const outPath = join(scratch, `${name}.grid.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const status = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
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
  const grids: Record<string, Grid> = {}
  for (const m of payload.marks ?? []) {
    marks[m.label] = gridText(m.grid)
    grids[m.label] = m.grid
  }
  marks.final = gridText(payload.grid)
  grids.final = payload.grid
  if (FRAMES) {
    mkdirSync(FRAMES, { recursive: true })
    for (const [label, frame] of Object.entries(marks)) writeFileSync(join(FRAMES, `${name}-${label}.txt`), `${frame}\n`)
  }
  return { marks, grids, sends: (cfg.sends as unknown[]).length, receipts: payload.sendReceipts?.length ?? 0, stderr: stderr.join(''), endReason: payload.endReason ?? '', status }
}

const gated = (data: string, awaitText: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ data, atTick: 999, awaitText, requireAwait: true, minTick: 1, awaitSettleTicks: 3, ...extra })
const after = (data: string, ticks: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ data, afterPrevTicks: ticks, ...extra })
const boot = (): Array<Record<string, unknown>> => [
  gated('\r', 'New Session', { minTick: 5, awaitStableTicks: 6, awaitSettleTicks: 4 }),
  gated('\x1b[I', 'shortcuts', { minTick: 2, awaitSettleTicks: 6 }),
  gated('', '← back', { minTick: 2, awaitSettleTicks: 6, mark: 'land' }),
]
const railRoad = (): Array<Record<string, unknown>> => [
  after('\t', 2),
  gated('\x1b[B', 'lanes · ↑↓ ↵ tab esc', { awaitSettleTicks: 4 }),
  gated('\x1b[B', '❯ no prompts sent yet', { awaitSettleTicks: 2 }),
  gated('\x1b[B', '❯ · /workflows', { awaitSettleTicks: 2 }),
  gated('\x1b[B', '❯ · /health', { awaitSettleTicks: 2 }),
  gated('\x1b[B', '❯ · /cards', { awaitSettleTicks: 2 }),
  gated('\x1b[B', '❯ · /mission', { awaitSettleTicks: 2 }),
  gated('\r', '❯ ↵ or click · browse', { awaitSettleTicks: 2, mark: 'files-row' }),
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

function menuRegion(frame: string | undefined): { top: number; left: number; right: number; rows: string[] } | null {
  const rows = rowsOf(frame)
  const top = rows.findIndex(r => r.includes(TITLE)) - 1
  if (top < 0) return null
  const titleRow = rows[top + 1] ?? ''
  const at = titleRow.indexOf(TITLE)
  const left = titleRow.lastIndexOf('│', at)
  const right = titleRow.indexOf('│', at + TITLE.length)
  const region: string[] = []
  for (let i = top; i < rows.length; i++) {
    const row = rows[i] ?? ''
    region.push(row.slice(left, right + 1))
    if (row[left] === '╰') break
  }
  return { top, left, right, rows: region }
}

const worlds = new Set(WORLDS)
const frames: Record<string, Capture> = {}

if (worlds.has('plain') || worlds.has('off')) {
  const { home, cwd } = seedWorld('plain', {})
  const cap = await capture('plain-178x51', cfgFor(178, 51, cwd, [
    ...boot(),
    ...railRoad(),
    gated('\x1b[B', TITLE, { awaitSettleTicks: 4, mark: 'menu' }),
    gated('\x1b[C', '❯ src', { awaitSettleTicks: 2 }),
    gated('/', '▸ components', { mark: 'unfold' }),
    after('rea', 2),
    gated('\x1b', '/ rea', { mark: 'filter' }),
    gated('\x1b[B', '/ filter by name', { mark: 'cleared' }),
    gated('\x1b[B', '❯ src', { awaitSettleTicks: 2 }),
    gated('\x1b[C', '❯ components', { awaitSettleTicks: 2 }),
    gated('\x1b[B', 'Alpha.tsx', { awaitSettleTicks: 2 }),
    gated('\r', '❯ Alpha.tsx', { awaitSettleTicks: 2, mark: 'on-file' }),
    gated('\x1b', '@src/components/Alpha.tsx', { awaitSettleTicks: 4, mark: 'picked' }),
    after('\x1b', 2),
    gated('/files', 'Type a prompt', { mark: 'draft-cleared' }),
    after('', 4, { mark: 'typed' }),
    after('\r', 2),
    gated('\x1b', TITLE, { awaitSettleTicks: 4, mark: 'command' }),
    after('', 6, { mark: 'esc-closed' }),
    after(CLICK, 2, { targetText: 'FILES · fixture-cwd' }),
    gated(CLICK, TITLE, { awaitSettleTicks: 4, mark: 'click-open', targetText: 'SEAT · 0 peers' }),
    after('', 6, { mark: 'click-closed' }),
    after('/model', 2),
    after('\r', 3),
    gated(CLICK_BESIDE_PICKER, 'Mercury — model', { awaitSettleTicks: 6, mark: 'picker' }),
    after('/model', 8, { mark: 'picker-clicked' }),
    after('\r', 3),
    gated('\x1b', 'Mercury — model', { awaitSettleTicks: 6, mark: 'picker-again' }),
    after('', 6, { mark: 'picker-esc' }),
  ]), driveEnv(home))
  frames.plain = cap
  const m = cap.marks
  tally.section('plain · 178x51 · the FILES box, the menu, the keys, the command, the clicks')
  tally.check('P1 every send became due', cap.receipts === cap.sends && cap.status === 0, `${cap.receipts}/${cap.sends} · status ${cap.status} · end ${cap.endReason} · ${cap.stderr.slice(-300)}`)
  const land = railRows(m.land)
  const boxAt = land.findIndex(r => r === FILES_BOX[1])
  tally.check('P2 the FILES box paints its four rows exactly, under the NEXT box', boxAt > 1 && [land[boxAt - 1], land[boxAt], land[boxAt + 1], land[boxAt + 2]].join('\n') === FILES_BOX.join('\n') && (land[boxAt - 2] ?? '').startsWith('╰') && (land[boxAt - 3] ?? '').includes('/mission'), land.slice(Math.max(0, boxAt - 3), boxAt + 3).join(' | '))
  tally.check('P3 the rail row under the cursor reads the caret on the FILES row', railRows(m['files-row']).includes('│ ❯ ↵ or click · browse      │'), railRows(m['files-row']).filter(r => r.includes('browse')).join(' | '))
  const menu = menuRegion(m.menu)
  tally.check('P4 the menu opens over the chat at rows 5..19, columns 54..123, seventy wide', menu !== null && menu.top === 5 && menu.left === 54 && menu.right === 123 && menu.rows.length === 15, menu === null ? 'no menu' : `top ${menu.top} left ${menu.left} right ${menu.right} rows ${menu.rows.length}`)
  const expectedMenu = [
    '╭────────────────────────────────────────────────────────────────────╮',
    '│ ▖▟▆▙▗ Mercury · files                                              │',
    '│ FIXTURE-CWD                                                        │',
    '│                                                                    │',
    '│ ❯ .mercury                                                         │',
    '│ ▸ src                                                              │',
    '│ ▸ tests                                                            │',
    '│ ▸ vendor                                                           │',
    '│   README.md                                                        │',
    '│   build.ts                                                         │',
    '│   package.json                                                     │',
    '│                                                                    │',
    '│ / filter by name                                                   │',
    '│ ↑↓ move · ↵ open · → ← unfold · / filter · esc or click outside clo│',
    '╰────────────────────────────────────────────────────────────────────╯',
  ]
  tally.check('P5 the menu rows read as the frame: the title, the folder line, the tree, the filter line, the hint row', menu !== null && menu.rows.join('\n') === expectedMenu.join('\n'), menu === null ? 'no menu' : menu.rows.join('\n'))
  const unfold = menuRegion(m.unfold)
  tally.check('P6 → unfolds the folder under the cursor: its children indent two columns', unfold !== null && unfold.rows.some(r => r.startsWith('│ ❯ src')) && unfold.rows.some(r => r.startsWith('│   ▸ components')) && unfold.rows.some(r => r.startsWith('│   ▸ screens')), unfold === null ? 'no menu' : unfold.rows.join('\n'))
  const filter = menuRegion(m.filter)
  tally.check('P7 / and letters filter the rows by name; the filter line reads the letters', filter !== null && filter.rows.some(r => r.startsWith('│ / rea')) && filter.rows.some(r => r.includes('README.md')) && !filter.rows.some(r => r.includes('build.ts')) && !filter.rows.some(r => r.includes('▸ tests')), filter === null ? 'no menu' : filter.rows.join('\n'))
  const cleared = menuRegion(m.cleared)
  tally.check('P8 esc clears the filter and the rows return', cleared !== null && cleared.rows.some(r => r.startsWith('│ / filter by name')) && cleared.rows.some(r => r.includes('build.ts')), cleared === null ? 'no menu' : cleared.rows.join('\n'))
  const onFile = menuRegion(m['on-file'])
  tally.check('P9 the cursor reaches a file two folders deep', onFile !== null && onFile.rows.some(r => r.startsWith('│     ❯ Alpha.tsx')), onFile === null ? 'no menu' : onFile.rows.join('\n'))
  tally.check('P10 ↵ on the file puts @path in the composer and closes the menu', !(m.picked ?? '').includes(TITLE) && rowsOf(m.picked).some(r => r.includes('│❯ @src/components/Alpha.tsx')), rowWith(m.picked, '@src') ?? '(no composer row)')
  tally.check('P11 /files opens the same menu from the composer', menuRegion(m.command) !== null && (menuRegion(m.command)?.top ?? -1) === 5)
  tally.check('P11b the typed /files offers its row with the word browse and no other words', rowsOf(m.typed).some(r => /\/files\s+browse\s*$/.test(r.trimEnd())) && rowsOf(m.typed).filter(r => r.includes('/files')).every(r => r.includes('❯ /files') || /\/files\s+browse\s*$/.test(r.trimEnd())), rowsOf(m.typed).filter(r => r.includes('/files')).join(' | '))
  tally.check('P12 esc closes the menu', !(m['esc-closed'] ?? '').includes(TITLE))
  tally.check('P13 a click on the FILES box opens the menu', menuRegion(m['click-open']) !== null)
  tally.check('P14 a click on the chat outside the menu closes it and nothing else moves', !(m['click-closed'] ?? '').includes(TITLE) && m['click-closed'] === m['esc-closed'], m['click-closed'] === m['esc-closed'] ? '' : 'the frame after the click differs from the frame after esc')
  tally.check('P15 the model picker opened over the chat', (m.picker ?? '').includes('Mercury — model'))
  tally.check('P16 a click on the dimmed chat beside the picker closes it and the chat returns', !(m['picker-clicked'] ?? '').includes('Mercury — model') && (m['picker-clicked'] ?? '').includes('no prompts sent yet'), rowsOf(m['picker-clicked']).slice(0, 8).join('\n'))
  tally.check('P17 the picker opens again and esc closes it', (m['picker-again'] ?? '').includes('Mercury — model') && !(m['picker-esc'] ?? '').includes('Mercury — model') && (m['picker-esc'] ?? '').includes('no prompts sent yet'), rowsOf(m['picker-esc']).slice(0, 8).join('\n'))
  if (KEEP) console.log(`world kept: ${home} ${cwd}`)
}

if (worlds.has('git')) {
  const { home, cwd } = seedWorld('git', { git: true })
  const cap = await capture('git-178x51', cfgFor(178, 51, cwd, [
    ...boot(),
    ...railRoad(),
    gated('\x1b[B', '3 changed', { awaitSettleTicks: 4, mark: 'menu' }),
    gated('\x1b[C', '❯ src', { awaitSettleTicks: 2 }),
    gated('\x1b[B', '▸ components', { awaitSettleTicks: 2 }),
    gated('\x1b[C', '❯ components', { awaitSettleTicks: 2 }),
    gated('\x1b[B', 'Alpha.tsx', { awaitSettleTicks: 2 }),
    gated('', '❯ Alpha.tsx', { awaitSettleTicks: 3, mark: 'nested' }),
    after('\x1b', 2),
  ]), driveEnv(home))
  frames.git = cap
  const m = cap.marks
  tally.section('git · 178x51 · the branch, the count and the marks')
  tally.check('G1 every send became due', cap.receipts === cap.sends && cap.status === 0, `${cap.receipts}/${cap.sends} · status ${cap.status} · end ${cap.endReason} · ${cap.stderr.slice(-300)}`)
  const menu = menuRegion(m.menu)
  tally.check('G2 the second line names the folder, the branch and the count of changed files', menu !== null && menu.rows[2] === '│ FIXTURE-CWD · ⌥ main · 3 changed                                   │', menu === null ? 'no menu' : menu.rows[2] ?? '')
  tally.check('G3 a modified file carries M and an untracked file carries U at the right edge', menu !== null && menu.rows.some(r => r === '│   README.md                                                     M  │') && menu.rows.some(r => r === '│   notes.txt                                                     U  │'), menu === null ? 'no menu' : menu.rows.join('\n'))
  const nested = menuRegion(m.nested)
  tally.check('G4 a modified file inside an unfolded folder carries its mark too', nested !== null && nested.rows.some(r => r === '│     ❯ Alpha.tsx                                                 M  │'), nested === null ? 'no menu' : nested.rows.join('\n'))
  if (KEEP) console.log(`world kept: ${home} ${cwd}`)
}

if (worlds.has('off')) {
  const { home, cwd } = seedWorld('off', { filesBox: false })
  const cap = await capture('off-178x51', cfgFor(178, 51, cwd, [
    ...boot(),
    after('/files', 2),
    after('\r', 3),
    after('', 8, { mark: 'typed' }),
  ]), driveEnv(home))
  frames.off = cap
  const m = cap.marks
  tally.section('off · 178x51 · the setting off restores the rail as shipped')
  tally.check('O1 every send became due', cap.receipts === cap.sends && cap.status === 0, `${cap.receipts}/${cap.sends} · status ${cap.status} · end ${cap.endReason} · ${cap.stderr.slice(-300)}`)
  tally.check('O2 no FILES box anywhere', !(m.land ?? '').includes('FILES'))
  const plainLand = railRows(frames.plain?.marks.land)
  const boxAt = plainLand.findIndex(r => r === FILES_BOX[1])
  const plainWithoutBox = boxAt > 0 ? plainLand.map((row, i) => (i >= boxAt - 1 && i <= boxAt + 2 ? '' : row)) : []
  tally.check('O3 the rail with the setting off is the rail with the setting on with the four FILES rows blank', frames.plain !== undefined && railRows(m.land).join('\n') === plainWithoutBox.join('\n'), frames.plain === undefined ? 'the plain world did not run' : `off:\n${railRows(m.land).join('\n')}\nexpected:\n${plainWithoutBox.join('\n')}`)
  const plainGrid = frames.plain?.grids.land
  const offGrid = cap.grids.land
  const boxRows = new Set(boxAt > 0 ? [boxAt - 1, boxAt, boxAt + 1, boxAt + 2] : [])
  let outsideDiffers = 0
  let insideNotBlank = 0
  if (plainGrid && offGrid) {
    for (let r = 0; r < Math.max(plainGrid.length, offGrid.length); r++) {
      const onRow = plainGrid[r] ?? []
      const offRow = offGrid[r] ?? []
      for (let c = 0; c < Math.max(onRow.length, offRow.length); c++) {
        if (boxRows.has(r) && c < FILES_BOX[0].length) {
          if (cellGlyph(offRow[c]) !== ' ') insideNotBlank++
        } else if (cellKey(onRow[c]) !== cellKey(offRow[c])) outsideDiffers++
      }
    }
  }
  tally.check('O3b every cell outside the four FILES rows keeps its glyph and colours with the setting off, and those rows are blank', plainGrid !== undefined && offGrid !== undefined && outsideDiffers === 0 && insideNotBlank === 0, `${outsideDiffers} cells differ outside the box, ${insideNotBlank} cells inside it are not blank`)
  tally.check('O4 /files typed opens no menu with the setting off', !(m.typed ?? '').includes(TITLE))
  if (KEEP) console.log(`world kept: ${home} ${cwd}`)
}

if (worlds.has('small')) {
  for (const [cols, rows] of [[120, 40], [100, 30]] as const) {
    const label = `${cols}x${rows}`
    const { home, cwd } = seedWorld(`small-${label}`, {})
    const cap = await capture(`plain-${label}`, cfgFor(cols, rows, cwd, [
      ...boot(),
      after('/files', 2),
      after('\r', 3),
      gated('\x1b', TITLE, { awaitSettleTicks: 4, mark: 'menu' }),
      after('', 4, { mark: 'closed' }),
    ]), driveEnv(home))
    frames[`small-${label}`] = cap
    const m = cap.marks
    tally.section(`plain · ${label} · the box and the menu fit`)
    tally.check(`${label} S1 every send became due`, cap.receipts === cap.sends && cap.status === 0, `${cap.receipts}/${cap.sends} · status ${cap.status} · end ${cap.endReason} · ${cap.stderr.slice(-300)}`)
    tally.check(`${label} S2 the rail carries the FILES section and its row`, (m.land ?? '').includes('FILES · fixture-cwd') && /↵ or click · brow(se|…)/.test(m.land ?? ''), rowWith(m.land, 'or click') ?? '(no row)')
    const menu = menuRegion(m.menu)
    const composerAt = rowIndexWith(m.menu, 'Type a prompt')
    tally.check(`${label} S3 the menu fits inside the chat pane with its hint row and bottom border`, menu !== null && menu.rows[menu.rows.length - 1]?.startsWith('╰') === true && menu.rows.some(r => r.includes(HINT.slice(0, 20))) && menu.top + menu.rows.length < composerAt - 1, menu === null ? 'no menu' : `top ${menu.top} rows ${menu.rows.length} composer at ${composerAt}`)
    tally.check(`${label} S4 esc closes it`, !(m.closed ?? '').includes(TITLE))
    if (KEEP) console.log(`world kept: ${home} ${cwd}`)
  }
}

if (worlds.has('hop')) {
  for (const [cols, rows] of [[178, 51], [120, 40]] as const) {
    const label = `${cols}x${rows}`
    const { home, cwdA } = seedHopWorld(`hop-${label}`)
    const cap = await capture(`hop-${label}`, cfgFor(cols, rows, cwdA, [
      ...boot(),
      after(SHIFT_LEFT, 2),
      gated('\t', 'SESSION CONCOURSE', { awaitSettleTicks: 4 }),
      after(CTRL_G, 6),
      after(DOWN, 6),
      after('\r', 4),
      gated('', 'other-cwd ⌄', { awaitSettleTicks: 8, mark: 'board-b' }),
      after('\r', 4),
      after('\r', 4),
      gated('', '← back', { awaitSettleTicks: 6, mark: 'hopped' }),
      after('/files', 2),
      after('\r', 3),
      gated('', TITLE, { awaitSettleTicks: 4, mark: 'hop-menu' }),
      after(DOWN, 2),
      after(DOWN, 2),
      after(DOWN, 2),
      after(DOWN, 2),
      after('\r', 3),
      after('', 4, { mark: 'picked' }),
    ]), driveEnv(home))
    frames[`hop-${label}`] = cap
    const m = cap.marks
    tally.section(`hop · ${label} · the session of one project focused while the screen's ground is another: the FILES box and the tree follow the session`)
    tally.check(`${label} H1 every send became due`, cap.receipts === cap.sends && cap.status === 0, `${cap.receipts}/${cap.sends} · status ${cap.status} · end ${cap.endReason} · ${cap.stderr.slice(-300)}`)
    tally.check(`${label} H2 the board of the other folder carries the focused session of fixture-cwd as its selected row`, rowsOf(m['board-b']).some(r => r.includes('▸') && r.includes('✦') && r.includes('fixture-')) && rowsOf(m['board-b']).some(r => r.includes('other-cwd ⌄')), rowsOf(m['board-b']).filter(r => r.includes('✦')).join(' | ') || '(no carried row)')
    tally.check(`${label} H3 after the hop back into it, the FILES box names the session's folder, fixture-cwd, not the ground's`, /FILES · fixture-cwd/.test(m.hopped ?? '') && !/FILES · other-cwd/.test(m.hopped ?? ''), rowWith(m.hopped, 'FILES ·') ?? '(no FILES row)')
    const menu = menuRegion(m['hop-menu'])
    tally.check(`${label} H4 the tree opens on the session's folder: the folder line reads FIXTURE-CWD and the rows are its files`, menu !== null && menu.rows.some(r => r.startsWith('│ FIXTURE-CWD')) && menu.rows.some(r => r.includes('▸ src')) && menu.rows.some(r => r.includes('README.md')) && !menu.rows.some(r => r.includes('▸ lib') || r.includes('NOTES.md')), menu === null ? 'no menu' : menu.rows.slice(1, 8).join('\n'))
    tally.check(`${label} H5 ↵ on README.md puts the session folder's path in the composer`, rowsOf(m.picked).some(r => r.includes('│❯ @README.md')) && !(m.picked ?? '').includes(TITLE), rowWith(m.picked, '❯ @') ?? '(no @ in the composer)')
    if (KEEP) console.log(`world kept: ${home} ${cwdA}`)
  }
}

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`scratch kept: ${scratch}`)
tally.finish()
