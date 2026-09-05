#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { firstByteBudgetMs } from '../../src/services/providers/streamIdleBudget.ts'

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

const ID = 'gpt-6-astra'
const NAME = 'GPT-6 Astra'
const MAIN_ID = 'claude-fable-5-1'
const ASK = 'astra-crew: launch the survey'
const FIXTURE_API_KEY = 'fixture-key-000'
const BUDGET_MS = 8_000
const SEAT_CEILING = 6
const PORT = Number(process.env.ASTRA_CREW_PORT ?? 25181)

type SeatArm = 'deep' | 'quick' | 'cold'
const SEATS: Record<SeatArm, { name: string; type: string; effort: string }> = {
  deep: { name: 'deep-survey', type: 'astra-deep', effort: 'max' },
  quick: { name: 'quick-survey', type: 'astra-quick', effort: 'xhigh' },
  cold: { name: 'cold-survey', type: 'astra-quick', effort: 'xhigh' },
}
const STATIONS = [
  { station: 'one', effort: 'max' },
  { station: 'two', effort: 'high' },
] as const
const summaryOf = (who: string): string => `astra-summary: weighing the ${who} tables`
const noteOf = (who: string): string => `astra-note: checking the ${who} gauges`
const doneOf = (who: string): string => `astra-seat-done: ${who}`
const WF_NAME = 'astra-crew'
const WF_SCRIPT = [
  `export const meta = { name: '${WF_NAME}', description: 'two agents on the new row', phases: [{ title: 'Survey' }] }`,
  "phase('Survey')",
  ...STATIONS.map(
    (s, i) => `const r${i} = await agent('wf-astra: report the tide at station ${s.station}', { model: '${ID}', effort: '${s.effort}' })`,
  ),
  `return { ${STATIONS.map((_, i) => `r${i}`).join(', ')} }`,
].join('\n')

type Lane = 'messages' | 'responses' | 'models' | 'other'
type Route = 'parent' | 'parent-ack' | 'seat' | 'wf' | 'side'
interface Hit {
  route: Route
  lane: Lane
  model: string
  who: string | null
  at: number
  effort: string | null
  promptTokens: number
  tools: string[]
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
    if (/astra-crew:|astra-seat:|wf-astra:/.test(text)) last = text
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

function toolNames(body: unknown): string[] {
  const tools = (body as { tools?: unknown[] })?.tools
  return Array.isArray(tools) ? tools.map(t => String((t as { name?: string })?.name ?? '')) : []
}

function routeOf(lane: Lane, body: unknown): { route: Route; who: string | null } {
  const text = lastUserText(body)
  if (lane === 'responses') {
    if (text.includes('astra-seat:')) {
      const arm = (Object.keys(SEATS) as SeatArm[]).find(k => text.includes(SEATS[k].name)) ?? null
      return { route: 'seat', who: arm }
    }
    if (text.includes('wf-astra:')) {
      const station = STATIONS.find(s => text.includes(`station ${s.station}`))?.station ?? null
      return { route: 'wf', who: station }
    }
    return { route: 'side', who: null }
  }
  if (text.includes('astra-crew:') && toolNames(body).includes('Agent')) return { route: carriesToolResult(body) ? 'parent-ack' : 'parent', who: null }
  return { route: 'side', who: null }
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }

function messagesAnswer(model: string, blocks: Block[], usage: { input: number; output: number }): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_astra_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
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
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_astra_${Date.now() % 100000}_${index}`, name: block.name, input: {} } })}`,
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

let respSeq = 0
function responsesAnswer(who: string, usage: { input: number; output: number }): { head: string; body: string; tail: string } {
  const n = ++respSeq
  const id = `resp_astra_${n}`
  const summary = summaryOf(who)
  const note = noteOf(who)
  const done = doneOf(who)
  const message = (mid: string, phase: string, status: 'in_progress' | 'completed', text?: string) => ({
    type: 'message',
    id: mid,
    role: 'assistant',
    status,
    content: text === undefined ? [] : [{ type: 'output_text', text, annotations: [] }],
    phase,
  })
  return {
    head: sse({ type: 'response.created', response: { id } }),
    body: [
      sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: `rs_${n}`, summary: [] } }),
      sse({ type: 'response.reasoning_summary_text.delta', item_id: `rs_${n}`, delta: summary }),
      sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: `rs_${n}`, summary: [{ type: 'summary_text', text: summary }], encrypted_content: `astra-opaque-${n}` } }),
      sse({ type: 'response.output_item.added', output_index: 1, item: message(`msg_${n}_note`, 'commentary', 'in_progress') }),
      sse({ type: 'response.output_text.delta', item_id: `msg_${n}_note`, delta: note }),
      sse({ type: 'response.output_item.done', output_index: 1, item: message(`msg_${n}_note`, 'commentary', 'completed', note) }),
      sse({ type: 'response.output_item.added', output_index: 2, item: message(`msg_${n}_answer`, 'final_answer', 'in_progress') }),
      sse({ type: 'response.output_text.delta', item_id: `msg_${n}_answer`, delta: done }),
      sse({ type: 'response.output_item.done', output_index: 2, item: message(`msg_${n}_answer`, 'final_answer', 'completed', done) }),
    ].join(''),
    tail: sse({
      type: 'response.completed',
      response: { id, model: ID, usage: { input_tokens: usage.input, output_tokens: usage.output, input_tokens_details: { cached_tokens: 0 } } },
    }),
  }
}

