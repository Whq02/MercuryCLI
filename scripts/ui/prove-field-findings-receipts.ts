#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] capture driver unavailable — ${driver.kind === 'unavailable' ? driver.reason : driver.kind}`)
  process.exit(0)
}

const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { readSessionFacts, sessionFactsDir } = await import('../../src/services/engine-connector/seatProjections.ts')
const { CREW_EMPTY_LINE } = await import('../../src/services/engine-connector/crewFacts.ts')

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
function itemsOf(body: unknown): unknown[] {
  const b = body as { messages?: unknown }
  return Array.isArray(b?.messages) ? b.messages : []
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
        if (block.type === 'text' && typeof block.text === 'string') text += `\n${block.text}`
      }
    }
    if (text.includes('crew-seat:') || text.includes('crew-drive:')) last = text
  }
  return last
}
function carriesToolResult(body: unknown): boolean {
  for (const m of itemsOf(body)) {
    const item = m as { role?: string; content?: unknown }
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
type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
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
interface Fixture {
  base: string
  hits: Route[]
  close(): Promise<void>
}
async function startCrewFixture(seatSleepSeconds: number): Promise<Fixture> {
  const hits: Route[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
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
      hits.push(route)
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
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
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
  const dir = mkdtempSync(join(tmpdir(), 'field-receipts-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(300_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'field-receipts-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'field-receipts-cwd-')))
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

const COLS = 160
const ROWS = 44
const flat = (s: string): string => s.replace(/\s+/g, ' ')
const SPLASH_READY = 'type a prompt, or / for commands'
const SHIFT_LEFT = '\x1b[1;2D'
const BOARD = 'SESSION CONCOURSE'
const FACE_READY = '↵ start  ·  m menu  ·  ↑↓ choose'

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

const namesSeat = (frame: string): boolean => frame.includes(SEAT_ONE) || frame.includes(SEAT_TWO)
const attributesCrew = (frame: string): boolean => /sub-agents \d[\d.,]*k? (tokens|spent)/.test(flat(frame))

console.log('— a crew lands, then a fresh session is born in place —')
const fixture = await startCrewFixture(3)
const { home, cwd } = seedWorld()
let cap: Capture
try {
  cap = await capture(
    {
      cols: COLS,
      rows: ROWS,
      total: 420,
      cwd,
      argv: ['node', DIST],
      sends: [
        ...bootSends(ASK),
        { data: '/teammates', atTick: 999, awaitText: 'agents finished', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'landed' },
        { data: '\r', afterPrevTicks: 4 },
        { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-landed' },
        { data: '/clear', afterPrevTicks: 4 },
        { data: '\r', afterPrevTicks: 3 },
        { data: '/teammates', atTick: 999, awaitText: SPLASH_READY, requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'fresh' },
        { data: '\r', afterPrevTicks: 4 },
        { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'fresh-crew' },
        { data: SHIFT_LEFT, afterPrevTicks: 4, mark: 'fresh-after' },
        { data: SHIFT_LEFT, atTick: 999, awaitText: BOARD, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'board' },
        { data: '\r', atTick: 999, awaitText: FACE_READY, requireAwait: true, minTick: 2, awaitStableTicks: 4, awaitSettleTicks: 3, mark: 'face' },
        { data: '/teammates', atTick: 999, awaitText: SPLASH_READY, requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'fresh-b' },
        { data: '\r', afterPrevTicks: 4 },
        { data: '\x1b', atTick: 999, awaitText: 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'fresh-crew-b' },
        { data: '', afterPrevTicks: 4, mark: 'fresh-after-b' },
      ],
      stableTicks: 6,
    },
    driveEnv(home, fixture.base),
  )
} finally {
  await fixture.close()
}
const { marks } = cap
if (process.env.FIELD_KEEP === '1') for (const [label, frame] of Object.entries(marks)) dump(label, frame)
check('every send became due (the frames the sends waited on all painted)', cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
check('the crew ran and landed on the wire (parent → two seats → the ack)', fixture.hits.filter(h => h === 'seat').length >= 2 && fixture.hits.includes('parent-ack'), fixture.hits.join(','))
const landed = marks['landed'] ?? ''
check('the previous session\'s crew was on every surface: the card names both seats and the usage line attributes the crew', namesSeat(landed) && landed.includes('agents finished') && attributesCrew(landed))
const crewLanded = marks['crew-landed'] ?? ''
check('the previous session\'s Crew view listed both, landed', namesSeat(crewLanded) && crewLanded.includes('0 running · 2 sub-agents'))
const fresh = marks['fresh'] ?? ''
check('the born session is a fresh chat (its splash is up, no card)', fresh.includes(SPLASH_READY) && !fresh.includes('agents finished'))
check('the born session names no seat of the previous session (the CREW lane, the transcript)', !namesSeat(fresh), fresh.split('\n').filter(l => namesSeat(l)).join(' | '))
check('the born session attributes no sub-agents in its usage line', !attributesCrew(fresh), flat(fresh).match(/sub-agents[^·]*/)?.[0] ?? '')
const freshCrew = marks['fresh-crew'] ?? ''
check(`the born session's Crew view reads the honest empty line ("${CREW_EMPTY_LINE}") and names no seat`, freshCrew.includes(CREW_EMPTY_LINE) && !namesSeat(freshCrew), freshCrew.split('\n').filter(l => /sub-agent|running/.test(l)).join(' | '))
const freshAfter = marks['fresh-after'] ?? ''
check('back on the fresh chat, still none of it', !namesSeat(freshAfter) && !attributesCrew(freshAfter))
check('the leave gesture reached the concourse, then the face', (marks['board'] ?? '').includes(BOARD) && (marks['face'] ?? '').includes(FACE_READY))
const freshB = marks['fresh-b'] ?? ''
check('the session born from the face is a fresh chat naming no earlier seat and attributing no sub-agents', freshB.includes(SPLASH_READY) && !namesSeat(freshB) && !attributesCrew(freshB), freshB.split('\n').filter(l => namesSeat(l) || attributesCrew(l)).join(' | '))
const freshCrewB = marks['fresh-crew-b'] ?? ''
check(`its Crew view reads "${CREW_EMPTY_LINE}" and names no seat`, freshCrewB.includes(CREW_EMPTY_LINE) && !namesSeat(freshCrewB), freshCrewB.split('\n').filter(l => /sub-agent|running/.test(l)).join(' | '))
check('back on that chat, still none of it', !namesSeat(marks['fresh-after-b'] ?? '') && !attributesCrew(marks['fresh-after-b'] ?? ''))

const daemonDir = join(home, 'daemon')
const records = Object.values(readSessionWorkers(daemonDir)).sort((a, b) => a.spawnedAt - b.spawnedAt)
const crewSession = records[0]
const bornSessions = records.slice(1)
check('three sessions exist on the daemon\'s board: the crew\'s, the one born in place, the one born from the face', records.length === 3, `${records.length} records`)
check('every born session has its own id', crewSession !== undefined && bornSessions.every(r => r.sessionId !== crewSession.sessionId) && new Set(records.map(r => r.sessionId)).size === records.length)
const files = existsSync(sessionFactsDir(daemonDir)) ? readdirSync(sessionFactsDir(daemonDir)) : []
for (const born of bornSessions) {
  const facts = readSessionFacts(born.sessionId, daemonDir)
  check(`the born session ${born.runnerId}'s facts projection carries no work rows`, facts !== null && (facts.work ?? []).length === 0, facts === null ? 'no projection' : `${(facts.work ?? []).length} rows`)
  check(`the born session ${born.runnerId}'s projection is its own file, keyed by its id`, files.some(f => f.startsWith(born.sessionId)), files.join(','))
}
if (failures > 0 && process.env.FIELD_KEEP !== '1') for (const [label, frame] of Object.entries(marks)) dump(label, frame)
if (failures > 0 || process.env.FIELD_KEEP === '1') dump('final grid', cap.text)
rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })

console.log(failures === 0 ? '\nprove-field-findings-receipts: ALL LAWS HOLD' : `\nprove-field-findings-receipts: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
