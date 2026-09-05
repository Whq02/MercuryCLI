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

const SEATS = ['tide-gauges', 'reef-survey', 'dune-count', 'kelp-map'] as const
const ASK = 'crew-seats: launch four'
const FIXTURE_API_KEY = 'fixture-key-000'
const SEAT_CEILING = 3
const SEAT_HOLD_MS = 14_000
const CLAUDE_ID = 'claude-opus-4-8'
const GPT_ID = 'gpt-5.6-sol'
const CLAUDE_SEAT_ALIAS = 'opus'
const CLAUDE_SEAT_PREFIX = 'claude-opus'

type Dialect = 'anthropic' | 'openai'
type Route = 'parent' | 'parent-ack' | 'seat' | 'side'
interface Hit {
  route: Route
  model: string
  seat: string | null
  lane: string
  at: number
  effort: string | null
}
interface Fixture {
  base: string
  hits: Hit[]
  close(): Promise<void>
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

function itemsOf(body: unknown): unknown[] {
  const b = body as { messages?: unknown; input?: unknown }
  if (Array.isArray(b?.messages)) return b.messages
  if (Array.isArray(b?.input)) return b.input
  if (typeof b?.input === 'string') return [{ role: 'user', content: b.input }]
  return []
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
        if ((block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string') text += `\n${block.text}`
      }
    }
    if (text.includes('crew-seat:') || text.includes('crew-seats:')) last = text
  }
  return last
}

function carriesToolResult(body: unknown): boolean {
  for (const m of itemsOf(body)) {
    const item = m as { type?: string; role?: string; content?: unknown }
    if (item.type === 'function_call_output') return true
    if (item.role !== 'user' || !Array.isArray(item.content)) continue
    if ((item.content as Array<{ type?: string }>).some(b => b.type === 'tool_result')) return true
  }
  return false
}

function offersTool(body: unknown, name: string): boolean {
  const tools = (body as { tools?: unknown[] })?.tools
  return Array.isArray(tools) && tools.some(t => (t as { name?: string })?.name === name)
}

function routeOf(body: unknown): { route: Route; seat: string | null } {
  const text = lastUserText(body)
  if (text.includes('crew-seat:')) {
    const seat = SEATS.find(s => text.includes(s)) ?? 'seat'
    return { route: 'seat', seat }
  }
  if (text.includes('crew-seats:') && offersTool(body, 'Agent')) return { route: carriesToolResult(body) ? 'parent-ack' : 'parent', seat: null }
  return { route: 'side', seat: null }
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }

function responsesAnswer(blocks: Block[], usage: { input: number; output: number }): { head: string; tail: string } {
  const calls = blocks.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
  const text = blocks.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
  const completed = sse({
    type: 'response.completed',
    response: { id: 'resp_seats', usage: { input_tokens: usage.input, output_tokens: usage.output, input_tokens_details: { cached_tokens: 0 } } },
  })
  const head = sse({ type: 'response.created', response: { id: 'resp_seats' } })
  if (calls.length > 0) {
    return {
      head,
      tail: [
        ...calls.map((call, i) =>
          sse({ type: 'response.output_item.done', item: { type: 'function_call', name: call.name, call_id: `call_seats_${Date.now() % 100000}_${i}`, arguments: JSON.stringify(call.input) } }),
        ),
        completed,
      ].join(''),
    }
  }
  return {
    head,
    tail: [
      sse({ type: 'response.output_text.delta', delta: text }),
      sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
      completed,
    ].join(''),
  }
}