function modelsList(): string {
  const row = (slug: string, name: string, priority: number, efforts: string[], window: number) => ({
    slug,
    display_name: name,
    supported_reasoning_levels: efforts.map(effort => ({ effort, description: effort })),
    default_reasoning_level: 'high',
    visibility: 'list',
    priority,
    context_window: window,
    input_modalities: ['text', 'image'],
    supported_in_api: true,
  })
  return JSON.stringify({
    models: [row(ID, NAME, 1, ['low', 'medium', 'high', 'xhigh', 'max'], 1_050_000), row('gpt-5.6-sol', 'GPT-5.6 Sol', 2, ['low', 'medium', 'high', 'xhigh'], 272_000)],
  })
}

async function startFixture(port: number): Promise<Fixture> {
  const hits: Hit[] = []
  const startedAt = Date.now()
  const seatHits = new Map<SeatArm, number>()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && url === '/openai/v1/models') {
        hits.push({ route: 'side', lane: 'models', model: '', who: null, at: Date.now() - startedAt, effort: null, promptTokens: 0, tools: [] })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(modelsList())
        return
      }
      const lane: Lane = url.includes('/v1/messages') ? 'messages' : url.endsWith('/responses') ? 'responses' : 'other'
      if (lane === 'other') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(url.endsWith('/models') ? JSON.stringify({ object: 'list', data: [], models: [] }) : '{}')
        return
      }
      const raw = Buffer.concat(chunks)
      let body: unknown = null
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        body = null
      }
      const b = body as { model?: unknown; reasoning?: { effort?: unknown } } | null
      const model = typeof b?.model === 'string' ? b.model : 'fixture'
      const effort = typeof b?.reasoning?.effort === 'string' ? b.reasoning.effort : null
      const { route, who } = routeOf(lane, body)
      hits.push({ route, lane, model, who, at: Date.now() - startedAt, effort, promptTokens: Math.ceil(raw.byteLength / 4), tools: toolNames(body) })

      if (lane === 'messages') {
        let blocks: Block[]
        let usage: { input: number; output: number }
        switch (route) {
          case 'parent':
            blocks = [
              { type: 'text', text: 'launching the survey crew' },
              ...(Object.keys(SEATS) as SeatArm[]).map(arm => ({
                type: 'tool_use' as const,
                name: 'Agent',
                input: { description: SEATS[arm].name, prompt: `astra-seat: survey the ${SEATS[arm].name}`, subagent_type: SEATS[arm].type, model: ID },
              })),
              { type: 'tool_use', name: 'Workflow', input: { script: WF_SCRIPT } },
            ]
            usage = { input: 1200, output: 160 }
            break
          case 'parent-ack':
            blocks = [{ type: 'text', text: 'astra-crew: the survey landed.' }]
            usage = { input: 1800, output: 30 }
            break
          default:
            blocks = [{ type: 'text', text: 'ok' }]
            usage = { input: 20, output: 2 }
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(messagesAnswer(model, blocks, usage))
        return
      }

      if (route === 'seat' && who !== null) {
        const arm = who as SeatArm
        const nth = (seatHits.get(arm) ?? 0) + 1
        seatHits.set(arm, nth)
        const answer = responsesAnswer(SEATS[arm].name, { input: 900, output: 60 })
        if (arm === 'cold' && nth === 1) {
          res.on('close', () => {})
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        if (arm === 'quick') {
          res.write(answer.head + answer.body)
          res.on('close', () => {})
          return
        }
        res.end(answer.head + answer.body + answer.tail)
        return
      }
      if (route === 'wf' && who !== null) {
        const answer = responsesAnswer(`station ${who}`, { input: 700, output: 40 })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(answer.head + answer.body + answer.tail)
        return
      }
      const side = responsesAnswer('side', { input: 20, output: 2 })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(side.head + side.body + side.tail)
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
  const dir = mkdtempSync(join(tmpdir(), 'astra-crew-cfg-'))
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'astra-crew-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'astra-crew-cwd-')))
  seedFirstRun(home, [cwd])
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg.switchboardCapacity = { askedAt: Date.now() - 86_400_000, allowed: true, recommendedSeats: SEAT_CEILING }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const agentsDir = join(home, 'agents')
  mkdirSync(agentsDir, { recursive: true })
  for (const [type, effort] of [
    ['astra-deep', 'max'],
    ['astra-quick', 'xhigh'],
  ] as const) {
    writeFileSync(
      join(agentsDir, `${type}.md`),
      `---\nname: ${type}\ndescription: a survey seat on the new row at ${effort} effort\nmodel: ${ID}\neffort: ${effort}\n---\nSurvey what you are asked and answer in one line.\n`,
    )
  }
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
    MERCURY_STREAM_IDLE_TIMEOUT_MS: String(BUDGET_MS),
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
const namesRow = (row: string | undefined): boolean => row !== undefined && (row.includes(ID) || row.includes(NAME))
const COLS = 160
const ROWS = 44

function transcriptFiles(home: string): Array<{ file: string; rows: string[] }> {
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return []
  const files = (readdirSync(projects, { recursive: true }) as string[]).filter(f => f.endsWith('.jsonl'))
  return files.map(f => ({ file: f, rows: readFileSync(join(projects, f), 'utf8').split('\n').filter(l => l.trim() !== '') }))
}
function transcriptRows(home: string): string[] {
  return transcriptFiles(home).flatMap(f => f.rows)
}
function agentTranscriptOf(home: string, seatName: string): { file: string; rows: string[] } | undefined {
  return transcriptFiles(home).find(f => /(^|\/)agent-[^/]*\.jsonl$/.test(f.file) && f.rows.some(l => l.includes(`astra-seat: survey the ${seatName}`)))
}

function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, COLS)}`)
}

const bootSends = (ask: string): Array<Record<string, unknown>> => [
  { data: '\r', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: ask, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\r', afterPrevTicks: 4 },
]

console.log(`\n— a ${MAIN_ID} main → ${ID} seats and a workflow —`)
const fixture = await startFixture(PORT)
const { home, cwd } = seedWorld()
let cap: Capture | null = null
try {
  cap = await capture(
    {
      cols: COLS,
      rows: ROWS,
      total: 780,
      cwd,
      argv: ['node', DIST, '--model', MAIN_ID],
      sends: [
        ...bootSends(ASK),
        { data: '/teammates', atTick: 999, awaitText: 'Running 3 agents', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'running' },
        { data: '\r', afterPrevTicks: 3 },
        { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-mid' },
        { data: '/teammates', afterPrevTicks: 90 },
        { data: '\r', afterPrevTicks: 3 },
        { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-wait' },
        { data: '\r', atTick: 999, awaitText: 'Yes, run this workflow', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'wf-ask' },
        { data: '\r', afterPrevTicks: 5 },
        { data: '/teammates', atTick: 999, awaitText: 'the survey landed.', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'landed' },
        { data: '\r', afterPrevTicks: 3 },
        { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-landed' },
        { data: '/workflows', afterPrevTicks: 4 },
        { data: '\r', afterPrevTicks: 3 },
        { data: '2', atTick: 999, awaitText: 'Mercury — workflows', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'wf-board' },
        { data: '\r', afterPrevTicks: 6, mark: 'wf-recent' },
        { data: '\x1b[C', afterPrevTicks: 10, mark: 'wf-run' },
        { data: '', afterPrevTicks: 14, mark: 'wf-agent' },
        { data: '\x1b', afterPrevTicks: 2 },
        { data: '\x1b', afterPrevTicks: 3 },
        { data: '\x1b', afterPrevTicks: 3 },
        { data: '', afterPrevTicks: 4, mark: 'end' },
      ],
      stableTicks: 6,
    },
    driveEnv(home, fixture.base),
  )
} finally {
  await fixture.close()
}
const { marks } = cap
const keep = process.env.ASTRA_CREW_KEEP === '1'
if (keep) for (const [label, frame] of Object.entries(marks)) dump(label, frame)
check('every send became due (the frames the sends waited on all painted)', cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)

const hits = fixture.hits
console.log(`  models list reads: ${hits.filter(h => h.lane === 'models').length} · side calls: ${hits.filter(h => h.route === 'side' && h.lane !== 'models').map(h => `${h.lane}:${h.model}`).join(',') || 'none'}`)
check('the live models list was read (the row is present because the list serves it)', hits.some(h => h.lane === 'models'))
const parents = hits.filter(h => h.route === 'parent' || h.route === 'parent-ack')
check(`the main rode the Anthropic wire on ${MAIN_ID}`, parents.length >= 2 && parents.every(h => h.lane === 'messages' && h.model === MAIN_ID), parents.map(h => `${h.route}:${h.lane}:${h.model}`).join(','))
check('the ask offered both the Agent tool and the Workflow tool', parents.some(h => h.tools.includes('Agent') && h.tools.includes('Workflow')), parents[0]?.tools.join(',') ?? '')

const seatHits = hits.filter(h => h.route === 'seat').sort((a, b) => a.at - b.at)
console.log(`  wire: ${seatHits.map(h => `${h.who}@${(h.at / 1000).toFixed(1)}s ${h.effort}`).join(' · ')}`)
const byArm = (arm: SeatArm): Hit[] => seatHits.filter(h => h.who === arm)
check(`A1 every seat request rode the Responses wire on ${ID}`, seatHits.length >= 4 && seatHits.every(h => h.lane === 'responses' && h.model === ID), seatHits.map(h => `${h.lane}:${h.model}`).join(','))
check('A1 the deep seat asked once, the quick seat once, the parked seat twice', byArm('deep').length === 1 && byArm('quick').length === 1 && byArm('cold').length === 2, `${byArm('deep').length}/${byArm('quick').length}/${byArm('cold').length}`)
const LIVE_LADDER = ['low', 'medium', 'high', 'xhigh', 'max']
console.log(`  efforts: ${(Object.keys(SEATS) as SeatArm[]).map(arm => `${SEATS[arm].name} asked ${SEATS[arm].effort} → sent ${byArm(arm).map(h => String(h.effort)).join('/')}`).join(' · ')}`)
check('A2 every seat request carried a reasoning effort from the served five-level ladder', seatHits.every(h => h.effort !== null && LIVE_LADDER.includes(h.effort)), seatHits.map(h => String(h.effort)).join(','))
for (const arm of Object.keys(SEATS) as SeatArm[]) {
  const sent = byArm(arm).map(h => String(h.effort))
  check(`A2 the ${SEATS[arm].name} seat sent the word its definition asked (${SEATS[arm].effort}) on every request, above the session's stamp`, sent.length > 0 && sent.every(word => word === SEATS[arm].effort), `sent ${sent.join('/')}`)
}
const wfHits = hits.filter(h => h.route === 'wf').sort((a, b) => a.at - b.at)
check(`A1 the workflow's two agents rode the Responses wire on ${ID}`, wfHits.length === 2 && wfHits.every(h => h.lane === 'responses' && h.model === ID), wfHits.map(h => `${h.who}:${h.lane}:${h.model}`).join(','))
console.log(`  workflow efforts: ${STATIONS.map(s => `station ${s.station} asked ${s.effort} → sent ${wfHits.find(h => h.who === s.station)?.effort ?? 'none'}`).join(' · ')}`)
check('A2 every workflow call carried a reasoning effort from the served ladder', wfHits.length === 2 && wfHits.every(h => h.effort !== null && LIVE_LADDER.includes(h.effort)), wfHits.map(h => `${h.who}:${h.effort}`).join(','))
check("A2 each workflow call sent the call's own word (station one max · station two high), above the session's stamp", STATIONS.every(s => wfHits.find(h => h.who === s.station)?.effort === s.effort), wfHits.map(h => `${h.who}:${h.effort}`).join(','))

