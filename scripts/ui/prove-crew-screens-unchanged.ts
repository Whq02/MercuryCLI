#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST_BEFORE = argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs')
const DIST_AFTER = argAfter('--dist-after') ?? DIST_BEFORE
const TWO_BUNDLES = argAfter('--dist-after') !== undefined
const PIN = process.argv.includes('--pin')
const STORED_DIR = join(ROOT, 'scripts', 'ui')
const storedPath = (cols: number, rows: number): string => join(STORED_DIR, `crew-screens-frames-${cols}x${rows}.json`)
const STORED_LABEL = 'the stored frames (scripts/ui/crew-screens-frames-<cols>x<rows>.json)'
const FRAMES = argAfter('--frames')
const PAGE = argAfter('--page')
const SIZES = (argAfter('--sizes') ?? '80x24,120x40,178x51').split(',').map(s => s.split('x').map(Number) as [number, number])
const ONLY = argAfter('--only')
const KEEP = process.argv.includes('--keep')
const DUMP = process.argv.includes('--dump')
const JOBS = Math.max(1, Number(argAfter('--jobs') ?? '3'))
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
const ESC = '\x1b'
const DOWN = '\x1b[B'
const SHIFT_LEFT = '\x1b[1;2D'
const LEAD_ASK = 'crew-screens: launch the crew'
const LEAD_DONE = 'crew-screens: the crew is out.'
const REPORT_PLACES = ['the rail', 'the view', 'the composer', 'the crew box', 'the runs board', 'the model picker', 'the help rows', 'the sessions list', 'the boot face', 'the status row', 'the footer keys', 'the pop-up frame']
const REPORT_CLAIMS = ['keeps every row', 'holds its keys', 'stands where it stood', 'paints the same cells']
const LEAD_REPORT = [LEAD_DONE, ...Array.from({ length: 48 }, (_, i) => `${i + 1}. ${REPORT_PLACES[i % REPORT_PLACES.length]} ${REPORT_CLAIMS[Math.floor(i / REPORT_PLACES.length) % REPORT_CLAIMS.length]}`)].join('\n')
const NOTICE_PATTERN = 'Agent "fjord" completed'
const FACE_PATTERN = '\\d+ agents\\b[\\s\\S]*\\d+ of \\d+ signed in'
const FOCUSED_WIDE_PATTERN = '\\n ready · [^\\n]*← back'
const FOCUSED_NARROW_PATTERN = '● ready · [\\s\\S]*\\d+ sessions? on · '
const LOADING_WORDS = 'opening the conversation|no chat is focused|has not reported its work|counts unavailable|Initializing agent'
const settledPattern = (pattern?: string): string => `\\A(?![\\s\\S]*(?:${LOADING_WORDS}))${pattern === undefined ? '' : `[\\s\\S]*(?:${pattern})`}`
const BOARD_PATTERN = 'STATUS & TITLE|─sessions · \\d+ ─'
const COUNTS_PATTERN = '\\d+ agents? here|A:\\d+'
const CREW_EMPTY_NEEDLE = 'ask the chat to delegate'
const SESSIONS_NEEDLE = 'No other sessions in this project'
const SESSIONS_PATTERN = 'this session ● active'
const MATE_TAG = 'crew-screens-mate'
const RUNNER = 'atlas'
const SETTLED = 'fjord'
const RUNNER_LINE = 'atlas: holding the line for the screens'
const SETTLED_LINE = 'fjord: reports in with one line for the view'
const RUNNER_SLEEP_SECONDS = 287
const SETTLED_SLEEP_SECONDS = 4
const SECOND_LAUNCH_DELAY_MS = 3000
const LEAD_NOTED = 'noted — the crewmate is in.'
const MODEL_TITLE = 'Mercury · model'
const STILL_TICKS = 12
const VOLATILE_TOKEN = '⟪·⟫'

export const SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ['/teammates', '/crewmates'],
  ['TeamBrief', 'LiveComms'],
  ['Teammates', 'Crewmates'],
  ['Teammate', 'Crewmate'],
  ['teammates', 'crewmates'],
  ['teammate', 'crewmate'],
  ['Teams', 'Crews'],
  ['Team', 'Crew'],
  ['teams', 'crews'],
  ['team', 'crew'],
]

export const VOLATILE: ReadonlyArray<readonly [string, RegExp]> = [
  ['a duration', /\b(?:\d+h )?(?:\d+m )?\d+(?:\.\d)?s\b|\b\d+h(?: \d+m)?\b|\b\d+m\b/g],
  ['a relative age', /\b\d+[smhd] (?:ago|old)\b/g],
  ['a wall clock', /\b\d{1,2}:\d{2}(?::\d{2})?(?: ?[AP]M)?\b/g],
  ['a calendar day', /\b\d{4}-\d{2}-\d{2}\b|\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b/g],
  ["the composer caret's blink phase", /\u258c/g],
]

type Cell = { c?: string; fg?: string; bg?: string; bold?: boolean; rev?: boolean }
type Grid = Cell[][]
type Frame = { rows: string[]; grid: Grid }
type Capture = { marks: Record<string, Frame>; final: Frame; sends: number; receipts: number; endReason: string; status: number | null; stderr: string }
type Send = Record<string, unknown>
type Scene = { id: string; title: string }

