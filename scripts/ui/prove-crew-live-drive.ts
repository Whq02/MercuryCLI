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

type Dialect = 'anthropic' | 'openai'
type Route = 'parent' | 'parent-ack' | 'seat' | 'seat-ack' | 'side'
interface Hit {
  route: Route
  model: string
  seat: string | null
  lane: string
}
const GPT_ID = 'gpt-5.5'
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
    if (text.includes('crew-seat:') || text.includes('crew-drive:')) last = text
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

function responsesAnswer(blocks: Block[], usage: { input: number; output: number }): string {
  const calls = blocks.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
  const text = blocks.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
  const completed = sse({
    type: 'response.completed',
    response: { id: 'resp_crew', usage: { input_tokens: usage.input, output_tokens: usage.output, input_tokens_details: { cached_tokens: 0 } } },
  })
  if (calls.length > 0) {
    return [
      sse({ type: 'response.created', response: { id: 'resp_crew' } }),
      ...calls.map((call, i) =>
        sse({ type: 'response.output_item.done', item: { type: 'function_call', name: call.name, call_id: `call_crew_${Date.now() % 100000}_${i}`, arguments: JSON.stringify(call.input) } }),
      ),
      completed,
    ].join('')
  }
  return [
    sse({ type: 'response.created', response: { id: 'resp_crew' } }),
    sse({ type: 'response.output_text.delta', delta: text }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    completed,
  ].join('')
}

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
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && url === '/openai/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            models: [
              {
                slug: GPT_ID,
                display_name: GPT_ID.toUpperCase(),
                supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({ effort, description: effort })),
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
      const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
      const { route, seat } = routeOf(body)
      hits.push({ route, model, seat, lane })
      if (process.env.CREW_KEEP === '1' && route === 'side') {
        const b = body as { tools?: unknown[]; input?: unknown; messages?: unknown }
        const toolNames = Array.isArray(b?.tools) ? b.tools.map(t => (t as { name?: string; function?: { name?: string } })?.name ?? (t as { function?: { name?: string } })?.function?.name).slice(0, 12) : 'none'
        console.log(`[side ${lane}] keys=${Object.keys(body ?? {}).join(',')} tools=${JSON.stringify(toolNames)} items=${JSON.stringify(itemsOf(body).slice(-2)).slice(0, 700)}`)
      }
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
      res.end(lane === 'responses' ? responsesAnswer(blocks, usage) : answer(model, blocks, usage))
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

function driveEnv(home: string, fixtureBase: string, dialect: Dialect): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: dialect === 'anthropic' ? FIXTURE_API_KEY : '',
    ...(dialect === 'openai'
      ? {
          OPENAI_API_KEY: 'fixture-openai-key',
          MERCURY_OPENAI_API_BASE: `${fixtureBase}/openai/v1`,
          MERCURY_OPENAI_CHATGPT_BASE: `${fixtureBase}/openai/chatgpt`,
          MERCURY_OPENAI_AUTH_BASE: `${fixtureBase}/openai/auth`,
        }
      : {}),
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    ...(dialect === 'anthropic' ? { OPENAI_API_KEY: '' } : {}),
  }
}

const TOKENS_RE = /\b\d[\d.,]*k? tokens\b/
const nonZeroTokens = (text: string): boolean => TOKENS_RE.test(text) && !/\b0 tokens\b/.test(text)
const agentRow = (text: string, name: string, ...words: Array<string | RegExp>): boolean =>
  text.split('\n').some(line => line.includes(name) && words.every(w => (typeof w === 'string' ? line.includes(w) : w.test(line))))
const rowTokens = (text: string, name: string): boolean =>
  text.split('\n').some(line => line.includes(name) && nonZeroTokens(line))
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