{
  const cold = byArm('cold')
  const first = cold[0]
  const budget = first ? firstByteBudgetMs({ cold: true, promptTokens: first.promptTokens, idleMs: BUDGET_MS }) : 0
  const gap = cold.length >= 2 ? cold[1]!.at - cold[0]!.at : -1
  check(`A4 the parked seat's retry re-issued at the owner's first-byte budget (${budget} ms for its ${first?.promptTokens ?? 0}-token prompt)`, gap >= budget - 500 && gap <= budget + 6_000, `gap=${gap} ms`)
}

const mid = marks['crew-mid'] ?? ''
check('A1 the Crew view rows name the row for every seat', (Object.keys(SEATS) as SeatArm[]).every(arm => namesRow(rowOf(mid, SEATS[arm].name))), flat(mid).slice(0, 500))
check('A5 mid-crew, the held seat reads in flight — streaming (its reply stands, its end is still due)', /\b(streaming|running)\b/.test(rowOf(mid, SEATS.quick.name) ?? ''), flat(rowOf(mid, SEATS.quick.name) ?? ''))
const waiting = marks['crew-wait'] ?? ''
check('A5 mid-wait, the held seat has landed (the typed end freed it at the budget)', /\blanded\b/.test(rowOf(waiting, SEATS.quick.name) ?? ''), flat(rowOf(waiting, SEATS.quick.name) ?? ''))
check('A4 mid-wait, the parked seat still waits and its row says so — "waiting for the first byte"', /waiting for the first byte|\brunning\b/.test(rowOf(waiting, SEATS.cold.name) ?? ''), flat(rowOf(waiting, SEATS.cold.name) ?? ''))
const landed = marks['crew-landed'] ?? ''
check('A4/A5 every seat landed with the row kept — the held seat and the parked seat included', (Object.keys(SEATS) as SeatArm[]).every(arm => /\blanded\b/.test(rowOf(landed, SEATS[arm].name) ?? '') && namesRow(rowOf(landed, SEATS[arm].name))), flat(landed).slice(0, 500))
check('nothing read stuck', !/may be stuck/.test(landed) && !/may be stuck/.test(marks['landed'] ?? ''))

