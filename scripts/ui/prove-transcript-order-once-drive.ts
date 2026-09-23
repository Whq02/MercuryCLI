#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'
import { resolveExecutionProfile } from '../lib/executionProfile.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
const RUNS = Math.max(1, Number(argAfter('--runs') ?? '1') || 1)
const KEEP = process.env.ORDER_ONCE_KEEP === '1'
const VENDORED_NODE = join(dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : (Bun.which('node') ?? 'node')
const TEE_ROWS = join(ROOT, 'scripts', 'ui', 'tee-rows.py')

type Size = { cols: number; rows: number }
const SIZES: Size[] = (argAfter('--sizes') ?? '120x40,100x30').split(',').map(s => {
  const [c, r] = s.split('x')
  return { cols: Number(c), rows: Number(r) }
})

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks += 1
  if (!cond) failures += 1
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

const driver = resolveCaptureDriver()
const hosted = resolveExecutionProfile(ROOT).kind === 'hosted-gate'
function refuse(reason: string): never {
  if (hosted) {
    console.error(`  [FAIL] the hosted gate cannot capture — ${reason}`)
    process.exit(1)
  }
  console.log(`__SUITE_SKIPPED transcript-order-once: ${reason}`)
  process.exit(0)
}
if (driver.kind === 'unavailable') refuse(`${driver.reason} (${driver.remedy})`)
if (driver.kind !== 'posix-pty') refuse(`the ${driver.kind} capture driver is not driven by this suite`)
const preflight = preflightCaptureDriver(driver, ROOT)
if (!preflight.ok) refuse(describeCapturePreflight(preflight))
if (!existsSync(DIST)) {
  console.error(`${DIST} missing — build first`)
  process.exit(1)
}

const SCRATCH = join(realpathSync(tmpdir()), `order-once-${process.pid}`)
mkdirSync(SCRATCH, { recursive: true })

const SEAT_MARK = 'order-once-seat:'
const DONE = 'order-once: the turn is done'
const NOTED = 'order-once: noted'

type Block = { type?: string; id?: string; name?: string; text?: string; tool_use_id?: string; content?: unknown; input?: Record<string, unknown> }
type Item = { role?: string; content?: unknown }
type Answer =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; pre?: { deltas: string[]; gapMs: number }; tools: Array<{ name: string; input: Record<string, unknown> }> }
  | { kind: 'paced'; deltas: string[]; gapMs: number }
