#!/usr/bin/env bun
import { execFile, spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { vshotBudgetMs, resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-seats-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'
const ASK = 'seat-survey: launch'
const LAUNCHED = 'WF-LAUNCHED'
const NOTED = 'WF-NOTED'
const SEAT_MARK = 'seat-survey-seat:'
const WF_NAME = 'seat-survey'
const PHASE = 'Survey'
const STATIONS = ['a', 'b', 'c', 'd'] as const
type Station = (typeof STATIONS)[number]
const labelOf = (s: Station): string => `seat-${s}`
const SEAT_CEILING = 2
const HOLD_MS = 20_000
const IDLE_FIRST_S = 5
const IDLE_SECOND_S = 20
const WF_SCRIPT = [
  `export const meta = { name: '${WF_NAME}', description: 'four agents survey the stations', phases: [{ title: '${PHASE}' }] }`,
  `phase('${PHASE}')`,
  `const reports = await parallel([${STATIONS.map(s => `() => agent('${SEAT_MARK}${s} survey the station and report in one line', { label: '${labelOf(s)}' })`).join(', ')}])`,
  'return { reports }',
].join('\n')

type Route = 'launch' | 'launched' | 'note' | 'seat' | 'side'
type Block = { type?: string; id?: string; name?: string; text?: string; tool_use_id?: string; content?: unknown; input?: Record<string, unknown> }
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
function answeredTool(items: Item[]): string | null {
  const last = items[items.length - 1]
  if (!last || last.role !== 'user') return null
  const results = blocksOf(last.content).filter(b => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
  if (results.length === 0) return null
  const ids = new Set(results.map(b => b.tool_use_id as string))
  for (let i = items.length - 2; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'assistant') continue
    const use = blocksOf(item.content).find(b => b.type === 'tool_use' && typeof b.id === 'string' && ids.has(b.id))
    if (use) return use.name ?? ''
  }
  return null
}
function stationOf(items: Item[]): Station | null {
  const userText = items
    .filter(i => i.role === 'user')
    .map(i => textOf(i.content))
    .filter(t => !t.includes('task-notification'))
    .join('\n')
  for (const s of STATIONS) if (userText.includes(`${SEAT_MARK}${s} `)) return s
  return null
}
const toolCallsOf = (items: Item[], name: string): number =>
  items.filter(i => i.role === 'assistant' && blocksOf(i.content).some(b => b.type === 'tool_use' && b.name === name)).length

type Hit = { route: Route; station: Station | null; kind: 'tool' | 'held' | 'done' | 'other'; startMs: number; endMs: number; lastUserText: string }
type Answer =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
const USAGE = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
function answer(model: string, blocks: Answer[]): { head: string; tail: string } {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const head = `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_seats_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...USAGE, output_tokens: 1 } } })}`
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
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { ...USAGE, output_tokens: 40 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return { head, tail: parts.join('') }
}

async function startFixture(port: number): Promise<{ base: string; hits: Hit[]; close(): Promise<void> }> {
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
      const items = itemsOf(body)
      const lastUser = [...items].reverse().find(i => i.role === 'user')
      const lastUserText = lastUser ? textOf(lastUser.content) : ''
      const station = stationOf(items)
      const answered = answeredTool(items)
      let route: Route
      if (station !== null) route = 'seat'
      else if (lastUserText.includes('task-notification')) route = 'note'
      else if (answered === 'Workflow') route = 'launched'
      else if (lastUserText.includes(ASK) && offersTool(body, 'Workflow')) route = 'launch'
      else route = 'side'
      let blocks: Answer[]
      let holdMs = 0
      let kind: Hit['kind'] = 'other'
      switch (route) {
        case 'launch':
          blocks = [
            { type: 'text', text: 'launching the survey' },
            { type: 'tool_use', id: `toolu_seats_launch_${++toolSeq}`, name: 'Workflow', input: { script: WF_SCRIPT } },
          ]
          break
        case 'launched':
          blocks = [{ type: 'text', text: LAUNCHED }]
          break
        case 'note':
          blocks = [{ type: 'text', text: NOTED }]
          break
        case 'seat':
          if (station === 'a') {
            const bashes = toolCallsOf(items, 'Bash')
            if (bashes < 2) {
              blocks = [{ type: 'tool_use', id: `toolu_seats_sleep_${++toolSeq}`, name: 'Bash', input: { command: `sleep ${bashes === 0 ? IDLE_FIRST_S : IDLE_SECOND_S}`, description: 'the station survey' } }]
              kind = 'tool'
            } else {
              blocks = [{ type: 'text', text: `SEAT-DONE-${station}` }]
              kind = 'done'
            }
          } else {
            blocks = [{ type: 'text', text: `SEAT-DONE-${station}` }]
            holdMs = HOLD_MS
            kind = 'held'
          }
          break
        default:
          blocks = [{ type: 'text', text: 'side' }]
      }
      const hit: Hit = { route, station, kind, startMs: Date.now(), endMs: 0, lastUserText }
      hits.push(hit)
      const payload = answer(model, blocks)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(payload.head)
      if (holdMs === 0) {
        hit.endMs = Date.now()
        res.end(payload.tail)
        return
      }
      const t = setTimeout(() => {
        hit.endMs = Date.now()
        res.end(payload.tail)
      }, holdMs)
      res.on('close', () => {
        clearTimeout(t)
        if (hit.endMs === 0) hit.endMs = Date.now()
      })
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
type Capture = { text: string; marks: Record<string, string>; markTicks: Record<string, number>; receipts: Array<{ atTick: number; ts: number }>; sends: number; endReason: string; stderr: string; rss: RssSample[] }
type RssSample = { at: number; pid: number; rssBytes: number; role: 'daemon' | 'runner' | 'screen' | 'other' }

function startRssSampler(): { stop(): RssSample[] } {
  const samples: RssSample[] = []
  const tick = (): void => {
    execFile('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }, (err, out) => {
      if (err) return
      const at = Date.now()
      const rows: Array<{ pid: number; ppid: number; rss: number; command: string }> = []
      for (const line of out.split('\n')) {
        if (!line.includes(BIN)) continue
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
        if (!m) continue
        rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, command: m[4] ?? '' })
      }
      const daemons = new Set(rows.filter(r => /\bdaemon\b/.test(r.command)).map(r => r.pid))
      for (const r of rows) {
        const role: RssSample['role'] = daemons.has(r.pid) ? 'daemon' : daemons.has(r.ppid) ? 'runner' : /^\S*node \S*mercury\.mjs\s*$/.test(r.command.trim()) ? 'screen' : 'other'
        samples.push({ at, pid: r.pid, rssBytes: r.rss, role })
      }
    })
  }
  const timer = setInterval(tick, 2000)
  tick()
  return {
    stop: () => {
      clearInterval(timer)
      return samples
    },
  }
}

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'seats-drive-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const sampler = startRssSampler()
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
  const rss = sampler.stop()
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 600)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as {
    grid: Grid
    sendReceipts?: Array<{ atTick: number; ts: number }>
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
    receipts: payload.sendReceipts ?? [],
    sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0,
    endReason: payload.endReason ?? '',
    stderr: stderr.join(''),
    rss,
  }
}

