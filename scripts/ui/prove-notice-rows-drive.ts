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
const KEEP = process.env.NOTICE_ROWS_KEEP === '1'
const VENDORED_NODE = join(dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : (Bun.which('node') ?? 'node')
const TEE_ROWS = join(ROOT, 'scripts', 'ui', 'tee-rows.py')

type Size = { cols: number; rows: number }
const SIZE: Size = ((): Size => {
  const [c, r] = (argAfter('--size') ?? '120x40').split('x')
  return { cols: Number(c), rows: Number(r) }
})()

let failures = 0
let checks = 0
const verdicts: Array<{ label: string; ok: boolean; detail: string }> = []
function check(label: string, cond: boolean, detail = ''): void {
  checks += 1
  if (!cond) failures += 1
  verdicts.push({ label, ok: cond, detail })
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

const driver = resolveCaptureDriver()
const hosted = resolveExecutionProfile(ROOT).kind === 'hosted-gate'
function refuse(reason: string): never {
  if (hosted) {
    console.error(`  [FAIL] the hosted gate cannot capture — ${reason}`)
    process.exit(1)
  }
  console.log(`__SUITE_SKIPPED notice-rows: ${reason}`)
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

const SCRATCH = join(realpathSync(tmpdir()), `notice-rows-${process.pid}`)
mkdirSync(SCRATCH, { recursive: true })

const DONE = 'notice-rows: the turn is done'
const NOTED = 'notice-rows: noted'
const WATCH_MID = 'the notice-rows watch'
const WATCH_LATE = 'the late watch'
const WATCH_OWNER = 'the owner watch'
const CARRIED = 'carried to the owner, waiting'

type Block = { type?: string; id?: string; name?: string; text?: string; tool_use_id?: string; content?: unknown; input?: Record<string, unknown> }
type Item = { role?: string; content?: unknown }
type Answer =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; pre?: { deltas: string[]; gapMs: number }; tools: Array<{ name: string; input: Record<string, unknown> }> }
type Facts = { step: number; notice: boolean; toolNames: string[] }
type Hit = { n: number; at: number; facts: Facts; answer: string }
type Journey = {
  name: string
  ask: string
  ready: string[]
  total: number
  parent: (facts: Facts) => Answer
  onNotice: (facts: Facts) => Answer
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
  let askAt = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'user') continue
    if (unreminded(textOf(item.content)).includes(journey.ask)) {
      askAt = i
      break
    }
  }
  let step = 0
  for (let i = askAt + 1; i < items.length; i++) {
    const item = items[i]!
    if (item.role === 'user' && blocksOf(item.content).some(x => x.type === 'tool_result')) step += 1
  }
  const last = items[items.length - 1]
  const lastText = last?.role === 'user' ? unreminded(textOf(last.content)) : ''
  const lastHasResult = last?.role === 'user' && blocksOf(last.content).some(x => x.type === 'tool_result')
  const notice = !lastHasResult && (lastText.includes('<monitor ') || lastText.includes('task-notification') || lastText.includes('<task-id>'))
  return { step, notice, toolNames }
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
function head(res: ServerResponse, n: number, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_nr_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }))
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
  const tools = (from: number): string => answer.tools.map((t, i) => toolBlock(from + i, `toolu_nr_${n}_${i}`, t.name, t.input)).join('')
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
      else if (facts.notice) answer = journey.onNotice(facts)
      else answer = journey.parent(facts)
      hits.push({ n, at: Date.now(), facts, answer: answer.kind === 'text' ? answer.text.slice(0, 40) : answer.tools.map(t => t.name).join('+') })
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

const bash = (command: string, description: string): { name: string; input: Record<string, unknown> } => ({ name: 'Bash', input: { command, description } })
const monitor = (description: string, command: string): { name: string; input: Record<string, unknown> } => ({ name: 'Monitor', input: { description, command } })
const words = (text: string): string[] => text.split(' ').map((w, i, all) => (i < all.length - 1 ? `${w} ` : w))