const SCENES: readonly Scene[] = [
  { id: 'face', title: 'the boot face' },
  { id: 'model-picker', title: 'the model picker (m on the boot face)' },
  { id: 'crew-empty', title: 'the crew view with no crewmate' },
  { id: 'chat', title: 'the chat, a blank session' },
  { id: 'help', title: 'help (? on the empty composer)' },
  { id: 'chat-crew', title: "the chat with two crewmates in the rail's crew box" },
  { id: 'crew-two', title: 'the crew view with two crewmates (the running one selected)' },
  { id: 'crew-settled', title: 'the crew view with the settled crewmate selected' },
  { id: 'view-panel', title: 'the view panel (↵ open in the view) on the settled crewmate' },
  { id: 'runs', title: 'the runs board' },
  { id: 'sessions', title: 'the session manager (/sessions)' },
  { id: 'board', title: "the concourse board's recent-sessions list" },
]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

const glyphOf = (cell: Cell | undefined): string => (cell === undefined ? ' ' : (cell.c ?? ' ') === '' ? ' ' : (cell.c ?? ' '))
const rowsOf = (grid: Grid): string[] => grid.map(row => row.map(glyphOf).join(''))
const toFrame = (grid: Grid): Frame => ({ rows: rowsOf(grid), grid })
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
type Item = { role?: string; content?: unknown }
type Fixture = { base: string; hits: string[]; close: () => Promise<void> }

const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const itemsOf = (body: unknown): Item[] => (Array.isArray((body as { messages?: unknown })?.messages) ? ((body as { messages: Item[] }).messages) : [])
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content as Array<{ type?: string; text?: string }>) if (part.type === 'text' && typeof part.text === 'string' && !part.text.trimStart().startsWith('<system-reminder>')) text += `\n${part.text}`
  return text
}
const isToolResultItem = (item: Item | undefined): boolean => item?.role === 'user' && Array.isArray(item.content) && (item.content as Array<{ type?: string }>).some(b => b.type === 'tool_result')
function stepOf(body: unknown): number {
  const items = itemsOf(body)
  let askAt = -1
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.role === 'user' && textOf(items[i]!.content).trim() !== '') {
      askAt = i
      break
    }
  }
  return items.slice(askAt + 1).filter(isToolResultItem).length
}
function openingOf(body: unknown): string {
  for (const item of itemsOf(body)) {
    if (item.role !== 'user') continue
    const text = textOf(item.content)
    if (text.trim() !== '') return text
  }
  return ''
}
function launchesOf(body: unknown): number {
  let n = 0
  for (const item of itemsOf(body)) {
    if (item.role !== 'assistant' || !Array.isArray(item.content)) continue
    for (const part of item.content as Array<{ type?: string; name?: string }>) if (part.type === 'tool_use' && part.name === 'Agent') n++
  }
  return n
}
const lastIsToolResult = (body: unknown): boolean => isToolResultItem(itemsOf(body)[itemsOf(body).length - 1])
function answer(model: string, blocks: Block[], usage: { input: number; output: number }): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts = [sse('message_start', { type: 'message_start', message: { id: `msg_crewscreens_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })]
  blocks.forEach((block, index) => {
    if (block.type === 'text') parts.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }), sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }), sse('content_block_stop', { type: 'content_block_stop', index }))
    else parts.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_crewscreens_${Date.now() % 100000}_${index}`, name: block.name, input: {} } }), sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }), sse('content_block_stop', { type: 'content_block_stop', index }))
  })
  parts.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output } }), sse('message_stop', { type: 'message_stop' }))
  return parts.join('')
}
const launch = (name: string): Block => ({ type: 'tool_use', name: 'Agent', input: { description: name, prompt: `${MATE_TAG} ${name}: take your part of the screens drive`, subagent_type: 'mercury-crew', run_in_background: true } })
function blocksFor(body: unknown): { route: string; blocks: Block[]; usage: { input: number; output: number } } {
  const opening = openingOf(body)
  const step = stepOf(body)
  if (opening.includes(`${MATE_TAG} ${RUNNER}:`)) return step === 0 ? { route: `${RUNNER}#0`, blocks: [{ type: 'text', text: RUNNER_LINE }, { type: 'tool_use', name: 'Sleep', input: { seconds: RUNNER_SLEEP_SECONDS } }], usage: { input: 900, output: 40 } } : { route: `${RUNNER}#${step}`, blocks: [{ type: 'text', text: `${RUNNER}: the line held` }], usage: { input: 950, output: 30 } }
  if (opening.includes(`${MATE_TAG} ${SETTLED}:`)) return step === 0 ? { route: `${SETTLED}#0`, blocks: [{ type: 'text', text: `${SETTLED}: one short wait, then the report` }, { type: 'tool_use', name: 'Sleep', input: { seconds: SETTLED_SLEEP_SECONDS } }], usage: { input: 800, output: 40 } } : { route: `${SETTLED}#${step}`, blocks: [{ type: 'text', text: SETTLED_LINE }], usage: { input: 850, output: 40 } }
  if (opening.includes(LEAD_ASK)) {
    const launches = launchesOf(body)
    if (lastIsToolResult(body)) return launches === 1 ? { route: 'lead#launch-2', blocks: [launch(SETTLED)], usage: { input: 1250, output: 80 } } : { route: 'lead#done', blocks: [{ type: 'text', text: LEAD_REPORT }], usage: { input: 1500, output: 30 } }
    if (launches === 0) return { route: 'lead#launch-1', blocks: [{ type: 'text', text: 'launching the crew — two crewmates, one after another' }, launch(RUNNER)], usage: { input: 1200, output: 80 } }
    return { route: 'lead#notice', blocks: [{ type: 'text', text: LEAD_NOTED }], usage: { input: 1600, output: 20 } }
  }
  return { route: 'side', blocks: [{ type: 'text', text: 'ok' }], usage: { input: 20, output: 2 } }
}
async function startFixture(): Promise<Fixture> {
  const hits: string[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (!(req.method === 'POST' && url.endsWith('/v1/messages'))) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(url.endsWith('/models') ? JSON.stringify({ object: 'list', data: [], models: [] }) : '{}')
        return
      }
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
      const { route, blocks, usage } = blocksFor(body)
      hits.push(route)
      const reply = (): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(answer(model, blocks, usage))
      }
      if (route === 'lead#launch-2') setTimeout(reply, SECOND_LAUNCH_DELAY_MS)
      else reply()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

