#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  console.error(`prove-crew-interrupt-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'
const LAUNCHED = 'CREW-LAUNCHED'
const NOTED = 'CREW-NOTED'
const SEAT_MARK = 'crew-seat:'
const NOTES_FILE = 'crew-notes.txt'
const SEATS = { one: 'crew-one', two: 'crew-two', three: 'crew-three' } as const
type Seat = keyof typeof SEATS
const SEAT_READS = 10
const SEAT_STEP_MS = 2500
const DECLINE_TEXT = 'CREW-FIXTURE-DECLINE'

type Route = 'launch' | 'launched' | 'fail-launch' | 'note' | 'seat' | 'side'
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
function seatOf(items: Item[]): Seat | null {
  const userText = items
    .filter(i => i.role === 'user')
    .map(i => textOf(i.content))
    .filter(t => !t.includes('task-notification'))
    .join('\n')
  for (const seat of Object.keys(SEATS) as Seat[]) if (userText.includes(`${SEAT_MARK}${seat}`)) return seat
  return null
}
const readsOf = (items: Item[]): number =>
  items.filter(i => i.role === 'assistant' && blocksOf(i.content).some(b => b.type === 'tool_use' && b.name === 'Read')).length

type Hit = { route: Route; seat: Seat | null; atMs: number; lastUserText: string; firstUserText: string; priorReads: number }
type Answer =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
const USAGE = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
function answer(model: string, blocks: Answer[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_crew_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...USAGE, output_tokens: 1 } } })}`,
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

const agentLaunch = (id: string, seat: Seat): Answer => ({
  type: 'tool_use',
  id,
  name: 'Agent',
  input: {
    description: SEATS[seat],
    prompt: `${SEAT_MARK}${seat} read the notes file ten times, one read per turn, then report in one line`,
    subagent_type: 'mercury-general',
    run_in_background: true,
  },
})

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
      const seat = seatOf(items)
      const answered = answeredTool(items)
      let route: Route
      if (seat !== null) route = 'seat'
      else if (lastUserText.includes('task-notification')) route = 'note'
      else if (answered === 'Agent') route = 'launched'
      else if (lastUserText.includes('crew-drive: launch') && offersTool(body, 'Agent')) route = 'launch'
      else if (lastUserText.includes('crew-drive: fail') && offersTool(body, 'Agent')) route = 'fail-launch'
      else route = 'side'
      const priorReads = readsOf(items)
      const userHeads = items.map(i => `${i.role === 'user' ? 'U' : 'A'}:${textOf(i.content).replace(/\s+/g, ' ').slice(0, 36)}${blocksOf(i.content).some(b => b.type === 'tool_result') ? '[tool_result]' : ''}${blocksOf(i.content).some(b => b.type === 'tool_use') ? '[tool_use]' : ''}`)
      hits.push({ route, seat, atMs: Date.now(), lastUserText, firstUserText: userHeads.join(' | '), priorReads })
      let blocks: Answer[]
      let delayMs = 0
      switch (route) {
        case 'launch':
          blocks = [agentLaunch(`toolu_crew_agent_${++toolSeq}`, 'one'), agentLaunch(`toolu_crew_agent_${++toolSeq}`, 'two')]
          break
        case 'fail-launch':
          blocks = [agentLaunch(`toolu_crew_agent_${++toolSeq}`, 'three')]
          break
        case 'launched':
          blocks = [{ type: 'text', text: LAUNCHED }]
          break
        case 'note':
          blocks = [{ type: 'text', text: NOTED }]
          break
        case 'seat':
          if (seat === 'three') {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: DECLINE_TEXT } }))
            return
          }
          if (priorReads >= SEAT_READS) {
            blocks = [{ type: 'text', text: `SEAT-DONE-${seat}` }]
          } else {
            blocks = [{ type: 'tool_use', id: `toolu_crew_read_${++toolSeq}`, name: 'Read', input: { file_path: join(cwd, NOTES_FILE) } }]
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
  const dir = mkdtempSync(join(tmpdir(), 'crew-interrupt-cfg-'))
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'crew-interrupt-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'crew-interrupt-cwd-')))
  writeFileSync(join(cwd, NOTES_FILE), 'the crew notes\n')
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

function agentTranscripts(home: string): Array<{ path: string; seat: Seat | null; lines: string[] }> {
  const out: Array<{ path: string; seat: Seat | null; lines: string[] }> = []
  const walk = (dir: string): void => {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (name.startsWith('agent-') && name.endsWith('.jsonl')) {
        const text = readFileSync(full, 'utf8')
        const lines = text.split('\n').filter(l => l.trim() !== '')
        let seat: Seat | null = null
        for (const s of Object.keys(SEATS) as Seat[]) if (text.includes(`${SEAT_MARK}${s}`)) seat = s
        out.push({ path: full, seat, lines })
      }
    }
  }
  walk(join(home, 'projects'))
  return out
}

const rowsWith = (frame: string | undefined, needle: string | RegExp): string[] =>
  (frame ?? '').split('\n').filter(line => (typeof needle === 'string' ? line.includes(needle) : needle.test(line)))
const RUNNING_WORDS = /running|request sent|waiting for the first byte|first byte in|reasoning|streaming|Read/
const runs = (row: string): boolean => RUNNING_WORDS.test(row)
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
console.log(' the crew survive the chat\'s esc — real bundle, PTY')
console.log('============================================================')
const KEEP = process.env.CREW_INTERRUPT_KEEP === '1'
const { home, cwd } = seedWorld()
const fixture = await startFixture(Number(process.env.CREW_INTERRUPT_PORT ?? 25197), cwd)
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
        { data: 'crew-drive: launch\r', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'boot' },
        { data: '\x1b', awaitText: 'waiting on 2 agents', requireAwait: true, minTick: 2, awaitSettleTicks: 10, mark: 'waiting' },
        { data: '', afterPrevTicks: 15, mark: 'after-esc' },
        { data: '/teammates\r', afterPrevTicks: 2 },
        { data: 'x', awaitText: SEATS.one, requireAwait: true, minTick: 2, awaitSettleTicks: 5, mark: 'crew' },
        { data: 'x', afterPrevTicks: 3, mark: 'x1' },
        { data: '', afterPrevTicks: 12, mark: 'x2' },
        { data: 'r', afterPrevTicks: 5, mark: 'pre-resume' },
        { data: '', afterPrevTicks: 20, mark: 'resumed' },
        { data: '\x1b', afterPrevTicks: 2 },
        { data: 'crew-drive: fail\r', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'chat-again' },
        { data: '', afterPrevTicks: 60, mark: 'end' },
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
  console.log(`  routes: ${fixture.hits.map(h => (h.seat !== null ? `seat:${h.seat}` : h.route)).join(' → ')}`)
  const t0 = fixture.hits[0]?.atMs ?? 0
  for (const h of fixture.hits) console.log(`  hit +${((h.atMs - t0) / 1000).toFixed(1)}s ${h.seat !== null ? `seat:${h.seat}` : h.route} reads=${h.priorReads} · items: ${h.firstUserText.slice(0, 400)}`)
  console.log(`  esc sent at +${(((cap.receipts[2]?.ts ?? 0) - t0) / 1000).toFixed(1)}s · resume sent at +${(((cap.receipts[8]?.ts ?? 0) - t0) / 1000).toFixed(1)}s`)
  console.log(`  send ticks: ${cap.receipts.map(r => r.atTick).join(',')} · marks: ${Object.entries(cap.markTicks).map(([k, v]) => `${k}@${v}`).join(' ')} · end: ${cap.endReason}`)
  for (const label of ['waiting', 'after-esc', 'crew', 'x1', 'x2', 'resumed', 'chat-again', 'end']) dump(label, m[label])

  const escAt = cap.receipts[2]?.ts ?? Number.POSITIVE_INFINITY
  const resumeAt = cap.receipts[8]?.ts ?? Number.POSITIVE_INFINITY
  const after = (seat: Seat, sinceMs: number): Hit[] => fixture.hits.filter(h => h.seat === seat && h.atMs > sinceMs + 300)

  console.log('\n— K1 esc is the chat\'s —')
  check('the turn was waiting on both agents when esc landed', rowsWith(m['waiting'], 'waiting on 2 agents').length > 0, rowsWith(m['waiting'], /waiting/).map(flat).join(' | ').slice(0, 200))
  check('K1 after esc the composer is back (the turn ended)', rowsWith(m['after-esc'], 'ype a prompt').length > 0)
  const oneAfter = after('one', escAt).length
  const twoAfter = after('two', escAt).length
  check(`K1 both seats kept calling the fixture after esc (one: ${oneAfter}, two: ${twoAfter} calls)`, oneAfter >= 1 && twoAfter >= 1)
  const receipt = rowsWith(m['after-esc'], /sub-agents? still running/)
  check('K1 the interruption receipt names the running count and the crew view door', receipt.some(r => r.includes('2 sub-agents still running') && r.includes('crew view')), rowsWith(m['after-esc'], /running|interrupt/).map(flat).join(' | ').slice(0, 300))
  check('K1 the wait\'s state word carries no esc-stops-them clause', !(m['waiting'] ?? '').includes('esc stops them'))
  const crewRows = (name: string): string[] => rowsWith(m['crew'], name)
  check('K1 the crew view lists both agents as running (the status cell speaks the phase)', crewRows(SEATS.one).some(runs) && crewRows(SEATS.two).some(runs), [...crewRows(SEATS.one), ...crewRows(SEATS.two)].map(flat).join(' | ').slice(0, 300))

  console.log('\n— K2 x twice within two seconds —')
  const cursorRow = rowsWith(m['crew'], /▸/).find(r => r.includes(SEATS.one) || r.includes(SEATS.two)) ?? ''
  const stoppedSeat: Seat = cursorRow.includes(SEATS.two) ? 'two' : 'one'
  const otherSeat: Seat = stoppedSeat === 'one' ? 'two' : 'one'
  console.log(`  the cursor row: ${flat(cursorRow).slice(0, 120)} → stopping ${SEATS[stoppedSeat]}`)
  check(`K2 one x paints the hint naming the selected agent ("x again within 2 s stops ${SEATS[stoppedSeat]}")`, (m['x1'] ?? '').includes(`x again within 2 s stops ${SEATS[stoppedSeat]}`), rowsWith(m['x1'], /x again|stops/).map(flat).join(' | ').slice(0, 200))
  const x2Stopped = rowsWith(m['x2'], SEATS[stoppedSeat])
  const x2Other = rowsWith(m['x2'], SEATS[otherSeat])
  const survivorAfter = after(otherSeat, escAt).length
  check(`K1 the surviving seat kept calling through the whole journey (${survivorAfter} calls after esc)`, survivorAfter >= 3)
  check(`K2 the second x stops ${SEATS[stoppedSeat]} alone — its row reads stopped`, x2Stopped.some(r => r.includes('stopped')), x2Stopped.map(flat).join(' | ').slice(0, 200))
  check(`K2 ${SEATS[otherSeat]} keeps running`, x2Other.some(runs), x2Other.map(flat).join(' | ').slice(0, 200))
  check('K2 the stopped row names its reason and offers the resume door', rowsWith(m['x2'], /crew view|r resumes/).length > 0, rowsWith(m['x2'], /stopped|resume/).map(flat).join(' | ').slice(0, 300))

  console.log('\n— K3 the notices —')
  const notes = fixture.hits.filter(h => h.route === 'note')
  for (const note of notes) console.log(`  note: ${flat(note.lastUserText).slice(0, 220)}`)
  const killedFor = (name: string): Hit[] => notes.filter(h => h.lastUserText.includes('<status>killed</status>') && h.lastUserText.includes(name))
  check(`K3 exactly one 'killed' notice reached the main agent, naming ${SEATS[stoppedSeat]}`, killedFor(SEATS[stoppedSeat]).length === 1, `${killedFor(SEATS[stoppedSeat]).length} notices`)
  check(`K3 no 'killed' notice names ${SEATS[otherSeat]}`, killedFor(SEATS[otherSeat]).length === 0)
  const killedText = killedFor(SEATS[stoppedSeat])[0]?.lastUserText ?? ''
  check('K3 the stop notice carries the reason and names the resume door', /stopped/.test(killedText) && /crew view/.test(killedText) && /resume/i.test(killedText), flat(killedText).slice(0, 300))
  const failedNotes = notes.filter(h => h.lastUserText.includes('<status>failed</status>') && h.lastUserText.includes(SEATS.three))
  check(`K3 the declined seat delivered exactly one 'failed' notice naming ${SEATS.three}`, failedNotes.length === 1, `${failedNotes.length} notices; ${notes.length} notes total`)
  check('K3 the failed notice carries the decline text', failedNotes.some(h => h.lastUserText.includes(DECLINE_TEXT)))

  console.log('\n— K4 resume —')
  const resumedHits = fixture.hits.filter(h => h.seat === stoppedSeat && h.atMs >= resumeAt - 200)
  const resumedFirst = resumedHits[0]
  check(`K4 after r the stopped seat called the fixture again (${resumedHits.length} calls)`, resumedHits.length >= 1)
  check('K4 the resumed call carries the reads made before the stop (the transcript stands)', (resumedFirst?.priorReads ?? 0) >= 1, `prior reads ${resumedFirst?.priorReads ?? 'none'}`)
  check('K4 the resumed call carries the resume note (the operator resumed it from the crew view)', /resumed/i.test(resumedFirst?.lastUserText ?? '') && /crew view/.test(resumedFirst?.lastUserText ?? ''), flat(resumedFirst?.lastUserText ?? '').slice(0, 200))
  const resumedRows = rowsWith(m['resumed'], SEATS[stoppedSeat])
  check('K4 its row runs again', resumedRows.some(runs), resumedRows.map(flat).join(' | ').slice(0, 200))
  const transcripts = agentTranscripts(home)
  const stoppedTranscript = transcripts.find(t => t.seat === stoppedSeat)
  console.log(`  transcripts on disk: ${transcripts.map(t => `${t.seat ?? '?'}:${t.lines.length} lines`).join(', ') || 'none'}`)
  check('K4 the stopped agent\'s transcript stands on disk with the reads before the stop and the resume note after', stoppedTranscript !== undefined && stoppedTranscript.lines.some(l => /tool[-_]result/.test(l)) && stoppedTranscript.lines.some(l => /resumed/i.test(l) && /crew view/.test(l)))
}

if (!KEEP) {
  for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${home} cwd=${cwd}`)
}
console.log(failures === 0 ? '\n✅ crew-interrupt drive GREEN' : `\n❌ crew-interrupt drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