const JOURNEYS: Journey[] = [
  {
    name: 'monitor-mid-turn-rows',
    ask: 'notice-rows: watch the events',
    ready: [DONE],
    total: 220,
    parent: f => {
      if (f.step === 0) return { kind: 'tools', tools: [monitor(WATCH_MID, 'for i in 1 2 3; do sleep 1; echo event-$i; done')] }
      if (f.step === 1) return { kind: 'tools', pre: { deltas: words('Watching the events land while this line is written out slowly.'), gapMs: 300 }, tools: [bash('sleep 2; echo after-watch', 'the tool after the watch')] }
      return { kind: 'text', text: DONE }
    },
    onNotice: f => (f.step >= 2 ? { kind: 'text', text: DONE } : { kind: 'text', text: NOTED }),
  },
  {
    name: 'notice-between-turns',
    ask: 'notice-rows: arm the late watch',
    ready: [NOTED],
    total: 220,
    parent: f => {
      if (f.step === 0) return { kind: 'tools', tools: [monitor(WATCH_LATE, 'sleep 3; echo late-event')] }
      return { kind: 'text', text: DONE }
    },
    onNotice: () => ({ kind: 'text', text: NOTED }),
  },
  {
    name: 'text-between-tools',
    ask: 'notice-rows: carry the word',
    ready: [DONE],
    total: 240,
    parent: f => {
      if (f.step === 0) return { kind: 'tools', tools: [monitor(WATCH_OWNER, 'sleep 2; echo owner-event')] }
      if (f.step === 1) return { kind: 'tools', pre: { deltas: words(`${CARRIED} for the ruling on the plate words before the next step`), gapMs: 300 }, tools: [bash('sleep 3; echo one', 'the first tool after the words')] }
      if (f.step === 2) return { kind: 'tools', tools: [bash('echo two', 'the second tool after the words')] }
      return { kind: 'text', text: DONE }
    },
    onNotice: f => (f.step >= 3 ? { kind: 'text', text: DONE } : { kind: 'text', text: NOTED }),
  },
]

