#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-switch-agents-live.ts — background agents across a
//  model switch and across a runner restart, on the REAL product: the
//  shipped dist boots in a PTY (vshot) on a hermetic seeded home, a
//  content-routed fixture plays the model, the operator's typed ask launches
//  TWO background agents, and the wire + the marked frames are the verdict.
//
//    LEG 1 (switch, 120×40): /model claude-opus-5, "continue", /model
//      claude-fable-5-1, "continue". The runner is the SAME process across
//      both switches (the seat's set-model is in place — no respawn), the
//      two agents keep running, the registry (mercury://agent, read by the
//      model's own Inspect call) answers "2 task(s) · 2 running" on each
//      model, the new model's request carries no death notice (none is
//      due), the rail's crew rows and the Crew view read both agents
//      running, and the Inspect answer lands within its bound.
//    LEG 2 (restart, 80×22): the runner is killed while the two agents run
//      (the crash-respawn road: the daemon relaunches it on --resume). The
//      fresh runner cannot hold the old in-process agents, so the launch
//      receipts in the transcript would stand alone — the reconciliation
//      writes their death notices: the model's next request carries TWO
//      <task-notification> rows naming the launches' tool-use ids, the
//      registry answers "2 task(s) · 0 running" (settled records through
//      the panel grace), the Crew view reads both stopped, and the model —
//      told the truth — launches nothing.
//
//  The fixture is STATELESS and CONTENT-ROUTED (the crew drive's law): the
//  request whose last user item is the operator's marked ask answers two
//  Agent tool_use blocks (run_in_background); the request carrying their
//  results answers the landing text; a "continue" ask answers ONE Inspect
//  tool_use on mercury://agent; the request carrying the Inspect result
//  echoes the registry's own summary line and the count of death notices
//  the request carries — so the frame shows what the model was told. A
//  seat's own prompt answers a long read-only shell sleep (a background
//  agent's roster carries Bash, never the Sleep tool; a read-only command
//  needs no consent). Every answer echoes the requested model id and
//  carries usage.
//
//  Ports: 25171–25172. ~90 s + ~60 s. The fixture lives in THIS process, so
//  the capture engine is spawned ASYNC. SWITCH_KEEP=1 prints every marked
//  frame; SWITCH_LEG=switch|restart runs one leg.
// ============================================================================
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

const SEAT_ONE = 'harbour-count'
const SEAT_TWO = 'lantern-index'
const ASK = 'switch-drive: launch two in the background'
const CONTINUE = 'switch-drive: continue'
const FIXTURE_API_KEY = 'fixture-key-000'
const FABLE = 'claude-fable-5-1'
const OPUS = 'claude-opus-5'
/** The Inspect answer's bound — the field's minute is the failure class. */
const INSPECT_BOUND_MS = 5_000