type Facts = { ask: string; step: number; seat: boolean; notice: boolean; results: string[]; toolNames: string[]; opening: string }
type Hit = { n: number; at: number; facts: Facts; answer: string }
type Journey = {
  name: string
  ask: string
  parent: (facts: Facts) => Answer
  seat?: (facts: Facts) => Answer
  total: number
  resizeAtTick?: number
}

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [])
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return blocksOf(content)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
}
const unreminded = (t: string): string => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
function factsOf(body: unknown, journey: Journey): Facts {
  const b = body as { messages?: unknown; tools?: unknown[] }
  const items: Item[] = Array.isArray(b?.messages) ? (b.messages as Item[]) : []
  const toolNames = Array.isArray(b?.tools) ? b.tools.map(t => String((t as { name?: string })?.name ?? '')) : []
  const userTexts: string[] = []
  for (const item of items) if (item.role === 'user') userTexts.push(unreminded(textOf(item.content)))
  const seat = !toolNames.includes('Agent') && userTexts.some(t => t.includes(SEAT_MARK))
  let askAt = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'user') continue
    const t = unreminded(textOf(item.content))
    if (t === '') continue
    if (seat ? t.includes(SEAT_MARK) : t.includes(journey.ask)) {
      askAt = i
      break
    }
  }
  let step = 0
  const results: string[] = []
  for (let i = askAt + 1; i < items.length; i++) {
    const item = items[i]!
    if (item.role !== 'user') continue
    const rs = blocksOf(item.content).filter(x => x.type === 'tool_result')
    if (rs.length > 0) {
      step += 1
      for (const r of rs) results.push(textOf(r.content))
    }
  }
  const last = items[items.length - 1]
  const lastText = last?.role === 'user' ? unreminded(textOf(last.content)) : ''
  const lastHasResult = last?.role === 'user' && blocksOf(last.content).some(x => x.type === 'tool_result')
  const notice = !lastHasResult && (lastText.includes('task-notification') || lastText.includes('<task-id>') || lastText.includes('task-id'))
  const opening = userTexts.find(t => t !== '') ?? ''
  return { ask: seat ? SEAT_MARK : journey.ask, step, seat, notice, results, toolNames, opening: opening.slice(0, 120) }
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
function head(res: ServerResponse, n: number, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_oo_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }))
}
function foot(stop: 'end_turn' | 'tool_use'): string {
  return sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }) + sse('message_stop', { type: 'message_stop' })
}
function textBlock(index: number, text: string): string {
  return sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }) + sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }) + sse('content_block_stop', { type: 'content_block_stop', index })
}
function toolBlock(index: number, id: string, name: string, input: Record<string, unknown>): string {
  return sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }) + sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) + sse('content_block_stop', { type: 'content_block_stop', index })
}
function paceDeltas(res: ServerResponse, index: number, deltas: string[], gapMs: number, then: () => void): void {
  res.write(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
  let i = 0
  const step = (): void => {
    if (res.destroyed || res.writableEnded) return
    if (i < deltas.length) {
      res.write(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: deltas[i]! } }))
      i += 1
      setTimeout(step, gapMs)
      return
    }
    res.write(sse('content_block_stop', { type: 'content_block_stop', index }))
    then()
  }
  setTimeout(step, gapMs)
}
function answerWith(res: ServerResponse, n: number, model: string, answer: Answer): void {
  head(res, n, model)
  if (answer.kind === 'text') {
    res.end(textBlock(0, answer.text) + foot('end_turn'))
    return
  }
  if (answer.kind === 'paced') {
    paceDeltas(res, 0, answer.deltas, answer.gapMs, () => res.end(foot('end_turn')))
    return
  }
  const tools = (from: number): string => answer.tools.map((t, i) => toolBlock(from + i, `toolu_oo_${n}_${i}`, t.name, t.input)).join('')
  if (answer.pre === undefined) {
    res.end(tools(0) + foot('tool_use'))
    return
  }
  paceDeltas(res, 0, answer.pre.deltas, answer.pre.gapMs, () => res.end(tools(1) + foot('tool_use')))
}

type Fixture = { url: string; hits: Hit[]; close: () => Promise<void> }
async function startFixture(journey: Journey): Promise<Fixture> {
  const hits: Hit[] = []
  const open = new Set<ServerResponse>()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
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
      const facts = factsOf(body, journey)
      const n = hits.length + 1
      let answer: Answer
      if (facts.toolNames.length === 0) answer = { kind: 'text', text: 'ok' }
      else if (facts.seat) answer = journey.seat ? journey.seat(facts) : { kind: 'text', text: `${SEAT_MARK} done` }
      else if (facts.notice) answer = { kind: 'text', text: NOTED }
      else answer = journey.parent(facts)
      hits.push({ n, at: Date.now(), facts, answer: answer.kind === 'text' ? answer.text.slice(0, 40) : answer.kind === 'paced' ? 'paced' : answer.tools.map(t => t.name).join('+') })
      open.add(res)
      res.on('close', () => open.delete(res))
      answerWith(res, n, model, answer)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>(resolve => {
        for (const res of open) res.destroy()
        server.close(() => resolve())
      }),
  }
}

const bash = (command: string, description: string, background = false): { name: string; input: Record<string, unknown> } => ({
  name: 'Bash',
  input: { command, description, ...(background ? { run_in_background: true } : {}) },
})
const words = (text: string): string[] => text.split(' ').map((w, i, all) => (i < all.length - 1 ? `${w} ` : w))

