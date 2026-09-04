#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { vshotBudgetMs, resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-token-ring-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'
const ALPHA_DONE = 'RING-ALPHA-DONE'
const SCOUT_BACK = 'RING-SCOUT-BACK'
const SHELL_REFUSED = 'RING-SHELL-REFUSED'
const SEAT_DONE = 'RING-SEAT-DONE'
const SEAT_MARK = 'ring-seat:'
const SEAT_ONE_FILE = 'seat-notes.txt'
const SEAT_TWO_FILE = 'seat-two.txt'
const PROCEED = 'Do you want to proceed?'

const USAGE = {
  alpha: { input: 40_000, cacheRead: 60_000, output: 900 },
  scout: { input: 1500, cacheRead: 0, output: 80 },
  seatOne: { input: 5000, cacheRead: 0, output: 100 },
  seatTwo: { input: 6000, cacheRead: 0, output: 100 },
  seatThree: { input: 7000, cacheRead: 0, output: 200 },
  scoutBack: { input: 200_000, cacheRead: 100_000, output: 300 },
  shell: { input: 2500, cacheRead: 0, output: 60 },
  shellRefused: { input: 2600, cacheRead: 0, output: 40 },
  sleep: { input: 2700, cacheRead: 0, output: 50 },
  side: { input: 10, cacheRead: 0, output: 5 },
} as const
type Usage = { input: number; cacheRead: number; output: number }
const contextOf = (u: Usage): number => u.input + u.cacheRead + u.output
const SEAT_HOLD_MS = 5_000

type Route = 'alpha' | 'scout' | 'scout-back' | 'shell' | 'shell-refused' | 'sleep' | 'seat-one' | 'seat-two' | 'seat-three' | 'side'
type Block = { type?: string; id?: string; name?: string; text?: string; tool_use_id?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
const itemsOf = (body: unknown): Item[] => {
  const b = body as { messages?: unknown }
  return Array.isArray(b?.messages) ? (b.messages as Item[]) : []
}
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [])
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : blocksOf(content).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
const offersTool = (body: unknown, name: string): boolean => {
  const tools = (body as { tools?: unknown[] })?.tools
  return Array.isArray(tools) && tools.some(t => (t as { name?: string })?.name === name)
}
function answeredTool(items: Item[]): { name: string; resultText: string } | null {
  const last = items[items.length - 1]
  if (!last || last.role !== 'user') return null
  const results = blocksOf(last.content).filter(b => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
  if (results.length === 0) return null
  const ids = new Set(results.map(b => b.tool_use_id as string))
  for (let i = items.length - 2; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'assistant') continue
    const use = blocksOf(item.content).find(b => b.type === 'tool_use' && typeof b.id === 'string' && ids.has(b.id))
    if (use) return { name: use.name ?? '', resultText: textOf(results[0]!.content) }
  }
  return null
}
function routeOf(body: unknown): Route {
  const items = itemsOf(body)
  const allUserText = items.map(i => (i.role === 'user' ? textOf(i.content) : '')).join('\n')
  const seat = allUserText.includes(SEAT_MARK) && !offersTool(body, 'Agent')
  const answered = answeredTool(items)
  if (seat) {
    const reads = items.filter(i => i.role === 'assistant' && blocksOf(i.content).some(b => b.type === 'tool_use' && b.name === 'Read')).length
    if (answered?.name === 'Read') return reads >= 2 ? 'seat-three' : 'seat-two'
    return 'seat-one'
  }
  if (answered) {
    if (answered.name === 'Agent') return 'scout-back'
    if (answered.name === 'Bash') return 'shell-refused'
  }
  const last = [...items].reverse().find(i => i.role === 'user')
  const text = last ? textOf(last.content) : ''
  if (text.includes('ring-drive: alpha') && offersTool(body, 'Bash')) return 'alpha'
  if (text.includes('ring-drive: scout') && offersTool(body, 'Agent')) return 'scout'
  if (text.includes('ring-drive: shell') && offersTool(body, 'Bash')) return 'shell'
  if (text.includes('ring-drive: sleep') && offersTool(body, 'Bash')) return 'sleep'
  return 'side'
}

