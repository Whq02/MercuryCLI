#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
const CASE = argAfter('--case')
const VSHOT = join(import.meta.dir, 'vshot.py')
const KEY = 'proof-key-ci-gate-not-a-real-key'
const DEAD = 'http://127.0.0.1:9'
const ESC = '\x1b'
const UP = `${ESC}[A`
const RIGHT = `${ESC}[C`
const SHIFT_RIGHT = `${ESC}[1;2C`
const TAB = '\t'
const PHRASE = 'm to select model-default'
const CHAT_HINT = '>_ ready  ·  ↵ start  ·  ↑↓ choose'
const FULL_HINT = '>_ ready  ·  ↵ start  ·  m menu  ·  ↑↓ choose'
const DOOR = '▸ n starts a blank session in this project'
const FOOTER_AS_SHIPPED = '↑↓ browse · tab panes · ⌃g ground · n new session · / filter · s split · ? keys · esc boot face'
const FOOTER_WITH_KEY = `↑↓ browse · tab panes · ⌃g ground · n new session · ${PHRASE} · / filter · s split · ? keys · esc boot face`
const PICKER_LEFT = 39
const PICKER_TOP = 3
const PICKER_BOTTOM = 46
const KEEP = process.env.MODEL_DEFAULT_KEY_KEEP === '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

process.env.ANTHROPIC_API_KEY = KEY
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'model-default-key-')))
const CWD = join(ROOT, 'fixture-cwd')
mkdirSync(join(CWD, '.mercury'), { recursive: true })
writeFileSync(join(CWD, 'README.md'), 'a fixture folder\n')
const NODE = existsSync(join(dirname(BIN), 'vendor', 'node', 'bin', 'node')) ? join(dirname(BIN), 'vendor', 'node', 'bin', 'node') : 'node'

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: KEY,
    MERCURY_CRITTER: 'clam',
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    BROWSER: 'true',
    TERM_PROGRAM: 'vscode',
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'proof-home'),
    ANTHROPIC_BASE_URL: DEAD,
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
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
  }
  for (const k of [
    'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_OAUTH_TOKEN', 'NODE_ENV', 'MERCURY_DEMO', 'TERMINAL_EMULATOR',
    '__CFBundleIdentifier', 'MERCURY_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL',
  ]) {
    delete env[k]
  }
  return env
}

function seededHome(tag: string, settingsExtra: Record<string, unknown> = {}): string {
  const home = join(ROOT, `home-${tag}`)
  seedFirstRun(home, [CWD])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false, ...settingsExtra }))
  writeFileSync(
    join(home, 'critter-profile.json'),
    JSON.stringify({ v: 1, seed: '00000000-0000-4000-8000-00000000c0de', createdAt: 1787600000000, milestones: { settles: 0, recoveries: 0 }, quiet: true, seenTips: {}, openedSurfaces: [] }),
  )
  return home
}

type Send = Record<string, unknown>
type Grid = Array<Array<{ c: string }>>
type Capture = { status: number | null; stderr: string; stdout: string; lines: string[]; text: string; marks: Map<string, string[]> }

const driver = resolveCaptureDriver()
const textOf = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c).join(''))

