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
const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
const { vshotBudgetMs, resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-header-truth-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const SEAT_MARK = 'hdr-seat:'
const NOTE_FILES = 30
const noteFile = (n: number): string => `hdr-notes-${n}.txt`
const SEATS = { one: 'hdr-one', two: 'hdr-two', three: 'hdr-three', four: 'hdr-four', five: 'hdr-five' } as const
type Seat = keyof typeof SEATS
const SEAT_READS: Record<Seat, number> = { one: 30, two: 30, three: 4, four: 4, five: 3 }
const SEAT_STEP_MS = 2500
const THINK_LONG_STEPS = 40
const THINK_SHORT_STEPS = 3
const THINK_STEP_MS = 1000
const FIRST_BYTE_HOLD_MS = 10_000
const IDLE_BUDGET_MS = 16_000
const NAP_SECONDS = 8

type Block = { type?: string; id?: string; name?: string; text?: string; tool_use_id?: string; content?: unknown; input?: Record<string, unknown> }
type Item = { role?: string; content?: unknown }
const itemsOf = (body: unknown): Item[] => {
  const b = body as { messages?: unknown }
  return Array.isArray(b?.messages) ? (b.messages as Item[]) : []
}
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [])
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : blocksOf(content).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
const hasToolResult = (content: unknown): boolean => blocksOf(content).some(b => b.type === 'tool_result')
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
function askOf(items: Item[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'user' || hasToolResult(item.content)) continue
    const text = textOf(item.content)
    if (text.includes('task-notification')) continue
    const m = /hdr: ([a-z0-9]+)/.exec(text)
    if (m) return m[1]!
  }
  return null
}
function seatOf(items: Item[]): Seat | null {
  const userText = items
    .filter(i => i.role === 'user' && !hasToolResult(i.content))
    .map(i => textOf(i.content))
    .filter(t => !t.includes('task-notification'))
    .join('\n')
  for (const seat of Object.keys(SEATS) as Seat[]) if (userText.includes(`${SEAT_MARK}${seat}`)) return seat
  return null
}
const readsOf = (items: Item[]): number =>
  items.filter(i => i.role === 'assistant' && blocksOf(i.content).some(b => b.type === 'tool_use' && b.name === 'Read')).length

type Hit = { route: string; seat: Seat | null; atMs: number; lastUserText: string }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
let toolSeq = 0
const USAGE = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const head = (model: string): string =>
  `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_hdr_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...USAGE, output_tokens: 1 } } })}`
const tail = (stop: 'end_turn' | 'tool_use'): string =>
  `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { ...USAGE, output_tokens: 40 } })}` +
  `event: message_stop\n${sse({ type: 'message_stop' })}`
const textBlock = (index: number, text: string): string =>
  `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}` +
  `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })}` +
  `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`
const toolBlock = (index: number, id: string, name: string, input: Record<string, unknown>): string =>
  `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })}` +
  `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}` +
  `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`
const thinkingBlock = (index: number, thinking: string): string =>
  `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })}` +
  `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })}` +
  `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'fixture-signature' } })}` +
  `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`
const agentLaunch = (index: number, seat: Seat, background: boolean): string =>
  toolBlock(index, `toolu_hdr_agent_${++toolSeq}`, 'Agent', {
    description: SEATS[seat],
    prompt: `${SEAT_MARK}${seat} read the ${SEAT_READS[seat]} note files, one read per turn, then report in one line`,
    subagent_type: 'mercury-general',
    run_in_background: background,
  })
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
type SseBlock = Record<string, unknown> & { _json?: string }
function messageFromSse(sseText: string): Record<string, unknown> {
  let message: Record<string, unknown> = {}
  const blocks: SseBlock[] = []
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const ev = JSON.parse(line.slice(6)) as Record<string, unknown>
    const index = typeof ev.index === 'number' ? ev.index : -1
    switch (ev.type) {
      case 'message_start':
        message = { ...(ev.message as Record<string, unknown>) }
        break
      case 'content_block_start':
        if (index >= 0) blocks[index] = { ...(ev.content_block as Record<string, unknown>) }
        break
      case 'content_block_delta': {
        const block = index >= 0 ? blocks[index] : undefined
        const delta = ev.delta as Record<string, unknown>
        if (block === undefined) break
        if (delta.type === 'text_delta') block.text = `${String(block.text ?? '')}${String(delta.text ?? '')}`
        else if (delta.type === 'thinking_delta') block.thinking = `${String(block.thinking ?? '')}${String(delta.thinking ?? '')}`
        else if (delta.type === 'signature_delta') block.signature = delta.signature
        else if (delta.type === 'input_json_delta') block._json = `${block._json ?? ''}${String(delta.partial_json ?? '')}`
        break
      }
      case 'content_block_stop': {
        const block = index >= 0 ? blocks[index] : undefined
        if (block !== undefined && block._json !== undefined) {
          block.input = JSON.parse(block._json) as unknown
          delete block._json
        }
        break
      }
      case 'message_delta': {
        const delta = ev.delta as Record<string, unknown>
        message.stop_reason = delta.stop_reason
        message.stop_sequence = delta.stop_sequence
        message.usage = { ...(message.usage as Record<string, unknown>), ...(ev.usage as Record<string, unknown>) }
        break
      }
      default:
        break
    }
  }
  return { ...message, content: blocks.filter(block => block !== undefined) }
}

