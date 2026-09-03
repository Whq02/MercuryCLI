#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const SEAT_ONE = 'tide-gauges'
const SEAT_TWO = 'reef-survey'
const ASK = 'crew-drive: launch two'
const FIXTURE_API_KEY = 'fixture-key-000'

type Route = 'parent' | 'parent-ack' | 'seat' | 'seat-ack' | 'side'
interface Hit {
  route: Route
  model: string
  seat: string | null
}
interface Fixture {
  base: string
  hits: Hit[]
  close(): Promise<void>
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

function lastUserText(body: unknown): string {
  const messages = (body as { messages?: unknown[] })?.messages ?? []
  let last = ''
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown }
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') {
      if (msg.content.trim() !== '') last = msg.content
      continue
    }
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content as Array<{ type?: string; text?: string }>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') last = block.text
    }
  }
  return last
}

function carriesToolResult(body: unknown): boolean {
  const messages = (body as { messages?: unknown[] })?.messages ?? []
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown }
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    if ((msg.content as Array<{ type?: string }>).some(b => b.type === 'tool_result')) return true
  }
  return false
}

function offersTool(body: unknown, name: string): boolean {
  const tools = (body as { tools?: unknown[] })?.tools
  return Array.isArray(tools) && tools.some(t => (t as { name?: string })?.name === name)
}

function routeOf(body: unknown): { route: Route; seat: string | null } {
  const text = lastUserText(body)
  const ack = carriesToolResult(body)
  if (text.includes('crew-seat:')) {
    const seat = text.includes(SEAT_ONE) ? SEAT_ONE : text.includes(SEAT_TWO) ? SEAT_TWO : 'seat'
    return { route: ack ? 'seat-ack' : 'seat', seat }
  }
  if (text.includes('crew-drive:') && offersTool(body, 'Agent')) return { route: ack ? 'parent-ack' : 'parent', seat: null }
  return { route: 'side', seat: null }
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }

function answer(model: string, blocks: Block[], usage: { input: number; output: number }): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_crew_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
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
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_crew_${Date.now() % 100000}_${index}`, name: block.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

async function startCrewFixture(port: number, seatSleepSeconds: number): Promise<Fixture> {
  const hits: Hit[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = req.url ?? ''
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
      const { route, seat } = routeOf(body)
      hits.push({ route, model, seat })
      let blocks: Block[]
      let usage: { input: number; output: number }
      switch (route) {
        case 'parent':
          blocks = [
            { type: 'text', text: 'launching two sub-agents' },
            { type: 'tool_use', name: 'Agent', input: { description: SEAT_ONE, prompt: `crew-seat: survey the ${SEAT_ONE}`, subagent_type: 'general-purpose' } },
            { type: 'tool_use', name: 'Agent', input: { description: SEAT_TWO, prompt: `crew-seat: map the ${SEAT_TWO}`, subagent_type: 'general-purpose' } },
          ]
          usage = { input: 1200, output: 80 }
          break
        case 'parent-ack':
          blocks = [{ type: 'text', text: 'crew-drive: both landed.' }]
          usage = { input: 1500, output: 30 }
          break
        case 'seat':
          blocks = [{ type: 'tool_use', name: 'Sleep', input: { seconds: seatSleepSeconds } }]
          usage = { input: 900, output: 40 }
          break
        case 'seat-ack':
          blocks = [{ type: 'text', text: `crew-seat-done: ${seat ?? 'seat'}.` }]
          usage = { input: 950, output: 60 }
          break
        default:
          blocks = [{ type: 'text', text: 'ok' }]
          usage = { input: 20, output: 2 }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(answer(model, blocks, usage))
    })
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
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
  const dir = mkdtempSync(join(tmpdir(), 'crew-drive-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(240_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as {
    grid: Grid
    sendReceipts?: unknown[]
    marks?: Array<{ label: string; grid: Grid }>
    endReason?: string
  }
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'crew-drive-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'crew-drive-cwd-')))
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
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    OPENAI_API_KEY: '',
  }
}

const TOKENS_RE = /\b\d[\d.,]*k? tokens\b/
const nonZeroTokens = (text: string): boolean => TOKENS_RE.test(text) && !/\b0 tokens\b/.test(text)
const flat = (s: string): string => s.replace(/\s+/g, ' ')
const COLS = 160
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

const LEG = process.env.CREW_LEG ?? 'both'

if (LEG !== 'stop') {
  console.log('— leg 1: land —')
  const fixture = await startCrewFixture(Number(process.env.CREW_PORT_LAND ?? '25161'), 10)
  const { home, cwd } = seedWorld()
  let cap: Capture | null = null
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 360,
        cwd,
        argv: ['node', DIST],
        sends: [
          ...bootSends(ASK),
          { data: '/teammates', atTick: 999, awaitText: 'Running 2 agents', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'running' },
          { data: '\r', afterPrevTicks: 4 },
          { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-running' },
          { data: '/teammates', atTick: 999, awaitText: 'agents finished', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'landed' },
          { data: '\r', afterPrevTicks: 4 },
          { data: '\r', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-landed' },
          { data: '\x1b', atTick: 999, awaitText: 'runs in this session', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'card' },
          { data: '\x1b', afterPrevTicks: 4 },
        ],
        stableTicks: 6,
      },
      driveEnv(home, fixture.base),
    )
  } finally {
    await fixture.close()
  }
  const seatHits = fixture.hits.filter(h => h.route === 'seat')
  const servedModel = seatHits[0]?.model ?? ''
  const { marks } = cap
  if (process.env.CREW_KEEP === '1') for (const [label, frame] of Object.entries(marks)) dump(`leg 1 · ${label}`, frame)
  check('land: every send became due (the frames the sends waited on all painted)', cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  check('land: both seats asked the model on the wire, on one served model', seatHits.length >= 2 && servedModel !== '' && seatHits.every(h => h.model === servedModel), fixture.hits.map(h => `${h.route}:${h.model}`).join(','))
  check('land: the parent asked once and landed once (the ack turn)', fixture.hits.some(h => h.route === 'parent') && fixture.hits.some(h => h.route === 'parent-ack'))
  const running = marks['running'] ?? ''
  check(
    "land: the running card's rows read the record — both names, the served model, tokens > 0",
    running.includes(SEAT_ONE) && running.includes(SEAT_TWO) && running.includes(servedModel) && nonZeroTokens(running),
  )
  check(
    'land: the CREW lane rows carry a token verb while they run',
    (flat(running).match(/◐ [a-z-…]+ · \d[\d.,]*k? tokens/g) ?? []).length >= 2,
  )
  check('land: the usage attribution line counts the crew', /sub-agents \d[\d.,]*k? tokens/.test(flat(running)))
  const crewRunning = marks['crew-running'] ?? ''
  check(
    'land: the Crew view while running — both rows, the served model, running, tokens > 0, the count label',
    crewRunning.includes(SEAT_ONE) && crewRunning.includes(SEAT_TWO) && crewRunning.includes(servedModel) && nonZeroTokens(crewRunning) && (crewRunning.match(/\brunning\b/g) ?? []).length >= 2 && crewRunning.includes('2 running · 2 sub-agents'),
  )
  const landed = marks['landed'] ?? ''
  check('land: the card landed both (its landed header) and no seat is still running', landed.includes('agents finished') && !/\bstopped\b/.test(landed))
  const crewLanded = marks['crew-landed'] ?? ''
  check(
    "land: the Crew view after landing — landed twice, the tokens kept, never the runner's word",
    (crewLanded.match(/\blanded\b/g) ?? []).length >= 2 && nonZeroTokens(crewLanded) && !crewLanded.includes('completed') && crewLanded.includes('0 running · 2 sub-agents'),
  )
  const card = marks['card'] ?? ''
  check(
    "land: the agent's card reads the same record — model, tokens, tool uses, landed",
    card.includes(servedModel) && card.includes('tokens') && card.includes('tool use') && card.includes('landed') && !card.includes('completed'),
  )
  if (failures > 0 && process.env.CREW_KEEP !== '1') for (const [label, frame] of Object.entries(marks)) dump(`leg 1 · ${label}`, frame)
  if (failures > 0 || process.env.CREW_KEEP === '1') dump('leg 1 · final grid', cap.text)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

if (LEG !== 'land') {
  console.log('\n— leg 2: stop —')
  const before = failures
  const fixture = await startCrewFixture(Number(process.env.CREW_PORT_STOP ?? '25162'), 90)
  const { home, cwd } = seedWorld()
  let cap: Capture | null = null
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 220,
        cwd,
        argv: ['node', DIST],
        sends: [
          ...bootSends(ASK),
          { data: '\x1b', atTick: 999, awaitText: 'Running 2 agents', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'running' },
          { data: '/teammates', atTick: 110, awaitText: 'stopped', minTick: 2, awaitSettleTicks: 4, mark: 'stopped' },
          { data: '\r', afterPrevTicks: 4 },
          { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-stopped' },
        ],
        stableTicks: 6,
      },
      driveEnv(home, fixture.base),
    )
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  if (process.env.CREW_KEEP === '1') for (const [label, frame] of Object.entries(marks)) dump(`leg 2 · ${label}`, frame)
  check('stop: every send became due', cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  const running = marks['running'] ?? ''
  check('stop: both seats were running with tokens when the Esc fired', running.includes(SEAT_ONE) && running.includes(SEAT_TWO) && nonZeroTokens(running))
  const stopped = marks['stopped'] ?? ''
  check("stop: the card rows read stopped — never the runner's word", (stopped.match(/\bstopped\b/g) ?? []).length >= 2 && !stopped.includes('killed'))
  const crewStopped = marks['crew-stopped'] ?? ''
  check("stop: the Crew view reads stopped for both agents, tokens kept", (crewStopped.match(/\bstopped\b/g) ?? []).length >= 2 && !crewStopped.includes('killed') && nonZeroTokens(crewStopped) && crewStopped.includes('0 running · 2 sub-agents'))
  check('stop: no seat settled its turn (the Sleep was interrupted — no seat-ack on the wire)', fixture.hits.every(h => h.route !== 'seat-ack'))
  if (failures > before && process.env.CREW_KEEP !== '1') for (const [label, frame] of Object.entries(marks)) dump(`leg 2 · ${label}`, frame)
  if (failures > before || process.env.CREW_KEEP === '1') dump('leg 2 · final grid', cap.text)
  if (process.env.CREW_KEEP === '1') console.log(`[keep] leg 2 home ${home} cwd ${cwd}`)
  else {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nprove-crew-live-drive: ALL LAWS HOLD' : `\nprove-crew-live-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