const rows = transcriptRows(home)
const durationOf = (reply: string): number | undefined => {
  for (const l of rows) {
    if (!l.includes(reply)) continue
    const m = /duration_ms: (\d+)/.exec(l)
    if (m) return Number(m[1])
  }
  return undefined
}
check('A3 the deep seat\'s record holds the reasoning summary as a reasoning span', rows.some(l => l.includes('"kind":"reasoning"') && l.includes(summaryOf(SEATS.deep.name))), `rows=${rows.length}`)
check('A3 the deep seat\'s record holds the working note labelled commentary', rows.some(l => l.includes(noteOf(SEATS.deep.name)) && l.includes('"phase":"commentary"')), `rows=${rows.length}`)
check('A3 the deep seat\'s record holds the answer labelled final_answer', rows.some(l => l.includes(doneOf(SEATS.deep.name)) && l.includes('"phase":"final_answer"')), `rows=${rows.length}`)
{
  const deep = durationOf(doneOf(SEATS.deep.name))
  const quick = durationOf(doneOf(SEATS.quick.name))
  const cold = durationOf(doneOf(SEATS.cold.name))
  const first = byArm('cold')[0]
  const coldBudget = first ? firstByteBudgetMs({ cold: true, promptTokens: first.promptTokens, idleMs: BUDGET_MS }) : 0
  check('the deep seat ended at once (its stream ended on the end event)', deep !== undefined && deep < 5_000, `duration=${deep} ms`)
  check(`A5 the held seat ended at the owner's budget (${BUDGET_MS} ms after its last item), the reply standing`, quick !== undefined && quick >= BUDGET_MS - 500 && quick <= BUDGET_MS + 5_000 && rows.some(l => l.includes(doneOf(SEATS.quick.name)) && l.includes('"kind":"text"')), `duration=${quick} ms`)
  check(`A4 the parked seat ended one first-byte budget (${coldBudget} ms) and one retry later, the reply landed`, cold !== undefined && cold >= coldBudget - 500 && cold <= coldBudget + 8_000 && rows.some(l => l.includes(doneOf(SEATS.cold.name)) && l.includes('"kind":"text"')), `duration=${cold} ms`)
}
check("A3 the workflow agents' records hold their summaries as reasoning spans", STATIONS.every(s => rows.some(l => l.includes('"kind":"reasoning"') && l.includes(summaryOf(`station ${s.station}`)))), `rows=${rows.length}`)