function driveEnv(home: string, fixtureBase: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_SKIP_PERMISSIONS: '1',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER: 'clam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_THEME_PIN: 'dark',
    COLORTERM: 'truecolor',
    COLORFGBG: '15;0',
    TERM_PROGRAM: 'kitty',
    BROWSER: '/usr/bin/true',
  }
  for (const stamp of ['MERCURY_DAEMON_PERMISSION_MODE','NODE_ENV', 'CI', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_DEMO', 'TERMINAL_EMULATOR', '__CFBundleIdentifier', 'MERCURY_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL']) delete env[stamp]
  return env
}

const driver = resolveCaptureDriver()

async function capture(label: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv, scratch: string): Promise<Capture> {
  if (driver.kind !== 'posix-pty') throw new Error(`no POSIX pty capture driver on this host (${driver.kind})`)
  const cfgPath = join(scratch, `${label}.cfg.json`)
  const outPath = join(scratch, `${label}.grid.json`)
  rmSync(outPath, { force: true })
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const total = Number(cfg.total ?? 300)
  const status = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const wall = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(total * 200 + 90_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(wall)
      resolve(code)
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid for ${label}: ${stderr.join('').slice(0, 600)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, Frame> = {}
  for (const m of payload.marks ?? []) marks[m.label] = toFrame(m.grid)
  return { marks, final: toFrame(payload.grid), sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0, receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0, endReason: payload.endReason ?? '', status, stderr: stderr.join('') }
}

const see = (needle: string, mark: string, settle = 4, pattern?: string): Send => ({ data: '', atTick: 3000, awaitText: needle, requireAwait: true, minTick: 1, awaitSettleTicks: settle, awaitPattern: settledPattern(pattern), mark })
const still = (needle: string, mark: string, pattern?: string): Send => see(needle, `${mark}~still`, STILL_TICKS, pattern)
const stillPair = (needle: string, mark: string, settle = 4, pattern?: string): Send[] => [see(needle, `${mark}~first`, settle, pattern), still(needle, mark, pattern)]
const when = (needle: string, data: string, settle = 4, pattern?: string): Send => ({ data, atTick: 3000, awaitText: needle, requireAwait: true, minTick: 1, awaitSettleTicks: settle, awaitPattern: settledPattern(pattern) })

function sceneSends(cols: number): Send[] {
  const narrow = cols < 100
  const focused = narrow ? FOCUSED_NARROW_PATTERN : FOCUSED_WIDE_PATTERN
  return [
    { data: '', atTick: 3000, awaitText: '↑↓ choose', requireAwait: true, minTick: 3, awaitSettleTicks: 4, awaitStableTicks: 6, awaitPattern: settledPattern(FACE_PATTERN), mark: 'face~first' },
    still('↑↓ choose', 'face', FACE_PATTERN),
    when('↑↓ choose', 'm', 2, FACE_PATTERN),
    ...stillPair(MODEL_TITLE, 'model-picker', 4),
    when(MODEL_TITLE, ESC, 2),
    when('↑↓ choose', '\r', 3, FACE_PATTERN),
    when('ype a prompt', '/crewmates', 4, focused),
    when('/crewmates', '\r', 3),
    ...stillPair(CREW_EMPTY_NEEDLE, 'crew-empty', 5, focused),
    when(CREW_EMPTY_NEEDLE, ESC, 2, focused),
    ...stillPair('ype a prompt', 'chat', 6, narrow ? COUNTS_PATTERN : focused),
    when('ype a prompt', '?', 2, narrow ? COUNTS_PATTERN : focused),
    ...stillPair('ype a prompt', 'help', 4, focused),
    when('ype a prompt', '?', 2, focused),
    when('ype a prompt', LEAD_ASK, 3, focused),
    when(LEAD_ASK, '\r', 3),
    ...stillPair(LEAD_NOTED, 'chat-crew', 8, NOTICE_PATTERN),
    when('ype a prompt', '/crewmates', 3, NOTICE_PATTERN),
    when('/crewmates', '\r', 3),
    ...stillPair('x x stop', 'crew-two', 5),
    when('x x stop', DOWN, 2),
    ...stillPair('r resume', 'crew-settled', 5),
    when('r resume', '\r', 3),
    ...stillPair(SETTLED_LINE, 'view-panel', 6),
    when(SETTLED_LINE, ESC, 3),
    when('ype a prompt', '/runs', 4),
    when('/runs', '\r', 3),
    ...stillPair('Mercury — runs', 'runs', 5),
    when('Mercury — runs', ESC, 3),
    when('ype a prompt', '/sessions', 4),
    when('/sessions', '\r', 3),
    ...stillPair(SESSIONS_NEEDLE, 'sessions', 5, SESSIONS_PATTERN),
    when(SESSIONS_NEEDLE, ESC, 3, SESSIONS_PATTERN),
    when('ype a prompt', SHIFT_LEFT, 4),
    ...stillPair('crew-screens: launc', 'board', 6, BOARD_PATTERN),
  ]
}

type SizeRun = { cols: number; rows: number; frames: Map<string, Frame>; faults: string[]; hits: string[]; capture: Capture | null; attempts: number; firstFaults: string[] }

function storedRun(cols: number, rows: number): SizeRun {
  const run: SizeRun = { cols, rows, frames: new Map(), faults: [], hits: [], capture: null, attempts: 1, firstFaults: [] }
  const path = storedPath(cols, rows)
  if (!existsSync(path)) {
    run.faults.push(`no stored frames at ${path} — pin them from a ruled bundle with --pin`)
    return run
  }
  const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>
  for (const scene of SCENES) {
    const lines = stored[scene.id]
    if (!Array.isArray(lines)) {
      run.faults.push(`${scene.id}: no stored frame in ${path}`)
      continue
    }
    run.frames.set(scene.id, { rows: lines, grid: [] })
  }
  return run
}

function pinFrames(run: SizeRun): string {
  const path = storedPath(run.cols, run.rows)
  const stored: Record<string, string[]> = {}
  for (const scene of SCENES) {
    const frame = run.frames.get(scene.id)
    if (frame !== undefined) stored[scene.id] = frame.rows.map(r => r.trimEnd())
  }
  writeFileSync(path, JSON.stringify(stored, null, 1) + '\n')
  return path
}

async function driveBundle(dist: string, tag: string, cols: number, rows: number, root: string): Promise<SizeRun> {
  const first = await driveBundleOnce(dist, tag, cols, rows, root, 1)
  if (first.faults.length === 0) return first
  console.log(`  ↻ ${tag} ${cols}x${rows}: ${first.faults.join(' · ').slice(0, 300)} — one more capture at the same ceiling`)
  const second = await driveBundleOnce(dist, tag, cols, rows, root, 2)
  second.attempts = 2
  second.firstFaults = first.faults
  return second
}

async function driveBundleOnce(dist: string, tag: string, cols: number, rows: number, root: string, attempt: number): Promise<SizeRun> {
  const size = `${cols}x${rows}`
  const scratch = join(root, `${tag}-${size}-${attempt}`)
  const home = join(scratch, 'home')
  const cwd = join(root, 'fixture-cwd')
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { reducedMotion: true }, activity: { tips: { enabled: false } }, guardrails: { sovereignConsentSeen: true } }))
  writeFileSync(join(home, 'critter-profile.json'), JSON.stringify({ v: 1, seed: '00000000-0000-4000-8000-00000000c0de', createdAt: 1787600000000, milestones: { settles: 0, recoveries: 0 }, quiet: true, seenTips: {}, openedSurfaces: [] }))
  const fixture = await startFixture()
  const run: SizeRun = { cols, rows, frames: new Map(), faults: [], hits: fixture.hits, capture: null, attempts: attempt, firstFaults: [] }
  try {
    run.capture = await capture(`${tag}-${size}`, { cols, rows, total: 1500, cwd, argv: ['node', dist], sends: sceneSends(cols), readyText: ['crew-screens: launc'], readySettleTicks: 2 }, driveEnv(home, fixture.base), scratch)
  } finally {
    await fixture.close()
  }
  const cap = run.capture
  if (cap.receipts !== cap.sends || cap.status !== 0) run.faults.push(`${cap.receipts}/${cap.sends} sends delivered · vshot exit ${cap.status} · end ${cap.endReason} · ${flat(cap.stderr).slice(0, 300)}`)
  for (const scene of SCENES) {
    const first = cap.marks[`${scene.id}~first`]
    const last = cap.marks[`${scene.id}~still`]
    if (first === undefined || last === undefined) {
      run.faults.push(`${scene.id}: no frame (${first === undefined ? 'the scene never painted' : 'the still frame was not taken'})`)
      continue
    }
    const moved = firstMove(first.rows, last.rows)
    if (moved !== null) run.faults.push(`${scene.id}: not still ${STILL_TICKS} ticks after its needles painted — row ${moved.row} col ${moved.col}: "${flat(moved.a).slice(0, 80)}" then "${flat(moved.b).slice(0, 80)}"`)
    run.frames.set(scene.id, last)
  }
  if (!KEEP) rmSync(scratch, { recursive: true, force: true })
  return run
}

