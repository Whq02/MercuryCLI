#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-teammate-mail-abort-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'
const TEAMMATE = 'probe'
const TEAM = 'mailcrew'
const SEAT_MARK = 'mail-seat:'
const ALIVE = 'MAIN-ALIVE'
const LINE_1 = 'MAIL-OP-1 first queued line'
const LINE_2 = 'MAIL-OP-2 second queued line'
const SLEEP_SECONDS = 40
const TEAM_CREATE = 'TeamCreate'
const SEND_MESSAGE = 'SendMessage'

type Route = 'launch' | 'team-made' | 'spawned' | 'mailed' | 'slept' | 'note' | 'seat-hold' | 'seat' | 'alive' | 'side'
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
const resultTexts = (items: Item[]): string[] => {
  const last = items[items.length - 1]
  if (!last || last.role !== 'user') return []
  return blocksOf(last.content)
    .filter(b => b.type === 'tool_result')
    .map(b => (typeof b.content === 'string' ? b.content : blocksOf(b.content).map(x => x.text ?? '').join('\n')))
}
const isSeat = (items: Item[]): boolean =>
  items
    .filter(i => i.role === 'user')
    .map(i => textOf(i.content))
    .filter(t => !t.includes('task-notification'))
    .some(t => t.includes(SEAT_MARK))

type Hit = { route: Route; atMs: number; lastUserText: string; results: string[] }
type Answer =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
const USAGE = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const messageStart = (model: string): string =>
  `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_mail_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...USAGE, output_tokens: 1 } } })}`