// ── the content-routed fixture ──────────────────────────────────────────────
type Route = 'launch' | 'launch-ack' | 'continue' | 'inspect-ack' | 'seat' | 'seat-ack' | 'side'
interface Hit {
  route: Route
  model: string
  seat: string | null
  /** The session runner's pid at the request (the daemon's worker record). */
  pid: number | null
  atMs: number
  /** inspect-ack only: the registry's summary line the model was handed. */
  registry?: string
  /** inspect-ack only: the death notices the request carried. */
  notices?: number
  /** inspect-ack only: the Inspect tool's round trip. */
  inspectMs?: number
}
interface Fixture {
  base: string
  hits: Hit[]
  killedPid: number | null
  close(): Promise<void>
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

type Block = { type?: string; id?: string; name?: string; text?: string; tool_use_id?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
const itemsOf = (body: unknown): Item[] => {
  const b = body as { messages?: unknown }
  return Array.isArray(b?.messages) ? (b.messages as Item[]) : []
}
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [])
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : blocksOf(content).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')

/** The tool the last user item answers, by pairing its tool_result ids with
 *  the assistant blocks before it. */
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

/** The rows of the request that are death notices (the reconciliation's own). */
const noticeCount = (items: Item[]): number =>
  items.filter(item => item.role === 'user' && /<task-notification>[\s\S]*<status>(killed|stopped)<\/status>/.test(textOf(item.content))).length

function routeOf(body: unknown): { route: Route; seat: string | null; resultText: string; notices: number } {
  const items = itemsOf(body)
  const answered = answeredTool(items)
  const notices = noticeCount(items)
  if (answered) {
    if (answered.name === 'Agent') return { route: 'launch-ack', seat: null, resultText: answered.resultText, notices }
    if (answered.name === 'Inspect') return { route: 'inspect-ack', seat: null, resultText: answered.resultText, notices }
    if (answered.name === 'Bash') {
      const text = items.map(i => (i.role === 'user' ? textOf(i.content) : '')).join('\n')
      return { route: 'seat-ack', seat: text.includes(SEAT_ONE) ? SEAT_ONE : SEAT_TWO, resultText: answered.resultText, notices }
    }
  }
  const last = [...items].reverse().find(i => i.role === 'user')
  const text = last ? textOf(last.content) : ''
  if (text.includes('switch-seat:') && offersTool(body, 'Bash')) return { route: 'seat', seat: text.includes(SEAT_ONE) ? SEAT_ONE : SEAT_TWO, resultText: '', notices }
  // The parent is the request that carries the ask AND the tool it needs;
  // a side call (a title or summary ask quoting the words, no tools) is not.
  if (text.includes('switch-drive:') && text.includes('continue') && offersTool(body, 'Inspect')) return { route: 'continue', seat: null, resultText: '', notices }
  if (text.includes('switch-drive:') && !text.includes('continue') && offersTool(body, 'Agent')) return { route: 'launch', seat: null, resultText: '', notices }
  return { route: 'side', seat: null, resultText: '', notices }
}

function offersTool(body: unknown, name: string): boolean {
  const tools = (body as { tools?: unknown[] })?.tools
  return Array.isArray(tools) && tools.some(t => (t as { name?: string })?.name === name)
}

type Answer = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
/** One /v1/messages SSE answer — the requested model echoed, usage stated. */
function answer(model: string, blocks: Answer[], usage: { input: number; output: number }): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_sw_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
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
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_sw_${Date.now() % 100000}_${index}_${Math.floor(Math.random() * 1e4)}`, name: block.name, input: {} } })}`,
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

/** The session runner's pid from the daemon's worker records under the
 *  drive's home — the live record (no end stamp), newest first. */
function runnerPid(home: string): number | null {
  try {
    const file = join(home, 'daemon', 'concourse-workers.json')
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { workers?: Record<string, { pid?: number; endedAt?: number; spawnedAt?: number }> }
    const live = Object.values(raw.workers ?? {})
      .filter(w => w.endedAt === undefined && typeof w.pid === 'number')
      .sort((a, b) => (b.spawnedAt ?? 0) - (a.spawnedAt ?? 0))
    return live[0]?.pid ?? null
  } catch {
    return null
  }
}

async function startFixture(port: number, home: string, opts: { killAfterLaunchMs?: number }): Promise<Fixture> {
  const hits: Hit[] = []
  let inspectAskedAt = 0
  let checks = 0
  const fixture: Fixture = { base: `http://127.0.0.1:${port}`, hits, killedPid: null, close: async () => {} }
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
      const { route, seat, resultText, notices } = routeOf(body)
      const hit: Hit = { route, model, seat, pid: runnerPid(home), atMs: Date.now() }
      let blocks: Answer[]
      let usage: { input: number; output: number }
      switch (route) {
        case 'launch':
          blocks = [
            { type: 'text', text: 'launching two in the background' },
            { type: 'tool_use', name: 'Agent', input: { description: SEAT_ONE, prompt: `switch-seat: count the ${SEAT_ONE}`, subagent_type: 'general-purpose', run_in_background: true } },
            { type: 'tool_use', name: 'Agent', input: { description: SEAT_TWO, prompt: `switch-seat: index the ${SEAT_TWO}`, subagent_type: 'general-purpose', run_in_background: true } },
          ]
          usage = { input: 1200, output: 90 }
          break
        case 'launch-ack':
          blocks = [{ type: 'text', text: 'switch-drive: launched two in the background.' }]
          usage = { input: 1500, output: 30 }
          if (opts.killAfterLaunchMs !== undefined && fixture.killedPid === null) {
            const delay = opts.killAfterLaunchMs
            setTimeout(() => {
              const pid = runnerPid(home)
              if (pid === null) return
              fixture.killedPid = pid
              try {
                process.kill(pid, 'SIGTERM')
              } catch {
                /* already gone */
              }
            }, delay).unref?.()
          }
          break
        case 'continue':
          blocks = [{ type: 'tool_use', name: 'Inspect', input: { ref: 'mercury://agent' } }]
          usage = { input: 1600, output: 40 }
          inspectAskedAt = Date.now()
          break
        case 'inspect-ack': {
          const summary = resultText.match(/\d+ task\(s\) · \d+ running/)?.[0] ?? 'no summary'
          hit.registry = summary
          hit.notices = notices
          hit.inspectMs = inspectAskedAt > 0 ? Date.now() - inspectAskedAt : -1
          checks += 1
          blocks = [{ type: 'text', text: `switch-drive: check ${checks}: registry says ${summary} · notices ${notices}` }]
          usage = { input: 1700, output: 50 }
          break
        }
        case 'seat':
          // Under the Bash tool's cap (600 s) and past the drive: the seat's own
          // timeout, never the 120 s default that would settle it mid-drive.
          blocks = [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 280', description: 'hold the seat', timeout: 300_000 } }]
          usage = { input: 900, output: 40 }
          break
        case 'seat-ack':
          blocks = [{ type: 'text', text: `switch-seat-done: ${seat ?? 'seat'}.` }]
          usage = { input: 950, output: 60 }
          break
        default:
          blocks = [{ type: 'text', text: 'ok' }]
          usage = { input: 20, output: 2 }
      }
      hits.push(hit)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(answer(model, blocks, usage))
    })
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  fixture.close = () => new Promise<void>(resolve => server.close(() => resolve()))
  return fixture
}

