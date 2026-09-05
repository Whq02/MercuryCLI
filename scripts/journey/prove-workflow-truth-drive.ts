#!/usr/bin/env bun
import { spawn } from 'node:child_process'
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
  console.error(`prove-workflow-truth-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'
const ASK = 'wf-truth: launch'
const LAUNCHED = 'WF-LAUNCHED'
const NOTED = 'WF-NOTED'
const SEAT_MARK = 'wf-truth-seat:'
const NOTES_FILE = 'survey-notes.txt'
const WF_NAME = 'truth-survey'
const PHASE = 'Survey'
const STATIONS = ['one', 'two'] as const
type Station = (typeof STATIONS)[number]
const SEAT_READS = 12
const SEAT_STEP_MS = 3000
const FACTS_HOLD_MS = 4000
const WF_SCRIPT = [
  `export const meta = { name: '${WF_NAME}', description: 'two agents survey the stations', phases: [{ title: '${PHASE}' }] }`,
  `phase('${PHASE}')`,
  `const reports = await parallel([${STATIONS.map(s => `() => agent('${SEAT_MARK}${s} read the notes file, one read per turn, then report in one line')`).join(', ')}])`,
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
  for (const s of STATIONS) if (userText.includes(`${SEAT_MARK}${s}`)) return s
  return null
}
const readsOf = (items: Item[]): number =>
  items.filter(i => i.role === 'assistant' && blocksOf(i.content).some(b => b.type === 'tool_use' && b.name === 'Read')).length

type Hit = { route: Route; station: Station | null; atMs: number; lastUserText: string; priorReads: number }
type Answer =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
const USAGE = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
function answer(model: string, blocks: Answer[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_wft_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...USAGE, output_tokens: 1 } } })}`,
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
      const priorReads = readsOf(items)
      hits.push({ route, station, atMs: Date.now(), lastUserText, priorReads })
      let blocks: Answer[]
      let delayMs = 0
      switch (route) {
        case 'launch':
          blocks = [
            { type: 'text', text: 'launching the survey' },
            { type: 'tool_use', id: `toolu_wft_launch_${++toolSeq}`, name: 'Workflow', input: { script: WF_SCRIPT } },
          ]
          break
        case 'launched':
          blocks = [{ type: 'text', text: LAUNCHED }]
          break
        case 'note':
          blocks = [{ type: 'text', text: NOTED }]
          break
        case 'seat':
          if (priorReads >= SEAT_READS) {
            blocks = [{ type: 'text', text: `SEAT-DONE-${station}` }]
          } else {
            blocks = [{ type: 'tool_use', id: `toolu_wft_read_${++toolSeq}`, name: 'Read', input: { file_path: join(cwd, NOTES_FILE) } }]
            delayMs = SEAT_STEP_MS
          }
          break
        default:
          blocks = [{ type: 'text', text: 'side' }]
      }
      const payload = answer(model, blocks)
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
type Capture = { text: string; marks: Record<string, string>; markTicks: Record<string, number>; receipts: Array<{ atTick: number; ts: number }>; endReason: string; stderr: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'wf-truth-cfg-'))
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
    stderr: stderr.join(''),
  }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wf-truth-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'wf-truth-cwd-')))
  writeFileSync(join(cwd, NOTES_FILE), 'the survey notes\n')
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
    MERCURY_SESSION_FACTS_HOLD_MS: String(FACTS_HOLD_MS),
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

function panelRows(frame: string | undefined, label: string, nextLabel: string): string[] {
  const lines = (frame ?? '').split('\n')
  const head = lines.findIndex(l => l.includes(label))
  if (head < 0) return []
  const col = Math.max(0, lines[head]!.indexOf(label) - 4)
  const out: string[] = []
  for (let i = head + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.includes(nextLabel)) break
    out.push(line.slice(col))
  }
  return out
}
function panelCount(frame: string | undefined, label: string): number | null {
  const head = rowsWith(frame, label)[0] ?? ''
  const m = new RegExp(`${label}\\s*[·:]?\\s*(\\d+)`).exec(head)
  return m ? Number(m[1]) : null
}

