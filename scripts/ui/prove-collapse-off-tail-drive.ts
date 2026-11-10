#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { projectSlug } from '../../src/utils/sessionStoragePortable.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'

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
const PGUP = `${ESC}[5~`
const SHIFT_UP = `${ESC}[1;2A`
const DOWN = `${ESC}[B`
const ENTER = '\r'
const CLICK = `${ESC}[<0;{X};{Y}M${ESC}[<0;{X};{Y}m`
const WHEEL_UP = `${ESC}[<64;60;20M`
type Size = { cols: number; rows: number }
const WIDE: Size = { cols: 120, rows: 40 }
const SMALL: Size = { cols: 100, rows: 30 }
const TURNS = 12
const CALLS = 4
const LINES = 30
const SHORT_TURN = 10
const SID = '00000000-c011-4000-8000-0000000000a5'
const KEEP = process.env.COLLAPSE_DRIVE_KEEP === '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

process.env.ANTHROPIC_API_KEY = KEY
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'collapse-off-tail-')))
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
    TERM: 'xterm-256color',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_TMPDIR: join(ROOT, 'product-tmp'),
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
    MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
  }
  for (const k of [
    'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_OAUTH_TOKEN', 'NODE_ENV', 'MERCURY_DEMO', 'TERMINAL_EMULATOR',
    '__CFBundleIdentifier', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'MERCURY_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL',
    'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL',
  ]) {
    delete env[k]
  }
  return env
}

const pad = (n: number): string => String(n).padStart(2, '0')
const turn = (t: number): string => `T${pad(t)}`
const callsOf = (t: number): number => (t === SHORT_TURN ? 2 : CALLS)
const linesOf = (t: number): number => (t === SHORT_TURN ? 1 : LINES)
const outputLine = (t: number, call: number, line: number): string => `${turn(t)} cmd ${call} output line ${pad(line)} of ${linesOf(t)}`
const closing = (t: number): string => `${turn(t)} closing: all ${callsOf(t)} commands for part ${t} came back clean.`
const closingSecond = (t: number): string => `${turn(t)} closing second paragraph: nothing to fix in part ${t}; the next part is ${t + 1}.`
const ask = (t: number): string => `${turn(t)} ask: run the checks for part ${t} and tell me what came back`

function seededHome(tag: string): string {
  const home = join(ROOT, `home-${tag}`)
  seedFirstRun(home, [CWD])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { reducedMotion: true }, activity: { tips: { enabled: false } } }))
  writeFileSync(
    join(home, 'critter-profile.json'),
    JSON.stringify({ v: 1, seed: '00000000-0000-4000-8000-00000000c0de', createdAt: 1787600000000, milestones: { settles: 0, recoveries: 0 }, quiet: true, seenTips: {}, openedSurfaces: [] }),
  )
  const rows: Record<string, unknown>[] = []
  let seq = 0
  let prev: string | null = null
  let clock = Date.parse('2026-06-19T08:00:00.000Z')
  const push = (extra: Record<string, unknown>): void => {
    const uuid = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
    clock += 1500
    rows.push({ isSidechain: false, entrypoint: 'cli', cwd: CWD, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', parentUuid: prev, uuid, timestamp: new Date(clock).toISOString(), ...extra })
    prev = uuid
  }
  const assistant = (id: string, content: unknown[], stop: string): Record<string, unknown> => ({
    type: 'assistant',
    requestId: `req_${id}`,
    message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } },
  })
  for (let t = 1; t <= TURNS; t++) {
    push({ type: 'user', message: { role: 'user', content: ask(t) } })
    push(assistant(`${turn(t)}_open`, [{ type: 'text', text: `${turn(t)} opening: I will run ${callsOf(t)} commands for part ${t}.` }], 'tool_use'))
    for (let call = 1; call <= callsOf(t); call++) {
      const id = `toolu_${turn(t)}_${call}`
      const stdout = Array.from({ length: linesOf(t) }, (_, i) => outputLine(t, call, i + 1)).join('\n')
      push(assistant(`${turn(t)}_${call}`, [{ type: 'tool_use', id, name: 'Bash', input: { command: `./check-part ${t} --step ${call}`, description: `Check part ${t} step ${call}` } }], 'tool_use'))
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: stdout }] }] }, toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } })
    }
    push(assistant(`${turn(t)}_close`, [{ type: 'text', text: `${closing(t)}\n\n${closingSecond(t)}` }], 'end_turn'))
  }
  const file = join(home, 'projects', projectSlug(CWD), `${SID}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeSeedTranscript(rows, SID))
  return home
}

type Send = Record<string, unknown>
type Grid = Array<Array<{ c: string }>>
type Capture = { status: number | null; lines: string[]; marks: Map<string, string[]> }

const driver = resolveCaptureDriver()
const textOf = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, ''))

function capture(id: string, home: string, sends: Send[], total: number, size: Size): Capture {
  if (driver.kind !== 'posix-pty') throw new Error(`no POSIX pty capture driver on this host (${driver.kind})`)
  const out = join(ROOT, `${id}.json`)
  const cfgPath = join(ROOT, `${id}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [NODE, BIN, '--resume', SID], cwd: CWD, cols: size.cols, rows: size.rows, total, sends, readyText: ['bash commands'], out }))
  const res = spawnSync(driver.python, [VSHOT, cfgPath], { encoding: 'utf-8', env: childEnv(home), timeout: vshotBudgetMs(total * 200 + 90_000) })
  const marks = new Map<string, string[]>()
  let lines: string[] = []
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }> }
    if (payload.grid) lines = textOf(payload.grid)
    for (const m of payload.marks ?? []) marks.set(m.label, textOf(m.grid))
  }
  if (res.status !== 0) {
    console.log(`  ── ${id}: vshot exit ${res.status} ──`)
    for (const row of lines) console.log('  │' + row)
    console.log((res.stderr ?? '').trim().split('\n').slice(-8).join('\n'))
  }
  if (FRAMES !== undefined) {
    mkdirSync(FRAMES, { recursive: true })
    for (const [mark, frame] of marks) writeFileSync(join(FRAMES, `${id}-${size.cols}x${size.rows}-${mark}.txt`), frame.join('\n') + '\n')
  }
  return { status: res.status, lines, marks }
}