const LEG = process.env.CREW_LEG ?? 'all'
const runs = (dialect: Dialect, leg: 'land' | 'stop'): boolean => {
  const name = dialect === 'anthropic' ? leg : `openai-${leg}`
  return LEG === 'all' || LEG === name || LEG === dialect
}
const argvFor = (dialect: Dialect): string[] => (dialect === 'openai' ? ['node', DIST, '--model', GPT_ID] : ['node', DIST])
const portFor = (dialect: Dialect, leg: 'land' | 'stop'): number =>
  Number(process.env[`CREW_PORT_${dialect.toUpperCase()}_${leg.toUpperCase()}`] ?? (dialect === 'anthropic' ? (leg === 'land' ? 25161 : 25162) : leg === 'land' ? 25163 : 25164))

async function landLeg(dialect: Dialect): Promise<void> {
  console.log(`\n— ${dialect} · land —`)
  const fixture = await startCrewFixture(portFor(dialect, 'land'), 10)
  const { home, cwd } = seedWorld()
  let cap: Capture | null = null
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 360,
        cwd,
        argv: argvFor(dialect),
        sends: [
          ...bootSends(ASK),
          { data: '/teammates', atTick: 999, awaitText: 'Running 2 agents', requireAwait: true, minTick: 2, awaitSettleTicks: 10, mark: 'running' },
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
      driveEnv(home, fixture.base, dialect),
    )
  } finally {
    await fixture.close()
  }
  const seatHits = fixture.hits.filter(h => h.route === 'seat')
  const servedModel = seatHits[0]?.model ?? ''
  const { marks } = cap
  const tag = `${dialect} · land`
  if (process.env.CREW_KEEP === '1') for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
  check(`${tag}: every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  check(`${tag}: both seats asked the model on the wire, on one served model`, seatHits.length >= 2 && servedModel !== '' && seatHits.every(h => h.model === servedModel), fixture.hits.map(h => `${h.route}:${h.lane}:${h.model}`).join(','))
  check(`${tag}: the parent asked once and landed once (the ack turn)`, fixture.hits.some(h => h.route === 'parent') && fixture.hits.some(h => h.route === 'parent-ack'))
  const wantLane = dialect === 'anthropic' ? 'messages' : 'responses'
  check(
    `${tag}: every crew turn rode the family's own wire${dialect === 'openai' ? ` with the exact id ${GPT_ID}` : ''}`,
    fixture.hits.filter(h => h.route !== 'side').every(h => h.lane === wantLane && (dialect === 'anthropic' || h.model === GPT_ID)),
    fixture.hits.map(h => `${h.route}:${h.lane}:${h.model}`).join(','),
  )
  const running = marks['running'] ?? ''
  check(
    `${tag}: the running card's rows read the record — both names, the served model, tokens > 0`,
    agentRow(running, SEAT_ONE, servedModel) && agentRow(running, SEAT_TWO, servedModel) && rowTokens(running, SEAT_ONE) && rowTokens(running, SEAT_TWO),
  )
  check(
    `${tag}: the CREW lane rows carry a token verb while they run`,
    (flat(running).match(/◐ [a-z-…]+ · \d[\d.,]*k? tokens/g) ?? []).length >= 2,
  )
  check(`${tag}: the usage attribution line counts the crew`, /sub-agents \d[\d.,]*k? tokens/.test(flat(running)))
  const crewRunning = marks['crew-running'] ?? ''
  check(
    `${tag}: the Crew view while running — both rows, the served model, running, tokens > 0, the count label`,
    agentRow(crewRunning, SEAT_ONE, servedModel, /\brunning\b/) && agentRow(crewRunning, SEAT_TWO, servedModel, /\brunning\b/) && rowTokens(crewRunning, SEAT_ONE) && rowTokens(crewRunning, SEAT_TWO) && crewRunning.includes('2 running · 2 sub-agents'),
  )
  const landed = marks['landed'] ?? ''
  check(`${tag}: the card landed both (its landed header) and no seat is still running`, landed.includes('agents finished') && !/\bstopped\b/.test(landed))
  const crewLanded = marks['crew-landed'] ?? ''
  check(
    `${tag}: the Crew view after landing — landed twice, the tokens kept, never the runner's word`,
    agentRow(crewLanded, SEAT_ONE, /\blanded\b/) && agentRow(crewLanded, SEAT_TWO, /\blanded\b/) && rowTokens(crewLanded, SEAT_ONE) && rowTokens(crewLanded, SEAT_TWO) && !crewLanded.includes('completed') && crewLanded.includes('0 running · 2 sub-agents'),
  )
  const card = marks['card'] ?? ''
  check(
    `${tag}: the agent's card reads the same record — model, tokens, tool uses, landed`,
    card.includes(servedModel) && card.includes('tokens') && card.includes('tool use') && card.includes('landed') && !card.includes('completed'),
  )
  if (failures > 0 && process.env.CREW_KEEP !== '1') for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
  if (failures > 0 || process.env.CREW_KEEP === '1') dump(`${tag} · final grid`, cap.text)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

