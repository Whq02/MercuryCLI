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
  console.error(`prove-compact-roster-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'
const ASK = 'roster-drive: launch'
const AFTER = 'roster-drive: after'
const SEAT_MARK = 'roster-seat:'
const NOTES_FILE = 'station-notes.txt'
const WF_NAME = 'roster-survey'
const PHASE = 'Survey'
const WF_SEATS = ['wf-one', 'wf-two'] as const
const PLAIN_SEAT = 'plain'
const PLAIN_DESCRIPTION = 'plain-survey'
const LAUNCHED = 'ROSTER-LAUNCHED'
const POST_DONE = 'ROSTER-POST-DONE'
const NOTED = 'ROSTER-NOTED'
const SUMMARY_MARK = 'ROSTER-SUMMARY-BODY'
const WF_READS = 8
const WF_STEP_MS = 3000
const PLAIN_READS = 6
const PLAIN_STEP_MS = 3000
const SUMMARY_HOLD_MS = 2500
const WF_SCRIPT = [
  `export const meta = { name: '${WF_NAME}', description: 'two agents survey the stations', phases: [{ title: '${PHASE}' }] }`,
  `phase('${PHASE}')`,
  `const reports = await parallel([${WF_SEATS.map(s => `() => agent('${SEAT_MARK}${s} read the notes file, one read per turn, then report in one line')`).join(', ')}])`,
  'return { reports }',
].join('\n')

type Route = 'launch' | 'launched' | 'summary' | 'post' | 'note' | 'seat' | 'side'
type Seat = (typeof WF_SEATS)[number] | typeof PLAIN_SEAT
type Block = { type?: string; id?: string; name?: string; text?: string; tool_use_id?: string; content?: unknown; input?: Record<string, unknown> }
type Item = { role?: string; content?: unknown }
type Body = { model?: string; messages?: Item[]; tools?: unknown[] }
const itemsOf = (body: Body | null): Item[] => (Array.isArray(body?.messages) ? body!.messages! : [])
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [])
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : blocksOf(content).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
const offersTool = (body: Body | null, name: string): boolean =>
  Array.isArray(body?.tools) && body!.tools!.some(t => (t as { name?: string })?.name === name)
function answeredTools(items: Item[]): string[] {
  const last = items[items.length - 1]
  if (!last || last.role !== 'user') return []
  const ids = new Set(blocksOf(last.content).filter(b => b.type === 'tool_result' && typeof b.tool_use_id === 'string').map(b => b.tool_use_id as string))
  if (ids.size === 0) return []
  const names: string[] = []
  for (let i = items.length - 2; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'assistant') continue
    for (const use of blocksOf(item.content)) if (use.type === 'tool_use' && typeof use.id === 'string' && ids.has(use.id)) names.push(use.name ?? '')
    if (names.length > 0) break
  }
  return names
}
function seatOf(items: Item[]): Seat | null {
  const userText = items
    .filter(i => i.role === 'user')
    .map(i => textOf(i.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''))
    .filter(t => !t.includes('task-notification'))
    .join('\n')
  for (const s of [...WF_SEATS, PLAIN_SEAT] as Seat[]) if (userText.includes(`${SEAT_MARK}${s}`)) return s
  return null
}
const readsOf = (items: Item[]): number =>
  items.filter(i => i.role === 'assistant' && blocksOf(i.content).some(b => b.type === 'tool_use' && b.name === 'Read')).length
const userTextsOf = (items: Item[]): string[] =>
  items.filter(i => i.role === 'user').map(i =>
    typeof i.content === 'string'
      ? i.content
      : blocksOf(i.content)
          .map(b => (b.type === 'text' ? String(b.text ?? '') : b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : blocksOf(b.content).map(x => String(x.text ?? '')).join('\n')) : ''))
          .join('\n'),
  )

type Hit = { seq: number; route: Route; seat: Seat | null; atMs: number; answeredAtMs: number; model: string; body: Body | null; lastUserText: string }
type Answer =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
const USAGE = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
function answer(model: string, blocks: Answer[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_rosterd_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...USAGE, output_tokens: 1 } } })}`,
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
const SUMMARY_TEXT = [
  '<analysis>the launch turn</analysis>',
  '<summary>',
  `1. Operator Intent: ${SUMMARY_MARK} — launch the survey.`,
  '2. Technical Ground: the loopback fixture.',
  '3. Files and Code Touched: none.',
  '4. Errors and Corrections: none.',
  '5. Problems Worked: none.',
  `6. Operator Messages: "${ASK}".`,
  '7. Open Work: the survey.',
  '8. Where Work Stands: the launches landed.',
  '9. Next Move (optional): wait for the agents.',
  `10. Agents in flight: the workflow ${WF_NAME} (${WF_SEATS.join(', ')}) and the sub-agent ${PLAIN_DESCRIPTION}.`,
  '</summary>',
].join('\n')

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
      let body: Body | null = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
      } catch {
        body = null
      }
      const model = typeof body?.model === 'string' ? body.model : 'fixture'
      const items = itemsOf(body)
      const lastUser = [...items].reverse().find(i => i.role === 'user')
      const lastUserText = lastUser ? textOf(lastUser.content) : ''
      const firstUserText = textOf(items.find(i => i.role === 'user')?.content)
      const seat = seatOf(items)
      const answered = answeredTools(items)
      let route: Route
      if (seat !== null) route = 'seat'
      else if (lastUserText.includes('Reply with prose only')) route = 'summary'
      else if (lastUserText.includes('task-notification')) route = 'note'
      else if (firstUserText.includes('The context window turned over')) route = 'post'
      else if (answered.includes('Workflow') || answered.includes('Agent')) route = 'launched'
      else if (lastUserText.includes(ASK) && offersTool(body, 'Workflow')) route = 'launch'
      else route = 'side'
      const priorReads = readsOf(items)
      const hit: Hit = { seq: hits.length + 1, route, seat, atMs: Date.now(), answeredAtMs: 0, model, body, lastUserText }
      hits.push(hit)
      let blocks: Answer[]
      let delayMs = 0
      switch (route) {
        case 'launch':
          blocks = [
            { type: 'text', text: 'launching the survey and the plain sub-agent' },
            { type: 'tool_use', id: `toolu_rosterd_wf_${++toolSeq}`, name: 'Workflow', input: { script: WF_SCRIPT } },
            {
              type: 'tool_use',
              id: `toolu_rosterd_agent_${++toolSeq}`,
              name: 'Agent',
              input: { description: PLAIN_DESCRIPTION, prompt: `${SEAT_MARK}${PLAIN_SEAT} read the notes file six times, one read per turn, then report in one line`, subagent_type: 'mercury-general', run_in_background: true },
            },
          ]
          break
        case 'launched':
          blocks = [{ type: 'text', text: LAUNCHED }]
          break
        case 'summary':
          blocks = [{ type: 'text', text: SUMMARY_TEXT }]
          delayMs = SUMMARY_HOLD_MS
          break
        case 'post':
          blocks = [{ type: 'text', text: POST_DONE }]
          break
        case 'note':
          blocks = [{ type: 'text', text: NOTED }]
          break
        case 'seat': {
          const reads = seat === PLAIN_SEAT ? PLAIN_READS : WF_READS
          if (priorReads >= reads) {
            blocks = [{ type: 'text', text: `SEAT-DONE-${seat}` }]
          } else {
            blocks = [{ type: 'tool_use', id: `toolu_rosterd_read_${++toolSeq}`, name: 'Read', input: { file_path: join(cwd, NOTES_FILE) } }]
            delayMs = seat === PLAIN_SEAT ? PLAIN_STEP_MS : WF_STEP_MS
          }
          break
        }
        default:
          blocks = [{ type: 'text', text: 'side' }]
      }
      const payload = answer(model, blocks)
      setTimeout(() => {
        hit.answeredAtMs = Date.now()
        if (res.destroyed) return
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
  const dir = mkdtempSync(join(tmpdir(), 'compact-roster-cfg-'))
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'compact-roster-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'compact-roster-cwd-')))
  writeFileSync(join(cwd, NOTES_FILE), 'the station notes\n')
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
console.log(' a seated chat\'s fold re-tells the crew — real bundle, PTY')
console.log('============================================================')
const { home, cwd } = seedWorld()
const fixture = await startFixture(Number(process.env.COMPACT_ROSTER_DRIVE_PORT ?? 25199), cwd)
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
        { data: `${ASK}\r`, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'boot' },
        { data: '\r', awaitText: 'Yes, run this workflow', requireAwait: true, minTick: 2, awaitSettleTicks: 2, mark: 'confirm' },
        { data: '\x1b', awaitText: 'waiting on', requireAwait: true, minTick: 2, awaitSettleTicks: 10, mark: 'waiting' },
        { data: '/compact\r', afterPrevTicks: 8, mark: 'after-esc' },
        { data: `${AFTER}\r`, afterPrevTicks: 45, mark: 'folded' },
        { data: '', afterPrevTicks: 20, mark: 'after' },
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
  const hits = fixture.hits
  const t0 = hits[0]?.atMs ?? 0
  console.log(`  routes: ${hits.map(h => (h.seat !== null ? `seat:${h.seat}` : h.route)).join(' → ')}`)
  for (const h of hits) console.log(`  #${h.seq} +${((h.atMs - t0) / 1000).toFixed(1)}s ${h.seat !== null ? `seat:${h.seat}` : h.route} items=${itemsOf(h.body).length} · ${flat(h.lastUserText).slice(0, 100)}`)
  console.log(`  send ticks: ${cap.receipts.map(r => r.atTick).join(',')} · marks: ${Object.entries(cap.markTicks).map(([k, v]) => `${k}@${v}`).join(' ')} · end: ${cap.endReason}`)
  for (const label of ['waiting', 'after-esc', 'folded', 'after', 'end']) dump(label, m[label])

  console.log('\n— H0 the journey —')
  check('the launch turn went out', hits.some(h => h.route === 'launch'))
  check('the turn was waiting on the crew when esc landed', rowsWith(m['waiting'], /waiting on/).length > 0, rowsWith(m['waiting'], /waiting/).map(flat).join(' | ').slice(0, 200))
  const summary = hits.find(h => h.route === 'summary')
  check('the fold fired (the summariser request went out from the runner)', summary !== undefined, hits.map(h => h.route).join(' → '))
  const post = hits.find(h => h.route === 'post')
  check('the prompt after the fold went out from the summary row', post !== undefined)

  console.log('\n— H1 the summariser asks for the agents in flight —')
  const promptText = summary?.lastUserText ?? ''
  check('ten numbered sections, the tenth Agents in flight, with its laws', promptText.includes('these ten numbered sections') && /10\. Agents in flight/.test(promptText) && /never re-spawned/.test(promptText))

  console.log('\n— H2 the post-fold request carries ONE roster —')
  const postText = post !== undefined ? userTextsOf(itemsOf(post.body)).join('\n') : ''
  const reminders = postText.split('<system-reminder>').filter(t => t.includes('Agents in flight at the context turnover'))
  check('ONE roster attachment rides the request', reminders.length === 1, `${reminders.length} roster reminder(s)`)
  const roster = reminders[0] ?? ''
  for (const line of roster.split('\n').filter(l => l.startsWith('- '))) console.log(`  roster: ${line.slice(0, 220)}`)
  check(`…naming the workflow run ${WF_NAME}`, roster.includes(`local_workflow "${WF_NAME}"`))
  for (const s of WF_SEATS) check(`…and its agent ${s}`, roster.includes(s))
  check(`…and the sub-agent ${PLAIN_DESCRIPTION} with its SendMessage address`, new RegExp(`local_agent "${PLAIN_DESCRIPTION}" \\[a[0-9a-z]+\\]: (running|waiting)`).test(roster) && /reach it: SendMessage to "a[0-9a-z]+"/.test(roster))
  check('…with the never-re-spawn law', roster.includes('A running agent is never re-spawned'))
  check('the old per-task announcer is gone', !postText.includes('is still running. Do NOT spawn a duplicate'))

  console.log('\n— H3 the crew is untouched by the fold —')
  const summaryAnsweredAt = summary?.answeredAtMs ?? Number.POSITIVE_INFINITY
  for (const s of [...WF_SEATS, PLAIN_SEAT] as Seat[]) {
    const after = hits.filter(h => h.seat === s && h.atMs > summaryAnsweredAt).length
    check(`seat ${s} kept calling after the fold (${after} calls)`, after >= 1)
  }
  const notes = hits.filter(h => h.route === 'note')
  check('no killed notice reached the main', notes.every(n => !n.lastUserText.includes('<status>killed</status>')))

  console.log('\n— H4 the roster is never painted —')
  const painted = Object.entries(m).filter(([, frame]) => frame.includes('Agents in flight') || frame.includes('still running in the background'))
  check('no frame paints the roster or the old per-task line', painted.length === 0, painted.map(([k]) => k).join(','))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ COMPACT ROSTER DRIVE GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} COMPACT ROSTER DRIVE FAILURE(S) (${checks} checks)`)
process.exit(1)