const JOURNEYS: Journey[] = [
  {
    name: 'three-tools-bg-agent',
    ask: 'order-once: run the three tools',
    total: 260,
    parent: f => {
      if (f.step === 0) return { kind: 'tools', tools: [bash('sleep 2; echo bg-finished', 'the background command', true), { name: 'Agent', input: { description: 'the order-once seat', prompt: `${SEAT_MARK} greet main and finish`, run_in_background: true } }] }
      if (f.step === 1) return { kind: 'tools', pre: { deltas: words('The first tool of three runs now while the background work settles behind it.'), gapMs: 250 }, tools: [bash('echo tool-one', 'the first tool')] }
      if (f.step === 2) return { kind: 'tools', tools: [bash('sleep 1; echo tool-two', 'the second tool')] }
      if (f.step === 3) return { kind: 'tools', tools: [bash('sleep 1; echo tool-three', 'the third tool')] }
      return { kind: 'text', text: DONE }
    },
    seat: f => {
      if (f.step === 0) return { kind: 'tools', tools: [{ name: 'SendMessage', input: { to: 'main', summary: 'the seat greets main', message: `${SEAT_MARK} hello from the seat` } }] }
      return { kind: 'text', text: `${SEAT_MARK} done` }
    },
  },
  {
    name: 'monitor-mid-turn',
    ask: 'order-once: watch the events',
    total: 260,
    parent: f => {
      if (f.step === 0) return { kind: 'tools', tools: [{ name: 'Monitor', input: { description: 'the order-once watch', command: 'for i in 1 2 3; do sleep 1; echo event-$i; done' } }] }
      if (f.step === 1) return { kind: 'tools', pre: { deltas: words('Watching the events land one by one while this sentence is still being written out slowly.'), gapMs: 300 }, tools: [bash('sleep 2; echo after-watch', 'the tool after the watch')] }
      return { kind: 'text', text: DONE }
    },
  },
  {
    name: 'bg-task-while-streaming',
    ask: 'order-once: stream while the task finishes',
    total: 240,
    parent: f => {
      if (f.step === 0) return { kind: 'tools', tools: [bash('sleep 2; echo bg-finished', 'the background command', true)] }
      return { kind: 'paced', deltas: [...words('This reply streams slowly enough that the background command finishes while it is still being written, and then it ends. '), DONE], gapMs: 300 }
    },
  },
  {
    name: 'resize-during-turn',
    ask: 'order-once: resize during the turn',
    total: 240,
    resizeAtTick: 12,
    parent: f => {
      if (f.step === 0) return { kind: 'tools', pre: { deltas: words('The first half of the turn streams before the window changes its size.'), gapMs: 350 }, tools: [bash('sleep 2; echo one', 'the tool between the halves')] }
      return { kind: 'paced', deltas: [...words('The second half of the turn streams after the window changed its size and then it ends. '), DONE], gapMs: 350 }
    },
  },
  {
    name: 'long-turn-many-cards',
    ask: 'order-once: run the long turn',
    total: 300,
    parent: f => {
      if (f.step < 8) return { kind: 'tools', tools: [bash(`echo card-${f.step + 1}`, `the card ${f.step + 1} of eight`)] }
      return { kind: 'text', text: DONE }
    },
  },
]