export function maskVolatile(row: string): string {
  let out = row
  for (const [, re] of VOLATILE) out = out.replace(re, VOLATILE_TOKEN)
  return out
}

export function volatileWidth(row: string): number {
  return volatileCells(row).filter(Boolean).length
}

const blankRuns = (row: string): string => row.replace(/ {2,}/g, ' ').replace(/ +$/, '')

export type RowAgreement = 'same' | 'substituted' | 'volatile' | 'shifted' | null

export function rowAgrees(before: string, after: string): RowAgreement {
  const b = before.replace(/ +$/, '')
  const a = after.replace(/ +$/, '')
  if (b === a) return 'same'
  const sb = substitute(b)
  if (sb === a) return 'substituted'
  const mb = maskVolatile(sb)
  const ma = maskVolatile(a)
  if (mb === ma) return 'volatile'
  if (volatileWidth(sb) !== volatileWidth(a) && blankRuns(mb.split(VOLATILE_TOKEN).join('')) === blankRuns(ma.split(VOLATILE_TOKEN).join(''))) return 'shifted'
  return null
}

export function volatileCells(row: string): boolean[] {
  const cells = Array.from({ length: row.length }, () => false)
  for (const [, re] of VOLATILE) for (const m of row.matchAll(re)) for (let x = m.index!; x < m.index! + m[0].length; x++) cells[x] = true
  return cells
}