type Answer =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
function answer(model: string, blocks: Answer[], usage: Usage): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const usageStart = { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: usage.cacheRead, output_tokens: 1 }
  const usageEnd = { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: usage.cacheRead, output_tokens: usage.output }
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_ring_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: usageStart } })}`,
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    } else if (block.type === 'thinking') {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'fixture-signature' } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    } else {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: usageEnd })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

type Hit = { route: Route; model: string; atMs: number }
async function startFixture(port: number, cwd: string): Promise<{ base: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = []
  let toolSeq = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (!url.includes('/v1/messages')) {
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
      const route = routeOf(body)
      hits.push({ route, model, atMs: Date.now() })
      let blocks: Answer[]
      let usage: Usage
      let delayMs = 0
      switch (route) {
        case 'alpha':
          blocks = [{ type: 'thinking', thinking: 'weighing the alpha ask at length before answering it '.repeat(12) }, { type: 'text', text: ALPHA_DONE }]
          usage = USAGE.alpha
          break
        case 'scout':
          blocks = [{ type: 'tool_use', id: `toolu_ring_agent_${++toolSeq}`, name: 'Agent', input: { description: 'ring-scout', prompt: `${SEAT_MARK} read both seat files and report`, subagent_type: 'general-purpose' } }]
          usage = USAGE.scout
          break
        case 'seat-one':
          blocks = [{ type: 'tool_use', id: `toolu_ring_read_${++toolSeq}`, name: 'Read', input: { file_path: join(cwd, SEAT_ONE_FILE) } }]
          usage = USAGE.seatOne
          break
        case 'seat-two':
          blocks = [{ type: 'tool_use', id: `toolu_ring_read_${++toolSeq}`, name: 'Read', input: { file_path: join(cwd, SEAT_TWO_FILE) } }]
          usage = USAGE.seatTwo
          break
        case 'seat-three':
          blocks = [{ type: 'text', text: SEAT_DONE }]
          usage = USAGE.seatThree
          delayMs = SEAT_HOLD_MS
          break
        case 'scout-back':
          blocks = [{ type: 'text', text: SCOUT_BACK }]
          usage = USAGE.scoutBack
          break
        case 'shell':
          blocks = [{ type: 'tool_use', id: `toolu_ring_bash_${++toolSeq}`, name: 'Bash', input: { command: 'touch ring-refused.txt && rm ring-refused.txt', description: 'touch and remove a marker' } }]
          usage = USAGE.shell
          break
        case 'shell-refused':
          blocks = [{ type: 'text', text: SHELL_REFUSED }]
          usage = USAGE.shellRefused
          break
        case 'sleep':
          blocks = [{ type: 'tool_use', id: `toolu_ring_sleep_${++toolSeq}`, name: 'Bash', input: { command: 'sleep 30', description: 'wait half a minute' } }]
          usage = USAGE.sleep
          break
        default:
          blocks = [{ type: 'text', text: 'side' }]
          usage = USAGE.side
      }
      const payload = answer(model, blocks, usage)
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(payload)
      }, delayMs).unref?.()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Record<string, string>; markTicks: Record<string, number>; receipts: number[]; endReason: string; stderr: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'token-ring-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(budgetMs))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 600)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as {
    grid: Grid
    sendReceipts?: Array<{ atTick: number }>
    marks?: Array<{ label: string; atTick: number; grid: Grid }>
    endReason?: string
  }
  const marks: Record<string, string> = {}
  const markTicks: Record<string, number> = {}
  for (const m of payload.marks ?? []) {
    marks[m.label] = gridText(m.grid)
    markTicks[m.label] = m.atTick
  }
  rmSync(dir, { recursive: true, force: true })
  return {
    text: gridText(payload.grid),
    marks,
    markTicks,
    receipts: (payload.sendReceipts ?? []).map(r => r.atTick),
    endReason: payload.endReason ?? '',
    stderr: stderr.join(''),
  }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'token-ring-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'token-ring-cwd-')))
  writeFileSync(join(cwd, SEAT_ONE_FILE), 'the first seat note\n')
  writeFileSync(join(cwd, SEAT_TWO_FILE), 'the second seat note\n')
  seedFirstRun(home, [cwd])
  return { home, cwd }
}

function driveEnv(home: string, fixtureBase: string, tee: string): Record<string, string> {
  return {
    VSHOT_TEE: tee,
    TERM_PROGRAM: 'iTerm.app',
    TERM_PROGRAM_VERSION: '3.6.6',
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

type RingEvent = { tick: number; code: number }
function ringEvents(teePath: string): RingEvent[] {
  if (!existsSync(teePath)) return []
  const buf = readFileSync(teePath)
  const out: RingEvent[] = []
  let offset = 0
  const re = /\x1b\]9;4;(\d);(\d*)(?:\x07|\x1b\\)/g
  while (offset + 8 <= buf.length) {
    const tick = buf.readUInt32BE(offset)
    const len = buf.readUInt32BE(offset + 4)
    const data = buf.subarray(offset + 8, offset + 8 + len).toString('latin1')
    offset += 8 + len
    for (const m of data.matchAll(re)) out.push({ tick, code: Number(m[1]) })
  }
  return out
}

function unansweredToolUses(home: string): { unanswered: string[]; calls: number } {
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return { unanswered: [], calls: 0 }
  const files: string[] = []
  for (const dir of readdirSync(projects)) {
    const full = join(projects, dir)
    let names: string[] = []
    try {
      names = readdirSync(full)
    } catch {
      continue
    }
    for (const name of names) if (name.endsWith('.jsonl') && !name.startsWith('agent-')) files.push(join(full, name))
  }
  const calls = new Set<string>()
  const answered = new Set<string>()
  type Entry = { type?: string; message?: { content?: unknown } }
  type Block = { type?: string; id?: string; tool_use_id?: string }
  for (const file of files) {
    const entries = decodeTranscriptBuffer<Entry>(readFileSync(file, 'utf8')).entries
    for (const entry of entries) {
      const content = entry.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content as Block[]) {
        if (block.type === 'tool_use' && typeof block.id === 'string' && block.id.startsWith('toolu_ring_')) calls.add(block.id)
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') answered.add(block.tool_use_id)
      }
    }
  }
  return { unanswered: [...calls].filter(id => !answered.has(id)), calls: calls.size }
}

const rowsWith = (frame: string | undefined, needle: string | RegExp): string[] =>
  (frame ?? '').split('\n').filter(line => (typeof needle === 'string' ? line.includes(needle) : needle.test(line)))
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row}`)
}