console.log('============================================================')
console.log(' a running workflow is one truth on every surface — real bundle, PTY')
console.log('============================================================')
const KEEP = process.env.WF_TRUTH_KEEP === '1'
const { home, cwd } = seedWorld()
const fixture = await startFixture(Number(process.env.WF_TRUTH_PORT ?? 25199), cwd)
const COLS = 160
const ROWS = 44
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
        { data: '', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 0, mark: 'skeleton' },
        { data: `${ASK}\r`, afterPrevTicks: 2, awaitSettleTicks: 3, mark: 'boot' },
        { data: '\r', awaitText: 'Yes, run this workflow', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'ask' },
        { data: '', awaitText: LAUNCHED, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'launched' },
        { data: '', afterPrevTicks: 30, mark: 'cockpit-busy' },
        { data: '/workflows\r', afterPrevTicks: 2 },
        { data: '\r', awaitText: WF_NAME, requireAwait: true, minTick: 2, awaitSettleTicks: 5, mark: 'board' },
        { data: '', afterPrevTicks: 12, mark: 'run' },
        { data: '\x1b', afterPrevTicks: 2 },
        { data: '\x1b', afterPrevTicks: 3 },
        { data: '', afterPrevTicks: 8, mark: 'cockpit-again' },
        { data: '', awaitText: NOTED, requireAwait: true, minTick: 2, awaitSettleTicks: 12, mark: 'settled' },
        { data: '/workflows\r', afterPrevTicks: 2 },
        { data: '', afterPrevTicks: 12, mark: 'board-settled' },
        { data: '\x1b', afterPrevTicks: 2 },
        { data: '', afterPrevTicks: 6, mark: 'end' },
      ],
      stableTicks: 6,
      total: 1100,
    },
    driveEnv(home, fixture.base),
    280_000,
  )
} catch (error) {
  check('the capture ran', false, String(error).slice(0, 400))
}
await fixture.close()