function firstMove(a: string[], b: string[]): { row: number; col: number; a: string; b: string } | null {
  for (let y = 0; y < Math.max(a.length, b.length); y++) {
    const ra = a[y] ?? ''
    const rb = b[y] ?? ''
    if (rowAgrees(ra, rb) !== null) continue
    let x = 0
    while (x < Math.max(ra.length, rb.length) && ra[x] === rb[x]) x++
    return { row: y, col: x, a: ra, b: rb }
  }
  return null
}

export type CellVerdict = 'same' | 'substitution' | 'volatile' | 'shifted' | 'different'
export type RowVerdict = { before: string; after: string; cells: CellVerdict[]; firstDifferent: number | null; substituted: string }

export function substitute(row: string): string {
  let out = row
  for (const [from, to] of SUBSTITUTIONS) out = out.split(from).join(to)
  return out
}

export function compareRow(before: string, after: string): RowVerdict {
  const width = Math.max(before.length, after.length)
  const b = before.padEnd(width)
  const a = after.padEnd(width)
  const substituted = substitute(b)
  const agreement = rowAgrees(b, a)
  const cells: CellVerdict[] = []
  let firstDifferent: number | null = null
  if (agreement === null) {
    for (let x = 0; x < width; x++) {
      if (b[x] === a[x]) {
        cells.push('same')
        continue
      }
      cells.push('different')
      if (firstDifferent === null) firstDifferent = x
    }
    return { before: b, after: a, cells, firstDifferent, substituted }
  }
  const volatileB = volatileCells(b)
  const volatileA = volatileCells(a)
  for (let x = 0; x < width; x++) {
    if (b[x] === a[x]) cells.push('same')
    else if (agreement === 'substituted' || (agreement === 'volatile' && substituted[x] === a[x] && !volatileB[x] && !volatileA[x])) cells.push('substitution')
    else if (volatileB[x] || volatileA[x]) cells.push('volatile')
    else cells.push('shifted')
  }
  return { before: b, after: a, cells, firstDifferent, substituted }
}

export function compareFrames(before: string[], after: string[]): RowVerdict[] {
  const out: RowVerdict[] = []
  for (let y = 0; y < Math.max(before.length, after.length); y++) out.push(compareRow(before[y] ?? '', after[y] ?? ''))
  return out
}

type SceneVerdict = { scene: string; title: string; size: string; rows: RowVerdict[]; differences: number; substitutions: number; volatile: number; faults: string[] }