async function stopLeg(dialect: Dialect): Promise<void> {
  console.log(`\n— ${dialect} · stop —`)
  const before = failures
  const fixture = await startCrewFixture(portFor(dialect, 'stop'), 90)
  const { home, cwd } = seedWorld()
  let cap: Capture | null = null
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 220,
        cwd,
        argv: argvFor(dialect),
        sends: [
          ...bootSends(ASK),
          { data: '\x1b', atTick: 999, awaitText: 'Running 2 agents', requireAwait: true, minTick: 2, awaitSettleTicks: 10, mark: 'running' },
          { data: '/teammates', atTick: 110, awaitText: 'stopped', minTick: 2, awaitSettleTicks: 4, mark: 'stopped' },
          { data: '\r', afterPrevTicks: 4 },
          { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-stopped' },
        ],
        stableTicks: 6,
      },
      driveEnv(home, fixture.base, dialect),
    )
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  const tag = `${dialect} · stop`
  if (process.env.CREW_KEEP === '1') for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
  check(`${tag}: every send became due`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  const running = marks['running'] ?? ''
  check(`${tag}: both seats were running with tokens when the Esc fired`, rowTokens(running, SEAT_ONE) && rowTokens(running, SEAT_TWO))
  const stopped = marks['stopped'] ?? ''
  check(`${tag}: the card rows read stopped — never the runner's word`, (stopped.match(/\bstopped\b/g) ?? []).length >= 2 && !stopped.includes('killed'))
  const crewStopped = marks['crew-stopped'] ?? ''
  check(`${tag}: the Crew view reads stopped for both agents, tokens kept`, agentRow(crewStopped, SEAT_ONE, /\bstopped\b/) && agentRow(crewStopped, SEAT_TWO, /\bstopped\b/) && !crewStopped.includes('killed') && rowTokens(crewStopped, SEAT_ONE) && rowTokens(crewStopped, SEAT_TWO) && crewStopped.includes('0 running · 2 sub-agents'))
  check(`${tag}: no seat settled its turn (the Sleep was interrupted — no seat-ack on the wire)`, fixture.hits.every(h => h.route !== 'seat-ack'))
  const wantLane = dialect === 'anthropic' ? 'messages' : 'responses'
  check(`${tag}: every crew turn rode the family's own wire`, fixture.hits.filter(h => h.route !== 'side').every(h => h.lane === wantLane && (dialect === 'anthropic' || h.model === GPT_ID)), fixture.hits.map(h => `${h.route}:${h.lane}:${h.model}`).join(','))
  if (failures > before && process.env.CREW_KEEP !== '1') for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
  if (failures > before || process.env.CREW_KEEP === '1') dump(`${tag} · final grid`, cap.text)
  if (process.env.CREW_KEEP === '1') console.log(`[keep] ${tag} home ${home} cwd ${cwd}`)
  else {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

for (const dialect of ['anthropic', 'openai'] as const) {
  if (runs(dialect, 'land')) await landLeg(dialect)
  if (runs(dialect, 'stop')) await stopLeg(dialect)
}

console.log(failures === 0 ? '\nprove-crew-live-drive: ALL LAWS HOLD' : `\nprove-crew-live-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
