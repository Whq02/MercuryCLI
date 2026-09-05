#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] capture driver unavailable — ${driver.kind === 'unavailable' ? driver.reason : driver.kind}`)
  process.exit(0)
}

const { MOMENT_LINES } = await import('../../src/utils/cockpit/companionWords.ts')
const FAILURE_LINES: readonly string[] = MOMENT_LINES.failure

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('§0 the failure moment reads the turn\'s own end fact')
{
  const home = mkdtempSync(join(tmpdir(), 'field-companion-engine-'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_DECK_COMPANION = '1'
  const { publishCompanionTurnAt, resetCompanionSignals, turnEndedInError } = await import('../../src/utils/cockpit/companionSignals.ts')
  const { subscribeCompanionEngine, companionEngineSnapshot, resetCompanionEngineForTests, recomputeCompanionForProofs, setCompanionClockForProofs } =
    await import('../../src/utils/cockpit/companionEngine.ts')
  const { TIP_BOOT_QUIET_MS, VOICE_COOLDOWN_MS } = await import('../../src/utils/cockpit/companionVoice.ts')
  const { recordAgentStateVerdict } = await import('../../src/services/agentStateClassifier.ts')
  const { getSessionId } = await import('../../src/bootstrap/state.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
  type Rec = import('../../src/types/message.ts').Message

  const user = (text: string, meta = false): Rec => createUserMessage({ content: text, ...(meta ? { isMeta: true } : {}) }) as Rec
  const reply = (text: string): Rec => createAssistantMessage({ content: text }) as Rec
  const refusedReply = (): Rec => ({ ...(createAssistantMessage({ content: 'API Error: 400' }) as object), isApiErrorMessage: true }) as Rec
  check('no records ⇒ no error end', turnEndedInError([]) === false)
  check('a completed reply ⇒ no error end, whatever it says', turnEndedInError([user('read it'), reply('could not read it; everything else is done')]) === false)
  check("the wire's refusal as the last record ⇒ the turn ended in error", turnEndedInError([user('read it'), refusedReply()]) === true)
  check('the operator\'s next words after a refusal ⇒ a new turn, no error end', turnEndedInError([user('read it'), refusedReply(), user('again')]) === false)
  check('a meta row after the refusal is not a turn\'s word — the error end stands', turnEndedInError([user('read it'), refusedReply(), user('<reminder/>', true)]) === true)

  let now = 1_800_000_000_000
  setCompanionClockForProofs(() => now)
  resetCompanionEngineForTests()
  resetCompanionSignals()
  const unsubscribe = subscribeCompanionEngine(() => {})
  const tick = (ms: number): void => {
    now += ms
    recomputeCompanionForProofs()
  }
  const isFailureLine = (): boolean => {
    const quip = companionEngineSnapshot().quip
    return quip !== null && FAILURE_LINES.includes(quip.text)
  }
  tick(TIP_BOOT_QUIET_MS + 1_000)
  tick(VOICE_COOLDOWN_MS)
  const turn = (endedInError: boolean): void => {
    publishCompanionTurnAt({ turnLive: true, streaming: false, awaitingPermission: false }, now)
    recomputeCompanionForProofs()
    now += 4_000
    publishCompanionTurnAt({ turnLive: false, streaming: false, awaitingPermission: false, endedInError }, now)
    recomputeCompanionForProofs()
  }
  turn(false)
  recordAgentStateVerdict(getSessionId(), { state: 'failed', tempo: 'blocked', detail: 'could not read it', needs: 'review', source: 'preclassify' })
  let spokeFailure = false
  for (const ms of [500, 1_000, 5_000, 10_000, 30_000]) {
    tick(ms)
    if (isFailureLine()) spokeFailure = true
  }
  check('a completed turn never speaks the failure bank, whatever the reply\'s words were classified as', !spokeFailure, companionEngineSnapshot().quip?.text ?? '')
  check('its mood never read sad', companionEngineSnapshot().mood !== 'sad')
  tick(VOICE_COOLDOWN_MS)
  turn(true)
  tick(500)
  check("a turn that ended on the wire's refusal speaks the failure bank at once", isFailureLine(), companionEngineSnapshot().quip?.text ?? 'silent')
  check('its mood reads sad', companionEngineSnapshot().mood === 'sad')
  tick(60_000)
  publishCompanionTurnAt({ turnLive: false, streaming: false, awaitingPermission: false, endedInError: false }, now)
  recomputeCompanionForProofs()
  tick(VOICE_COOLDOWN_MS)
  publishCompanionTurnAt({ turnLive: false, streaming: false, awaitingPermission: false, endedInError: true }, now)
  recomputeCompanionForProofs()
  tick(500)
  check('an error end that arrives with no live edge seen still speaks the failure bank', isFailureLine(), companionEngineSnapshot().quip?.text ?? 'silent')
  unsubscribe()
  setCompanionClockForProofs(null)
  resetCompanionEngineForTests()
  resetCompanionSignals()
  rmSync(home, { recursive: true, force: true })
}

const FIXTURE_API_KEY = 'fixture-key-000'
const ASK = 'field-companion: read the notes file'
const MISSING = 'missing-notes.txt'
const DONE_TEXT = `The notes file was missing — could not read it; everything else is done.`
const DONE_NEEDLE = 'everything else is done'
const ERROR_TEXT = 'field-companion: refused on purpose'

type Leg = 'refused' | 'errored'
type Route = 'ask' | 'ack' | 'side'

function itemsOf(body: unknown): unknown[] {
  const b = body as { messages?: unknown }
  return Array.isArray(b?.messages) ? b.messages : []
}
function lastUserText(body: unknown): string {
  let last = ''
  for (const m of itemsOf(body)) {
    const msg = m as { role?: string; content?: unknown }
    if (msg.role !== 'user') continue
    let text = ''
    if (typeof msg.content === 'string') text = msg.content
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type?: string; text?: string }>) {
        if (block.type === 'text' && typeof block.text === 'string') text += `\n${block.text}`
      }
    }
    if (text.includes('field-companion:')) last = text
  }
  return last
}
function carriesToolResult(body: unknown): boolean {
  for (const m of itemsOf(body)) {
    const item = m as { role?: string; content?: unknown }
    if (item.role !== 'user' || !Array.isArray(item.content)) continue
    if ((item.content as Array<{ type?: string }>).some(b => b.type === 'tool_result')) return true
  }
  return false
}
function offersTool(body: unknown, name: string): boolean {
  const tools = (body as { tools?: unknown[] })?.tools
  return Array.isArray(tools) && tools.some(t => (t as { name?: string })?.name === name)
}
function routeOf(body: unknown): Route {
  if (!lastUserText(body).includes('field-companion:') || !offersTool(body, 'Read')) return 'side'
  return carriesToolResult(body) ? 'ack' : 'ask'
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function answer(model: string, blocks: Block[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    } else {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${Date.now() % 100000}_${index}`, name: block.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 12 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

interface Fixture {
  base: string
  hits: Route[]
  close(): Promise<void>
}
async function startFixture(leg: Leg, cwd: string): Promise<Fixture> {
  const hits: Route[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (!url.includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
      const route = routeOf(body)
      hits.push(route)
      if (route === 'ask' && leg === 'errored') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: ERROR_TEXT } }))
        return
      }
      let blocks: Block[]
      switch (route) {
        case 'ask':
          blocks = [
            { type: 'text', text: 'reading the notes' },
            { type: 'tool_use', name: 'Read', input: { file_path: join(cwd, MISSING) } },
          ]
          break
        case 'ack':
          blocks = [{ type: 'text', text: DONE_TEXT }]
          break
        default:
          blocks = [{ type: 'text', text: 'ok' }]
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(answer(model, blocks))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

interface Capture {
  text: string
  marks: Record<string, string>
  sends: number
  receipts: number
  endReason: string
}
type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')

async function capture(cfg: Record<string, unknown>, env: Record<string, string>): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'field-companion-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(240_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  rmSync(dir, { recursive: true, force: true })
  return {
    text: gridText(payload.grid),
    marks,
    sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0,
    receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0,
    endReason: payload.endReason ?? '',
  }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'field-companion-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'field-companion-cwd-')))
  seedFirstRun(home, [cwd])
  return { home, cwd }
}

function driveEnv(home: string, fixtureBase: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENAI_API_KEY: '',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
  }
}

const COLS = 140
const ROWS = 44

const bootSends = (ask: string): Array<Record<string, unknown>> => [
  { data: '\r', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: ask, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\r', afterPrevTicks: 4 },
]

function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, COLS)}`)
}

function failureLineOn(frame: string): string | null {
  for (const line of FAILURE_LINES) if (frame.includes(line)) return line
  return null
}

const LEG = process.env.FIELD_LEG ?? 'all'
const AFTER_MARKS: Array<[string, number]> = [
  ['after-1', 3],
  ['after-2', 15],
  ['after-3', 40],
  ['after-4', 65],
  ['after-5', 90],
  ['after-6', 120],
  ['after-7', 150],
  ['after-8', 180],
  ['after-9', 200],
]

async function leg(name: Leg): Promise<void> {
  if (LEG !== 'all' && LEG !== name) return
  console.log(`\n— ${name}: ${name === 'refused' ? 'a tool refuses, the turn completes' : 'the wire refuses the request, the turn ends on an error'} —`)
  const { home, cwd } = seedWorld()
  const fixture = await startFixture(name, cwd)
  const endNeedle = name === 'refused' ? DONE_NEEDLE : 'refused on purpose'
  let cap: Capture
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 520,
        cwd,
        argv: ['node', DIST],
        sends: [
          ...bootSends(ASK),
          { data: '', atTick: 999, awaitText: endNeedle, requireAwait: true, minTick: 2, awaitSettleTicks: 1, mark: 'end' },
          ...AFTER_MARKS.map(([label, ticks], i) => ({ data: '', afterPrevTicks: ticks - (i === 0 ? 0 : AFTER_MARKS[i - 1]![1]), mark: label })),
        ],
        stableTicks: 5,
      },
      driveEnv(home, fixture.base),
    )
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  const tag = name
  if (process.env.FIELD_KEEP === '1') for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
  check(`${tag}: every send became due (the turn reached its end on screen)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  const spoken = Object.entries(marks)
    .filter(([label]) => label === 'end' || label.startsWith('after-'))
    .map(([label, frame]) => [label, failureLineOn(frame)] as const)
    .filter(([, line]) => line !== null)
  if (name === 'refused') {
    check(`${tag}: the ask ran the tool and the turn completed on the wire (ask → refused tool → ack)`, fixture.hits.includes('ask') && fixture.hits.includes('ack'), fixture.hits.join(','))
    check(`${tag}: the tool's card and the completed reply are on screen`, /Read 1 file/.test(cap.text) && cap.text.includes(DONE_NEEDLE))
    check(`${tag}: the companion never spoke the failure bank on a completed turn`, spoken.length === 0, spoken.map(([l, s]) => `${l}: "${s}"`).join(' · '))
  } else {
    check(`${tag}: the ask was refused on the wire and no completion followed`, fixture.hits.includes('ask') && !fixture.hits.includes('ack'), fixture.hits.join(','))
    check(`${tag}: the companion spoke the failure bank on the errored turn`, spoken.length > 0, 'no failure line in any frame after the end')
  }
  if (failures > 0 && process.env.FIELD_KEEP !== '1') for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
  if (failures > 0 || process.env.FIELD_KEEP === '1') dump(`${tag} · final grid`, cap.text)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

await leg('refused')
await leg('errored')

console.log(failures === 0 ? '\nprove-field-findings-companion: ALL LAWS HOLD' : `\nprove-field-findings-companion: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