const HEAD_SHUT = `Ran ${CALLS} bash commands`
const HEAD_OPEN = `Expanded group (${CALLS} calls)`
const SHORT_SHUT = 'Ran 2 bash commands'
const SHORT_OPEN = 'Expanded group (2 calls)'

function under(frame: readonly string[], t: number): string[] | null {
  const opening = frame.findIndex(line => line.includes(`${turn(t)} opening`))
  const at = frame.findIndex((line, row) => row > opening && line.includes(HEAD_SHUT))
  if (at < 0) return null
  const foot = frame.findIndex((line, row) => row > at && (line.includes('back to the bottom') || /╰─{20,}/.test(line)))
  return frame.slice(at + 1, foot < 0 ? frame.length : foot).map(line => line.replace(/[│\s]+$/, '').replace(/^.*?│\s?/, ''))
}

function judge(label: string, frame: readonly string[], t: number): void {
  const shown = under(frame, t)
  const blankRun = (shown ?? []).reduce((run, row) => (row.trim() === '' ? { now: run.now + 1, most: Math.max(run.most, run.now + 1) } : { now: 0, most: run.most }), { now: 0, most: 0 }).most
  const wanted = [`${turn(t)} closing: all`, `${turn(t)} closing second paragraph`, `${turn(t + 1)} ask:`]
  const found = wanted.filter(words => (shown ?? []).some(row => row.includes(words)))
  const fits = Math.min(wanted.length, Math.floor((shown ?? []).length / 2))
  check(
    `${label}: the rows under the collapsed group are painted, the turn's closing first`,
    shown !== null && fits >= 1 && found.length >= fits && blankRun <= 1,
    `${shown === null ? `the collapsed row of ${turn(t)} is not in the pane` : `${shown.length} rows to the pane's foot, ${found.length} of ${fits} expected lines, the longest blank run ${blankRun}`}\n${frame.slice(4, 34).map(line => `      ${line}`).join('\n')}`,
  )
}