type Leg = { journey: Journey; size: Size; home: string; cwd: string; tee: string; cfg: string; grid: string; log: string }
function seedLeg(journey: Journey, size: Size): Leg {
  const tag = `${journey.name}-${size.cols}x${size.rows}`
  const home = join(SCRATCH, `home-${tag}`)
  const cwd = join(SCRATCH, `cwd-${tag}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# the notice-rows fixture\n')
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipSovereignConsentPrompt: true, spinnerTipsEnabled: false }))
  return { journey, size, home, cwd, tee: join(SCRATCH, `${tag}.tee`), cfg: join(SCRATCH, `${tag}-cfg.json`), grid: join(SCRATCH, `${tag}-grid.json`), log: join(SCRATCH, `${tag}-engine.log`) }
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
    MERCURY_DECK_COMPANION: '0',
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
type Payload = { endReason?: string; readyAt?: number | null; sendReceipts?: Array<{ atTick: number }>; stages?: Array<{ untilTick: number; cols: number; rows: number }> }
async function capture(leg: Leg, fixtureUrl: string): Promise<{ status: number | null; payload: Payload | null; output: string }> {
  const sends: unknown[] = [
    { atTick: 60, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
    { atTick: 999, awaitText: LANDED, minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, requireAwait: true, data: leg.journey.ask, mark: 'typed' },
    { afterPrevTicks: 2, data: '\r', mark: 'sent' },
  ]
  const cfg = {
    argv: [NODE, DIST, '--dangerously-bypass-permissions'],
    cwd: leg.cwd,
    cols: leg.size.cols,
    rows: leg.size.rows,
    sends,
    total: leg.journey.total,
    out: leg.grid,
    readyText: leg.journey.ready,
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

type Frame = { i: number; tick: number; cols: number; rows: number; lines: string[] }
async function replay(leg: Leg): Promise<Frame[]> {
  const proc = spawn(driver.python, [TEE_ROWS, leg.tee, String(leg.size.cols), String(leg.size.rows)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  proc.stdout.on('data', c => { out += String(c) })
  proc.stderr.on('data', c => { err += String(c) })
  const code = await new Promise<number | null>(resolve => proc.once('close', resolve))
  if (code !== 0) throw new Error(`tee-rows failed (${code}): ${err.slice(0, 400)}`)
  return out.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Frame)
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()
function paneRows(lines: string[]): string[] {
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
function runsOf(rows: string[]): string[] {
  const out: string[] = []
  let open = false
  for (const row of rows) {
    if (row === '') {
      open = false
      continue
    }
    const bare = row.replace(/▍/g, '').replace(GUTTER, '')
    const undressed = bare.replace(DRESS, '').replace(/^\[?Mercury\]\s*/, '')
    const starts = undressed !== bare || HEAD.test(undressed)
    const text = collapse(undressed)
    if (text === '') continue
    if (open && !starts) {
      out[out.length - 1] = `${out[out.length - 1]} ${text}`
      continue
    }
    out.push(text)
    open = true
  }
  return out
}
const runsIn = (f: Frame): string[] => runsOf(paneRows(f.lines))
const rawWrapperFrames = (frames: Frame[]): Frame[] => frames.filter(f => f.lines.some(l => l.includes('<monitor task=') || l.includes('</monitor>')))
const rowFrames = (frames: Frame[], pred: (row: string) => boolean): Frame[] => frames.filter(f => paneRows(f.lines).some(pred))
const runFrames = (frames: Frame[], pred: (run: string) => boolean): Frame[] => frames.filter(f => runsIn(f).some(pred))
const firstRunOf = (frames: Frame[], pred: (run: string) => boolean): string => {
  for (const f of frames) for (const run of runsIn(f)) if (pred(run)) return `frame ${f.i} · tick ${f.tick}: ${run}`
  return 'none'
}
const runIndex = (runs: string[], pred: (run: string) => boolean): number => runs.findIndex(pred)

function saveArtifacts(leg: Leg, frames: Frame[], hits: Hit[]): void {
  if (FRAMES === undefined) return
  const dir = join(FRAMES, `${leg.journey.name}-${leg.size.cols}x${leg.size.rows}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'checks.json'), JSON.stringify(verdicts.filter(v => v.label.startsWith(leg.journey.name)), null, 2))
  writeFileSync(join(dir, 'wire.json'), JSON.stringify(hits, null, 2))
  const all: string[] = []
  for (const f of frames) {
    all.push(`── frame ${f.i} · tick ${f.tick} · ${f.cols}x${f.rows} ──`)
    for (const row of f.lines) all.push(`│${row}`)
  }
  writeFileSync(join(dir, 'frames.txt'), all.join('\n'))
  const rows: string[] = []
  for (const f of frames) {
    rows.push(`── frame ${f.i} · tick ${f.tick} · ${f.cols}x${f.rows} ──`)
    paneRows(f.lines).forEach((row, y) => { if (row !== '') rows.push(`  y${y} ${row}`) })
  }
  writeFileSync(join(dir, 'rows.txt'), rows.join('\n'))
  for (const [name, from] of [['capture.tee', leg.tee], ['grid.json', leg.grid], ['connector-trace.jsonl', join(leg.home, 'connector-trace.jsonl')], ['engine.log', leg.log]] as const) {
    try {
      writeFileSync(join(dir, name), readFileSync(from))
    } catch {
    }
  }
}