{
  const quick = agentTranscriptOf(home, SEATS.quick.name)
  const cold = agentTranscriptOf(home, SEATS.cold.name)
  check('A6 the held seat has its own agent transcript', quick !== undefined, transcriptFiles(home).map(f => f.file).join(','))
  const notices = (t: { rows: string[] } | undefined): string => t?.rows.filter(l => l.includes('"kind":"notice"')).map(l => l.slice(0, 220)).join(' | ') ?? ''
  check("A6 the held seat's transcript holds the typed-end receipt row (the stream went silent after its last item; the reply stands)", quick !== undefined && quick.rows.some(l => l.includes('"kind":"notice"') && l.includes('stream went silent') && l.includes('the reply stands')), notices(quick))
  check('A6 the parked seat has its own agent transcript', cold !== undefined)
  check("A6 the parked seat's transcript holds the first-byte line (no first byte from the row after its budget — the reissue's own row)", cold !== undefined && cold.rows.some(l => l.includes('"kind":"notice"') && l.includes('no first byte from')), notices(cold))
}

const wfRecent = marks['wf-recent'] ?? ''
const wfRun = marks['wf-run'] ?? ''
const wfAgent = marks['wf-agent'] ?? ''
check('the board lists the settled run under Recent', wfRecent.includes(WF_NAME) || wfRecent.includes('two agents on the new row'), flat(wfRecent).slice(0, 400))
check(`A1 the run view names the row (${ID})`, wfRun.includes(ID) || wfRun.includes(NAME) || wfAgent.includes(ID) || wfAgent.includes(NAME), flat(wfRun).slice(0, 400))
check('A3 the agent view paints the reasoning summary', wfAgent.includes('astra-summary: weighing the station'), flat(wfAgent).slice(0, 600))

if (failures > 0 && !keep) for (const [label, frame] of Object.entries(marks)) dump(label, frame)
if (failures > 0 || keep) dump('final grid', cap.text)
if (failures === 0) {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
} else {
  console.log(`[forensics] world kept: ${home}`)
}

console.log(failures === 0 ? '\nprove-gpt6-astra-crew-drive: ALL LAWS HOLD' : `\nprove-gpt6-astra-crew-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