console.log('============================================================')
console.log(' A tool group collapsed while the transcript is scrolled off the tail')
console.log(`   bundle: ${BIN}`)
console.log('============================================================')
if (!existsSync(BIN)) {
  console.error('  dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}

const settledTail = { requireAwait: true, awaitText: HEAD_SHUT, awaitSettleTicks: 8, awaitStableTicks: 3 }
const NO_OPEN_GROUP = `^(?![\\s\\S]*Expanded group \\(${CALLS} calls\\))`
const NO_EDIT_ROW = '^(?![\\s\\S]*enter edit)'

if (CASE === undefined || CASE === 'click') {
  section('by a click: expanded at the tail, scrolled up until its head is in the pane, a short group above it opened, then collapsed with a click on its head')
  const t = TURNS - 1
  const c = capture('click', seededHome('click'), [
    { ...settledTail, targetText: HEAD_SHUT, targetDx: 1, data: CLICK, mark: 'rest' },
    { requireAwait: true, awaitText: outputLine(t, CALLS, LINES), awaitSettleTicks: 3, data: PGUP, mark: 'expanded-at-tail' },
    { requireAwait: true, awaitText: outputLine(t, 4, 10), awaitSettleTicks: 2, data: PGUP },
    { requireAwait: true, awaitText: outputLine(t, 3, 15), awaitSettleTicks: 2, data: PGUP },
    { requireAwait: true, awaitText: outputLine(t, 2, 25), awaitSettleTicks: 2, data: PGUP },
    { requireAwait: true, awaitText: SHORT_SHUT, repeatEveryTicks: 2, data: WHEEL_UP },
    { requireAwait: true, awaitText: HEAD_OPEN, awaitSettleTicks: 4, targetText: SHORT_SHUT, targetDx: 1, data: CLICK, mark: 'head-in-view' },
    { requireAwait: true, awaitText: SHORT_OPEN, awaitSettleTicks: 4, targetText: HEAD_OPEN, targetDx: 1, data: CLICK, mark: 'short-group-open' },
    { requireAwait: true, awaitText: HEAD_SHUT, awaitPattern: NO_OPEN_GROUP, awaitSettleTicks: 3, data: '', mark: 'collapsed' },
  ], 340, WIDE)
  check('the drive delivered every send', c.status === 0 && c.marks.has('collapsed'), `exit ${c.status}, marks ${[...c.marks.keys()].join(',')}`)
  const before = c.marks.get('short-group-open') ?? []
  check(
    "before the collapse the group's head is in the pane, its body runs past the pane's foot and the pill is on",
    before.some(line => line.includes(HEAD_OPEN)) && before.some(line => line.includes('back to the bottom')) && !before.some(line => line.includes(closing(t))),
    before.slice(4, 34).join('\n'),
  )
  judge('after the click', c.marks.get('collapsed') ?? [], t)
}

for (const size of [WIDE, SMALL]) {
  const at = `${size.cols}x${size.rows}`
  if (CASE !== undefined && CASE !== 'key') continue
  section(`by the key at ${at}: the message cursor on a group four turns up, Enter expands it, Enter collapses it`)
  const t = TURNS - 4
  const c = capture(`key-${at}`, seededHome(`key-${at}`), [
    { ...settledTail, data: SHIFT_UP, mark: 'rest' },
    { requireAwait: true, awaitText: 'navigate', awaitSettleTicks: 2, data: SHIFT_UP },
    { requireAwait: true, awaitText: 'navigate', awaitSettleTicks: 2, data: SHIFT_UP },
    { requireAwait: true, awaitText: `${turn(t + 2)} opening`, awaitSettleTicks: 2, data: SHIFT_UP },
    { requireAwait: true, awaitText: `${turn(t + 1)} opening`, awaitSettleTicks: 2, data: SHIFT_UP },
    { requireAwait: true, awaitText: `${turn(t)} opening`, awaitSettleTicks: 2, data: DOWN },
    { requireAwait: true, awaitText: 'c copy', awaitPattern: NO_EDIT_ROW, awaitSettleTicks: 2, data: DOWN },
    { requireAwait: true, awaitText: 'enter expand', awaitSettleTicks: 3, data: ENTER, mark: 'on-the-group' },
    { requireAwait: true, awaitText: 'enter collapse', awaitSettleTicks: 4, data: ENTER, mark: 'expanded' },
    { requireAwait: true, awaitText: 'enter expand', awaitSettleTicks: 3, data: '', mark: 'collapsed' },
  ], 320, size)
  check(`${at}: the drive delivered every send`, c.status === 0 && c.marks.has('collapsed'), `exit ${c.status}, marks ${[...c.marks.keys()].join(',')}`)
  const open = c.marks.get('expanded') ?? []
  const head = open.findIndex(line => line.includes(HEAD_OPEN))
  check(
    `${at}: after Enter the expanded group's head is in the pane with its first output under it`,
    head >= 0 && open.slice(head + 1, head + 4).some(line => line.includes(outputLine(t, 1, 1))) && !open.some(line => line.includes(closing(t))),
    open.slice(4, 16).join('\n'),
  )
  judge(`${at}: after the second Enter`, c.marks.get('collapsed') ?? [], t)
}

if (!KEEP) rmSync(ROOT, { recursive: true, force: true })
else console.log(`  kept: ${ROOT}`)
console.log(failures === 0 ? '\n✅ a group collapsed off the tail leaves the pane whole on the built product' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