type Leg = { journey: Journey; size: Size; run: number; home: string; cwd: string; tee: string; cfg: string; grid: string; log: string }
function seedLeg(journey: Journey, size: Size, run: number): Leg {
  const tag = `${journey.name}-${size.cols}x${size.rows}-r${run}`
  const home = join(SCRATCH, `home-${tag}`)
  const cwd = join(SCRATCH, `cwd-${tag}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# the order-once fixture\n')
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipSovereignConsentPrompt: true, spinnerTipsEnabled: false }))
  return { journey, size, run, home, cwd, tee: join(SCRATCH, `${tag}.tee`), cfg: join(SCRATCH, `${tag}-cfg.json`), grid: join(SCRATCH, `${tag}-grid.json`), log: join(SCRATCH, `${tag}-engine.log`) }
}
function childEnv(leg: Leg, fixtureUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: leg.home,
    MERCURY_DAEMON_DIR: join(leg.home, 'daemon'),
    MERCURY_TEAMS_DIR: join(leg.home, 'teams'),
    MERCURY_TABULA_DIR: join(leg.home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_UPDATE_NOTICE: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_DESKTOP_DRIVER: 'none',
    MERCURY_OASIS_BG: '0',
    MERCURY_CONNECTOR_TRACE: join(leg.home, 'connector-trace.jsonl'),
    ANTHROPIC_BASE_URL: fixtureUrl,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    BROWSER: '/usr/bin/true',
    VSHOT_TEE: leg.tee,
  }
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_REDUCED_MOTION', 'NODE_ENV', 'CI']) delete env[key]
  return env
}

const FACE_READY = '↑↓ choose'
const LANDED = '← back'
type Payload = { endReason?: string; readyAt?: number | null; sendReceipts?: Array<{ atTick: number }>; stages?: Array<{ untilTick: number; cols: number; rows: number }>; marks?: Array<{ label: string; atTick: number }> }
async function capture(leg: Leg, fixtureUrl: string): Promise<{ status: number | null; payload: Payload | null; output: string }> {
  const other = SIZES.find(s => s.cols !== leg.size.cols || s.rows !== leg.size.rows) ?? { cols: 100, rows: 30 }
  const sends: unknown[] = [
    { atTick: 60, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
    { atTick: 999, awaitText: LANDED, minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, requireAwait: true, data: leg.journey.ask, mark: 'typed' },
    { afterPrevTicks: 2, data: '\r', mark: 'sent' },
  ]
  const resizes = leg.journey.resizeAtTick === undefined ? [] : [{ afterMark: 'sent', afterMs: leg.journey.resizeAtTick * 200, cols: other.cols, rows: other.rows }]
  const cfg = {
    argv: [NODE, DIST, '--dangerously-bypass-permissions'],
    cwd: leg.cwd,
    cols: leg.size.cols,
    rows: leg.size.rows,
    sends,
    resizes,
    total: leg.journey.total,
    out: leg.grid,
    readyText: [DONE],
    stableTicks: 8,
  }
  writeFileSync(leg.cfg, JSON.stringify(cfg))
  rmSync(leg.tee, { force: true })
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), leg.cfg], { cwd: leg.cwd, env: childEnv(leg, fixtureUrl), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', c => { output += String(c) })
  child.stderr.on('data', c => { output += String(c) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(leg.journey.total * 200 + 60_000))
    child.once('error', error => { output += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  writeFileSync(leg.log, output)
  const payload = existsSync(leg.grid) ? (JSON.parse(readFileSync(leg.grid, 'utf8')) as Payload) : null
  return { status, payload, output }
}

export type Frame = { i: number; tick: number; cols: number; rows: number; lines: string[] }
async function replay(leg: Leg, payload: Payload | null): Promise<Frame[]> {
  const resizes = (payload?.stages ?? []).map((s, k, all) => {
    const next = all[k + 1]
    return `${s.untilTick}:${next ? next.cols : leg.size.cols}:${next ? next.rows : leg.size.rows}`
  })
  if (payload?.stages && payload.stages.length > 0) {
    const last = payload.stages[payload.stages.length - 1]!
    const final = JSON.parse(readFileSync(leg.grid, 'utf8')) as { cols: number; rows: number }
    resizes[resizes.length - 1] = `${last.untilTick}:${final.cols}:${final.rows}`
  }
  const proc = spawn(driver.python, [TEE_ROWS, leg.tee, String(leg.size.cols), String(leg.size.rows), ...resizes], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  proc.stdout.on('data', c => { out += String(c) })
  proc.stderr.on('data', c => { err += String(c) })
  const code = await new Promise<number | null>(resolve => proc.once('close', resolve))
  if (code !== 0) throw new Error(`tee-rows failed (${code}): ${err.slice(0, 400)}`)
  return out.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Frame)
}

export type Event = { kind: 'REORDER' | 'REPEAT' | 'POP'; tick: number; frame: number; row: string; detail: string }
export type Ledger = { reorder: number; repeat: number; pop: number; events: Event[]; frames: number }

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()
const SUBSTANTIVE = /[A-Za-z0-9]{3,}/
const substantive = (text: string): boolean => text.length >= 8 && SUBSTANTIVE.test(text)

export function paneRows(lines: string[]): string[] {
  let prompt = -1
  for (let y = lines.length - 1; y >= 0; y--) {
    if (/^│?❯/.test(lines[y]!.replace(/^[^│❯]*/, ''))) {
      prompt = y
      break
    }
  }
  if (prompt === -1) return []
  let top = prompt
  while (top > 0 && !/^\s*╭/.test(lines[top]!)) top -= 1
  const above = lines.slice(0, top)
  const bottom = above.findLastIndex(l => /╰─+╯\s*$/.test(l))
  if (bottom === -1) return []
  const right = above[bottom]!.lastIndexOf('╯')
  const left = above[bottom]!.indexOf('╰')
  const topBorder = above.findIndex(l => /╭─+╮\s*$/.test(l) && l.indexOf('╭') === left)
  if (topBorder === -1) return []
  const inner = above.slice(topBorder + 1, bottom).map(l => l.slice(left + 1, right).replace(/│\s*$/, ''))
  const headerEnd = inner.findIndex(l => /^\s*╰─+╯\s*$/.test(l))
  return (headerEnd === -1 ? inner : inner.slice(headerEnd + 1)).map(collapse)
}

const GUTTER = /^│\s*/
const DRESS = /^(\d\d:\d\d:\d\d\s+|queued\s+|\[[^\]]+\]\s*|[◐◑◒◓●⏺✶✷✸✹✺✻]\s*)+/
const HEAD = /^(❯|▰|▶|■|◆|✶|Ran \d|Read \d|Searched)/
function normalizeRow(row: string): { text: string; starts: boolean } {
  const bare = row.replace(/▍/g, '').replace(GUTTER, '')
  const undressed = bare.replace(DRESS, '').replace(/^\[?Mercury\]\s*/, '')
  const starts = undressed !== bare || HEAD.test(undressed)
  return { text: collapse(undressed), starts }
}

export type Run = { text: string; y: number; rows: number }
export function runsOf(rows: string[]): Run[] {
  const out: Run[] = []
  let current: Run | null = null
  rows.forEach((row, y) => {
    if (row === '') {
      current = null
      return
    }
    const { text, starts } = normalizeRow(row)
    if (text === '') return
    if (current !== null && !starts) {
      current.text = `${current.text} ${text}`
      current.rows += 1
      return
    }
    current = { text, y, rows: 1 }
    out.push(current)
  })
  return out.filter(b => substantive(b.text))
}

export function continues(earlier: string, later: string): boolean {
  if (later.startsWith(earlier)) return true
  if (earlier.startsWith(later) && later.length >= Math.max(8, earlier.length * 0.6)) return true
  const trimmed = earlier.replace(/\s\S*$/, '')
  return trimmed.length >= 8 && trimmed !== earlier && later.startsWith(trimmed)
}

const POP_TICKS = 5
export function classify(frames: Frame[], sendTicks: number[], resizeTicks: number[]): Ledger {
  const events: Event[] = []
  const quiet = (tick: number): boolean => !sendTicks.some(s => tick >= s - 1 && tick <= s + POP_TICKS) && !resizeTicks.some(r => Math.abs(tick - r) <= 2)
  const shots = frames.map(f => ({ f, blocks: runsOf(paneRows(f.lines)) }))
  const pairSign = new Map<string, number>()
  const born = new Map<string, { tick: number; frame: number }>()
  const repeatSeen = new Map<string, { tick: number; frame: number; count: number }>()
  for (let k = 1; k < shots.length; k++) {
    const prev = shots[k - 1]!
    const cur = shots[k]!
    if (cur.f.cols !== prev.f.cols || cur.f.rows !== prev.f.rows) {
      pairSign.clear()
      born.clear()
      repeatSeen.clear()
      continue
    }
    const counts = new Map<string, number>()
    for (const b of cur.blocks) counts.set(b.text, (counts.get(b.text) ?? 0) + 1)
    const prevCounts = new Map<string, number>()
    for (const b of prev.blocks) prevCounts.set(b.text, (prevCounts.get(b.text) ?? 0) + 1)
    const fresh = (c: Run): boolean => !prev.blocks.some(p => p.text === c.text && Math.abs(p.y - c.y) <= 3)
    const rewritten = cur.blocks.some(c => prev.blocks.some(p => p.y === c.y && p.text !== c.text && !continues(p.text, c.text) && !continues(c.text, p.text)))
    const unique = cur.blocks.filter(b => counts.get(b.text) === 1)
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const a = unique[i]!.text
        const b = unique[j]!.text
        const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
        const sign = a < b ? 1 : -1
        const seen = pairSign.get(key)
        if (seen !== undefined && seen !== sign && quiet(cur.f.tick)) {
          const moved = unique[j]!
          events.push({ kind: 'REORDER', tick: cur.f.tick, frame: cur.f.i, row: moved.text, detail: `now below ${JSON.stringify(unique[i]!.text.slice(0, 60))}, where it stood above it before` })
        }
        pairSign.set(key, sign)
      }
    }
    for (const key of pairSign.keys()) {
      const [a, b] = key.split('\u0000')
      if (!counts.has(a!) || !counts.has(b!)) pairSign.delete(key)
    }
    for (const [text, n] of counts) {
      if (n >= 2 && (prevCounts.get(text) ?? 0) < n && !repeatSeen.has(text)) repeatSeen.set(text, { tick: cur.f.tick, frame: cur.f.i, count: n })
    }
    for (const [text, seen] of repeatSeen) {
      const n = counts.get(text) ?? 0
      if (n < seen.count) {
        const copies = prev.blocks.filter(b => b.text === text)
        const gone = copies[copies.length - 1]
        const merged = gone !== undefined && cur.blocks.some(c => fresh(c) && c.y >= gone.y - 3 && c.y <= gone.y + gone.rows)
        if (!merged && cur.f.tick - seen.tick <= POP_TICKS && quiet(cur.f.tick)) events.push({ kind: 'REPEAT', tick: seen.tick, frame: seen.frame, row: text, detail: `painted ${seen.count}× at tick ${seen.tick}, ${n}× by tick ${cur.f.tick}` })
        repeatSeen.delete(text)
      }
    }
    for (const b of cur.blocks) if (!prevCounts.has(b.text) && !born.has(b.text)) born.set(b.text, { tick: cur.f.tick, frame: cur.f.i })
    for (const [text, b] of born) {
      if (counts.has(text)) continue
      born.delete(text)
      if (cur.f.tick - b.tick > POP_TICKS || !quiet(cur.f.tick)) continue
      if ((prevCounts.get(text) ?? 0) !== 1) continue
      const at = prev.blocks.findIndex(p => p.text === text)
      const gone = prev.blocks[at]!
      if (gone.y <= 1) continue
      if (cur.blocks.some(c => continues(text, c.text))) continue
      const replaced = rewritten || cur.blocks.some(c => fresh(c) && c.y >= gone.y - 3 && c.y <= gone.y + gone.rows)
      if (replaced) continue
      events.push({ kind: 'POP', tick: b.tick, frame: b.frame, row: text, detail: `appeared at tick ${b.tick}, gone by tick ${cur.f.tick}` })
    }
  }
  return { reorder: events.filter(e => e.kind === 'REORDER').length, repeat: events.filter(e => e.kind === 'REPEAT').length, pop: events.filter(e => e.kind === 'POP').length, events, frames: shots.length }
}

function saveArtifacts(leg: Leg, frames: Frame[], ledger: Ledger, hits: Hit[]): void {
  if (FRAMES === undefined) return
  const dir = join(FRAMES, `${leg.journey.name}-${leg.size.cols}x${leg.size.rows}-r${leg.run}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ reorder: ledger.reorder, repeat: ledger.repeat, pop: ledger.pop, frames: ledger.frames, events: ledger.events }, null, 2))
  writeFileSync(join(dir, 'wire.json'), JSON.stringify(hits, null, 2))
  const shown = new Set<number>()
  const lines: string[] = []
  for (const e of ledger.events) {
    const at = frames.findIndex(f => f.i === e.frame)
    for (const k of [at - 1, at, at + 1]) {
      const f = frames[k]
      if (f === undefined || shown.has(f.i)) continue
      shown.add(f.i)
      lines.push(`── frame ${f.i} · tick ${f.tick} · ${f.cols}x${f.rows}${k === at ? ` · ${e.kind}: ${e.row}` : ''} ──`)
      for (const row of f.lines) lines.push(`│${row}`)
      lines.push('')
    }
  }
  writeFileSync(join(dir, 'moved-rows.txt'), lines.join('\n'))
  const all: string[] = []
  for (const f of frames) {
    all.push(`── frame ${f.i} · tick ${f.tick} · ${f.cols}x${f.rows} ──`)
    for (const row of f.lines) all.push(`│${row}`)
  }
  writeFileSync(join(dir, 'frames.txt'), all.join('\n'))
  for (const [name, from] of [['capture.tee', leg.tee], ['grid.json', leg.grid], ['connector-trace.jsonl', join(leg.home, 'connector-trace.jsonl')]] as const) {
    try {
      writeFileSync(join(dir, name), readFileSync(from))
    } catch {
    }
  }
  const shownBlocks: string[] = []
  for (const f of frames) {
    shownBlocks.push(`── frame ${f.i} · tick ${f.tick} · ${f.cols}x${f.rows} ──`)
    for (const b of runsOf(paneRows(f.lines))) shownBlocks.push(`  y${b.y} ${b.text}`)
  }
  writeFileSync(join(dir, 'blocks.txt'), shownBlocks.join('\n'))
}