async function startFixture(port: number, cwd: string): Promise<{ base: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = []
  let stuckServed = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    let closed = false
    res.on('close', () => {
      closed = true
    })
    res.on('error', () => {
      closed = true
    })
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      void (async () => {
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
        const ask = askOf(items)
        const stream = (): void => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const live = (): boolean => !closed && !res.destroyed && !(req.socket?.destroyed ?? false)
        const streaming = (body as { stream?: unknown } | null)?.stream === true
        const reply = (sseText: string): void => {
          if (streaming) {
            stream()
            res.end(sseText)
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(messageFromSse(sseText)))
        }
        let route: string
        if (seat !== null) route = `seat:${seat}`
        else if (lastUserText.includes('task-notification')) route = 'note'
        else if (answered === 'Agent') route = `launched:${ask ?? '?'}`
        else if (answered === 'Bash') route = 'tool-done'
        else if (ask !== null && (ask !== 'launch' && ask !== 'launch2' && ask !== 'fore' || offersTool(body, 'Agent'))) route = ask
        else route = 'side'
        hits.push({ route, seat, atMs: Date.now(), lastUserText })
        if (seat !== null) {
          const priorReads = readsOf(items)
          if (priorReads >= SEAT_READS[seat]) {
            reply(head(model) + textBlock(0, `SEAT-DONE-${seat}`) + tail('end_turn'))
            return
          }
          await sleep(SEAT_STEP_MS)
          if (!live()) return
          reply(head(model) + toolBlock(0, `toolu_hdr_read_${++toolSeq}`, 'Read', { file_path: join(cwd, noteFile(priorReads % NOTE_FILES)) }) + tail('tool_use'))
          return
        }
        switch (route) {
          case 'note':
            reply(head(model) + textBlock(0, 'HDR-NOTED') + tail('end_turn'))
            return
          case 'launch':
            reply(head(model) + agentLaunch(0, 'one', true) + agentLaunch(1, 'two', true) + tail('tool_use'))
            return
          case 'launch2':
            reply(head(model) + agentLaunch(0, 'three', true) + agentLaunch(1, 'four', true) + tail('tool_use'))
            return
          case 'fore':
            reply(head(model) + agentLaunch(0, 'five', false) + tail('tool_use'))
            return
          case 'launched:launch':
          case 'launched:launch2': {
            const steps = route === 'launched:launch' ? THINK_LONG_STEPS : THINK_SHORT_STEPS
            const launchedText = route === 'launched:launch' ? 'HDR-LAUNCHED' : 'HDR-LAUNCHED-2'
            if (!streaming) {
              reply(head(model) + thinkingBlock(0, 'weighing the launch ') + textBlock(1, launchedText) + tail('end_turn'))
              return
            }
            stream()
            res.write(head(model))
            res.write(`event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}`)
            for (let i = 0; i < steps; i++) {
              if (!live()) return
              res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing the launch ' } })}`)
              await sleep(THINK_STEP_MS)
            }
            if (!live()) return
            res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } })}`)
            res.write(`event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`)
            res.end(textBlock(1, launchedText) + tail('end_turn'))
            return
          }
          case 'launched:fore':
            reply(head(model) + textBlock(0, 'HDR-FORE-DONE') + tail('end_turn'))
            return
          case 'tool-done':
            reply(head(model) + textBlock(0, 'HDR-TOOL-DONE') + tail('end_turn'))
            return
          case 'wait':
            await sleep(FIRST_BYTE_HOLD_MS)
            if (!live()) return
            reply(head(model) + textBlock(0, 'HDR-WAITED') + tail('end_turn'))
            return
          case 'tool':
            reply(head(model) + toolBlock(0, `toolu_hdr_bash_${++toolSeq}`, 'Bash', { command: `sleep ${NAP_SECONDS}`, description: 'the eight second nap' }) + tail('tool_use'))
            return
          case 'stuck': {
            stuckServed += 1
            if (stuckServed > 1) {
              reply(head(model) + textBlock(0, 'HDR-STUCK-DONE') + tail('end_turn'))
              return
            }
            if (!streaming) {
              reply(head(model) + textBlock(0, 'HDR-') + textBlock(1, 'late') + tail('end_turn'))
              return
            }
            stream()
            res.write(head(model))
            res.write(`event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`)
            res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'HDR-' } })}`)
            await sleep(IDLE_BUDGET_MS * 3)
            if (!live()) return
            res.end(textBlock(1, 'late') + tail('end_turn'))
            return
          }
          default:
            reply(head(model) + textBlock(0, 'side') + tail('end_turn'))
        }
      })().catch(() => {
        try {
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
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Record<string, string>; markTicks: Record<string, number>; receipts: Array<{ atTick: number; ts: number }>; endReason: string; stderr: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'header-truth-cfg-'))
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'header-truth-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'header-truth-cwd-')))
  for (let n = 0; n < NOTE_FILES; n++) writeFileSync(join(cwd, noteFile(n)), `the header note ${n}\n`)
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
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_STREAM_IDLE_TIMEOUT_MS: String(IDLE_BUDGET_MS),
  }
}