console.log('============================================================')
console.log(' the two token facts and the tab ring — real bundle, PTY')
console.log('============================================================')
const KEEP = process.env.TOKEN_RING_KEEP === '1'
const { home, cwd } = seedWorld()
const fixture = await startFixture(Number(process.env.TOKEN_RING_PORT ?? 25191), cwd)
const tee = join(home, 'frames.tee')
const COLS = 120
const ROWS = 40
let cap: Capture | null = null
try {
  cap = await capture(
    {
      argv: ['node', BIN],
      cwd,
      cols: COLS,
      rows: ROWS,
      sends: [
        { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
        { data: 'ring-drive: alpha\r', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'boot' },
        { data: 'ring-drive: scout\r', awaitText: ALPHA_DONE, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'alpha' },
        { data: '', awaitText: SEAT_TWO_FILE, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'scout-live' },
        { data: '/cost\r', awaitText: SCOUT_BACK, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'scout-done' },
        { data: 'ring-drive: shell\r', awaitText: 'Total cost', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'cost' },
        { data: '\x1b', awaitText: PROCEED, requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'shell-card' },
        { data: 'ring-drive: sleep\r', awaitText: SHELL_REFUSED, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'shell-refused' },
        { data: '\x1b', afterPrevTicks: 20, mark: 'sleep-running' },
        { data: '', afterPrevTicks: 40, mark: 'after-interrupt' },
      ],
      stableTicks: 6,
      total: 900,
    },
    driveEnv(home, fixture.base, tee),
    240_000,
  )
} catch (error) {
  check('the capture ran', false, String(error).slice(0, 400))
}
await fixture.close()

if (cap !== null) {
  console.log(`  routes: ${fixture.hits.map(h => h.route).join(' → ')}`)
  console.log(`  send ticks: ${cap.receipts.join(',')} · marks: ${Object.entries(cap.markTicks).map(([k, v]) => `${k}@${v}`).join(' ')} · end: ${cap.endReason}`)
  const m = cap.marks
  for (const label of ['alpha', 'scout-live', 'scout-done', 'cost', 'shell-refused', 'sleep-running', 'after-interrupt']) dump(label, m[label])

  console.log('\n— D1 the chat gauge —')
  const WINDOW = 1_000_000
  const alphaPct = `${Math.round((contextOf(USAGE.alpha) / WINDOW) * 100)}%`
  const gaugeRows = rowsWith(m['alpha'], /\b(ctx|context)\b/)
  check(
    `D1 the gauge after the alpha reply reads the reply's context (${contextOf(USAGE.alpha)} = input + cached prefix + output, thinking inside) — ${alphaPct}`,
    gaugeRows.some(r => r.includes(`ctx ${alphaPct}`) || r.includes(`context ${alphaPct}`)),
    gaugeRows.map(flat).join(' | ').slice(0, 300),
  )

  console.log('\n— D2 the live sub-agent card —')
  const seatLiveContext = contextOf(USAGE.seatTwo)
  const seatLiveSpend = contextOf(USAGE.seatOne) + contextOf(USAGE.seatTwo)
  const liveRows = rowsWith(m['scout-live'], /\d(\.\d)?k? (context|spent|tokens)\b/)
  console.log(`  live card figures: ${liveRows.map(flat).join(' | ').slice(0, 400) || '(none)'}`)
  console.log(`  the seat so far: context ${seatLiveContext} · spend ${seatLiveSpend}`)
  check(
    `D2 the live card names the seat's CONTEXT with the word — "${(seatLiveContext / 1000).toFixed(1)}k context"`,
    liveRows.some(r => r.includes(`${(seatLiveContext / 1000).toFixed(1)}k context`)),
    liveRows.map(flat).join(' | ').slice(0, 300),
  )
  const bareTokens = /(?<!↓ )\b\d[\d.]*k? tokens\b/
  check(
    'D2 no surface paints a bare "tokens" figure — a sum beside a size without the words',
    !liveRows.some(r => bareTokens.test(r)),
    liveRows.map(flat).join(' | ').slice(0, 300),
  )

  console.log('\n— D3 the settled card and the parent gauge beside it —')
  const seatContext = contextOf(USAGE.seatThree)
  const seatSpend = seatLiveSpend + contextOf(USAGE.seatThree)
  const doneRows = rowsWith(m['scout-done'], /\d(\.\d)?k? (context|spent|tokens)\b/)
  console.log(`  settled card figures: ${doneRows.map(flat).join(' | ').slice(0, 400) || '(none)'}`)
  console.log(`  the seat settled: context ${seatContext} · spend ${seatSpend}`)
  check(
    `D3 the settled card names the seat's context — "${(seatContext / 1000).toFixed(1)}k context"`,
    doneRows.some(r => r.includes(`${(seatContext / 1000).toFixed(1)}k context`)),
    doneRows.map(flat).join(' | ').slice(0, 300),
  )
  check(
    `D3 the settled card names the seat's spend beside it — "${(seatSpend / 1000).toFixed(1)}k spent"`,
    doneRows.some(r => r.includes(`${(seatSpend / 1000).toFixed(1)}k spent`)),
    doneRows.map(flat).join(' | ').slice(0, 300),
  )
  check(
    'D3 the settled card paints no bare "tokens" figure',
    !doneRows.some(r => bareTokens.test(r)),
    doneRows.map(flat).join(' | ').slice(0, 300),
  )
  const backPct = `${Math.round((contextOf(USAGE.scoutBack) / WINDOW) * 100)}%`
  const gaugeAfter = rowsWith(m['scout-done'], /\b(ctx|context)\b/)
  check(
    `D3 the parent's gauge beside it is the parent's own context (${contextOf(USAGE.scoutBack)}) — ${backPct}, never the seat's figure`,
    gaugeAfter.some(r => r.includes(`ctx ${backPct}`) || r.includes(`context ${backPct}`)),
    gaugeAfter.map(flat).join(' | ').slice(0, 300),
  )

  console.log('\n— D4 /cost —')
  const costRows = rowsWith(m['cost'], /spent|Usage by model|Total cost/)
  check('D4 the /cost rows say they are spend', costRows.some(r => r.includes('spent')), costRows.map(flat).join(' | ').slice(0, 300))

  console.log('\n— the ring —')
  const events = ringEvents(tee)
  console.log(`  OSC 9;4 events (tick:code): ${events.map(e => `${e.tick}:${e.code}`).join(' ') || '(none)'}`)
  const codes = events.map(e => e.code)
  const rings = codes.filter(c => c === 3).length
  const clears = codes.filter(c => c === 0).length
  const alternates = codes.every((c, i) => i === 0 || c !== codes[i - 1])
  check('R1 the ring alternates — one indeterminate per turn, a clear before the next', events.length > 0 && alternates && codes[0] === 3, codes.join(''))
  check(`R1 four turns ⇒ four rings and four clears (got ${rings} rings, ${clears} clears)`, rings === 4 && clears === 4, codes.join(''))
  check('R2 the last sequence is a clear — nothing rings at idle', codes.length > 0 && codes[codes.length - 1] === 0, codes.join(''))
  const idleTick = cap.markTicks['after-interrupt'] ?? Number.POSITIVE_INFINITY
  const afterIdle = events.filter(e => e.tick >= idleTick)
  check(`R2 no ring bytes after the idle mark (tick ${Number.isFinite(idleTick) ? idleTick : '?'})`, Number.isFinite(idleTick) && afterIdle.every(e => e.code === 0), afterIdle.map(e => `${e.tick}:${e.code}`).join(' '))
  const census = unansweredToolUses(home)
  console.log(`  transcript: ${census.calls} fixture tool calls, unanswered: ${census.unanswered.join(',') || 'none'}`)
  check(
    'R3 an unanswered tool_use in the records never keeps the ring on (the clear landed regardless)',
    codes.length > 0 && codes[codes.length - 1] === 0,
    `unanswered=${census.unanswered.length}`,
  )
  const idleRows = rowsWith(m['after-interrupt'], / · ready/)
  check("R3 the face is at rest after the interrupt (the status row's own word)", idleRows.length > 0, rowsWith(m['after-interrupt'], /⇧← back/).map(flat).join(' | ').slice(0, 200))
}

if (!KEEP) {
  for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${home} cwd=${cwd}`)
}
console.log(failures === 0 ? '\n✅ token-ring drive GREEN' : `\n❌ token-ring drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