function keep(dir: string, name: string, frame: Frame | undefined): void {
  if (frame === undefined) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.txt`), frame.rows.map(r => r.trimEnd()).join('\n') + '\n')
}

function dump(label: string, frame: Frame | undefined): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.rows) if (row.trim()) console.log(`│ ${row.trimEnd()}`)
}

const selfTest = (): void => {
  const same = compareRow('│ ↑↓ move · ↵ open in the view · m main chat · esc close │', '│ ↑↓ move · ↵ open in the view · m main chat · esc close │')
  check('self-test: an identical row reads same in every cell', same.cells.every(c => c === 'same') && same.firstDifferent === null)
  const words = compareRow('· no teammates yet — press n in /teammates', '· no crewmates yet — press n in /crewmates')
  check('self-test: a row that differs only by the word substitutions reads substitution, never different', words.firstDifferent === null && words.cells.includes('substitution') && !words.cells.includes('different'))
  const moved = compareRow('  ↑↓ move · ↵ open · esc close', '  ↑↓ move · esc close · ↵ open')
  check('self-test: a reordered key row is a difference at its first moved column', moved.firstDifferent === 12 && moved.cells.includes('different'), `first different ${moved.firstDifferent}`)
  const lost = compareRow('x x stop · r resume · c clear · esc close', 'x x stop · c clear · esc close')
  check('self-test: a lost key hint is a difference', lost.firstDifferent !== null)
  const widened = compareRow('team · 2 agents   │', 'crew · 2 agents    │')
  check('self-test: a substitution that changes the width of the row is a difference (only the words may change, never the cells around them)', widened.firstDifferent !== null)
  const age = compareRow('◐ atlas    running   1.2k context  12s', '◐ atlas    running   1.2k context  19s')
  check('self-test: a duration cell reads volatile, never different', age.firstDifferent === null && age.cells.includes('volatile'))
  const both = compareRow('◐ atlas   teammate   12s', '◐ atlas   crewmate   19s')
  check('self-test: a substitution beside a volatile cell still reads clean', both.firstDifferent === null && both.cells.includes('volatile') && both.cells.includes('substitution'))
  const brief = compareRow('TeamBrief · /teammates', 'LiveComms · /crewmates')
  check('self-test: TeamBrief→LiveComms and /teammates→/crewmates are word substitutions', brief.firstDifferent === null)
  const grown = compareRow('│ (9s · ↓ 545 tokens · ▁ 0% ctx)      │', '│ (11s · ↓ 545 tokens · ▁ 0% ctx)     │')
  check('self-test: a duration that grew a digit reads volatile, and the padding that absorbed it shifted, never different', grown.firstDifferent === null && grown.cells.includes('volatile') && grown.cells.includes('shifted'))
  const aligned = compareRow('│ ● fjord · landed · 851 context          17s │', '│ ● fjord · landed · 851 context           4s │')
  check('self-test: a right-aligned duration reads volatile with its padding shifted', aligned.firstDifferent === null && !aligned.cells.includes('different'))
  const beside = compareRow('│ (9s · ↓ 545 tokens · ▁ 0% ctx)      │', '│ (9s · ↓ 545 tokens ·  ▁ 0% ctx)     │')
  check('self-test: a cell that moved beside an unchanged duration is still a difference', beside.firstDifferent !== null)
  const caret = compareRow('│ ❯ \u258cdescribe a task — ↵ starts a session   │', '│ ❯ describe a task — ↵ starts a session    │')
  check("self-test: the composer caret's blink phase reads volatile, never different", caret.firstDifferent === null && caret.cells.includes('volatile'))
  const still = rowAgrees('03:48:10 [sam] ❯ crew-screens: launch the crew', '03:49:52 [sam] ❯ crew-screens: launch the crew')
  check('self-test: a wall clock agrees as volatile', still === 'volatile')
}

function verdictOf(scene: Scene, size: string, before: SizeRun, after: SizeRun): SceneVerdict {
  const b = before.frames.get(scene.id)
  const a = after.frames.get(scene.id)
  const faults = [...before.faults.filter(f => f.startsWith(`${scene.id}:`)).map(f => `before: ${f}`), ...after.faults.filter(f => f.startsWith(`${scene.id}:`)).map(f => `after: ${f}`)]
  if (b === undefined || a === undefined) return { scene: scene.id, title: scene.title, size, rows: [], differences: b === undefined && a === undefined ? 0 : 1, substitutions: 0, volatile: 0, faults: faults.length > 0 ? faults : [`${b === undefined ? 'before' : 'after'}: no frame`] }
  const rows = compareFrames(b.rows, a.rows)
  const differences = rows.filter(r => r.firstDifferent !== null).length
  const substitutions = rows.reduce((n, r) => n + r.cells.filter(c => c === 'substitution').length, 0)
  const volatile = rows.reduce((n, r) => n + r.cells.filter(c => c === 'volatile').length, 0)
  return { scene: scene.id, title: scene.title, size, rows, differences, substitutions, volatile, faults }
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const CELL_CLASS: Record<CellVerdict, string> = { same: '', substitution: 's', volatile: 'v', shifted: 'h', different: 'x' }

function renderRow(text: string, cells: CellVerdict[]): string {
  let out = ''
  let x = 0
  while (x < text.length) {
    const cls = CELL_CLASS[cells[x] ?? 'same']
    let end = x + 1
    while (end < text.length && CELL_CLASS[cells[end] ?? 'same'] === cls) end++
    const run = escapeHtml(text.slice(x, end))
    out += cls === '' ? run : `<span class="${cls}">${run}</span>`
    x = end
  }
  return out
}

export function renderPage(verdicts: readonly SceneVerdict[], meta: { before: string; after: string; failures: number }): string {
  const summary = verdicts.map(v => {
    const state = v.differences === 0 && v.faults.length === 0 ? 'same' : 'differs'
    return `<tr class="${state}"><td><a href="#${v.size}-${v.scene}">${escapeHtml(v.title)}</a></td><td>${v.size}</td><td>${state === 'same' ? 'the same cells but the words' : `${v.differences} row${v.differences === 1 ? '' : 's'} differ${v.faults.length > 0 ? ` · ${escapeHtml(v.faults.join(' · '))}` : ''}`}</td><td>${v.substitutions}</td><td>${v.volatile}</td></tr>`
  })
  const sections = verdicts.map(v => {
    const before = v.rows.map(r => renderRow(r.before.trimEnd(), r.cells)).join('\n')
    const after = v.rows.map(r => renderRow(r.after.trimEnd(), r.cells)).join('\n')
    const state = v.differences === 0 && v.faults.length === 0 ? 'same' : 'differs'
    const firstRow = v.rows.find(r => r.firstDifferent !== null)
    const where = firstRow === undefined ? '' : ` — first at row ${v.rows.indexOf(firstRow)}, column ${firstRow.firstDifferent}`
    return `<section id="${v.size}-${v.scene}" class="${state}"><h2>${escapeHtml(v.title)} <small>${v.size} · ${state === 'same' ? 'the same cells but the words' : `${v.differences} row${v.differences === 1 ? '' : 's'} differ${where}`}${v.substitutions > 0 ? ` · ${v.substitutions} substituted cells` : ''}${v.volatile > 0 ? ` · ${v.volatile} volatile cells` : ''}</small></h2>${v.faults.length > 0 ? `<p class="fault">${escapeHtml(v.faults.join(' · '))}</p>` : ''}<div class="pair"><figure><figcaption>before</figcaption><pre>${before}</pre></figure><figure><figcaption>after</figcaption><pre>${after}</pre></figure></div></section>`
  })
  const differing = verdicts.filter(v => v.differences > 0 || v.faults.length > 0).length
  const verdictLine = differing === 0 && meta.failures === 0 ? 'GREEN — no design change: every cell the same but the words' : `RED — ${differing} scene frame${differing === 1 ? '' : 's'} differ`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>the crew screens, before and after</title>
<style>
body{background:#111418;color:#d8dde3;font:14px/1.4 -apple-system,Helvetica,Arial,sans-serif;margin:0;padding:24px 32px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 8px}h2 small{font-weight:normal;color:#9aa4ae;margin-left:8px}
p.meta{color:#9aa4ae;margin:2px 0}p.verdict{font-size:16px;margin:12px 0 18px}p.fault{color:#f0a0a0}
table{border-collapse:collapse;margin:8px 0 24px}td,th{padding:3px 10px;border-bottom:1px solid #2a3037;text-align:left;font-size:13px}th{color:#9aa4ae;font-weight:normal}
tr.differs td:first-child a{color:#ff7b7b}tr.same td:first-child a{color:#8fd3a0}a{color:#d8dde3}
.legend span{display:inline-block;padding:0 6px;margin-right:10px;border-radius:3px}
.pair{display:flex;gap:16px;overflow-x:auto}figure{margin:0;flex:1 1 0;min-width:0}figcaption{color:#9aa4ae;font-size:12px;margin-bottom:4px}
pre{background:#0b0e11;border:1px solid #2a3037;border-radius:4px;padding:8px 10px;margin:0;font:11.5px/1.25 ui-monospace,Menlo,monospace;white-space:pre;overflow-x:auto;color:#c9d1d9}
section.differs pre{border-color:#7a2a2a}
.s{background:#1f5a2f;color:#e8ffe8}.v{background:#2c3138;color:#8a949e}.h{background:#243447;color:#a9c4de}.x{background:#8a1f1f;color:#fff}
</style></head><body>
<h1>the crew screens, before and after</h1>
<p class="meta">before: ${escapeHtml(meta.before)}</p><p class="meta">after: ${escapeHtml(meta.after)}</p>
<p class="verdict">${verdictLine}</p>
<p class="legend"><span class="s">substituted word (allowed)</span><span class="v">volatile cell (a clock, a duration, an age, the caret)</span><span class="h">shifted by a volatile cell's width</span><span class="x">a difference</span></p>
<p class="meta">the substitution law: ${escapeHtml(SUBSTITUTIONS.map(([a, b]) => `${a}→${b}`).join(', '))}; every pair keeps its width, so a substituted row keeps every other cell where it stood.</p>
<table><tr><th>scene</th><th>size</th><th>reading</th><th>substituted</th><th>volatile</th></tr>${summary.join('')}</table>
${sections.join('\n')}
</body></html>
`
}