function answer(model: string, blocks: Answer[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [messageStart(model)]
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
  return parts.join('')
}

type Fixture = {
  base: string
  hits: Hit[]
  holdClosedAt: () => number | null
  close(): Promise<void>
}

async function startFixture(port: number): Promise<Fixture> {
  const hits: Hit[] = []
  let seatCalls = 0
  let holdClosedAt: number | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
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
      const answered = answeredTool(items)
      let route: Route
      if (isSeat(items)) route = seatCalls === 0 ? 'seat-hold' : 'seat'
      else if (lastUserText.includes('task-notification')) route = 'note'
      else if (lastUserText.includes('mail-drive: alive')) route = 'alive'
      else if (answered === TEAM_CREATE) route = 'team-made'
      else if (answered === 'Agent') route = 'spawned'
      else if (answered === SEND_MESSAGE) route = 'mailed'
      else if (answered === 'Bash') route = 'slept'
      else if (lastUserText.includes('mail-drive: launch') && offersTool(body, TEAM_CREATE)) route = 'launch'
      else route = 'side'
      hits.push({ route, atMs: Date.now(), lastUserText, results: resultTexts(items) })
      if (route === 'seat-hold') {
        seatCalls++
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(messageStart(model))
        res.write(`event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`)
        res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'holding the line…' } })}`)
        const closed = (): void => {
          if (holdClosedAt === null) holdClosedAt = Date.now()
          if (heartbeat !== null) clearInterval(heartbeat)
          heartbeat = null
        }
        res.on('close', closed)
        res.on('error', closed)
        req.socket.on('close', closed)
        heartbeat = setInterval(() => {
          try {
            res.write(': hb\n\n')
          } catch {
            closed()
          }
        }, 250)
        return
      }
      let blocks: Answer[]
      switch (route) {
        case 'launch':
          blocks = [{ type: 'tool_use', id: 'toolu_mail_team_1', name: TEAM_CREATE, input: { team_name: TEAM, description: 'the mail probe team' } }]
          break
        case 'team-made':
          blocks = [
            {
              type: 'tool_use',
              id: 'toolu_mail_spawn_1',
              name: 'Agent',
              input: {
                name: TEAMMATE,
                team_name: TEAM,
                description: 'mail probe',
                prompt: `${SEAT_MARK} hold the line until told otherwise`,
                subagent_type: 'general-purpose',
              },
            },
          ]
          break
        case 'spawned':
          blocks = [
            { type: 'tool_use', id: 'toolu_mail_send_1', name: SEND_MESSAGE, input: { to: TEAMMATE, message: LINE_1, summary: 'first queued line' } },
            { type: 'tool_use', id: 'toolu_mail_send_2', name: SEND_MESSAGE, input: { to: TEAMMATE, message: LINE_2, summary: 'second queued line' } },
          ]
          break
        case 'mailed':
          blocks = [{ type: 'tool_use', id: 'toolu_mail_sleep_1', name: 'Bash', input: { command: `sleep ${SLEEP_SECONDS}`, description: 'the long sleep' } }]
          break
        case 'slept':
          blocks = [{ type: 'text', text: 'MAIL-SLEPT' }]
          break
        case 'note':
          blocks = [{ type: 'text', text: 'NOTED' }]
          break
        case 'seat':
          seatCalls++
          blocks = [{ type: 'text', text: `SEAT-REPLY ${lastUserText.slice(0, 40)}` }]
          break
        case 'alive':
          blocks = [{ type: 'text', text: ALIVE }]
          break
        default:
          blocks = [{ type: 'text', text: 'side' }]
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(answer(model, blocks))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    holdClosedAt: () => holdClosedAt,
    close: () =>
      new Promise<void>(resolve => {
        if (heartbeat !== null) clearInterval(heartbeat)
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Record<string, string>; markTicks: Record<string, number>; receipts: Array<{ atTick: number; ts: number }>; endReason: string; endedAt: number; stderr: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'teammate-mail-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  let endedAt = 0
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
      endedAt = Date.now()
      resolve()
    })
  })
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
    endReason: payload.endReason ?? '',
    endedAt,
    stderr: stderr.join(''),
  }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'teammate-mail-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'teammate-mail-cwd-')))
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
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
    MERCURY_STREAM_IDLE_TIMEOUT_MS: '180000',
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

function bundleProcesses(): string[] {
  const out = spawnSync('/usr/bin/pgrep', ['-f', BIN], { encoding: 'utf8' }).stdout.trim()
  return out === '' ? [] : out.split('\n')
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

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
console.log(' a teammate mid-turn, mail queued at it, esc, the exit — nothing blocks, nothing survives — real bundle, PTY')
console.log('============================================================')
const KEEP = process.env.TEAMMATE_MAIL_KEEP === '1'
const { home, cwd } = seedWorld()
const fixture = await startFixture(Number(process.env.TEAMMATE_MAIL_PORT ?? 25211))
const before = bundleProcesses()
let mostAlive = 0
const sampler = setInterval(() => {
  mostAlive = Math.max(mostAlive, bundleProcesses().filter(p => !before.includes(p)).length)
}, 500)
const COLS = 120
const ROWS = 40
let cap: Capture | null = null
try {
  cap = await capture(
    {
      argv: ['node', BIN, '--chat', '--teammate-mode', 'in-process'],
      cwd,
      cols: COLS,
      rows: ROWS,
      sends: [
        { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
        { data: 'mail-drive: launch\r', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: '\x1b', awaitText: 'running…', requireAwait: true, minTick: 5, awaitSettleTicks: 6, mark: 'tool-running' },
        { data: '', afterPrevTicks: 12, mark: 'after-esc' },
        { data: 'mail-drive: alive\r', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: '', awaitText: ALIVE, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'alive' },
        { data: '/exit\r', afterPrevTicks: 4, mark: 'pre-exit' },
        { data: '', afterPrevTicks: 8, mark: 'exit' },
      ],
      stableTicks: 6,
      total: 500,
    },
    driveEnv(home, fixture.base),
    150_000,
  )
} catch (error) {
  check('the capture ran', false, String(error).slice(0, 400))
}
clearInterval(sampler)
let after = bundleProcesses().filter(p => !before.includes(p))
for (let i = 0; i < 16 && after.length > 0; i++) {
  await sleep(500)
  after = bundleProcesses().filter(p => !before.includes(p))
}
for (let i = 0; i < 6 && fixture.holdClosedAt() === null; i++) await sleep(500)
const holdClosedAt = fixture.holdClosedAt()
await fixture.close()

if (cap !== null) {
  const m = cap.marks
  const t0 = fixture.hits[0]?.atMs ?? 0
  console.log(`  routes: ${fixture.hits.map(h => h.route).join(' → ')}`)
  for (const h of fixture.hits) console.log(`  hit +${((h.atMs - t0) / 1000).toFixed(1)}s ${h.route} · ${flat(h.lastUserText).slice(0, 100)}${h.results.length > 0 ? ` · results: ${h.results.map(r => flat(r).slice(0, 80)).join(' | ')}` : ''}`)
  console.log(`  send ticks: ${cap.receipts.map(r => r.atTick).join(',')} · marks: ${Object.entries(cap.markTicks).map(([k, v]) => `${k}@${v}`).join(' ')} · end: ${cap.endReason}`)
  for (const label of ['tool-running', 'after-esc', 'alive', 'pre-exit', 'exit']) dump(label, m[label])

  const sendAt = (index: number): number => cap!.receipts[index]?.ts ?? Number.POSITIVE_INFINITY
  const escAt = sendAt(2)
  const exitAt = sendAt(6)
  const seatHits = fixture.hits.filter(h => h.route === 'seat-hold' || h.route === 'seat')
  const seatHitsBefore = (untilMs: number): number => seatHits.filter(h => h.atMs <= untilMs).length
  const mailed = fixture.hits.find(h => h.route === 'mailed')

  console.log('\n— M1 the mail queues at the running teammate —')
  check('the team was made and the teammate spawned on the product\'s own road', fixture.hits.some(h => h.route === 'team-made') && fixture.hits.some(h => h.route === 'spawned'))
  check('M1 the teammate held its seat (served once, the connection held)', seatHitsBefore(escAt) === 1, `${seatHitsBefore(escAt)} seat calls before esc`)
  check('M1 both messages were sent to the teammate while it held (the tool answered for each)', mailed !== undefined && mailed.results.length === 2 && mailed.results.every(r => /sent|delivered|queued/i.test(r) && !/error|fail/i.test(r)), mailed?.results.map(flat).join(' | ').slice(0, 300) ?? 'no request after the sends')

  console.log('\n— M2 esc ends the chat\'s turn alone; the loop is live —')
  check('M2 the chat\'s Bash sleep was running when esc landed', rowsWith(m['tool-running'], 'running…').length > 0, rowsWith(m['tool-running'], /Bash|running/).map(flat).join(' | ').slice(0, 200))
  check('M2 after esc the composer is back (the chat\'s turn ended)', rowsWith(m['after-esc'], 'ype a prompt').length > 0, rowsWith(m['after-esc'], /prompt|interrupt/).map(flat).join(' | ').slice(0, 200))
  check('M2 the teammate\'s held connection stood through esc', holdClosedAt === null || holdClosedAt > exitAt - 500, holdClosedAt === null ? 'never closed' : `closed ${holdClosedAt - escAt} ms after esc`)
  check('M2 no second seat call before the exit (esc did not touch the teammate; its mail waited)', seatHitsBefore(exitAt) === 1, `${seatHitsBefore(exitAt)} seat calls by the exit`)
  check('M2 the chat answered the line typed after esc', rowsWith(m['alive'], ALIVE).length > 0, rowsWith(m['alive'], /ALIVE|alive/).map(flat).join(' | ').slice(0, 200))

  console.log('\n— M3 the exit aborts the teammate with its mail queued; nothing blocks, nothing survives —')
  check('M3 the cockpit exited on /exit (the capture ended at its end of file)', cap.endReason === 'eof', `end=${cap.endReason}`)
  console.log(`  [record] the held seat connection: ${holdClosedAt === null ? 'the fixture never saw its close' : `closed ${holdClosedAt - exitAt} ms after /exit`}`)
  check('M3 the bundle ran as more than one process during the journey (the census has teeth)', mostAlive >= 2, `${mostAlive} at most`)
  check('M3 no process of this bundle survived the exit (cockpit, daemon, runner)', after.length === 0, `alive pids: ${after.join(',')}`)
  check('M3 the queued mail was never served (the abort dropped it, by the runner\'s law)', !fixture.hits.some(h => h.route === 'seat' && /MAIL-OP/.test(h.lastUserText)))
}
for (const pid of after) {
  try {
    process.kill(Number(pid), 'SIGKILL')
  } catch {
  }
}

if (!KEEP) {
  for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${home} cwd=${cwd}`)
}
console.log(failures === 0 ? '\n✅ teammate-mail-abort drive GREEN' : `\n❌ teammate-mail-abort drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
