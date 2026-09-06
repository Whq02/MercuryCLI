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
  console.error(`prove-agent-truth-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const FIXTURE_API_KEY = 'fixture-key-000'
const GPT_ID = 'gpt-5.6-sol'
const SEAT_MARK = 'truth-seat:'
const NOTES_FILE = 'truth-notes.txt'
const SEATS = { foliage: 'foliage', lantern: 'lantern', walker: 'walker', stall: 'stall' } as const
type Seat = keyof typeof SEATS
const LANTERN_READS = 14
const WALKER_READS = 6
const SEAT_STEP_MS = 2500
const PARTIAL_TEXT = 'half the foliage is planted'
const LANTERN_WORD = 'a word for the lantern by its id'
const LANTERN_WORD_2 = 'a second word for the lantern by its name'
const DEAD_WORD = 'a word for the fallen foliage'
const WF_NAME = 'stall-survey'
const WF_SCRIPT = [
  `export const meta = { name: '${WF_NAME}', description: 'one agent stalls and resumes', phases: [{ title: 'Survey' }] }`,
  `phase('Survey')`,
  `const report = await agent('${SEAT_MARK}stall report in one line', { stallMs: 2000 })`,
  'return { report }',
].join('\n')

type Route = 'fault-launch' | 'lantern-launch' | 'message-id' | 'message-name' | 'message-dead' | 'walker-launch' | 'workflow-launch' | 'ack' | 'note' | 'side'
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
const resultTextOf = (content: unknown): string =>
  typeof content === 'string' ? content : blocksOf(content).filter(b => typeof b.text === 'string').map(b => b.text as string).join('\n')
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
function answeredResults(items: Item[]): Array<{ name: string; text: string; description: string }> {
  const last = items[items.length - 1]
  if (!last || last.role !== 'user') return []
  const uses = new Map<string, { name: string; description: string }>()
  for (const item of items) {
    if (item.role !== 'assistant') continue
    for (const b of blocksOf(item.content)) {
      if (b.type === 'tool_use' && typeof b.id === 'string') uses.set(b.id, { name: b.name ?? '', description: String(b.input?.description ?? '') })
    }
  }
  const out: Array<{ name: string; text: string; description: string }> = []
  for (const b of blocksOf(last.content)) {
    if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
    const use = uses.get(b.tool_use_id)
    if (use) out.push({ name: use.name, description: use.description, text: resultTextOf(b.content) })
  }
  return out
}
function receiptIdFor(items: Item[], description: string): string | null {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.role !== 'assistant') continue
    for (const b of blocksOf(item.content)) {
      if (b.type === 'tool_use' && b.name === 'Agent' && String(b.input?.description ?? '') === description && typeof b.id === 'string') ids.add(b.id)
    }
  }
  for (const item of items) {
    if (item.role !== 'user') continue
    for (const b of blocksOf(item.content)) {
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || !ids.has(b.tool_use_id)) continue
      const m = /agentId: (\S+)/.exec(resultTextOf(b.content))
      if (m) return m[1]!
    }
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

type Hit = {
  route: Route | 'gpt-seat' | 'seat'
  seat: Seat | null
  call: number
  atMs: number
  lastUserText: string
  raw: string
  results: Array<{ name: string; text: string; description: string }>
}
type Answer =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
const USAGE = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
function anthropicHead(model: string): string {
  return `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_truth_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...USAGE, output_tokens: 1 } } })}`
}
function answer(model: string, blocks: Answer[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [anthropicHead(model)]
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
const agentLaunch = (id: string, seat: Seat, extra: Record<string, unknown>): Answer => ({
  type: 'tool_use',
  id,
  name: 'Agent',
  input: {
    description: SEATS[seat],
    prompt: `${SEAT_MARK}${seat} read the notes file, one read per turn, then report in one line`,
    subagent_type: 'mercury-general',
    ...extra,
  },
})

async function startFixture(port: number, cwd: string): Promise<{ base: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = []
  let toolSeq = 0
  let acks = 0
  let notes = 0
  let gptCalls = 0
  let stallCalls = 0
  const held: ServerResponse[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        const url = (req.url ?? '').split('?')[0] ?? ''
        if (req.method === 'GET' && url.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: [{ id: GPT_ID, display_name: 'GPT-5.6 Sol', supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', visibility: 'public', supported_in_api: true, priority: 1, context_window: 400_000, input_modalities: ['text', 'image'] }] }))
          return
        }
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: unknown = null
        try {
          body = JSON.parse(raw)
        } catch {
          body = null
        }
        if (req.method === 'POST' && url.endsWith('/responses')) {
          const call = ++gptCalls
          hits.push({ route: 'gpt-seat', seat: 'foliage', call, atMs: Date.now(), lastUserText: '', raw, results: [] })
          const rid = `resp_truth_${call}`
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.write(sse({ type: 'response.created', response: { id: rid } }))
          if (raw.includes(DEAD_WORD)) {
            const text = 'FOLIAGE-RESUMED-DONE'
            res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `msg_${rid}`, role: 'assistant', content: [] } }))
            res.write(sse({ type: 'response.output_text.delta', item_id: `msg_${rid}`, output_index: 0, content_index: 0, delta: text }))
            res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `msg_${rid}`, role: 'assistant', content: [{ type: 'output_text', text }] } }))
            res.end(sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 900, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } } } }))
            return
          }
          res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `msg_${rid}`, role: 'assistant', content: [] } }))
          res.write(sse({ type: 'response.output_text.delta', item_id: `msg_${rid}`, output_index: 0, content_index: 0, delta: PARTIAL_TEXT }))
          await sleep(300)
          res.destroy()
          return
        }
        if (!url.includes('/v1/messages')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
        const items = itemsOf(body)
        const lastUser = [...items].reverse().find(i => i.role === 'user')
        const lastUserText = lastUser ? textOf(lastUser.content) : ''
        const seat = seatOf(items)
        if (seat === 'stall') {
          const call = ++stallCalls
          hits.push({ route: 'seat', seat, call, atMs: Date.now(), lastUserText, raw, results: [] })
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          if (raw.includes('cut off by a no-progress timeout')) {
            res.end(answer(model, [{ type: 'text', text: 'STALL-RESUMED-DONE' }]))
            return
          }
          if (readsOf(items) === 0) {
            res.end(answer(model, [{ type: 'tool_use', id: `toolu_truth_stall_read_${++toolSeq}`, name: 'Read', input: { file_path: join(cwd, NOTES_FILE) } }]))
            return
          }
          setTimeout(() => {
            res.write(anthropicHead(model))
            held.push(res)
          }, 300).unref?.()
          return
        }
        if (seat !== null) {
          const priorReads = readsOf(items)
          const call = hits.filter(h => h.route === 'seat' && h.seat === seat).length + 1
          hits.push({ route: 'seat', seat, call, atMs: Date.now(), lastUserText, raw, results: [] })
          const limit = seat === 'lantern' ? LANTERN_READS : WALKER_READS
          const blocks: Answer[] = priorReads >= limit ? [{ type: 'text', text: `SEAT-DONE-${seat}` }] : [{ type: 'tool_use', id: `toolu_truth_read_${++toolSeq}`, name: 'Read', input: { file_path: join(cwd, NOTES_FILE) } }]
          const payload = answer(model, blocks)
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
            res.end(payload)
          }, priorReads >= limit ? 0 : SEAT_STEP_MS).unref?.()
          return
        }
        const answered = answeredTool(items)
        const results = answeredResults(items)
        const asks: Array<[string, Route]> = [
          ['agent-truth: fault', 'fault-launch'],
          ['agent-truth: launch', 'lantern-launch'],
          ['agent-truth: message-name', 'message-name'],
          ['agent-truth: message-dead', 'message-dead'],
          ['agent-truth: message', 'message-id'],
          ['agent-truth: foreground', 'walker-launch'],
          ['agent-truth: workflow', 'workflow-launch'],
        ]
        let newest: { at: number; route: Route } | null = null
        for (const [word, askRoute] of asks) {
          const at = lastUserText.lastIndexOf(word)
          if (at >= 0 && (newest === null || at > newest.at || (at === newest.at && word.length > (asks.find(a => a[1] === newest!.route)?.[0].length ?? 0)))) newest = { at, route: askRoute }
        }
        let route: Route
        if (!offersTool(body, 'Agent')) route = 'side'
        else if (newest !== null) route = newest.route
        else if (lastUserText.includes('task-notification')) route = 'note'
        else if (answered === 'Agent' || answered === 'SendMessage' || answered === 'Workflow') route = 'ack'
        else route = 'side'
        hits.push({ route, seat: null, call: 0, atMs: Date.now(), lastUserText, raw, results })
        let blocks: Answer[]
        switch (route) {
          case 'fault-launch':
            blocks = [agentLaunch(`toolu_truth_agent_${++toolSeq}`, 'foliage', { run_in_background: true, model: GPT_ID })]
            break
          case 'lantern-launch':
            blocks = [agentLaunch(`toolu_truth_agent_${++toolSeq}`, 'lantern', { run_in_background: true, name: 'lantern' })]
            break
          case 'message-id':
            blocks = [{ type: 'tool_use', id: `toolu_truth_send_${++toolSeq}`, name: 'SendMessage', input: { to: receiptIdFor(items, 'lantern') ?? 'lantern-id-unknown', summary: 'a word by id', message: LANTERN_WORD } }]
            break
          case 'message-name':
            blocks = [{ type: 'tool_use', id: `toolu_truth_send_${++toolSeq}`, name: 'SendMessage', input: { to: 'lantern', summary: 'a word by name', message: LANTERN_WORD_2 } }]
            break
          case 'message-dead':
            blocks = [{ type: 'tool_use', id: `toolu_truth_send_${++toolSeq}`, name: 'SendMessage', input: { to: receiptIdFor(items, 'foliage') ?? 'foliage-id-unknown', summary: 'a word for the dead', message: DEAD_WORD } }]
            break
          case 'walker-launch':
            blocks = [agentLaunch(`toolu_truth_agent_${++toolSeq}`, 'walker', {})]
            break
          case 'workflow-launch':
            blocks = [{ type: 'tool_use', id: `toolu_truth_wf_${++toolSeq}`, name: 'Workflow', input: { script: WF_SCRIPT } }]
            break
          case 'ack':
            blocks = [{ type: 'text', text: `ACK-${++acks}` }]
            break
          case 'note':
            blocks = [{ type: 'text', text: `NOTED-${++notes}` }]
            break
          default:
            blocks = [{ type: 'text', text: 'side' }]
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(answer(model, blocks))
      })().catch(() => {
        try {
          res.writeHead(500)
          res.end()
        } catch {
        }
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
    close: () =>
      new Promise<void>(resolve => {
        for (const res of held) {
          try {
            res.destroy()
          } catch {
          }
        }
        server.close(() => resolve())
      }),
  }
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Record<string, string>; markTicks: Record<string, number>; receipts: Array<{ atTick: number; ts: number }>; endReason: string; stderr: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-truth-cfg-'))
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-truth-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agent-truth-cwd-')))
  writeFileSync(join(cwd, NOTES_FILE), 'the truth notes\n')
  seedFirstRun(home, [cwd])
  return { home, cwd }
}

function driveEnv(home: string, base: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENAI_API_KEY: 'sk-test-agent-truth-openai',
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
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

type Transcript = { path: string; kind: 'session' | 'agent' | 'workflow-agent'; text: string; lines: string[] }
function transcripts(home: string): Transcript[] {
  const out: Transcript[] = []
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
      else if (name.endsWith('.jsonl')) {
        const text = readFileSync(full, 'utf8')
        const kind: Transcript['kind'] = full.includes('/subagents/workflows/') ? 'workflow-agent' : full.includes('/subagents/') ? 'agent' : 'session'
        out.push({ path: full, kind, text, lines: text.split('\n').filter(l => l.trim() !== '') })
      }
    }
  }
  walk(join(home, 'projects'))
  return out
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
console.log(" a child's death, address, stop reason and status — real bundle, PTY")
console.log('============================================================')
const KEEP = process.env.AGENT_TRUTH_KEEP === '1'
const { home, cwd } = seedWorld()
const fixture = await startFixture(Number(process.env.AGENT_TRUTH_PORT ?? 25211), cwd)
let cap: Capture | null = null
try {
  cap = await capture(
    {
      argv: ['node', BIN],
      cwd,
      cols: 120,
      rows: 40,
      sends: [
        { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
        { data: 'agent-truth: fault\r', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'boot' },
        { data: '/teammates\r', awaitText: 'NOTED-1', requireAwait: true, minTick: 10, awaitSettleTicks: 6, mark: 'after-fault' },
        { data: '\x1b', awaitText: SEATS.foliage, requireAwait: true, minTick: 3, awaitSettleTicks: 4, mark: 'crew-fault' },
        { data: 'agent-truth: launch\r', afterPrevTicks: 4 },
        { data: '\x1b', awaitText: 'waiting on 1 agent', requireAwait: true, minTick: 3, awaitSettleTicks: 3, mark: 'lantern-waiting' },
        { data: 'agent-truth: message\r', afterPrevTicks: 8, mark: 'after-lantern-esc' },
        { data: '\x1b', awaitText: 'ACK-2', requireAwait: true, minTick: 3, awaitSettleTicks: 4, mark: 'message-id' },
        { data: 'agent-truth: message-name\r', afterPrevTicks: 6 },
        { data: '\x1b', awaitText: 'ACK-3', requireAwait: true, minTick: 3, awaitSettleTicks: 4, mark: 'message-name' },
        { data: 'agent-truth: message-dead\r', afterPrevTicks: 6 },
        { data: '\x1b', awaitText: 'ACK-4', requireAwait: true, minTick: 3, awaitSettleTicks: 4, mark: 'message-dead' },
        { data: 'agent-truth: foreground\r', afterPrevTicks: 6 },
        { data: '\x1b', awaitText: SEATS.walker, requireAwait: true, minTick: 5, awaitSettleTicks: 6, mark: 'walker-running' },
        { data: '', afterPrevTicks: 15, mark: 'after-walker-esc' },
        { data: 'agent-truth: workflow\r', afterPrevTicks: 4 },
        { data: '', afterPrevTicks: 12, mark: 'workflow-typed' },
        { data: '\r', afterPrevTicks: 8, mark: 'workflow-card' },
        { data: '', afterPrevTicks: 80, mark: 'after-workflow' },
        { data: '\x1b', afterPrevTicks: 2 },
        { data: '/teammates\r', afterPrevTicks: 4 },
        { data: '\x1b', awaitText: SEATS.lantern, requireAwait: true, minTick: 3, awaitSettleTicks: 4, mark: 'crew-end' },
        { data: '', afterPrevTicks: 10, mark: 'end' },
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
  const t0 = fixture.hits[0]?.atMs ?? 0
  console.log(`  routes: ${fixture.hits.map(h => (h.seat !== null ? `${h.route}:${h.seat}#${h.call}` : h.route)).join(' → ')}`)
  for (const h of fixture.hits) {
    if (h.route === 'ack') console.log(`  ack +${((h.atMs - t0) / 1000).toFixed(1)}s ${h.results.map(r => `${r.name}(${r.description}): ${flat(r.text).slice(0, 220)}`).join(' | ')}`)
    if (h.route === 'note') console.log(`  note +${((h.atMs - t0) / 1000).toFixed(1)}s ${flat(h.lastUserText).slice(0, 300)}`)
  }
  console.log(`  send ticks: ${cap.receipts.map(r => r.atTick).join(',')} · marks: ${Object.entries(cap.markTicks).map(([k, v]) => `${k}@${v}`).join(' ')} · end: ${cap.endReason}`)
  for (const label of ['after-fault', 'crew-fault', 'lantern-waiting', 'message-id', 'message-name', 'message-dead', 'walker-running', 'after-walker-esc', 'workflow-typed', 'workflow-card', 'after-workflow', 'crew-end']) dump(label, m[label])
  dump('final', cap.text)
  for (const h of fixture.hits.filter(h => h.route === 'note')) {
    const items = itemsOf(JSON.parse(h.raw))
    const shape = items.slice(-2).map(i => `${i.role}:[${blocksOf(i.content).map(b => `${b.type}${b.type === 'text' ? `(${flat(String(b.text ?? '')).slice(0, 60)})` : ''}`).join(',')}]${typeof i.content === 'string' ? `str(${flat(i.content).slice(0, 60)})` : ''}`)
    console.log(`  note request shape: ${shape.join(' → ')}`)
  }

  const disk = transcripts(home)
  console.log(`  transcripts on disk: ${disk.map(t => `${t.kind}:${t.lines.length}`).join(', ') || 'none'}`)
  const session = disk.filter(t => t.kind === 'session').sort((a, b) => b.lines.length - a.lines.length)[0]
  const foliage = disk.find(t => t.kind === 'agent' && t.text.includes(`${SEAT_MARK}foliage`))
  const lanternTranscript = disk.find(t => t.kind === 'agent' && t.text.includes(`${SEAT_MARK}lantern`))
  const stallAttempts = disk.filter(t => t.kind === 'workflow-agent' && t.text.includes(`${SEAT_MARK}stall`))
  const notes = fixture.hits.filter(h => h.route === 'note')
  const acks = fixture.hits.filter(h => h.route === 'ack')
  if (foliage !== undefined) {
    console.log('  foliage rows:')
    for (const line of foliage.lines) {
      try {
        const rec = JSON.parse(line) as { payload?: { kind?: string; metaKind?: string; content?: unknown; fields?: unknown } }
        const content = rec.payload?.content
        const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<{ kind?: string; text?: string }>).map(b => b.text ?? `<${b.kind}>`).join(' ') : JSON.stringify(rec.payload?.fields ?? '').slice(0, 80)
        console.log(`    ${rec.payload?.kind ?? '?'}${rec.payload?.metaKind ? `/${rec.payload.metaKind}` : ''}: ${flat(text).slice(0, 110)}`)
      } catch {
        console.log(`    (unparsed) ${line.slice(0, 80)}`)
      }
    }
  }
  const gptHits = fixture.hits.filter(h => h.route === 'gpt-seat')
  const lanternId = receiptIdFor(itemsOf(JSON.parse(fixture.hits.find(h => h.route === 'message-id')?.raw ?? '{}')), 'lantern')
  const foliageId = receiptIdFor(itemsOf(JSON.parse(fixture.hits.find(h => h.route === 'message-dead')?.raw ?? '{}')), 'foliage')
  console.log(`  receipt ids: lantern=${lanternId ?? 'none'} foliage=${foliageId ?? 'none'}`)

  console.log('\n— F the death is delivered once, with its cause —')
  const inputRow = (l: string): boolean => /"kind":\s*"input"/.test(l)
  const faultRows = foliage?.lines.filter(l => /"kind":\s*"output"/.test(l) && l.includes('stream fault after partial content')) ?? []
  const recoveryRows = foliage?.lines.filter(l => l.includes('asked the model to continue from where it stopped')) ?? []
  check(`F1 the child's transcript holds two faults and the one recovery between them (${faultRows.length} faults, ${recoveryRows.length} recovery notices)`, faultRows.length === 2 && recoveryRows.length === 1)
  const faultCalls = gptHits.filter(h => !h.raw.includes(DEAD_WORD))
  check(`F1 the seat was asked twice before it died, the second time with the nudge (${faultCalls.length} calls)`, faultCalls.length === 2 && faultCalls[1]?.raw.includes('Pick up exactly where your output stopped') === true)
  const failedNotes = notes.filter(h => h.lastUserText.includes('<status>failed</status>') && h.lastUserText.includes(SEATS.foliage))
  check(`F1 exactly one failed notice reached the parent's model, naming ${SEATS.foliage}`, failedNotes.length === 1, `${failedNotes.length} of ${notes.length} notes`)
  const failedText = failedNotes[0]?.lastUserText ?? ''
  check('F1 the notice carries the typed cause', /stream fault after partial content \(read-failed\)/.test(failedText), flat(failedText).slice(0, 300))
  check('F1 the notice says what landed on disk: no file writes', /no file writes landed/.test(failedText), flat(failedText).slice(0, 300))
  const sessionFailedNotes = session?.lines.filter(l => inputRow(l) && l.includes('task-notification') && l.includes('<status>failed</status>') && l.includes('<tool-use-id>toolu_truth_agent_1</tool-use-id>')) ?? []
  check(`F1 the parent's transcript on disk holds that one death notice for the launch (${sessionFailedNotes.length})`, sessionFailedNotes.length === 1)
  const crewFoliage = rowsWith(m['crew-fault'], SEATS.foliage)
  check('F1 the crew view lists the child failed', crewFoliage.some(r => /failed/.test(r)), crewFoliage.map(flat).join(' | ').slice(0, 300))

  console.log('\n— A the receipt\'s id routes, the name routes —')
  const sendResults = acks.flatMap(h => h.results.filter(r => r.name === 'SendMessage').map(r => r.text))
  for (const r of sendResults) console.log(`  send result: ${flat(r).slice(0, 240)}`)
  check(`A1 SendMessage to the receipt's id (${lanternId ?? 'none'}) queued the message for the running agent`, lanternId !== null && sendResults.some(r => r.includes(`Message queued for ${lanternId}`) && /"success":true/.test(r)))
  check("A2 SendMessage to the launch's name queued the message too", sendResults.some(r => r.includes('Message queued for lantern') && /"success":true/.test(r)))
  const lanternCarrying = fixture.hits.filter(h => h.route === 'seat' && h.seat === 'lantern' && h.raw.includes(LANTERN_WORD) && h.raw.includes(LANTERN_WORD_2))
  check("A3 the lantern seat's next request carried both words", lanternCarrying.length >= 1, `${lanternCarrying.length} carrying calls`)
  check("A3 the lantern's transcript on disk holds both words", lanternTranscript !== undefined && lanternTranscript.text.includes(LANTERN_WORD) && lanternTranscript.text.includes(LANTERN_WORD_2))

  console.log('\n— D a message to the dead child —')
  const deadResult = sendResults.find(r => r.includes(foliageId ?? 'foliage-id-unknown') && !r.includes('Message queued')) ?? ''
  check('D1 the answer names the failure before the resume (never "was stopped")', /failed/.test(deadResult) && !/was stopped/.test(deadResult) && /resumed/.test(deadResult), flat(deadResult).slice(0, 300))
  const resumedCall = gptHits.find(h => h.raw.includes(DEAD_WORD))
  check("D1 the resumed life's request reached the seat carrying the message", resumedCall !== undefined, resumedCall === undefined ? 'no resumed call' : 'resumed')
  check(`D1 the failed notices for the child stay at one after the resume (${failedNotes.length})`, failedNotes.length === 1)
  const resumedNotes = session?.lines.filter(l => inputRow(l) && l.includes('task-notification') && l.includes(`<task-id>${foliageId ?? 'foliage-id-unknown'}</task-id>`) && l.includes('<tool-use-id>toolu_truth_send_')) ?? []
  check(`D1 the resumed life settled once, completed, under the message's own tool-use id (${resumedNotes.length})`, resumedNotes.length === 1 && resumedNotes[0]!.includes('<status>completed</status>'))

  console.log('\n— W the foreground ask handed to the background says why —')
  const walkerReceipts = fixture.hits.flatMap(h => h.results.filter(r => r.name === 'Agent' && r.description === SEATS.walker).map(r => r.text))
  for (const r of walkerReceipts) console.log(`  walker receipt: ${flat(r).slice(0, 300)}`)
  check('W1 the walker\'s receipt reads as a background launch (the hand-over)', walkerReceipts.some(r => r.startsWith('Agent launched in the background.')), walkerReceipts.map(flat).join(' | ').slice(0, 300))
  check('W1 …and says why the foreground request was not honoured: the turn was interrupted', walkerReceipts.some(r => /interrupted/.test(r) && /foreground/.test(r)), walkerReceipts.map(flat).join(' | ').slice(0, 400))
  const walkerRunning = rowsWith(m['after-walker-esc'], /sub-agents? still running|walker/)
  check('W1 after esc the walker runs on (the receipt row or the running word)', walkerRunning.length > 0, walkerRunning.map(flat).join(' | ').slice(0, 300))

  console.log('\n— S the stalled child records the timeout, not the operator —')
  console.log(`  stall attempts on disk: ${stallAttempts.map(t => `${t.lines.length} lines`).join(', ') || 'none'}`)
  const cutAttempt = stallAttempts.find(t => t.text.includes('[Request cut off') || t.text.includes('[Request interrupted by user'))
  check('S1 the stalled attempt\'s transcript names the no-progress timeout as its reason', cutAttempt !== undefined && cutAttempt.text.includes('[Request cut off by a no-progress timeout'), cutAttempt === undefined ? 'no attempt carries a cut row' : 'found')
  check('S1 …and never the operator\'s interruption', !stallAttempts.some(t => t.text.includes('[Request interrupted by user')))
  const stallHits = fixture.hits.filter(h => h.route === 'seat' && h.seat === 'stall')
  const resumedStall = stallHits.find(h => h.raw.includes('cut off by a no-progress timeout'))
  check(`S1 the resumed attempt's request carries the continuation prompt beside the cut row (${stallHits.length} stall calls)`, resumedStall !== undefined && resumedStall.raw.includes('[Request cut off by a no-progress timeout') && !resumedStall.raw.includes('[Request interrupted by user'))
  check('S1 the workflow settled after the resume', notes.some(h => /workflow/i.test(h.lastUserText) && /completed/.test(h.lastUserText)) || (m['after-workflow'] ?? '').includes('STALL-RESUMED-DONE') || (m['after-workflow'] ?? '').includes('Completed'), rowsWith(m['after-workflow'], /workflow|Completed|STALL/i).map(flat).join(' | ').slice(0, 300))
}

if (!KEEP) {
  for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${home} cwd=${cwd}`)
}
console.log(failures === 0 ? '\n✅ agent-truth drive GREEN' : `\n❌ agent-truth drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