const wanted = (argAfter('--journeys') ?? JOURNEYS.map(j => j.name).join(',')).split(',')
console.log(`notice rows · dist ${DIST} · node ${NODE} · scratch ${SCRATCH} · ${SIZE.cols}x${SIZE.rows}`)
for (const journey of JOURNEYS) {
  if (!wanted.includes(journey.name)) continue
  const tag = journey.name
  console.log(`\n— ${tag} —`)
  const fixture = await startFixture(journey)
  const leg = seedLeg(journey, SIZE)
  let cap: Awaited<ReturnType<typeof capture>>
  try {
    cap = await capture(leg, fixture.url)
  } finally {
    await fixture.close()
  }
  const receipts = cap.payload?.sendReceipts?.map(r => r.atTick) ?? []
  console.log(`  wire: ${fixture.hits.map(h => `${h.n}:${h.facts.notice ? 'notice' : `s${h.facts.step}`}→${h.answer}`).join(' · ')}`)
  check(`${tag}: the journey happened (engine exit 0, every send due, the turn ended on its last words)`, cap.status === 0 && receipts.length === 3 && cap.payload?.endReason === 'stable' && typeof cap.payload?.readyAt === 'number', `exit=${cap.status} sends=${receipts.length}/3 end=${cap.payload?.endReason} ready=${cap.payload?.readyAt} · ${leg.log}`)
  let frames: Frame[] = []
  try {
    frames = await replay(leg)
  } catch (error) {
    check(`${tag}: the tee replayed`, false, error instanceof Error ? error.message : String(error))
  }
  const last = frames[frames.length - 1]
  const lastRuns = last === undefined ? [] : runsIn(last)
  const raw = rawWrapperFrames(frames)
  check(`${tag}: no frame paints the notice's raw wrapper`, raw.length === 0, raw.length === 0 ? '' : `${raw.length} frames, first: ${firstRunOf(raw, r => r.includes('<monitor') || r.includes('</monitor>'))}`)
  check(`${tag}: no frame paints a notice under the operator's caret`, runFrames(frames, r => r.includes('❯ <monitor')).length === 0, firstRunOf(frames, r => r.includes('❯ <monitor')))
  if (journey.name === 'monitor-mid-turn-rows') {
    const plate = (r: string): boolean => r.includes(`monitor · ${WATCH_MID}`)
    check(`${tag}: the plate names the watch`, runFrames(frames, plate).length > 0, `runs: ${lastRuns.join(' ‖ ')}`)
    check(`${tag}: an event line stands beneath the plate, not under a caret`, runFrames(frames, r => plate(r) && r.includes('event-1') && !r.includes('❯')).length > 0, `runs: ${lastRuns.join(' ‖ ')}`)
    check(`${tag}: the queued dress precedes the plate while the runner's queue holds the notice`, rowFrames(frames, r => r.startsWith('queued') && plate(r)).length > 0, firstRunOf(frames, r => r.includes('monitor ·')))
    check(`${tag}: the turn ends with the notice rows standing under their plate`, lastRuns.some(r => r.includes(DONE)) && lastRuns.some(r => plate(r) && r.includes('event-3') && !r.includes('❯')), `runs: ${lastRuns.join(' ‖ ')}`)
  }
  if (journey.name === 'notice-between-turns') {
    const plate = (r: string): boolean => r.includes(`monitor · ${WATCH_LATE}`)
    check(`${tag}: the notice that woke the turn stands under its plate, its line beneath`, runFrames(frames, r => plate(r) && r.includes('late-event') && !r.includes('❯')).length > 0, `runs: ${lastRuns.join(' ‖ ')}`)
    const plateAt = runIndex(lastRuns, plate)
    const notedAt = runIndex(lastRuns, r => r.includes(NOTED))
    check(`${tag}: the reply to the notice follows the notice row`, plateAt !== -1 && notedAt !== -1 && plateAt < notedAt, `plate=${plateAt} noted=${notedAt} runs: ${lastRuns.join(' ‖ ')}`)
  }
  if (journey.name === 'text-between-tools') {
    const carried = (r: string): boolean => r.includes(CARRIED)
    const plate = (r: string): boolean => r.includes(`monitor · ${WATCH_OWNER}`)
    const noticeRun = (r: string): boolean => plate(r) || r.includes('<monitor task=')
    const firstFull = frames.findIndex(f => runsIn(f).some(r => r.includes('before the next step')))
    const gaps = firstFull === -1 ? [] : frames.slice(firstFull).filter(f => !runsIn(f).some(carried))
    check(`${tag}: the words written before the tool call stand in every frame from their first full paint to the end`, firstFull !== -1 && gaps.length === 0, firstFull === -1 ? 'the words never painted whole' : `${gaps.length} frames without them, first: frame ${gaps[0]?.i} · tick ${gaps[0]?.tick}`)
    const above = frames.filter(f => { const runs = runsIn(f); const c = runIndex(runs, carried); const n = runIndex(runs, noticeRun); return c !== -1 && n !== -1 && n < c })
    check(`${tag}: the notice never stands above the words it arrived after`, above.length === 0, above.length === 0 ? '' : `${above.length} frames, first: frame ${above[0]?.i} · tick ${above[0]?.tick}: ${runsIn(above[0]!).join(' ‖ ')}`)
    const c = runIndex(lastRuns, carried)
    const p = runIndex(lastRuns, plate)
    const d = runIndex(lastRuns, r => r.includes(DONE))
    check(`${tag}: at the end the words stand, the notice beneath them, the turn's last words last`, c !== -1 && p !== -1 && d !== -1 && c < p && p < d, `carried=${c} plate=${p} done=${d} runs: ${lastRuns.join(' ‖ ')}`)
  }
  saveArtifacts(leg, frames, fixture.hits)
}

if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`\n[keep] ${SCRATCH}`)
console.log(`\nprove-notice-rows-drive: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