async function main(): Promise<void> {
  console.log('============================================================')
  console.log(' the crew screens, before and after: every cell the same but the words')
  console.log(`   before: ${TWO_BUNDLES ? DIST_BEFORE : PIN ? `${STORED_LABEL}, pinned from the bundle below` : STORED_LABEL}`)
  console.log(`   after:  ${DIST_AFTER}${TWO_BUNDLES && DIST_AFTER === DIST_BEFORE ? ' (the same bundle — the self-test)' : ''}`)
  console.log('============================================================')
  selfTest()
  for (const dist of new Set(TWO_BUNDLES ? [DIST_BEFORE, DIST_AFTER] : [DIST_AFTER])) {
    if (!existsSync(dist)) {
      console.log(`  [SKIP] ${dist} absent — build first, or name a bundle with --dist / --dist-after`)
      process.exit(0)
    }
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-screens-')))
  const verdicts: SceneVerdict[] = []
  const sizes = SIZES.filter(([c, r]) => ONLY === undefined || ONLY.split(',').includes(`${c}x${r}`))
  const queue = [...sizes]
  const runs = new Map<string, { before: SizeRun; after: SizeRun }>()
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const [cols, rows] = queue.shift()!
      const size = `${cols}x${rows}`
      const sizeRoot = join(root, size)
      mkdirSync(sizeRoot, { recursive: true })
      const after = await driveBundle(DIST_AFTER, 'after', cols, rows, sizeRoot)
      if (PIN && after.faults.length === 0) console.log(`  pinned ${size}: ${pinFrames(after)}`)
      const before = TWO_BUNDLES ? await driveBundle(DIST_BEFORE, 'before', cols, rows, sizeRoot) : storedRun(cols, rows)
      runs.set(size, { before, after })
    }
  }
  await Promise.all(Array.from({ length: Math.min(JOBS, sizes.length) }, () => worker()))
  for (const [cols, rows] of sizes) {
    const size = `${cols}x${rows}`
    const { before, after } = runs.get(size)!
    console.log(`\n— ${size} —`)
    console.log(`  fixture: ${TWO_BUNDLES ? `before ${before.hits.join(',')} · ` : ''}after ${after.hits.join(',')}`)
    if (!TWO_BUNDLES) check(`${size} before: the stored frames carry every scene (${before.frames.size}/${SCENES.length})`, before.faults.length === 0, before.faults.join(' · '))
    for (const [tag, run] of (TWO_BUNDLES ? [['before', before], ['after', after]] : [['after', after]]) as ReadonlyArray<readonly ['before' | 'after', SizeRun]>) {
      check(`${size} ${tag}: every send became due and every scene painted still (${run.capture?.receipts ?? 0}/${run.capture?.sends ?? 0} sends · end ${run.capture?.endReason ?? '?'}${run.attempts > 1 ? ` · attempt ${run.attempts}, the first: ${run.firstFaults.join(' · ').slice(0, 200)}` : ''})`, run.faults.length === 0, run.faults.join(' · '))
      if (FRAMES !== undefined) for (const [id, frame] of run.frames) keep(join(FRAMES, tag), `${id}-${size}`, frame)
      if (DUMP || run.faults.length > 0) {
        for (const [id, frame] of run.frames) dump(`${size} ${tag} · ${id}`, frame)
        if (run.frames.size === 0 && run.capture) dump(`${size} ${tag} · final`, run.capture.final)
      }
    }
    for (const scene of SCENES) {
      const v = verdictOf(scene, size, before, after)
      verdicts.push(v)
      const firstRow = v.rows.find(r => r.firstDifferent !== null)
      const where = firstRow === undefined ? '' : `row ${v.rows.indexOf(firstRow)} col ${firstRow.firstDifferent}: before "${flat(firstRow.before).slice(0, 90)}" · after "${flat(firstRow.after).slice(0, 90)}"`
      check(`${size} ${scene.id}: ${scene.title} — the same cells but the words (${v.substitutions} substituted, ${v.volatile} volatile)`, v.differences === 0 && v.faults.length === 0, [...v.faults, where].filter(Boolean).join(' · '))
    }
  }
  if (FRAMES !== undefined) {
    mkdirSync(FRAMES, { recursive: true })
    writeFileSync(join(FRAMES, 'verdict.json'), JSON.stringify({ before: TWO_BUNDLES ? DIST_BEFORE : STORED_LABEL, after: DIST_AFTER, substitutions: SUBSTITUTIONS, volatile: VOLATILE.map(([name, re]) => ({ name, pattern: re.source })), scenes: verdicts.map(v => ({ ...v, rows: v.rows.map(r => ({ before: r.before.trimEnd(), after: r.after.trimEnd(), cells: r.cells.map(c => c === 'same' ? '=' : c === 'substitution' ? 's' : c === 'volatile' ? 'v' : c === 'shifted' ? '~' : 'x').join(''), firstDifferent: r.firstDifferent })) })), failures }, null, 1) + '\n')
    console.log(`\n  frames and verdict.json under ${FRAMES}`)
  }
  if (PAGE !== undefined) {
    mkdirSync(join(PAGE, '..'), { recursive: true })
    writeFileSync(PAGE, renderPage(verdicts, { before: TWO_BUNDLES ? DIST_BEFORE : STORED_LABEL, after: DIST_AFTER, failures }))
    console.log(`  the side-by-side page: ${PAGE}`)
  }
  if (!KEEP) rmSync(root, { recursive: true, force: true })
  else console.log(`\n  kept: ${root}`)
  const differing = verdicts.filter(v => v.differences > 0 || v.faults.length > 0).length
  console.log(`\n${checks} checks, ${failures} failures · ${verdicts.length} scene frames compared · ${differing} with a difference`)
  console.log(failures === 0 ? 'prove-crew-screens-unchanged: NO DESIGN CHANGE — every cell the same but the words' : `prove-crew-screens-unchanged: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