function messagesAnswer(model: string, blocks: Block[], usage: { input: number; output: number }): { head: string; tail: string } {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const head = `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_seats_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`
  const parts: string[] = []
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    } else {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_seats_${Date.now() % 100000}_${index}`, name: block.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return { head, tail: parts.join('') }
}

async function startSeatsFixture(port: number, mainDialect: Dialect): Promise<Fixture> {
  const hits: Hit[] = []
  const startedAt = Date.now()
  const seatModel = mainDialect === 'anthropic' ? GPT_ID : CLAUDE_SEAT_ALIAS
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && url === '/openai/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            models: [
              {
                slug: GPT_ID,
                display_name: 'GPT-5.6 Sol',
                supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map(effort => ({ effort, description: effort })),
                default_reasoning_level: 'high',
                visibility: 'list',
                priority: 1,
                context_window: 272_000,
                input_modalities: ['text'],
                supported_in_api: true,
              },
            ],
          }),
        )
        return
      }
      const lane = url.includes('/v1/messages') ? 'messages' : url.endsWith('/responses') ? 'responses' : 'other'
      if (lane === 'other') {
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
      const b = body as { model?: unknown; reasoning?: { effort?: unknown } } | null
      const model = typeof b?.model === 'string' ? b.model : 'fixture'
      const effort = typeof b?.reasoning?.effort === 'string' ? b.reasoning.effort : null
      const { route, seat } = routeOf(body)
      hits.push({ route, model, seat, lane, at: Date.now() - startedAt, effort })
      let blocks: Block[]
      let usage: { input: number; output: number }
      let holdMs = 0
      switch (route) {
        case 'parent':
          blocks = [
            { type: 'text', text: 'launching four sub-agents' },
            ...SEATS.map(name => ({ type: 'tool_use' as const, name: 'Agent', input: { description: name, prompt: `crew-seat: survey the ${name}`, subagent_type: 'general-purpose', model: seatModel } })),
          ]
          usage = { input: 1200, output: 120 }
          break
        case 'parent-ack':
          blocks = [{ type: 'text', text: 'crew-seats: all four landed.' }]
          usage = { input: 1600, output: 30 }
          break
        case 'seat':
          blocks = [{ type: 'text', text: `crew-seat-done: ${seat ?? 'seat'}.` }]
          usage = { input: 900, output: 60 }
          holdMs = SEAT_HOLD_MS
          break
        default:
          blocks = [{ type: 'text', text: 'ok' }]
          usage = { input: 20, output: 2 }
      }
      const answer = lane === 'responses' ? responsesAnswer(blocks, usage) : messagesAnswer(model, blocks, usage)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(answer.head)
      if (holdMs === 0) {
        res.end(answer.tail)
        return
      }
      const t = setTimeout(() => res.end(answer.tail), holdMs)
      res.on('close', () => clearTimeout(t))
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
  const dir = mkdtempSync(join(tmpdir(), 'crew-seats-cfg-'))
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'crew-seats-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'crew-seats-cwd-')))
  seedFirstRun(home, [cwd])
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg.switchboardCapacity = { askedAt: Date.now() - 86_400_000, allowed: true, recommendedSeats: SEAT_CEILING }
  writeFileSync(cfgPath, JSON.stringify(cfg))
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
    OPENAI_API_KEY: 'fixture-openai-key',
    MERCURY_OPENAI_API_BASE: `${fixtureBase}/openai/v1`,
    MERCURY_OPENAI_CHATGPT_BASE: `${fixtureBase}/openai/chatgpt`,
    MERCURY_OPENAI_AUTH_BASE: `${fixtureBase}/openai/auth`,
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

const flat = (s: string): string => s.replace(/\s+/g, ' ')
const rowOf = (text: string, name: string): string | undefined => {
  const lines = text.split('\n').filter(line => line.includes(name))
  return lines.length === 0 ? undefined : lines[lines.length - 1]
}
const COLS = 160
const ROWS = 44
const TICK_MS = 200

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

const LEG = process.env.CREW_SEATS_LEG ?? 'all'
const portFor = (dialect: Dialect): number => Number(process.env[`CREW_SEATS_PORT_${dialect.toUpperCase()}`] ?? (dialect === 'anthropic' ? 25171 : 25172))

async function leg(mainDialect: Dialect): Promise<void> {
  const mainModel = mainDialect === 'anthropic' ? CLAUDE_ID : GPT_ID
  const seatModel = mainDialect === 'anthropic' ? GPT_ID : CLAUDE_SEAT_PREFIX
  const seatIs = (id: string): boolean => (mainDialect === 'anthropic' ? id === GPT_ID : id.startsWith(CLAUDE_SEAT_PREFIX))
  const seatLane = mainDialect === 'anthropic' ? 'responses' : 'messages'
  const tag = `${mainDialect} main → ${seatModel} seats`
  console.log(`\n— ${tag} —`)
  const before = failures
  const fixture = await startSeatsFixture(portFor(mainDialect), mainDialect)
  const { home, cwd } = seedWorld()
  let cap: Capture | null = null
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 560,
        cwd,
        argv: ['node', DIST, '--model', mainModel],
        sends: [
          ...bootSends(ASK),
          { data: '/teammates', atTick: 999, awaitText: 'Running 4 agents', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'running' },
          { data: '\r', afterPrevTicks: 3 },
          { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-mid' },
          { data: '/teammates', atTick: 999, awaitText: 'agents finished', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'landed' },
          { data: '\r', afterPrevTicks: 3 },
          { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-landed' },
          { data: '', afterPrevTicks: 3 },
        ],
        stableTicks: 6,
      },
      driveEnv(home, fixture.base),
    )
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  if (process.env.CREW_SEATS_KEEP === '1') for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
  check(`${tag}: every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)

  const seatHits = fixture.hits.filter(h => h.route === 'seat').sort((a, b) => a.at - b.at)
  const starts = seatHits.map(h => `${h.seat}@${(h.at / 1000).toFixed(1)}s`)
  console.log(`  wire: ${starts.join(' · ')}`)
  check(`${tag}: four seat requests reached the wire`, seatHits.length === 4, starts.join(','))
  if (seatHits.length === 4) {
    const firstThreeSpan = seatHits[2]!.at - seatHits[0]!.at
    const fourthGap = seatHits[3]!.at - seatHits[2]!.at
    check(`${tag}: S1 three seats start together (span ${Math.round(firstThreeSpan)} ms < ${SEAT_HOLD_MS / 2} ms)`, firstThreeSpan < SEAT_HOLD_MS / 2, `span ${firstThreeSpan} ms`)
    check(`${tag}: S1 the fourth waits for a seat (starts ≥ ${Math.round(SEAT_HOLD_MS * 0.6)} ms after the third)`, fourthGap >= SEAT_HOLD_MS * 0.6, `gap ${fourthGap} ms`)
    check(`${tag}: S1 the queue drains in launch order (the fourth to start is the last launched)`, seatHits[3]!.seat === SEATS[3], seatHits.map(h => h.seat).join(','))
  }

  const mid = marks['crew-mid'] ?? ''
  const fourth = rowOf(mid, SEATS[3]) ?? ''
  check(`${tag}: S2 the fourth row says why it waits — the seat sentence`, /waiting for a seat/.test(fourth) && /3 of 3 held/.test(fourth), flat(fourth))
  const heldWords = /(\brunning\b|first byte|request sent|streaming|reasoning|replying|retry)/
  check(`${tag}: S2 the three held rows run (a phase or 'running'; never a seat wait)`, SEATS.slice(0, 3).every(s => heldWords.test(rowOf(mid, s) ?? '') && !/waiting for a seat/.test(rowOf(mid, s) ?? '')), SEATS.slice(0, 3).map(s => flat(rowOf(mid, s) ?? '(no row)')).join(' | ').slice(0, 400))

  check(`${tag}: S3 every seat rode the seats' wire on ${seatModel}`, seatHits.every(h => h.lane === seatLane && seatIs(h.model)), seatHits.map(h => `${h.lane}:${h.model}`).join(','))
  if (seatModel === GPT_ID) check(`${tag}: S3 every GPT seat's request carries a reasoning effort`, seatHits.every(h => h.effort !== null), seatHits.map(h => String(h.effort)).join(','))
  const parentHits = fixture.hits.filter(h => h.route === 'parent' || h.route === 'parent-ack')
  check(`${tag}: S3 the main rode its own wire with ${mainModel}`, parentHits.length >= 2 && parentHits.every(h => h.model === mainModel), parentHits.map(h => `${h.route}:${h.lane}:${h.model}`).join(','))
  check(`${tag}: S3 the Crew view rows name the seats' model`, SEATS.every(s => (rowOf(mid, s) ?? '').includes(seatModel)), flat(mid).slice(0, 400))

  const landed = marks['crew-landed'] ?? ''
  check(`${tag}: S4 all four landed with their model kept`, SEATS.every(s => /\blanded\b/.test(rowOf(landed, s) ?? '') && (rowOf(landed, s) ?? '').includes(seatModel)) && landed.includes('0 running · 4 sub-agents'), flat(landed).slice(0, 400))

  if (failures > before && process.env.CREW_SEATS_KEEP !== '1') for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
  if (failures > before || process.env.CREW_SEATS_KEEP === '1') dump(`${tag} · final grid`, cap.text)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

for (const dialect of ['anthropic', 'openai'] as const) {
  if (LEG === 'all' || LEG === dialect) await leg(dialect)
}

console.log(failures === 0 ? '\nprove-crew-seats-drive: ALL LAWS HOLD' : `\nprove-crew-seats-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