const classifyDir = argAfter('--classify')
if (classifyDir !== undefined) {
  const size = SIZES[0]!
  const payload = existsSync(join(classifyDir, 'grid.json')) ? (JSON.parse(readFileSync(join(classifyDir, 'grid.json'), 'utf8')) as Payload) : null
  const leg = { tee: join(classifyDir, 'capture.tee'), grid: join(classifyDir, 'grid.json'), size } as Leg
  const frames = await replay(leg, payload)
  const ledger = classify(frames, payload?.sendReceipts?.map(r => r.atTick) ?? [], payload?.stages?.map(s => s.untilTick) ?? [])
  console.log(`ledger: ${ledger.frames} frames · REORDER ${ledger.reorder} · REPEAT ${ledger.repeat} · POP ${ledger.pop}`)
  for (const e of ledger.events) console.log(`  ${e.kind} @tick ${e.tick} (frame ${e.frame}): ${JSON.stringify(e.row)} — ${e.detail}`)
  if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(0)
}

const wanted = (argAfter('--journeys') ?? JOURNEYS.map(j => j.name).join(',')).split(',')
console.log(`transcript order-once · dist ${DIST} · node ${NODE} · scratch ${SCRATCH}`)
const table: string[] = []
for (let run = 1; run <= RUNS; run++) {
  for (const journey of JOURNEYS) {
    if (!wanted.includes(journey.name)) continue
    for (const size of SIZES) {
      const tag = `${journey.name} ${size.cols}x${size.rows} run ${run}`
      console.log(`\n— ${tag} —`)
      const startedAt = Date.now()
      const fixture = await startFixture(journey)
      const leg = seedLeg(journey, size, run)
      let cap: Awaited<ReturnType<typeof capture>>
      try {
        cap = await capture(leg, fixture.url)
      } finally {
        await fixture.close()
      }
      const receipts = cap.payload?.sendReceipts?.map(r => r.atTick) ?? []
      const resizeTicks = cap.payload?.stages?.map(s => s.untilTick) ?? []
      console.log(`  wire: ${fixture.hits.map(h => `${h.n}:${h.facts.seat ? 'seat' : h.facts.notice ? 'notice' : `s${h.facts.step}`}→${h.answer}`).join(' · ')}`)
      check(`${tag}: the journey happened (engine exit 0, every send due, the turn ended on its last words)`, cap.status === 0 && receipts.length === 3 && cap.payload?.endReason === 'stable' && typeof cap.payload?.readyAt === 'number', `exit=${cap.status} sends=${receipts.length}/3 end=${cap.payload?.endReason} ready=${cap.payload?.readyAt} · ${leg.log}`)
      let ledger: Ledger = { reorder: 0, repeat: 0, pop: 0, events: [], frames: 0 }
      let frames: Frame[] = []
      try {
        frames = await replay(leg, cap.payload)
        ledger = classify(frames, receipts, resizeTicks)
      } catch (error) {
        check(`${tag}: the tee replayed`, false, error instanceof Error ? error.message : String(error))
      }
      console.log(`  ledger: ${ledger.frames} frames · REORDER ${ledger.reorder} · REPEAT ${ledger.repeat} · POP ${ledger.pop}`)
      for (const e of ledger.events) console.log(`    ${e.kind} @tick ${e.tick} (frame ${e.frame}): ${JSON.stringify(e.row)} — ${e.detail}`)
      table.push(`${journey.name}\t${size.cols}x${size.rows}\tr${run}\tREORDER ${ledger.reorder}\tREPEAT ${ledger.repeat}\tPOP ${ledger.pop}\tframes ${ledger.frames}\t${Math.round((Date.now() - startedAt) / 1000)}s`)
      check(`${tag}: no row moved against its neighbours after it painted (REORDER 0)`, ledger.reorder === 0, `${ledger.reorder}`)
      check(`${tag}: no row painted twice at once and then lost a copy (REPEAT 0)`, ledger.repeat === 0, `${ledger.repeat}`)
      check(`${tag}: no row appeared and vanished within a second without the operator's act (POP 0)`, ledger.pop === 0, `${ledger.pop}`)
      saveArtifacts(leg, frames, ledger, fixture.hits)
    }
  }
}

console.log('\nledger')
for (const row of table) console.log(`  ${row}`)
if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`\n[keep] ${SCRATCH}`)
console.log(`\nprove-transcript-order-once-drive: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