function rssSummary(samples: RssSample[]): string[] {
  const byPid = new Map<number, { role: RssSample['role']; min: number; max: number; n: number }>()
  for (const s of samples) {
    const row = byPid.get(s.pid)
    if (row === undefined) byPid.set(s.pid, { role: s.role, min: s.rssBytes, max: s.rssBytes, n: 1 })
    else {
      row.min = Math.min(row.min, s.rssBytes)
      row.max = Math.max(row.max, s.rssBytes)
      row.n++
    }
  }
  const mb = (n: number): string => `${Math.round(n / 2 ** 20)} MB`
  return [...byPid.entries()].map(([pid, r]) => `pid ${pid} ${r.role}: ${mb(r.min)} → ${mb(r.max)} (${r.n} samples)`)
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'seats-drive-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'seats-drive-cwd-')))
  seedFirstRun(home, [cwd])
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg.switchboardCapacity = { askedAt: Date.now() - 86_400_000, allowed: true, recommendedSeats: SEAT_CEILING }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(sleep:*)'] } }))
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
const laneOf = (frame: string | undefined, s: Station): string =>
  rowsWith(frame, `${labelOf(s)} · `).map(flat).join(' | ')

type AgentSummary = { index: number; label: string; state: string; waiting?: string; waitWords?: string; startedAt?: number }
function readRunManifest(home: string): AgentSummary[] | null {
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return null
  let newest: { path: string; mtime: number } | null = null
  for (const project of readdirSync(projects)) {
    const runs = join(projects, project, 'workflows', 'runs')
    if (!existsSync(runs)) continue
    for (const dir of readdirSync(runs)) {
      const path = join(runs, dir, 'run.json')
      if (!existsSync(path)) continue
      const mtime = statSync(path).mtimeMs
      if (newest === null || mtime > newest.mtime) newest = { path, mtime }
    }
  }
  if (newest === null) return null
  try {
    const parsed = JSON.parse(readFileSync(newest.path, 'utf8')) as { agents?: AgentSummary[] }
    return Array.isArray(parsed.agents) ? parsed.agents : null
  } catch {
    return null
  }
}
function manifestAtBusyMoment(home: string, hits: Hit[], afterMs: number): Promise<{ agents: AgentSummary[] | null; atMs: number }> {
  return new Promise(resolve => {
    const poll = setInterval(() => {
      const first = hits.find(h => h.route === 'seat')
      if (first === undefined) return
      if (Date.now() - first.startMs < afterMs) return
      clearInterval(poll)
      resolve({ agents: readRunManifest(home), atMs: Date.now() - first.startMs })
    }, 250)
    poll.unref?.()
  })
}

console.log('============================================================')
console.log(' the seats are the calls in flight — real bundle, PTY, four agents on two seats')
console.log('============================================================')
const KEEP = process.env.SEATS_DRIVE_KEEP === '1'
const { home, cwd } = seedWorld()
const fixture = await startFixture(Number(process.env.SEATS_DRIVE_PORT ?? 25183))
const COLS = 160
const ROWS = 44
let cap: Capture | null = null
const busyManifest = manifestAtBusyMoment(home, fixture.hits, 8_000)
try {
  cap = await capture(
    {
      argv: ['node', BIN],
      cwd,
      cols: COLS,
      rows: ROWS,
      sends: [
        { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
        { data: `${ASK}\r`, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'boot' },
        { data: '\r', awaitText: 'Yes, run this workflow', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'ask' },
        { data: '', awaitText: LAUNCHED, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'launched' },
        { data: '/workflows\r', afterPrevTicks: 30 },
        { data: '\r', awaitText: WF_NAME, requireAwait: true, minTick: 2, awaitSettleTicks: 5, mark: 'board' },
        { data: '', afterPrevTicks: 12, mark: 'run-busy' },
        { data: '\x1b', afterPrevTicks: 2 },
        { data: '\x1b', afterPrevTicks: 3 },
        { data: '', awaitText: NOTED, requireAwait: true, minTick: 2, awaitSettleTicks: 12, mark: 'settled' },
        { data: '', afterPrevTicks: 4, mark: 'end' },
      ],
      stableTicks: 6,
      total: 900,
    },
    driveEnv(home, fixture.base),
    240_000,
  )
} catch (error) {
  check('the capture ran', false, String(error).slice(0, 400))
}
await fixture.close()

if (cap !== null) {
  const m = cap.marks
  const seatHits = fixture.hits.filter(h => h.route === 'seat')
  const firstCall = (s: Station): Hit | undefined => seatHits.find(h => h.station === s)
  const clock0 = Math.min(...seatHits.map(h => h.startMs))
  const at = (h: Hit | undefined): string => (h === undefined ? '—' : `${((h.startMs - clock0) / 1000).toFixed(1)}s`)
  console.log(`  wire (first call per station): ${STATIONS.map(s => `${labelOf(s)}@${at(firstCall(s))}`).join(' · ')}`)
  console.log(`  send ticks: ${cap.receipts.map(r => r.atTick).join(',')} · marks: ${Object.entries(cap.markTicks).map(([k, v]) => `${k}@${v}`).join(' ')} · end: ${cap.endReason}`)
  const busyTick = cap.markTicks['run-busy']
  const busyTs = cap.receipts.find(r => r.atTick === busyTick)?.ts
  if (busyTs !== undefined) {
    const inFlight = seatHits.filter(h => h.kind === 'held' && h.startMs <= busyTs && (h.endMs === 0 || h.endMs >= busyTs)).map(h => labelOf(h.station!))
    const landed = seatHits.filter(h => h.kind === 'done' && h.endMs !== 0 && h.endMs <= busyTs).map(h => labelOf(h.station!))
    console.log(`  at the busy moment (${((busyTs - clock0) / 1000).toFixed(1)}s): calls in flight ${inFlight.length} (${inFlight.join(', ')}) · landed ${landed.length}`)
  }
  dump('run-busy', m['run-busy'])
  console.log(`  memory: ${rssSummary(cap.rss).join(' · ') || '(no samples)'}`)
  if (KEEP) for (const label of ['launched', 'settled']) dump(label, m[label])
  check('every send became due (the frames the sends waited on all painted)', cap.receipts.length === cap.sends, `${cap.receipts.length}/${cap.sends} · end ${cap.endReason}`)

  console.log('\n— D1 the wire —')
  const a = firstCall('a')
  const b = firstCall('b')
  const c = firstCall('c')
  const d = firstCall('d')
  check('D1 all four stations reached the wire', a !== undefined && b !== undefined && c !== undefined && d !== undefined, seatHits.map(h => `${h.station}:${h.kind}`).join(','))
  if (a && b && c && d) {
    const span3 = Math.max(a.startMs, b.startMs, c.startMs) - Math.min(a.startMs, b.startMs, c.startMs)
    check(`D1 a, b and c start together (span ${span3} ms < ${HOLD_MS / 4} ms) — the idle agent holds no seat`, span3 < HOLD_MS / 4, `span ${span3} ms`)
    const dGap = d.startMs - c.startMs
    check(`D1 d waits for a seat (starts ≥ ${Math.round(HOLD_MS * 0.6)} ms after c)`, dGap >= HOLD_MS * 0.6, `gap ${dGap} ms`)
    const freedAt = Math.min(b.endMs || Infinity, c.endMs || Infinity)
    check('D1 d starts once a held call ends (the queue forms only with two calls in flight)', d.startMs >= freedAt - 1500, `d@${d.startMs - clock0} · freed@${freedAt - clock0}`)
  }

  console.log('\n— D2 the words at the busy moment —')
  const manifest = await busyManifest
  const summary = (s: Station): AgentSummary | undefined => manifest.agents?.find(a => a.label === labelOf(s))
  const wordsOf = (s: Station): string => {
    const a = summary(s)
    return a === undefined ? '(no summary)' : `${a.state}${a.waiting !== undefined ? `/${a.waiting}` : ''}${a.waitWords !== undefined ? ` "${a.waitWords}"` : ''}`
  }
  console.log(`  manifest ${(manifest.atMs / 1000).toFixed(1)}s after the first seat call: ${STATIONS.map(s => `${labelOf(s)} ${wordsOf(s)}`).join(' · ')}`)
  const dTile = summary('d')
  const aTile = summary('a')
  check('D2 the manifest carries every agent', STATIONS.every(s => summary(s) !== undefined), String(manifest.agents?.map(a => a.label).join(',')))
  check("D2 d's tile says why it waits — the seat sentence (2 of 2 held)", dTile?.waiting === 'seat' && /^waiting for a seat — 2 of 2 held/.test(dTile.waitWords ?? ''), wordsOf('d'))
  check('D2 the sentence names the two holders by their labels — the calls in flight (b, c), never a waiter', /\(seat-b, seat-c\)$/.test(dTile?.waitWords ?? ''), wordsOf('d'))
  check("D2 b's and c's tiles hold seats: neither waits for one", summary('b')?.waiting !== 'seat' && summary('c')?.waiting !== 'seat', `${wordsOf('b')} || ${wordsOf('c')}`)
  check("D2 a's second call waits for a seat like any other (its seat was free while its tool ran)", aTile?.waiting === 'seat' && /\(seat-b, seat-c\)$/.test(aTile.waitWords ?? ''), wordsOf('a'))
  check('D2 no tile wears a gate sentence of its own (a start tile carries no words)', (manifest.agents ?? []).every(a => a.state !== 'start' || a.waitWords === undefined), String(manifest.agents?.map(a => `${a.label}:${a.state}`).join(',')))
  const busy = m['run-busy']
  const lanes = STATIONS.map(s => laneOf(busy, s))
  console.log(`  run view lanes: ${lanes.map((l, i) => `${labelOf(STATIONS[i]!)}: ${l.slice(0, 120) || '(none)'}`).join(' | ')}`)
  check('D2 no lane on the screen reads a bare queued', !lanes.some(l => /\bqueued\b/.test(l)), lanes.join(' || ').slice(0, 300))
  check("D2 d's lane on the screen wears the seat sentence", /waiting for a seat — 2 of 2 held/.test(laneOf(busy, 'd')), laneOf(busy, 'd').slice(0, 200))

  console.log('\n— D3 the settle —')
  check('D3 every station reported (SEAT-DONE on the wire)', STATIONS.every(s => seatHits.some(h => h.station === s && (h.kind === 'held' || h.kind === 'done'))), seatHits.map(h => `${h.station}:${h.kind}`).join(','))
  check("D3 the idle agent's calls were short and its seat was free between them (two tool calls, then the report)", seatHits.filter(h => h.station === 'a' && h.kind === 'tool').length === 2 && seatHits.some(h => h.station === 'a' && h.kind === 'done'), seatHits.filter(h => h.station === 'a').map(h => h.kind).join(','))
  check('D3 the completion notice reached the main agent', fixture.hits.some(h => h.route === 'note' && h.lastUserText.includes('<status>completed</status>')), fixture.hits.filter(h => h.route === 'note').map(h => h.lastUserText.slice(0, 160)).join(' | '))
  check('D3 the main saw the notice (NOTED painted)', rowsWith(m['settled'], NOTED).length > 0)
  check('nothing read stuck', !Object.values(m).some(f => /may be stuck/.test(f)))
  if (failures > 0 && !KEEP) for (const label of ['launched', 'settled']) dump(label, m[label])
}

if (!KEEP) {
  for (const dir of [home, cwd]) rmSync(dir, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${home} cwd=${cwd}`)
}
console.log(failures === 0 ? '\n✅ seats drive GREEN' : `\n❌ seats drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