function capture(id: string, home: string, argv: string[], sends: Send[], opts: { total: number; ready: string[]; cols?: number; rows?: number; env?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv }): Capture {
  if (driver.kind !== 'posix-pty') throw new Error(`no POSIX pty capture driver on this host (${driver.kind})`)
  const out = join(ROOT, `${id}.json`)
  const cfgPath = join(ROOT, `${id}.cfg.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({ argv: [NODE, BIN, ...argv], cwd: CWD, cols: opts.cols ?? 178, rows: opts.rows ?? 51, total: opts.total, readySettleTicks: 4, stableTicks: 3, sends, readyText: opts.ready, out }),
  )
  const env = opts.env ? opts.env(childEnv(home)) : childEnv(home)
  const res = spawnSync(driver.python, [VSHOT, cfgPath], { encoding: 'utf-8', env, timeout: vshotBudgetMs(opts.total * 200 + 90_000) })
  const marks = new Map<string, string[]>()
  let lines: string[] = []
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }> }
    if (payload.grid) lines = textOf(payload.grid)
    for (const m of payload.marks ?? []) marks.set(m.label, textOf(m.grid))
  }
  if (res.status !== 0) {
    console.log(`  ── ${id}: vshot exit ${res.status} ──`)
    for (const row of lines) console.log('  │' + row.replace(/\s+$/, ''))
    console.log((res.stderr ?? '').trim().split('\n').slice(-8).join('\n'))
  }
  return { status: res.status, stderr: res.stderr ?? '', stdout: res.stdout ?? '', lines, text: lines.join('\n'), marks }
}

const rowWith = (lines: string[], needle: string): string => lines.find(l => l.includes(needle)) ?? ''
const trimmedRow = (lines: string[], needle: string): string => rowWith(lines, needle).trim()
const ANTHROPIC_TITLE = ' ANTHROPIC · '
const headingOf = (lines: string[], title: string): string => (lines.find(l => l.includes(title)) ?? '').replace(/^.*?│ ?/, '').replace(/\s*│\s*$/, '').trim()
const anthropicKeyHeading = (lines: string[]): boolean => /^[▾❯] ANTHROPIC · API key · …\S+ · \d+ live$/.test(headingOf(lines, ANTHROPIC_TITLE))
const pickerFrames = (lines: string[]): boolean =>
  (lines[PICKER_TOP] ?? '')[PICKER_LEFT] === '╭' && (lines[PICKER_TOP + 1] ?? '')[PICKER_LEFT] === '│' && lines.some((l, at) => at > PICKER_TOP && at <= PICKER_BOTTOM && l[PICKER_LEFT] === '╰')
const settingsOf = (home: string): { model?: string; effortLevel?: string } => JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { model?: string; effortLevel?: string }

console.log('============================================================')
console.log(' the default model and effort a new session starts on, chosen with m')
console.log(`   bundle: ${BIN}`)
console.log('============================================================')
if (!existsSync(BIN)) {
  console.error('  dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}

const boardSends: Send[] = [
  { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: SHIFT_RIGHT },
  { requireAwait: true, awaitText: 'coordinator model', awaitStableTicks: 3, mark: 'coord', data: TAB },
  { requireAwait: true, awaitText: 'n new session', awaitStableTicks: 3, mark: 'board', data: 'm' },
]

if (CASE === undefined) {
section('§1 the concourse: the door row names the pair, the bottom row names m, m opens the picker, a pick writes the default')
{
  const home = seededHome('board')
  const c = capture('board', home, [], [
    ...boardSends,
    { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'picker', data: UP },
    { afterPrevTicks: 3, data: 'e' },
    { afterPrevTicks: 3, data: '\r' },
    { requireAwait: true, awaitText: 'Sonnet 5 · ', awaitStableTicks: 3, mark: 'picked', data: TAB },
    { afterPrevTicks: 3, data: TAB },
    { afterPrevTicks: 3, data: 'm' },
    { afterPrevTicks: 4, data: '', mark: 'typed' },
  ], { total: 360, ready: ['esc boot face'] })
  check('the drive delivered every send (exit 0)', c.status === 0, `exit ${c.status}`)
  const coord = c.marks.get('coord') ?? []
  const board = c.marks.get('board') ?? []
  const picker = c.marks.get('picker') ?? []
  const picked = c.marks.get('picked') ?? []
  const typed = c.marks.get('typed') ?? []
  check('with the coordinator panel focused, the door row reads as shipped and the bottom row carries no m phrase', rowWith(coord, DOOR) !== '' && !rowWith(coord, DOOR).includes(`${DOOR} · `) && rowWith(coord, 'esc boot face').includes('coordinator model') && !rowWith(coord, 'esc boot face').includes(PHRASE), `${trimmedRow(coord, DOOR)} / ${trimmedRow(coord, 'esc boot face')}`)
  check('the door row reads the pair it starts on (Opus 5.5 · ● high)', rowWith(board, DOOR).includes(`${DOOR} · Opus 5.5 · ● high`), trimmedRow(board, DOOR))
  check('the bottom row names m between n and the filter', trimmedRow(board, 'esc boot face') === FOOTER_WITH_KEY, trimmedRow(board, 'esc boot face'))
  check('m opens the picker over the concourse (the plain title row)', rowWith(picker, 'Mercury · model') !== '' && rowWith(picker, 'CHOOSE A MODEL') === '', picker.slice(3, 8).join(' | '))
  check('the picker sits in the main band, centred (top row 3, left column 39, its bottom border inside the band)', pickerFrames(picker), `${(picker[PICKER_TOP] ?? '').slice(PICKER_LEFT, PICKER_LEFT + 4)} / ${(picker[PICKER_BOTTOM] ?? '').slice(PICKER_LEFT, PICKER_LEFT + 4)}`)
  check('the bottom row keeps the phrase while the picker stands', trimmedRow(picker, 'esc boot face') === FOOTER_WITH_KEY, trimmedRow(picker, 'esc boot face'))
  check('no row of the picker reads frontier:', picker.length > 0 && !picker.some(l => l.includes('frontier:')), picker.filter(l => l.includes('frontier:')).join(' | '))
  check('the Anthropic heading reads the key door with its tail and the live count', anthropicKeyHeading(picker), headingOf(picker, ANTHROPIC_TITLE))
  const saved = settingsOf(home)
  check("a pick writes the saved default (settings.json model names the picked row, effortLevel the ladder move)", typeof saved.model === 'string' && /sonnet/i.test(saved.model) && saved.effortLevel === 'xhigh', JSON.stringify(saved))
  check('the door row follows at once (Sonnet 5 · ◉ xhigh) and the picker is gone', rowWith(picked, DOOR).includes(`${DOOR} · Sonnet 5 · ◉ xhigh`) && !picked.some(l => l.includes('Mercury · model')), trimmedRow(picked, DOOR))
  check('with the coordinator panel focused, m types into its box (the negative pin)', typed.some(l => /│ ❯ m(▌|\s)/.test(l)) && !typed.some(l => l.includes('Mercury · model')), typed.filter(l => l.includes('❯')).join(' | '))
}

section('§2 --chat: the hint row without m menu, the bottom row names m, m opens the picker over the face, esc closes it')
{
  const home = seededHome('chat')
  const c = capture('chat', home, ['--chat'], [
    { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'face', data: 'm' },
    { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'picker', data: ESC },
    { requireAwait: true, awaitText: '↑↓ choose', awaitSettleTicks: 3, mark: 'closed', data: '' },
  ], { total: 260, ready: ['↑↓ choose'] })
  check('the drive delivered every send (exit 0)', c.status === 0, `exit ${c.status}`)
  const face = c.marks.get('face') ?? []
  const picker = c.marks.get('picker') ?? []
  const closed = c.marks.get('closed') ?? []
  check('the hint row reads ↵ start · ↑↓ choose, m menu gone', trimmedRow(face, '>_ ready') === CHAT_HINT, trimmedRow(face, '>_ ready'))
  check('the bottom row names m beside the shift arrow', trimmedRow(face, '⇧→') === `⇧→ no chat open · ${PHRASE}`, trimmedRow(face, '⇧→'))
  check('m opens the picker over the face, centred (top row 3, left column 39), the card still beside it', rowWith(picker, 'Mercury · model') !== '' && pickerFrames(picker) && picker.some(l => l.includes('❯ ✶ New S')), picker.slice(3, 8).join(' | '))
  check('the Boot Menu did not open and no row reads frontier:', picker.length > 0 && !picker.some(l => l.includes('CONTROL PLANE')) && !picker.some(l => l.includes('frontier:')))
  check('the Anthropic heading reads the key door with its tail and the live count', anthropicKeyHeading(picker), headingOf(picker, ANTHROPIC_TITLE))
  check('esc closes the picker back to the face', trimmedRow(closed, '>_ ready') === CHAT_HINT && !closed.some(l => l.includes('Mercury · model')), trimmedRow(closed, '>_ ready'))
}

section('§3 the face outside --chat: the same door — m menu gone from the hint row, the bottom row names m, m opens the picker')
{
  const home = seededHome('face')
  const c = capture('face', home, [], [
    { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'face', data: 'm' },
    { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'picker', data: '' },
  ], { total: 200, ready: ['esc or click outside closes'] })
  check('the drive delivered every send (exit 0)', c.status === 0, `exit ${c.status}`)
  const face = c.marks.get('face') ?? []
  check('the hint row reads ↵ start · ↑↓ choose, m menu gone', trimmedRow(face, '>_ ready') === CHAT_HINT, trimmedRow(face, '>_ ready'))
  check('the bottom row names the concourse and m', trimmedRow(face, '⇧→') === `⇧→ concourse · ${PHRASE}`, trimmedRow(face, '⇧→'))
  check('m opens the picker over the face', (c.marks.get('picker') ?? []).some(l => l.includes('Mercury · model')))
}

section("§4 the chat's /model: the picker without its frontier rows")
{
  const home = seededHome('model')
  const c = capture('model', home, [], [
    { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { atTick: 999, requireAwait: true, awaitText: '← back', minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'chat', data: '' },
    { afterPrevTicks: 1, data: '/model' },
    { afterPrevTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'picker', data: '' },
  ], { total: 360, ready: ['esc or click outside closes'] })
  check('the drive delivered every send (exit 0)', c.status === 0, `exit ${c.status}`)
  const chat = c.marks.get('chat') ?? []
  check('the row above the composer reads ready · Opus 5.5 · high, the way back at its right, the project name gone from it', /^ready · Opus 5\.5 · high {2,}(?:⇧|shift\+)← back$/.test(trimmedRow(chat, '← back')) && !trimmedRow(chat, '← back').includes('fixture-cwd'), trimmedRow(chat, '← back'))
  const picker = c.marks.get('picker') ?? []
  const zai = headingOf(picker, ' Z.AI · ')
  check('no row of the picker reads frontier:', picker.length > 0 && !picker.some(l => l.includes('frontier:')), picker.filter(l => l.includes('frontier:')).join(' | '))
  check('the Anthropic heading reads the key door with its tail and the live count', anthropicKeyHeading(picker), headingOf(picker, ANTHROPIC_TITLE))
  check('the Z.AI heading carries its not-connected reason', zai !== '' && zai.includes('no Z.AI API key'), zai)
}

section('§5 the setting off (sessionDefaultsKey false in settings.json): every row as shipped, m does what it did')
{
  const off = { sessionDefaultsKey: false }
  const homeBoard = seededHome('off-board', off)
  const a = capture('off-board', homeBoard, [], [
    ...boardSends,
    { afterPrevTicks: 6, data: '', mark: 'after-m' },
  ], { total: 220, ready: ['esc boot face'] })
  check('the drive delivered every send (exit 0)', a.status === 0, `exit ${a.status}`)
  const board = a.marks.get('board') ?? []
  const afterM = a.marks.get('after-m') ?? []
  check('the door row reads as shipped (no pair)', rowWith(board, DOOR) !== '' && !rowWith(board, DOOR).includes(`${DOOR} · `), trimmedRow(board, DOOR))
  check('the bottom row reads as shipped', trimmedRow(board, 'esc boot face') === FOOTER_AS_SHIPPED, trimmedRow(board, 'esc boot face'))
  check('m opens no picker', !afterM.some(l => l.includes('Mercury · model')))
  const homeChat = seededHome('off-chat', off)
  const b = capture('off-chat', homeChat, ['--chat'], [
    { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'face', data: 'm' },
    { requireAwait: true, awaitText: 'CONTROL PLANE', awaitStableTicks: 3, mark: 'menu', data: '' },
  ], { total: 200, ready: ['CONTROL PLANE'] })
  check('the drive delivered every send (exit 0)', b.status === 0, `exit ${b.status}`)
  const face = b.marks.get('face') ?? []
  check('--chat: the hint row keeps m menu', trimmedRow(face, '>_ ready') === FULL_HINT, trimmedRow(face, '>_ ready'))
  check('--chat: the bottom row reads ⇧→ no chat open alone', trimmedRow(face, '⇧→') === '⇧→ no chat open', trimmedRow(face, '⇧→'))
  check('--chat: m opens the Boot Menu', (b.marks.get('menu') ?? []).some(l => l.includes('CONTROL PLANE')))
}

section('§6 a fresh home with no sign-in: the bottom row stands at the height where the card would fill the terminal, and nothing moves where it already stood')
{
  const noSignIn = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const bare = { ...env }
    delete bare.ANTHROPIC_API_KEY
    return bare
  }
  const faceSends: Send[] = [{ atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'face', data: '' }]
  const dividers = (lines: string[]): number => lines.filter(l => l.trim().startsWith('├')).length
  const cardRows = (lines: string[]): number => lines.filter(l => l.includes(' → ')).length
  const tight = capture('fresh-49', seededHome('fresh-49'), [], faceSends, { total: 200, ready: ['↑↓ choose'], cols: 177, rows: 49, env: noSignIn })
  check('177×49: the drive delivered every send (exit 0)', tight.status === 0, `exit ${tight.status}`)
  const at49 = tight.marks.get('face') ?? []
  check('177×49: the strip reads no sign-in yet and not signed in', rowWith(at49, 'Model no sign-in yet') !== '' && rowWith(at49, 'Acct not signed in') !== '', at49.filter(l => l.includes('Model') || l.includes('Acct')).map(l => l.trim()).join(' | '))
  check('177×49: the card has nine rows (no Continue row on a fresh home)', cardRows(at49) === 9, `${cardRows(at49)} rows`)
  check('177×49: the bottom row names the concourse and m', (at49[48] ?? '').trim() === `⇧→ concourse · ${PHRASE}`, JSON.stringify((at49[48] ?? '').trim()))
  check('177×49: the block ends above the bottom row', !(at49[48] ?? '').includes('╰') && at49.some((l, i) => i < 48 && l.trim().startsWith('╰')), (at49[48] ?? '').trim())
  check('177×49: the card gives up its dividers to make room for the row', dividers(at49) === 0, `${dividers(at49)} dividers`)
  const wide = capture('fresh-51', seededHome('fresh-51'), [], faceSends, { total: 200, ready: ['↑↓ choose'], env: noSignIn })
  check('178×51: the drive delivered every send (exit 0)', wide.status === 0, `exit ${wide.status}`)
  const at51 = wide.marks.get('face') ?? []
  check('178×51: the bottom row names the concourse and m', (at51[50] ?? '').trim() === `⇧→ concourse · ${PHRASE}`, JSON.stringify((at51[50] ?? '').trim()))
  check('178×51: the block stands where it stood — two blank rows above the art, eight dividers on the card, the strip\'s bottom border on row 50', (at51[0] ?? '').trim() === '' && (at51[1] ?? '').trim() === '' && (at51[2] ?? '').includes('▀') && dividers(at51) === 8 && (at51[49] ?? '').trim().startsWith('╰'), `dividers ${dividers(at51)} · row 49 ${(at51[49] ?? '').trim().slice(0, 4)}`)
}

section('§7 the Boot face picker asks OpenAI for the live list when it opens: the GPT rows land before any session exists')
{
  const home = seededHome('gpt-face')
  writeFileSync(join(home, '.openai-auth.json'), JSON.stringify({ version: 1, tokens: { idToken: 'fixture-id', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus', email: 'sam@example.test', accessTokenExpiresAtMs: Date.now() + 86_400_000 } }), { mode: 0o600 })
  const wireFile = join(home, 'wire.jsonl')
  const catalogueFile = join(home, 'models.json')
  writeFileSync(wireFile, '')
  const gpt = (id: string, display_name: string, priority: number) => ({ id, display_name, priority, visibility: 'public', supported_in_api: true, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', context_window: 400_000, input_modalities: ['text', 'image'] })
  writeFileSync(catalogueFile, JSON.stringify({ models: [gpt('gpt-5.6-sol', 'GPT-5.6 Sol', 1), gpt('gpt-5.6-terra', 'GPT-5.6 Terra', 2)], afterTurn: [], delayMs: 0 }))
  const fixture = spawn(NODE, [join(REPO, 'scripts/journey/cap-offer-fixture-server.ts'), wireFile, catalogueFile], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('the catalogue fixture did not print PORT')), vshotBudgetMs(15_000))
      let output = ''
      fixture.stdout!.on('data', chunk => {
        output += String(chunk)
        const match = /PORT (\d+)/.exec(output)
        if (match) {
          clearTimeout(timer)
          resolvePort(Number(match[1]))
        }
      })
      fixture.on('exit', code => {
        clearTimeout(timer)
        reject(new Error(`the catalogue fixture exited ${code}`))
      })
    })
    const base = `http://127.0.0.1:${port}`
    const c = capture('gpt-face', home, [], [
      { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'face', data: 'm' },
      { requireAwait: true, awaitText: 'Mercury · model', awaitSettleTicks: 2, data: '\u001b[A'.repeat(12) },
      { requireAwait: true, awaitText: 'GPT-5.6 Terra', awaitStableTicks: 3, mark: 'picker', data: ESC },
      { requireAwait: true, awaitText: '↑↓ choose', awaitSettleTicks: 3, mark: 'closed', data: '' },
    ], { total: 260, ready: ['↑↓ choose'], env: e => ({ ...e, MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`, MERCURY_OPENAI_API_BASE: `${base}/openai/v1` }) })
    check('the drive delivered every send (exit 0): the fetched GPT rows painted on the Boot face picker', c.status === 0, `exit ${c.status}`)
    const picker = c.marks.get('picker') ?? []
    const gptRows = picker.filter(l => l.includes('GPT')).map(l => l.trim()).join(' | ')
    check('the picker lists the fetched GPT rows as switchable (no unavailable word)', /GPT-5\.6 Sol\s{2,}gpt-5\.6-sol\s{2,}(?!unavailable)\S/.test(picker.join('\n')) && /GPT-5\.6 Terra\s{2,}gpt-5\.6-terra\s{2,}(?!unavailable)\S/.test(picker.join('\n')), gptRows)
    check('no row reads connecting or not fetched yet', picker.length > 0 && !picker.some(l => l.includes('GPT — connecting') || l.includes('not fetched yet')), gptRows)
    check('the first list arrives without a changed-list notice', picker.length > 0 && !picker.some(l => l.includes('the live list changed')))
    const wire = readFileSync(wireFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string })
    check('exactly one models request reached the fixture, and no session was born for it', wire.filter(e => e.kind === 'models').length === 1 && !wire.some(e => e.kind === 'openai'), wire.map(e => e.kind).join(','))
    check('esc closes the picker back to the face', (c.marks.get('closed') ?? []).some(l => l.includes('↑↓ choose')) && !(c.marks.get('closed') ?? []).some(l => l.includes('Mercury · model')))
  } finally {
    fixture.kill('SIGTERM')
  }
}

section('§8 the board with sessions keeps the new-session line as its first row: m on it opens the model-default picker, m on a session row the session picker')
{
  const SHIFT_LEFT = `${ESC}[1;2D`
  const DOWN = `${ESC}[B`
  const LINE = 'n starts a blank session in this project'
  const home = seededHome('board-with-sessions')
  const birth: Send[] = [
    { requireAwait: true, awaitText: 'n new session', awaitStableTicks: 3, data: 'n' },
    { requireAwait: true, awaitText: 'contract?', awaitSettleTicks: 2, data: ESC },
    { requireAwait: true, awaitText: '← back', minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, data: SHIFT_LEFT },
  ]
  const c = capture('board-with-sessions', home, [], [
    { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: SHIFT_RIGHT },
    { requireAwait: true, awaitText: 'coordinator model', awaitStableTicks: 3, data: TAB },
    ...birth,
    { requireAwait: true, awaitText: 'STATUS & TITLE', awaitStableTicks: 3, data: '' },
    ...birth,
    { requireAwait: true, awaitText: 'STATUS & TITLE', awaitStableTicks: 3, mark: 'board', data: UP },
    { afterPrevTicks: 3, data: UP },
    { afterPrevTicks: 3, data: UP },
    { afterPrevTicks: 4, data: '', mark: 'line' },
    { afterPrevTicks: 2, data: 'm' },
    { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'default-picker', data: ESC },
    { requireAwait: true, awaitText: LINE, awaitSettleTicks: 3, data: DOWN },
    { afterPrevTicks: 4, data: '', mark: 'row' },
    { afterPrevTicks: 2, data: 'm' },
    { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'session-picker', data: UP },
    { afterPrevTicks: 3, data: 'e' },
    { afterPrevTicks: 3, data: '\r' },
    { afterPrevTicks: 8, data: '', mark: 'session-picked' },
  ], { total: 900, ready: ['esc focused chat'] })
  check('the drive delivered every send (exit 0)', c.status === 0, `exit ${c.status}`)
  const board = c.marks.get('board') ?? []
  const line = c.marks.get('line') ?? []
  const defaultPicker = c.marks.get('default-picker') ?? []
  const row = c.marks.get('row') ?? []
  const sessionPicker = c.marks.get('session-picker') ?? []
  const sessionPicked = c.marks.get('session-picked') ?? []
  const headerAt = (lines: string[]): number => lines.findIndex(l => l.includes('STATUS & TITLE'))
  const sessionRows = (lines: string[]): string[] => lines.filter(l => /new session · fixture-cwd/.test(l))
  check('two blank sessions stand on the board', sessionRows(board).length >= 2, sessionRows(board).map(l => l.trim().slice(0, 80)).join(' | '))
  check('the first row under the column header is the new-session line with its door words, unselected while a session row holds the cursor', headerAt(board) >= 0 && (board[headerAt(board) + 1] ?? '').includes(`  ${LINE} · Opus 5.5 · ● high`) && !(board[headerAt(board) + 1] ?? '').includes(`▸ ${LINE}`), (board[headerAt(board) + 1] ?? '').trim())
  check('↑ from the first session row reaches the line: it wears the cursor and the bottom row names m for the default', (line[headerAt(line) + 1] ?? '').includes(`▸ ${LINE} · Opus 5.5 · ● high`) && trimmedRow(line, 'esc focused chat').includes(`n new session · ${PHRASE}`), `${(line[headerAt(line) + 1] ?? '').trim()} / ${trimmedRow(line, 'esc focused chat')}`)
  check('the mirror shows no session while the line holds the cursor', line.some(l => l.includes('select a session to mirror its chat')), line.filter(l => l.includes('mirror')).map(l => l.trim()).join(' | '))
  check('m on the line opens the model-default picker over the board', defaultPicker.some(l => l.includes('Mercury · model')) && pickerFrames(defaultPicker), defaultPicker.slice(3, 8).join(' | '))
  check('↓ returns to the first session row and the line loses the cursor', row.some(l => /▸ .*new session · fixture-cwd/.test(l)) && (row[headerAt(row) + 1] ?? '').includes(`  ${LINE}`), (row[headerAt(row) + 1] ?? '').trim())
  check('m on a session row opens a picker over the board', sessionPicker.some(l => l.includes('Mercury · model')) && pickerFrames(sessionPicker), sessionPicker.slice(3, 8).join(' | '))
  const afterPick = settingsOf(home)
  check("the session row's pick is the session's own: the default door still reads Opus 5.5 · ● high, settings.json keeps no model and no effort, the picker is gone", (sessionPicked[headerAt(sessionPicked) + 1] ?? '').includes(`${LINE} · Opus 5.5 · ● high`) && afterPick.model === undefined && afterPick.effortLevel === undefined && !sessionPicked.some(l => l.includes('Mercury · model')), `${(sessionPicked[headerAt(sessionPicked) + 1] ?? '').trim()} / ${JSON.stringify(afterPick)}`)
  console.log(`  [record] the session row after its pick: ${sessionPicked.filter(l => /model → |new session · fixture-cwd/.test(l)).map(l => l.trim().slice(0, 100)).join(' | ') || 'no row receipt on the frame'}`)
}

}

if (CASE === undefined || CASE === 'session-effort') {
  section('the session picker reads the selected session effort, not the saved default')
  for (const [cols, rows] of [[120, 40], [178, 51]]) {
    const home = seededHome(`session-effort-${cols}`, { effortLevel: 'high' })
    const c = capture(`session-effort-${cols}`, home, [], [
      { requireAwait: true, awaitText: '↑↓ choose', awaitSettleTicks: 3, data: SHIFT_RIGHT },
      { requireAwait: true, awaitText: 'coordinator model', awaitSettleTicks: 3, data: TAB },
      { requireAwait: true, awaitText: 'n new session', awaitSettleTicks: 3, data: 'n' },
      { requireAwait: true, awaitText: 'contract?', awaitSettleTicks: 2, data: ESC },
      { requireAwait: true, awaitText: '← back', awaitSettleTicks: 4, data: `${ESC}[1;2D` },
      { requireAwait: true, awaitText: 'STATUS & TITLE', awaitSettleTicks: 4, data: 'e' },
      { requireAwait: true, awaitText: "sets this session's effort", awaitSettleTicks: 3, mark: 'effort-door', data: '\r' },
      { requireAwait: true, awaitText: 'effort → low', awaitSettleTicks: 4, mark: 'low-receipt', data: 'm' },
      { requireAwait: true, awaitText: 'Mercury · model', awaitSettleTicks: 5, mark: 'opened', data: 'e' },
      { afterPrevTicks: 12, data: '', mark: 'after-arrow' },
    ], { cols, rows, total: 600, ready: ['Mercury · model'] })
    const opened = c.marks.get('opened') ?? []
    const after = c.marks.get('after-arrow') ?? []
    check(`${cols}x${rows}: the drive delivered every send`, c.status === 0, `exit ${c.status}`)
    check(`${cols}x${rows}: the session picker opens on low`, opened.some(l => l.includes('[low]')), opened.filter(l => l.includes('effort')).join(' | '))
    check(`${cols}x${rows}: the session ladder carries no supercode`, opened.length > 0 && !opened.some(l => l.includes('supercode')))
    check(`${cols}x${rows}: e advances the effort from low to medium`, after.some(l => l.includes('[medium]')), after.filter(l => l.includes('effort')).join(' | '))
    check(`${cols}x${rows}: the saved default remains high`, settingsOf(home).effortLevel === 'high')
    if (FRAMES !== undefined) {
      mkdirSync(FRAMES, { recursive: true })
      writeFileSync(join(FRAMES, `session-effort-${cols}x${rows}.json`), readFileSync(join(ROOT, `session-effort-${cols}.json`)))
      for (const [mark, lines] of c.marks) writeFileSync(join(FRAMES, `session-effort-${cols}x${rows}-${mark}.txt`), lines.join('\n') + '\n')
    }
  }
}

if (!KEEP) rmSync(ROOT, { recursive: true, force: true })
else console.log(`\n  kept: ${ROOT}`)
console.log(failures === 0 ? '\n✅ the default model and effort a new session starts on: chosen with m, saved, shown on the door' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