// ── the capture (vshot, async — the fixture lives in this process) ──────────
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

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'switch-drive-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], {
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'switch-drive-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'switch-drive-cwd-')))
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

// ── the frames' vocabulary ──────────────────────────────────────────────────
const agentRow = (text: string, name: string, ...words: Array<string | RegExp>): boolean =>
  text.split('\n').some(line => line.includes(name) && words.every(w => (typeof w === 'string' ? line.includes(w) : w.test(line))))
const flat = (s: string): string => s.replace(/\s+/g, ' ')

/** The Boot face's ready word: the ten-row card's chooser at a full size,
 *  the compact face's "↵ start" where the card does not fit (80×22). */
const bootSends = (ask: string, faceReady = '↑↓ choose'): Array<Record<string, unknown>> => [
  { data: '\r', atTick: 999, awaitText: faceReady, requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: ask, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\r', afterPrevTicks: 4 },
]
/** /model <id> applies through the seat's settlement owner — a same-family
 *  switch lands at once; a cross-family one opens the switch preview, which
 *  ↵ confirms (the ↵ is a no-op on the empty composer when no card opened).
 *  The band's chip names the applied model; the continue waits for it. */
const switchSends = (model: string, chipAfter: string, mark: string): Array<Record<string, unknown>> => [
  // While agents hold the turn the composer shows no placeholder (the
  // session reads "waiting on N agents"), so the command follows the
  // previous send on the clock, never a ready word.
  { data: `/model ${model}\r`, afterPrevTicks: 6 },
  { data: '\r', afterPrevTicks: 12, awaitText: 'Model switch preview', minTick: 2, awaitSettleTicks: 3 },
  { data: `${CONTINUE}\r`, atTick: 999, awaitText: chipAfter, requireAwait: true, minTick: 4, awaitSettleTicks: 3, mark },
]

function dump(label: string, frame: string | undefined, cols: number): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, cols)}`)
}

const LEG = process.env.SWITCH_LEG ?? 'all'
const KEEP = process.env.SWITCH_KEEP === '1'
const hitLine = (hits: Hit[]): string => hits.map(h => `${h.route}${h.seat ? `(${h.seat})` : ''}:${h.model}:pid${h.pid ?? '?'}${h.registry ? `:[${h.registry}·n${h.notices}·${h.inspectMs}ms]` : ''}`).join(' ')

// ── LEG 1 — the switch ──────────────────────────────────────────────────────
async function switchLeg(): Promise<void> {
  console.log('\n— switch · 120×40 —')
  const before = failures
  const { home, cwd } = seedWorld()
  const fixture = await startFixture(Number(process.env.SWITCH_PORT_SWITCH ?? 25171), home, {})
  const COLS = 120
  const ROWS = 40
  let cap: Capture
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 700,
        cwd,
        argv: ['node', DIST, '--model', FABLE],
        sends: [
          ...bootSends(ASK),
          // The launch landed: the parent's own line; the mark photographs the
          // rail's crew rows beside the transcript (past the usage settle).
          { data: '/teammates', atTick: 999, awaitText: 'launched two in the background', requireAwait: true, minTick: 2, awaitSettleTicks: 10, mark: 'launched' },
          { data: '\r', afterPrevTicks: 4 },
          { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-launched' },
          ...switchSends(OPUS, 'Opus 5 · ●', 'opus-set'),
          { data: '/teammates', atTick: 999, awaitText: 'check 1:', requireAwait: true, minTick: 4, awaitSettleTicks: 6, mark: 'after-opus' },
          { data: '\r', afterPrevTicks: 4 },
          { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-opus' },
          ...switchSends(FABLE, 'Fable 5.1 · ●', 'fable-set'),
          { data: '/teammates', atTick: 999, awaitText: 'check 2:', requireAwait: true, minTick: 4, awaitSettleTicks: 6, mark: 'after-fable' },
          { data: '\r', afterPrevTicks: 4 },
          { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-fable' },
        ],
        stableTicks: 6,
      },
      driveEnv(home, fixture.base),
      300_000,
    )
  } finally {
    await fixture.close()
  }
  const tag = 'switch'
  const { marks } = cap
  if (KEEP) for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame, COLS)
  console.log(`  hits: ${hitLine(fixture.hits)}`)
  check(`${tag}: every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  const parentHits = fixture.hits.filter(h => h.route !== 'seat' && h.route !== 'seat-ack' && h.route !== 'side')
  check(`${tag}: the parent launched once and never again (no phantom launch on either model)`, fixture.hits.filter(h => h.route === 'launch').length === 1 && fixture.hits.filter(h => h.route === 'launch-ack').length === 1)
  check(`${tag}: the two continues rode the switched models in order — opus, then fable back`, parentHits.filter(h => h.route === 'continue').map(h => h.model).join(',') === `${OPUS},${FABLE}`, parentHits.map(h => `${h.route}:${h.model}`).join(' '))
  const seats = fixture.hits.filter(h => h.route === 'seat')
  check(`${tag}: both seats asked once and neither settled (their shell sleeps outlive the drive)`, seats.length === 2 && new Set(seats.map(h => h.seat)).size === 2 && !fixture.hits.some(h => h.route === 'seat-ack'))
  const pids = new Set(fixture.hits.map(h => h.pid).filter((p): p is number => typeof p === 'number'))
  check(`${tag}: ONE runner process across both switches — the seat switches in place, never a respawn`, pids.size === 1, `pids ${[...pids].join(',')}`)
  const acks = fixture.hits.filter(h => h.route === 'inspect-ack')
  check(`${tag}: the registry answered the model's Inspect on both models: 2 task(s) · 2 running`, acks.length === 2 && acks.every(h => h.registry === '2 task(s) · 2 running'), acks.map(h => h.registry).join(' | '))
  check(`${tag}: no death notice rode either request (none was due — the agents lived)`, acks.every(h => h.notices === 0))
  check(`${tag}: the Inspect answer landed within ${INSPECT_BOUND_MS} ms at ${COLS}×${ROWS}`, acks.every(h => (h.inspectMs ?? Infinity) < INSPECT_BOUND_MS), acks.map(h => `${h.inspectMs}ms`).join(' '))
  for (const label of ['launched', 'after-opus', 'after-fable']) {
    const frame = marks[label] ?? ''
    check(`${tag}: the rail's crew rows read both agents running with tokens at '${label}'`, (flat(frame).match(/◐ [a-z-…]+ · \d[\d.,]*k? tokens/g) ?? []).length >= 2, flat(frame).slice(0, 200))
  }
  for (const label of ['crew-launched', 'crew-opus', 'crew-fable']) {
    const frame = marks[label] ?? ''
    check(`${tag}: the Crew view at '${label}' — both rows running, the count label`, agentRow(frame, SEAT_ONE, /\brunning\b/) && agentRow(frame, SEAT_TWO, /\brunning\b/) && frame.includes('2 running · 2 sub-agents'))
  }
  check(`${tag}: the transcript carries the registry's own words after each switch`, (marks['after-opus'] ?? '').includes('check 1: registry says 2 task(s) · 2 running') && (marks['after-fable'] ?? '').includes('check 2: registry says 2 task(s) · 2 running'))
  if (failures > before && !KEEP) for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame, COLS)
  if (failures > before || KEEP) dump(`${tag} · final grid`, cap.text, COLS)
  if (KEEP) console.log(`[keep] ${tag} home ${home} cwd ${cwd}`)
  else {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

// ── LEG 2 — the restart ─────────────────────────────────────────────────────
async function restartLeg(): Promise<void> {
  console.log('\n— restart · 80×22 —')
  const before = failures
  const { home, cwd } = seedWorld()
  const fixture = await startFixture(Number(process.env.SWITCH_PORT_RESTART ?? 25172), home, { killAfterLaunchMs: 2_500 })
  const COLS = 80
  const ROWS = 22
  let cap: Capture
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 500,
        cwd,
        argv: ['node', DIST, '--model', FABLE],
        sends: [
          ...bootSends(ASK, '↵ start'),
          // The launch landed; the fixture kills the runner 2.5 s later and
          // the daemon relaunches it on --resume. The continue waits well
          // past the kill + the backoff + the boot (the seat holds a
          // delivery until the fresh child is idle, so an early ask still
          // lands on the new runner).
          { data: `${CONTINUE}\r`, atTick: 999, awaitText: 'launched two in the background', requireAwait: true, minTick: 2, awaitSettleTicks: 45, mark: 'launched' },
          { data: '/teammates', atTick: 999, awaitText: 'check 1:', requireAwait: true, minTick: 4, awaitSettleTicks: 6, mark: 'after-restart' },
          { data: '\r', afterPrevTicks: 4 },
          { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-restart' },
        ],
        stableTicks: 6,
      },
      driveEnv(home, fixture.base),
      240_000,
    )
  } finally {
    await fixture.close()
  }
  const tag = 'restart'
  const { marks } = cap
  if (KEEP) for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame, COLS)
  console.log(`  hits: ${hitLine(fixture.hits)} · killed pid ${fixture.killedPid ?? 'none'}`)
  check(`${tag}: every send became due`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  check(`${tag}: the runner was killed while both agents ran`, fixture.killedPid !== null && fixture.hits.filter(h => h.route === 'seat').length === 2)
  const ack = fixture.hits.find(h => h.route === 'inspect-ack')
  const continueHit = fixture.hits.find(h => h.route === 'continue')
  check(`${tag}: the daemon relaunched the runner — the continue rode a NEW pid`, continueHit !== undefined && continueHit.pid !== null && continueHit.pid !== fixture.killedPid, `continue pid ${continueHit?.pid} · killed ${fixture.killedPid}`)
  check(`${tag}: the model's next request carried TWO death notices — one per launch receipt`, ack !== undefined && ack.notices === 2, `notices ${ack?.notices}`)
  check(`${tag}: the registry answered the model: 2 task(s) · 0 running (settled records, nothing live)`, ack?.registry === '2 task(s) · 0 running', ack?.registry)
  check(`${tag}: told the truth, the model launched nothing more`, fixture.hits.filter(h => h.route === 'launch').length === 1)
  check(`${tag}: the Inspect answer landed within ${INSPECT_BOUND_MS} ms at ${COLS}×${ROWS}`, ack !== undefined && (ack.inspectMs ?? Infinity) < INSPECT_BOUND_MS, `${ack?.inspectMs}ms`)
  const crew = marks['crew-restart'] ?? ''
  const crewRows = crew.split('\n').filter(line => line.includes(SEAT_ONE) || line.includes(SEAT_TWO) || line.includes('sub-agents'))
  check(`${tag}: the Crew view reads both agents stopped — never running, never the store's word`, agentRow(crew, SEAT_ONE, /\bstopped\b/) && agentRow(crew, SEAT_TWO, /\bstopped\b/) && crewRows.every(line => !/\brunning\b\s*(·|—)?\s*$/.test(line) || line.includes('0 running')) && !crewRows.some(line => line.includes('killed')) && crew.includes('0 running · 2 sub-agents'))
  check(`${tag}: the registry's own rows read stopped, never the store's word`, /\(stopped · harbour/.test(flat(marks['after-restart'] ?? '')) && !(marks['after-restart'] ?? '').includes('killed'))
  // At 80 columns the line wraps: the words are read off the flattened frame.
  const afterRestart = flat((marks['after-restart'] ?? '').replace(/^│ ?/gm, ''))
  check(`${tag}: the transcript carries the registry's words and the notice count`, afterRestart.includes('check 1: registry says 2 task(s) · 0 running') && afterRestart.includes('notices 2'))
  if (failures > before && !KEEP) for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame, COLS)
  if (failures > before || KEEP) dump(`${tag} · final grid`, cap.text, COLS)
  if (KEEP) console.log(`[keep] ${tag} home ${home} cwd ${cwd}`)
  else {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

if (LEG === 'all' || LEG === 'switch') await switchLeg()
if (LEG === 'all' || LEG === 'restart') await restartLeg()

console.log(failures === 0 ? '\nprove-switch-agents-live: ALL LAWS HOLD' : `\nprove-switch-agents-live: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