if (cap !== null) {
  const m = cap.marks
  console.log(`  routes: ${fixture.hits.map(h => (h.station !== null ? `seat:${h.station}(${h.priorReads})` : h.route)).join(' → ')}`)
  console.log(`  send ticks: ${cap.receipts.map(r => r.atTick).join(',')} · marks: ${Object.entries(cap.markTicks).map(([k, v]) => `${k}@${v}`).join(' ')} · end: ${cap.endReason}`)
  for (const label of ['skeleton', 'launched', 'cockpit-busy', 'board', 'run', 'cockpit-again', 'settled', 'board-settled']) dump(label, m[label])
  check('every send became due (the frames the sends waited on all painted)', cap.receipts.length === 17, `${cap.receipts.length}/17 · end ${cap.endReason}`)

  const seatHits = (s: Station): Hit[] => fixture.hits.filter(h => h.station === s)
  check(`both seats ran on the wire (one: ${seatHits('one').length}, two: ${seatHits('two').length} calls)`, seatHits('one').length >= 3 && seatHits('two').length >= 3)
  check('the main\'s turn ended on the launch (the workflow ran on in the runner)', rowsWith(m['launched'], LAUNCHED).length > 0 && rowsWith(m['launched'], 'ype a prompt').length > 0)

  console.log('\n— W4 the board and the run view —')
  const boardRow = rowsWith(m['board'], WF_NAME)
  check('W4 the board lists the run under Active', rowsWith(m['board'], 'Active').length > 0 && boardRow.length > 0, boardRow.map(flat).join(' | ').slice(0, 300))
  check('W4 the board\'s header rollup counts the run and its agents (1 running · 0/2 agents)', rowsWith(m['board'], /1 running · 0\/2 agents/).length > 0, rowsWith(m['board'], /running/).map(flat).join(' | ').slice(0, 300))
  const laneWords = /running|queued|Read|thinking|request sent|first byte|reasoning|streaming/
  const runOne = rowsWith(m['run'], `${SEAT_MARK}one`)
  const runTwo = rowsWith(m['run'], `${SEAT_MARK}two`)
  check('W4 the run view shows both agents running', runOne.some(r => laneWords.test(r)) && runTwo.some(r => laneWords.test(r)), [...runOne, ...runTwo].map(flat).join(' | ').slice(0, 400))

  console.log('\n— W1 the WORKFLOW panel at the busy moment —')
  for (const label of ['cockpit-busy', 'cockpit-again'] as const) {
    const panel = panelRows(m[label], 'WORKFLOW', 'HEALTH')
    const words = panel.map(flat).filter(Boolean).join(' | ')
    check(`W1 [${label}] the panel does not read idle while the run lives`, panel.length > 0 && !panel.some(r => /\bidle\b/.test(r)), words.slice(0, 300))
    check(`W1 [${label}] the panel names the run`, panel.some(r => r.includes(WF_NAME)), words.slice(0, 300))
    check(`W1 [${label}] the panel carries the agent fraction and the phase (0/2 agents · ${PHASE})`, panel.some(r => /0\/2 agents/.test(r)) && panel.some(r => r.includes(PHASE)), words.slice(0, 300))
    check(`W1 [${label}] the panel's count agrees with the board (1 run)`, panelCount(m[label], 'WORKFLOW') === 1, `count ${panelCount(m[label], 'WORKFLOW')}`)
  }

  console.log('\n— W2 the launch line —')
  for (const label of ['cockpit-busy', 'cockpit-again'] as const) {
    const fallback = rowsWith(m[label], 'to view dynamic workflow runs')
    const live = rowsWith(m[label], /Running ·/)
    check(`W2 [${label}] the launch line reads Running with the live count, never the open-the-board fallback`, fallback.length === 0 && live.some(r => /2 running|2 agents/.test(r)), [...live, ...fallback].map(flat).join(' | ').slice(0, 300))
    check(`W2 [${label}] the launch line names the phase and the last-event age`, live.some(r => r.includes(PHASE) && /last event \d+[smh]/.test(r)), live.map(flat).join(' | ').slice(0, 300))
  }

  console.log('\n— W3 the heartbeat chip —')
  for (const label of ['cockpit-busy', 'cockpit-again'] as const) {
    const chip = rowsWith(m[label], /◐ wf(\s|×)/)
    check(`W3 [${label}] the frame's wf chip stands while the run lives, naming the phase and the age`, chip.some(r => new RegExp(`◐ wf ${PHASE} \\d+[smh]`).test(r)), chip.map(flat).join(' | ').slice(0, 200))
  }

  console.log('\n— W7 the skeleton window —')
  {
    const panel = panelRows(m['skeleton'], 'WORKFLOW', 'HEALTH')
    const words = panel.map(flat).filter(Boolean).join(' | ')
    check('W7 before the runner\'s first answer the panel never reads idle (a skeleton fact is not a fact)', panel.length > 0 && !panel.some(r => /\bidle\b/.test(r)), words.slice(0, 200))
    check('W7 …it paints the unknown mark instead', panel.some(r => /—/.test(r)), words.slice(0, 200))
  }

  console.log('\n— W6 the wait words —')
  for (const label of ['cockpit-busy', 'cockpit-again'] as const) {
    const waits = rowsWith(m[label], /waiting on/)
    check(`W6 [${label}] the strip says the turn waits on 1 workflow — never on "1 agent"`, waits.length > 0 && waits.every(r => r.includes('waiting on 1 workflow')) && !waits.some(r => /waiting on 1 agent/.test(r)), waits.map(flat).join(' | ').slice(0, 300))
  }

  console.log('\n— W5 the settle —')
  const settledPanel = panelRows(m['settled'], 'WORKFLOW', 'HEALTH')
  check('W5 once the run settled the panel reads idle', settledPanel.some(r => /\bidle\b/.test(r)) && !settledPanel.some(r => r.includes(WF_NAME)), settledPanel.map(flat).filter(Boolean).join(' | ').slice(0, 200))
  check('W5 the launch line reads Completed with the agent count', rowsWith(m['settled'], /Completed/).some(r => /2 agents/.test(r)), rowsWith(m['settled'], /Completed|Running/).map(flat).join(' | ').slice(0, 300))
  check('W5 the board counts the settled run under Recent and none under Active', rowsWith(m['board-settled'], /Active \(0\)/).length > 0 && rowsWith(m['board-settled'], /Recent \(1\)/).length > 0, rowsWith(m['board-settled'], /Active|Recent/).map(flat).join(' | ').slice(0, 300))
  check('W5 the settle carried the output file (no missing-file warning in the notice)', !Object.values(m).some(f => /output file could not be written/.test(f)) && fixture.hits.some(h => h.route === 'note' && !h.lastUserText.includes('could not be written')))
  check('W5 the completion notice reached the main agent', fixture.hits.some(h => h.route === 'note' && h.lastUserText.includes('<status>completed</status>')))
  check('nothing read stuck', !Object.values(m).some(f => /may be stuck/.test(f)))
}

if (!KEEP) {
  for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${home} cwd=${cwd}`)
}
console.log(failures === 0 ? '\n✅ workflow-truth drive GREEN' : `\n❌ workflow-truth drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