const rows = (frame: string | undefined): string[] => (frame ?? '').split('\n')
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
const GLYPHS = /[◐◓◑◒]/
const CLOCK = /\b\d\d:\d\d:\d\d\b/
const PHASE_WORDS = /\b(thinking|running a tool|replying|compacting)\b/
const CREW_CLOCK = /\b(agents?|workflows?) thought for \d+[sm]\b/
const headerIndex = (frame: string | undefined): number => rows(frame).findIndex(r => r.includes('✶ SESSION'))
const headerRow = (frame: string | undefined): string => rows(frame)[headerIndex(frame)] ?? ''
const statusIndex = (frame: string | undefined): number => rows(frame).findIndex(r => r.includes('⇧← back'))
const statusRow = (frame: string | undefined): string => rows(frame)[statusIndex(frame)] ?? ''
const crewClock = (frame: string | undefined): string => (/\b(?:agents?|workflows?) thought for (\d+[sm])\b/.exec(statusRow(frame)) ?? ['', ''])[1]!
const crewClockAdvances = (a: string | undefined, b: string | undefined): boolean => crewClock(a) !== '' && crewClock(b) !== '' && crewClock(a) !== crewClock(b)
const crewClockStands = (a: string | undefined, b: string | undefined): boolean => crewClock(a) !== '' && crewClock(a) === crewClock(b)
const noGlyph = (frame: string | undefined): boolean => statusGlyph(frame) === ''
const statusGlyph = (frame: string | undefined): string => (GLYPHS.exec(statusRow(frame)) ?? [''])[0]!
const berth = (frame: string | undefined): string => rows(frame).slice(2, 13).join('\n')
function headerRight(frame: string | undefined): string {
  const row = headerRow(frame).replace(/│/g, ' ')
  const at = row.indexOf('✶ SESSION')
  return at < 0 ? '' : row.slice(at + '✶ SESSION'.length).trim()
}
function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row}`)
}

console.log('============================================================')
console.log(' the title row and the bottom row tell two truths — real bundle, PTY')
console.log('============================================================')
const KEEP = process.env.HEADER_TRUTH_KEEP === '1'
const { home, cwd } = seedWorld()
const fixture = await startFixture(Number(process.env.HEADER_TRUTH_PORT ?? 25233), cwd)
const COLS = 120
const ROWS = 40
const ask = (text: string, mark?: string): Record<string, unknown> => ({
  data: `${text}\r`,
  awaitText: 'ype a prompt',
  requireAwait: true,
  minTick: 2,
  awaitSettleTicks: 4,
  ...(mark ? { mark } : {}),
})
const after = (ticks: number, mark: string, data = ''): Record<string, unknown> => ({ data, afterPrevTicks: ticks, mark })
let cap: Capture | null = null
try {
  cap = await capture(
    {
      argv: ['node', BIN],
      cwd,
      cols: COLS,
      rows: ROWS,
      sends: [
        { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitSettleTicks: 8 },
        ask('hdr: launch', 'idle'),
        after(80, 'thinking'),
        after(12, 'thinking+'),
        after(2, 'esc', '\x1b'),
        after(1, 'interrupting'),
        after(14, 'after-esc'),
        after(12, 'after-esc+'),
        { data: '/teammates\r', afterPrevTicks: 2 },
        { data: 'x', awaitText: SEATS.one, requireAwait: true, minTick: 2, awaitSettleTicks: 5, mark: 'crew' },
        { data: 'x', afterPrevTicks: 3 },
        after(12, 'x2', '\x1b[A'),
        { data: 'x', afterPrevTicks: 3 },
        { data: 'x', afterPrevTicks: 3 },
        after(12, 'x4', '\x1b'),
        after(10, 'crew-done'),
        after(12, 'crew-done+'),
        ask('hdr: launch2'),
        { data: '', awaitText: 'waiting on 2 agents', requireAwait: true, minTick: 2, awaitSettleTicks: 5, mark: 'waiting' },
        after(2, 'esc2', '\x1b'),
        after(14, 'after-esc-2'),
        after(12, 'after-esc-2+'),
        after(70, 'crew-landed'),
        after(12, 'crew-landed+'),
        { data: 'hdr: wait\r', awaitText: 'HDR-NOTED', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
        after(25, 'first-byte'),
        after(2, 'first-byte+'),
        { data: 'hdr: tool\r', awaitText: 'HDR-WAITED', requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'idle-2' },
        after(20, 'tool'),
        after(2, 'tool+'),
        { data: 'hdr: fore\r', awaitText: 'HDR-TOOL-DONE', requireAwait: true, minTick: 2, awaitSettleTicks: 8 },
        after(20, 'fore'),
        after(12, 'fore+'),
        { data: 'hdr: stuck\r', awaitText: 'HDR-FORE-DONE', requireAwait: true, minTick: 2, awaitSettleTicks: 8 },
        after(55, 'stuck'),
        after(40, 'end'),
      ],
      total: 1100,
    },
    driveEnv(home, fixture.base),
    300_000,
  )
} catch (error) {
  check('the capture ran', false, String(error).slice(0, 400))
}
await fixture.close()

if (cap !== null) {
  const m = cap.marks
  const t0 = fixture.hits[0]?.atMs ?? 0
  console.log(`  routes: ${fixture.hits.map(h => `+${((h.atMs - t0) / 1000).toFixed(1)}s ${h.route}`).join(' → ')}`)
  console.log(`  marks: ${Object.entries(cap.markTicks).map(([k, v]) => `${k}@${v}`).join(' ')} · end: ${cap.endReason}`)
  const scenes = ['idle', 'thinking', 'esc', 'interrupting', 'after-esc', 'crew', 'x2', 'x4', 'crew-done', 'waiting', 'after-esc-2', 'crew-landed', 'first-byte', 'idle-2', 'tool', 'fore', 'stuck', 'end']
  for (const label of scenes) dump(label, m[label])

  console.log('\n— H1 the title row —')
  const chatFrames = scenes.filter(s => m[s] !== undefined && headerIndex(m[s]) >= 0)
  check(`the title row (✶ SESSION) stands in every chat frame (${chatFrames.length} frames)`, chatFrames.length >= 12, chatFrames.join(','))
  const clocked = chatFrames.filter(s => CLOCK.test(headerRow(m[s])))
  check('H1 no chat frame carries a clock-shaped string on the title row', clocked.length === 0, `clock on: ${clocked.join(',')} — ${flat(headerRight(m[clocked[0] ?? '']))}`)
  const EXPECTED_NAME: Record<string, string> = { idle: 'new session', thinking: 'hdr: launch', 'after-esc': 'hdr: launch', 'first-byte': 'hdr: launch', stuck: 'hdr: launch' }
  for (const s of ['idle', 'thinking', 'after-esc', 'first-byte', 'stuck']) {
    if (m[s] === undefined) continue
    const title = EXPECTED_NAME[s]!
    const right = headerRight(m[s])
    check(`H1 ${s}: the title row's right side is the session's name ("${title}")`, right.endsWith(title), `right: "${flat(right)}"`)
    check(`H1 ${s}: the bottom row carries neither the name nor a glyph`, !statusRow(m[s]).includes(title) && noGlyph(m[s]), flat(statusRow(m[s])))
  }
  check('H1 the idle chat names itself with the product\'s own unnamed word ("new session"), never blank', headerRight(m['idle']).endsWith('new session'), `right "${flat(headerRight(m['idle']))}"`)

  console.log('\n— H6 no row of the frame moves —')
  const headerRows = new Set(chatFrames.map(s => headerIndex(m[s])))
  const statusRows = new Set(chatFrames.filter(s => statusIndex(m[s]) >= 0).map(s => statusIndex(m[s])))
  check(`H6 the title row keeps one row index across every frame (row ${[...headerRows].join('/')})`, headerRows.size === 1)
  check(`H6 the bottom row keeps one row index across every frame (row ${[...statusRows].join('/')})`, statusRows.size === 1)

  console.log('\n— thinking, two agents running —')
  const thinkingRow = statusRow(m['thinking'])
  check('the main agent is thinking (the card under the critter narrates it)', /thinking|…/.test(berth(m['thinking'])), flat(berth(m['thinking'])).slice(0, 160))
  check('H3 the bottom row carries no main-agent phase word', !PHASE_WORDS.test(thinkingRow), flat(thinkingRow))
  check('H3 the bottom row carries the crew\'s clock, past tense ("agents thought for …")', CREW_CLOCK.test(thinkingRow) && /\bagents thought for\b/.test(thinkingRow), flat(thinkingRow))
  const thinkingWordRows = rows(m['thinking']).filter(r => /\bthinking\b/.test(r))
  console.log(`  rows carrying the word "thinking": ${thinkingWordRows.length} — ${thinkingWordRows.map(flat).join(' | ').slice(0, 300)}`)
  check('H2 the crew clock advances while the agents run (no glyph on the row)', crewClockAdvances(m['thinking'], m['thinking+']) && noGlyph(m['thinking']), `${crewClock(m['thinking'])} → ${crewClock(m['thinking+'])}`)

  console.log('\n— esc with the crew running —')
  const interruptingRow = statusRow(m['interrupting'])
  if (/interrupting|stopping/.test(interruptingRow)) {
    check('the interrupting words carry no phase word (the arm stands)', !PHASE_WORDS.test(interruptingRow), flat(interruptingRow))
  } else {
    console.log(`  (the interrupt settled within a tick — the interrupting words were not on screen at +200 ms: "${flat(interruptingRow).slice(0, 120)}")`)
  }
  const escRow = statusRow(m['after-esc'])
  check('after esc the composer is back (the turn ended)', rows(m['after-esc']).some(r => r.includes('ype a prompt')))
  check('H4 after esc the card under the critter no longer narrates the main agent', !/\bthinking\b/.test(berth(m['after-esc'])), flat(berth(m['after-esc'])).slice(0, 160))
  check('the receipt says the crew run on', rows(m['after-esc']).some(r => /sub-agents? still running/.test(r)))
  check('H3 after esc the bottom row carries the crew\'s clock, not "ready"', CREW_CLOCK.test(escRow) && !/\bready\b/.test(escRow), flat(escRow))
  check('H2 after esc the crew clock keeps advancing', crewClockAdvances(m['after-esc'], m['after-esc+']), `${crewClock(m['after-esc'])} → ${crewClock(m['after-esc+'])}`)

  console.log('\n— x x on each crew row —')
  const crewRow = (frame: string | undefined, name: string): string[] => rows(frame).filter(r => r.includes(name) && /✕|◐|◓|◑|◒/.test(r) && /stopped|running|waiting|reasoning|request sent|Read/.test(r))
  check('both crew rows read stopped after x x on each', crewRow(m['x4'], SEATS.one).some(r => /stopped/.test(r)) && crewRow(m['x4'], SEATS.two).some(r => /stopped/.test(r)), [...crewRow(m['x4'], SEATS.one), ...crewRow(m['x4'], SEATS.two)].map(flat).join(' | ').slice(0, 240))
  const doneRow = statusRow(m['crew-done'])
  check('H2 after the last stop the crew clock stands', crewClockStands(m['crew-done'], m['crew-done+']), `${crewClock(m['crew-done'])} → ${crewClock(m['crew-done+'])}`)
  check('H3 after the last stop the words follow: the crew\'s settled clock stands, past tense', CREW_CLOCK.test(doneRow) && !PHASE_WORDS.test(doneRow), flat(doneRow))

  console.log('\n— waiting on agents —')
  const waitingRow = statusRow(m['waiting'])
  check('the wait words stand ("waiting on 2 agents")', /waiting on 2 agents/.test(waitingRow), flat(waitingRow))
  check('the wait words carry no phase word', !PHASE_WORDS.test(waitingRow), flat(waitingRow))
  const esc2Row = statusRow(m['after-esc-2'])
  check('H3 after esc the bottom row carries the crew\'s clock', CREW_CLOCK.test(esc2Row), flat(esc2Row))
  check('H2 after esc the crew clock keeps advancing', crewClockAdvances(m['after-esc-2'], m['after-esc-2+']), `${crewClock(m['after-esc-2'])} → ${crewClock(m['after-esc-2+'])}`)
  const landedRow = statusRow(m['crew-landed'])
  const seatsThreeFour = fixture.hits.filter(h => h.seat === 'three' || h.seat === 'four').length
  check(`the second crew landed on their own (${seatsThreeFour} seat calls)`, seatsThreeFour >= 8)
  check('H2 after the crew land the crew clock stands', crewClockStands(m['crew-landed'], m['crew-landed+']), `${crewClock(m['crew-landed'])} → ${crewClock(m['crew-landed+'])}`)
  check('H3 after the crew land the settled clock stands, past tense', CREW_CLOCK.test(landedRow) && !PHASE_WORDS.test(landedRow), flat(landedRow))

  console.log('\n— the first-byte wait —')
  const fbRow = statusRow(m['first-byte'])
  check('the request-wait words stand ("first byte")', /first byte/.test(fbRow), flat(fbRow))
  check('the request-wait words carry no phase word', !PHASE_WORDS.test(fbRow), flat(fbRow))
  check('H2 with no crew running the row wears no glyph', noGlyph(m['first-byte']) && noGlyph(m['first-byte+']), flat(statusRow(m['first-byte'])))

  console.log('\n— the shell nap —')
  const toolRow = statusRow(m['tool'])
  check('the transcript narrates the tool (its own card)', rows(m['tool']).some(r => /eight second nap|sleep 8/.test(r)), rows(m['tool']).filter(r => /nap|sleep/.test(r)).map(flat).join(' | ').slice(0, 200))
  check('H3 the bottom row carries no "running a tool" word', !PHASE_WORDS.test(toolRow), flat(toolRow))
  check('H2 with no crew running the row wears no glyph', noGlyph(m['tool']) && noGlyph(m['tool+']), flat(statusRow(m['tool'])))
  const idle2Row = statusRow(m['idle-2'])
  check('between turns the row reads "ready" with the settled crew clock gone or standing, never a phase word', /\bready\b|thought for/.test(idle2Row) && !PHASE_WORDS.test(idle2Row), flat(idle2Row))

  console.log('\n— the foreground agent —')
  const foreRow = statusRow(m['fore'])
  check('H3 one running agent: "agent thought for …" (singular), no tool word', /\bagent thought for \d+[sm]\b/.test(foreRow) && !PHASE_WORDS.test(foreRow), flat(foreRow))
  check('H2 the crew clock advances for the foreground agent', crewClockAdvances(m['fore'], m['fore+']), `${crewClock(m['fore'])} → ${crewClock(m['fore+'])}`)

  console.log('\n— the silent stream —')
  const stuckRow = statusRow(m['stuck'])
  check('the stuck words stand ("may be stuck")', /may be stuck/.test(stuckRow), flat(stuckRow))
  check('the stuck words carry no phase word', !PHASE_WORDS.test(stuckRow), flat(stuckRow))
}

if (!KEEP) {
  for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${home} cwd=${cwd}`)
}
console.log(failures === 0 ? '\n✅ header-truth drive GREEN' : `\n❌ header-truth drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
