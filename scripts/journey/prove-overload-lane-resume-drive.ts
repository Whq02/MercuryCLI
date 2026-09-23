#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const REPO = join(import.meta.dir, '..', '..')
const BIN = resolve(arg('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const FRAMES_DIR = arg('--frames-dir')
const FRAME_TAG = arg('--frame-tag') ?? 'run'
const SIZE = (arg('--size') ?? '120x40').split('x').map(Number)
const COLS = SIZE[0] ?? 120
const ROWS = SIZE[1] ?? 40
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const vendoredNode = join(dirname(BIN), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(vendoredNode) ? vendoredNode : 'node'
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { vshotBudgetMs, resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-overload-lane-resume-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'
const LAUNCHED = 'OVERLOAD-LAUNCHED'
const NOTED = 'OVERLOAD-NOTED'
const RESUMED = 'OVERLOAD-RESUMED-BY-HAND'
const LANE_DONE = 'LANE-DONE'
const LANE_NAME = 'overload-lane'
const LANE_MODEL = arg('--lane-model') ?? 'claude-fable-5-1'
const DOOR = /opus/i.test(LANE_MODEL)
const FAMILY = arg('--family')
if (FAMILY !== undefined && FAMILY !== 'compat' && FAMILY !== 'zai') {
  console.error(`✗ --family ${FAMILY}: compat or zai`)
  process.exit(2)
}
const FAMILY_MODEL = FAMILY === 'compat' ? 'compat/fixture-model' : FAMILY === 'zai' ? 'glm-5.2' : undefined
const FAMILY_STATUS = FAMILY === 'compat' ? 503 : FAMILY === 'zai' ? 429 : 529
const HANDOVER = process.argv.includes('--handover')
const INLINE = process.argv.includes('--inline') || HANDOVER
const BUDGET_CUT = process.argv.includes('--budget-cut')
const GONE_CWD = process.argv.includes('--gone-cwd')
if (FAMILY !== undefined && (HANDOVER || GONE_CWD || BUDGET_CUT)) {
  console.error('✗ --family rides the background shape alone (no --handover, --budget-cut or --gone-cwd)')
  process.exit(2)
}
const SEAT_MARK = 'overload-seat:lane'
const PROBE_MARK = 'Reply with the single word ready.'
const OLD_DOOR = 'its work is kept; resume it'
const NOTES_FILE = 'overload-notes.txt'
const OUTAGE_MS = 25_000
const SECOND_WAVE_MS = 8_000
const HAND_RESUMES_MAX = 9
const BUSY_SCALE = '0.05'
const PROBE_SCALE = '0.02'

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
const USAGE_START = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
const USAGE_END = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
let msgSeq = 0
let toolSeq = 0
function head(model: string): string {
  return `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_overload_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: USAGE_START } })}`
}
function textBlock(index: number, text: string): string {
  return [
    `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
  ].join('')
}
function toolBlock(index: number, id: string, name: string, input: Record<string, unknown>): string {
  return [
    `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
  ].join('')
}
function tail(stop: 'end_turn' | 'tool_use'): string {
  return `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: USAGE_END })}event: message_stop\n${sse({ type: 'message_stop' })}`
}
const overloadedBody = (n: number): string => JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: `req_fixture_overload_${n}` })
const pickTag = (text: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  return m === null ? null : m[1]!.trim()
}

type Hit = { lane: 'parent' | 'lane' | 'probe' | 'other'; atMs: number; answer: string }
async function startFixture(port: number, laneCwd?: string): Promise<{ base: string; hits: Hit[]; state: { handResumes: number; noteSeen: boolean }; close(): Promise<void> }> {
  const hits: Hit[] = []
  const state = { handResumes: 0, noteSeen: false }
  let outageStartedAt: number | null = null
  let secondWaveAt: number | null = null
  let laneCalls = 0
  const phase = (now: number, probe: boolean): 'down' | 'up' => {
    if (outageStartedAt === null) return 'up'
    if (now - outageStartedAt < OUTAGE_MS) return 'down'
    if (secondWaveAt === null) {
      if (probe) {
        secondWaveAt = now
        return 'up'
      }
      return 'up'
    }
    return now - secondWaveAt < SECOND_WAVE_MS ? 'down' : 'up'
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      if (req.method === 'POST' && url.includes('/chat/completions') && FAMILY !== undefined) {
        const items = itemsOf(body)
        const users = items.filter(i => i.role === 'user')
        const userText = users.map(i => textOf(i.content)).join('\n')
        const now = Date.now()
        const isProbe = userText.includes(PROBE_MARK) && users.length === 1
        const isLane = !isProbe && userText.includes(SEAT_MARK)
        const refuse = (): void => {
          if (FAMILY === 'zai') {
            res.writeHead(429, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { code: '1305', message: 'The service may be temporarily overloaded, please try again later' } }))
            return
          }
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { type: 'server_error', message: 'the endpoint is overloaded' } }))
        }
        const answer = (text: string): void => {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
        }
        if (isProbe) {
          const verdict = phase(now, true)
          hits.push({ lane: 'probe', atMs: now, answer: verdict })
          if (verdict === 'down') refuse()
          else answer('ready')
          return
        }
        if (isLane) {
          laneCalls++
          if (outageStartedAt === null) outageStartedAt = now
          const verdict = phase(now, false)
          hits.push({ lane: 'lane', atMs: now, answer: verdict })
          if (verdict === 'down') refuse()
          else answer(LANE_DONE)
          return
        }
        hits.push({ lane: 'other', atMs: now, answer: url })
        answer('side')
        return
      }
      if (req.method !== 'POST' || !url.includes('/v1/messages')) {
        hits.push({ lane: 'other', atMs: Date.now(), answer: url })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(url.endsWith('/models') ? JSON.stringify({ data: [] }) : '{}')
        return
      }
      const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
      const items = itemsOf(body)
      const userText = items.filter(i => i.role === 'user').map(i => textOf(i.content)).join('\n')
      const now = Date.now()
      const isProbe = userText.includes(PROBE_MARK) && items.length === 1
      const isLane = !isProbe && userText.includes(SEAT_MARK)
      if (isProbe) {
        if (laneCwd !== undefined) rmSync(laneCwd, { recursive: true, force: true })
        const answer = phase(now, true)
        hits.push({ lane: 'probe', atMs: now, answer })
        if (answer === 'down') {
          res.writeHead(529, { 'content-type': 'application/json', 'request-id': `req_fixture_probe_${hits.length}` })
          res.end(overloadedBody(hits.length))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(head(model) + textBlock(0, 'ready') + tail('end_turn'))
        return
      }
      if (isLane) {
        if (laneCwd !== undefined && userText.includes(`NOTE: its recorded directory ${laneCwd} is gone`)) state.noteSeen = true
        laneCalls++
        if (outageStartedAt === null) outageStartedAt = now
        const answer = phase(now, false)
        hits.push({ lane: 'lane', atMs: now, answer: laneCalls === 1 ? 'mid-stream' : answer })
        if (laneCalls === 1) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_fixture_mid_stream' })
          res.end(head(model) + `event: error\n${sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: 'req_fixture_mid_stream' })}`)
          return
        }
        if (answer === 'down') {
          res.writeHead(529, { 'content-type': 'application/json', 'request-id': `req_fixture_lane_${laneCalls}` })
          res.end(overloadedBody(laneCalls))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(head(model) + textBlock(0, LANE_DONE) + tail('end_turn'))
        return
      }
      hits.push({ lane: 'parent', atMs: now, answer: 'answer' })
      const lastUser = [...items].reverse().find(i => i.role === 'user')
      const lastUserText = lastUser ? textOf(lastUser.content) : ''
      const answered = answeredTool(items)
      let out: string
      if (answered === 'Agent') out = textBlock(0, LAUNCHED) + tail('end_turn')
      else if (answered === 'SendMessage') out = textBlock(0, RESUMED) + tail('end_turn')
      else if (lastUserText.includes('<task-notification>')) {
        const status = pickTag(lastUserText, 'status')
        const taskId = pickTag(lastUserText, 'task-id')
        if (status === 'failed' && lastUserText.includes(OLD_DOOR) && taskId !== null && state.handResumes < HAND_RESUMES_MAX) {
          state.handResumes++
          out = toolBlock(0, `toolu_overload_resume_${++toolSeq}`, 'SendMessage', { to: taskId, message: 'carry on with the notes report', summary: 'carry on with the notes report' }) + tail('tool_use')
        } else out = textBlock(0, NOTED) + tail('end_turn')
      } else if (lastUserText.includes('overload-drive: launch')) {
        out =
          toolBlock(0, `toolu_overload_agent_${++toolSeq}`, 'Agent', {
            description: LANE_NAME,
            prompt: `${SEAT_MARK} read the notes file once, then report in one line`,
            subagent_type: 'mercury-general',
            ...(INLINE ? {} : { run_in_background: true }),
            ...(laneCwd !== undefined ? { cwd: laneCwd } : {}),
            ...(FAMILY_MODEL !== undefined ? { model: FAMILY_MODEL } : {}),
          }) + tail('tool_use')
      } else out = textBlock(0, 'side') + tail('end_turn')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(head(model) + out)
    })
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolveListen())
  })
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    state,
    close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
  }
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Array<{ label: string; atTick: number; text: string }>; endReason: string; stderr: string }
async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'overload-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(budgetMs))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolveRun()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 600)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; marks?: Array<{ label: string; atTick: number; grid: Grid }>; endReason?: string }
  rmSync(dir, { recursive: true, force: true })
  return {
    text: gridText(payload.grid),
    marks: (payload.marks ?? []).map(m => ({ label: m.label, atTick: m.atTick, text: gridText(m.grid) })),
    endReason: payload.endReason ?? '',
    stderr: stderr.join(''),
  }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'overload-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'overload-cwd-')))
  writeFileSync(join(cwd, NOTES_FILE), 'the overload notes\n')
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
    BROWSER: '/usr/bin/true',
    MERCURY_MODEL: LANE_MODEL,
    MERCURY_BUSY_RETRY_SCALE: BUSY_SCALE,
    MERCURY_OVERLOAD_PROBE_SCALE: PROBE_SCALE,
    MERCURY_MAX_RETRIES: '2',
    ...(BUDGET_CUT ? { MERCURY_RECOVERY_BUDGET_MINUTES: '0.02' } : {}),
    ...(FAMILY === 'compat' ? { MERCURY_COMPAT_BASE_URL: `${base}/v1`, MERCURY_COMPAT_MODELS: 'fixture-model', MERCURY_COMPAT_LABEL: 'the fixture endpoint', MERCURY_LOCAL_PROBE_TARGETS: 'none' } : {}),
    ...(FAMILY === 'zai' ? { ZAI_API_KEY: 'fixture-zai-key', MERCURY_ZAI_API_BASE: `${base}/zai`, MERCURY_LOCAL_PROBE_TARGETS: 'none' } : {}),
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    DEBUG: '1',
  }
}

type Record_ = Record<string, unknown>
function readJsonl(path: string): Record_[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      try {
        return JSON.parse(line) as Record_
      } catch {
        return null
      }
    })
    .filter((record): record is Record_ => record !== null)
}
function sessionTranscript(home: string): { path: string; records: Record_[]; dir: string } | null {
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return null
  const files: Array<{ path: string; mtime: number; dir: string }> = []
  for (const dir of readdirSync(projects)) {
    const full = join(projects, dir)
    if (!statSync(full).isDirectory()) continue
    for (const name of readdirSync(full)) if (name.endsWith('.jsonl') && !name.includes('.receipts.')) files.push({ path: join(full, name), mtime: statSync(join(full, name)).mtimeMs, dir: full })
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const newest = files[0]
  return newest === undefined ? null : { path: newest.path, records: readJsonl(newest.path), dir: newest.dir }
}
const payloadText = (record: Record_): string => {
  const payload = record.payload as { content?: unknown } | undefined
  const content = payload?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(block => (typeof (block as { text?: unknown }).text === 'string' ? ((block as { text: string }).text) : '')).join('\n')
  return ''
}
type Notice = { status: string | null; summary: string | null; taskId: string | null }
function laneNotices(records: Record_[]): Notice[] {
  const out: Notice[] = []
  for (const record of records) {
    const payload = record.payload as { kind?: string } | undefined
    if (payload?.kind !== 'input') continue
    const text = payloadText(record)
    if (!text.includes('<task-notification>')) continue
    for (const block of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
      const summary = pickTag(block, 'summary')
      if (summary === null) continue
      out.push({ status: pickTag(block, 'status'), summary, taskId: pickTag(block, 'task-id') })
    }
  }
  const taskIds = new Set(out.filter(notice => notice.summary?.includes(`"${LANE_NAME}"`)).map(notice => notice.taskId))
  return out.filter(notice => notice.taskId !== null && taskIds.has(notice.taskId))
}
function parentToolUses(records: Record_[], name: string): number {
  let n = 0
  for (const record of records) {
    const payload = record.payload as { kind?: string; content?: unknown } | undefined
    if (payload?.kind !== 'output' || !Array.isArray(payload.content)) continue
    for (const block of payload.content as Array<{ kind?: string; name?: string }>) if (block.kind === 'tool-use' && block.name === name) n++
  }
  return n
}
function laneTranscript(sessionDir: string, sessionPath: string): Record_[] | null {
  const sessionId = sessionPath.slice(sessionPath.lastIndexOf('/') + 1).replace(/\.jsonl$/, '')
  const dir = join(sessionDir, sessionId, 'subagents')
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const records = readJsonl(join(dir, name))
    if (records.some(record => payloadText(record).includes(SEAT_MARK))) return records
  }
  return null
}
const laneOutputs = (records: Record_[]): Array<{ model: string; text: string; at: string }> =>
  records
    .filter(record => (record.payload as { kind?: string } | undefined)?.kind === 'output')
    .map(record => ({ model: String((record.payload as { model?: unknown }).model ?? ''), text: payloadText(record), at: String(record.occurredAt ?? '') }))
function parentToolResults(records: Record_[], name: string): string[] {
  const ids = new Set<string>()
  for (const record of records) {
    const payload = record.payload as { kind?: string; content?: unknown } | undefined
    if (payload?.kind !== 'output' || !Array.isArray(payload.content)) continue
    for (const block of payload.content as Array<{ kind?: string; name?: string; callId?: string }>) if (block.kind === 'tool-use' && block.name === name && typeof block.callId === 'string') ids.add(block.callId)
  }
  const out: string[] = []
  for (const record of records) {
    const payload = record.payload as { kind?: string; content?: unknown } | undefined
    if (payload?.kind !== 'input' || !Array.isArray(payload.content)) continue
    for (const block of payload.content as Array<{ kind?: string; callId?: string; body?: unknown }>) if (block.kind === 'tool-result' && typeof block.callId === 'string' && ids.has(block.callId)) out.push(typeof block.body === 'string' ? block.body : JSON.stringify(block.body ?? ''))
  }
  return out
}
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()

console.log('============================================================')
console.log(` a lane on the ${FAMILY === undefined ? 'first-party' : FAMILY} wire meets an overload${HANDOVER ? ' (handed over by Esc)' : ''} — ${COLS}×${ROWS}, real bundle, PTY`)
console.log(`  bundle ${BIN}`)
console.log('============================================================')
const KEEP = process.env.OVERLOAD_DRIVE_KEEP === '1'
const { home, cwd } = seedWorld()
const laneCwd = GONE_CWD ? join(cwd, 'helper') : undefined
if (laneCwd !== undefined) mkdirSync(laneCwd)
const fixture = await startFixture(Number(process.env.OVERLOAD_DRIVE_PORT ?? 25311), laneCwd)
const FRAMES = 30
const sends: Array<Record<string, unknown>> = [
  { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: 'overload-drive: launch\r', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'boot' },
]
const ESC_TICKS = BUDGET_CUT ? 3 : 5
if (HANDOVER) sends.push({ data: '\x1b', afterPrevTicks: ESC_TICKS, mark: 'esc' })
for (let i = 1; i <= FRAMES; i++) sends.push({ data: '', afterPrevTicks: 10, mark: `w${i}` })
sends.push({ data: '', afterPrevTicks: 15, mark: 'end' })
let cap: Capture | null = null
try {
  cap = await capture({ argv: [NODE, BIN], cwd, cols: COLS, rows: ROWS, sends, stableTicks: 6, total: 900 }, driveEnv(home, fixture.base), 260_000)
} catch (error) {
  check('the capture ran', false, String(error).slice(0, 400))
}
await fixture.close()

if (cap !== null) {
  const t0 = fixture.hits.find(h => h.lane === 'lane')?.atMs ?? fixture.hits[0]?.atMs ?? 0
  console.log(`  hits: ${fixture.hits.filter(h => h.lane !== 'other').map(h => `+${((h.atMs - t0) / 1000).toFixed(1)}s ${h.lane}:${h.answer}`).join(' · ')}`)
  console.log(`  hand resumes by the parent: ${fixture.state.handResumes}`)
  if (FRAMES_DIR !== undefined) {
    mkdirSync(FRAMES_DIR, { recursive: true })
    writeFileSync(join(FRAMES_DIR, `parent-chat-${COLS}x${ROWS}-${FRAME_TAG}-end.txt`), cap.text + '\n')
    const mid = cap.marks.find(m => m.label === 'w14')
    if (mid !== undefined) writeFileSync(join(FRAMES_DIR, `parent-chat-${COLS}x${ROWS}-${FRAME_TAG}-during.txt`), mid.text + '\n')
    console.log(`  frames written under ${FRAMES_DIR}`)
  }
  const session = sessionTranscript(home)
  const parentRecords = session?.records ?? []
  const allNotices = laneNotices(parentRecords)
  const notices = GONE_CWD ? allNotices.filter(notice => !notice.summary?.includes('NOTE: its recorded directory')) : allNotices
  if (GONE_CWD) {
    check('E1 the resumed helper reads the gone-directory note', fixture.state.noteSeen)
    check('E2 the automatic resume receipt names the removed folder and where edits land', allNotices.some(notice => notice.summary?.includes(`NOTE: its recorded directory ${laneCwd} is gone`) && notice.summary.includes(cwd) && notice.summary.includes('anything it edits lands there')))
    check('E3 the fixture removed the helper directory during the pause', laneCwd !== undefined && !existsSync(laneCwd))
  }
  const lane = session === null ? null : laneTranscript(session.dir, session.path)
  const outputs = lane === null ? [] : laneOutputs(lane)
  const deaths = outputs.filter(o => o.model === '<synthetic>' && (FAMILY !== undefined ? /stayed busy through \d+ retr/.test(o.text) : /^API Error: 529\b|API overload errors \(529\)/.test(o.text)))
  const done = outputs.some(o => o.text.includes(LANE_DONE))
  const sendMessages = parentToolUses(parentRecords, 'SendMessage')
  const laneHits = fixture.hits.filter(h => h.lane === 'lane')
  const probeHits = fixture.hits.filter(h => h.lane === 'probe')
  const refused = laneHits.filter(h => h.answer === 'down' || h.answer === 'mid-stream')
  const workHits = fixture.hits.filter(hit => hit.lane === 'lane' || hit.lane === 'probe')
  const probeStarts = workHits.filter((hit, index) => hit.lane === 'probe' && workHits[index - 1]?.lane === 'lane')
  const deathCount = BUDGET_CUT ? probeStarts.length : deaths.length
  console.log(`  lane requests ${laneHits.length} (refused ${refused.length}) · probes ${probeHits.length} (answered ${probeHits.filter(h => h.answer === 'up').length}) · lane deaths ${deaths.length} · ${LANE_DONE} ${done} · parent SendMessage uses ${sendMessages}`)
  console.log('  the parent\'s lane notices:')
  for (const n of notices) console.log(`    [${n.status}] ${flat(n.summary ?? '').slice(0, 220)}`)

  console.log('\n— §A the lane dies on the overload, pauses, and comes back by itself —')
  if (FAMILY !== undefined) {
    check(`A1 the lane met the outage on the ${FAMILY} wire: its requests were refused with the family's busy answer (HTTP ${FAMILY_STATUS})`, laneHits[0]?.answer === 'down' && refused.length >= 2, `${laneHits.map(h => h.answer).join(',')}`)
    check("A2 the lane's own transcript records the death: a synthetic 'stayed busy through' row on the spent ladder", deaths.length >= 1, `${deaths.length} deaths: ${deaths.map(d => d.text.slice(0, 80)).join(' | ')}`)
  } else {
    check('A1 the lane met the outage: its first request was cut mid-stream by an overloaded_error and its next ones were refused with HTTP 529', laneHits[0]?.answer === 'mid-stream' && refused.length >= 2, `${laneHits.map(h => h.answer).join(',')}`)
    if (BUDGET_CUT) {
      const firstProbe = probeHits[0]
      const beforeProbe = firstProbe === undefined ? [] : laneHits.filter(hit => hit.atMs < firstProbe.atMs)
      check('A2 the shorter retry budget reaches the probe before the full busy ladder is spent', beforeProbe.length >= 2 && beforeProbe.length < 8 && deaths.length === 0, `${beforeProbe.length} requests before the first probe, ${deaths.length} full-ladder deaths`)
    } else {
      check(DOOR ? "A2 the lane's own transcript records the death: a synthetic row carrying the door's words on the spent ladder" : "A2 the lane's own transcript records the death: a synthetic 'API Error: 529' row carrying the wire's answer", deaths.length >= 1 && deaths.every(d => (DOOR ? /API overload errors \(529\)/.test(d.text) : /^API Error: 529\b/.test(d.text))), `${deaths.length} deaths: ${deaths.map(d => d.text.slice(0, 60)).join(' | ')}`)
    }
  }
  check(`A3 the lane finished by itself once the provider answered: ${LANE_DONE} in its transcript with no message from the parent (SendMessage uses 0)`, done && sendMessages === 0, `${LANE_DONE}=${done} SendMessage=${sendMessages}`)
  check('A4 Mercury probed the provider while the lane was paused, and a probe was answered before the lane resumed', probeHits.length >= 1 && probeHits.some(h => h.answer === 'up'), `${probeHits.length} probes`)
  const probeGaps = probeHits.slice(1).map((hit, i) => hit.atMs - probeHits[i]!.atMs)
  check('A7 every probe was one request (no two probe requests within 300 ms of each other)', probeHits.length >= 1 && probeGaps.every(gap => gap >= 300), `gaps ${probeGaps.map(g => `${g}ms`).join(',')}`)
  const first = notices[0]
  const STATUS_WORDS = `(HTTP ${FAMILY_STATUS})`
  if (!INLINE || HANDOVER) {
    check(`A5 the parent's first notice for the lane is the calm paused line — status 'paused', the provider named as overloaded ${STATUS_WORDS}, Mercury's probing named — never 'failed: API Error' with the resume door`, first !== undefined && first.status === 'paused' && new RegExp(`paused — .* is overloaded \\(HTTP ${FAMILY_STATUS}\\); its work so far is kept and rides below; Mercury probes the provider for up to .* and resumes the agent by itself when it answers`).test(first.summary ?? '') && !(first.summary ?? '').includes('API Error') && !(first.summary ?? '').includes(OLD_DOOR), first === undefined ? '(no notice)' : `[${first.status}] ${flat(first.summary ?? '').slice(0, 200)}`)
    check(`A6 the parent's chat painted that line once during the outage and no 'failed: API Error' line`, cap.marks.some(m => m.text.includes(`is overloaded ${STATUS_WORDS}`)) && !cap.marks.some(m => m.text.includes('failed: API Error')) && !cap.text.includes('failed: API Error'), cap.text.split('\n').filter(l => l.includes('●')).map(flat).slice(0, 6).join(' | ').slice(0, 400))

    console.log('\n— §B one calm line per lane per outage episode —')
    const completion = notices.findIndex(n => n.status === 'completed')
    const beforeCompletion = completion < 0 ? notices : notices.slice(0, completion)
    check(`B1 the lane died more than once in the episode (the second wave) yet the parent's record holds exactly ONE lane notice before the completion notice`, deathCount >= 2 && beforeCompletion.length === 1, `deaths=${deathCount} notices before completion=${beforeCompletion.length} (${beforeCompletion.map(n => n.status).join(',')})`)
    check("B2 no 'resumed' receipt row rides the episode — the lane's row carries the resume, the parent's chat one line", !notices.some(n => n.status === 'resumed'), notices.map(n => n.status).join(','))
    check('B3 the completion notice follows as its own line', completion >= 0 && notices[completion]?.summary?.includes('completed') === true, notices.map(n => n.status).join(','))
  }

  if (DOOR && !BUDGET_CUT) {
    console.log('\n— §C the three-strikes door yields to the ladder —')
    const firstDeathAtMs = deaths.length > 0 ? Date.parse(deaths[0]!.at) : Number.NaN
    const beforeFirstDeath = laneHits.filter(h => h.atMs <= firstDeathAtMs)
    check('C1 the lane walked every rung before its first death: eight requests (the cut stream and seven refused) before the door spoke', deaths.length >= 1 && beforeFirstDeath.length >= 8, `${beforeFirstDeath.length} requests before the first death at +${((firstDeathAtMs - t0) / 1000).toFixed(1)}s`)
    check('C2 the first death came once the ladder was spent, not inside its first rungs', deaths.length >= 1 && firstDeathAtMs - (laneHits[0]?.atMs ?? firstDeathAtMs) >= 2_500, `${firstDeathAtMs - (laneHits[0]?.atMs ?? 0)} ms from the first request`)
    check("C3 the death row carries the door's words, and the pause road read them as an overload", deaths.length >= 1 && /API overload errors \(529\)/.test(deaths[0]!.text) && probeHits.length >= 1, deaths[0]?.text.slice(0, 80) ?? '(no death)')
  }

  if (HANDOVER) {
    console.log('\n— §H an inline helper handed to the background by Esc takes the same pause-and-probe road —')
    const results = parentToolResults(parentRecords, 'Agent')
    const handed = results.some(r => r.includes('Agent launched in the background.') && r.includes('the turn it ran in was interrupted'))
    check(handed ? 'H0 the Esc landed while the helper ran: the launch receipt says the turn was interrupted and the agent handed to the background' : 'H0 [staging] the Esc did not hand the helper over (retune ESC_TICKS: the receipt must say the turn was interrupted)', handed, results.map(r => flat(r).slice(0, 160)).join(' | ').slice(0, 400))
    check("H1 the handed-over helper's first notice is the calm paused line, never the failed line with the resume door", first !== undefined && first.status === 'paused' && !(first.summary ?? '').includes(OLD_DOOR), first === undefined ? '(no notice)' : `[${first.status}] ${flat(first.summary ?? '').slice(0, 200)}`)
    check('H2 no failed notice rode the episode and the completion followed as its own line', !notices.some(n => n.status === 'failed') && notices.some(n => n.status === 'completed'), notices.map(n => n.status).join(','))
    check(`H3 the helper finished by itself once the provider answered: ${LANE_DONE} with no message from the parent`, done && sendMessages === 0, `${LANE_DONE}=${done} SendMessage=${sendMessages}`)
  }

  if (INLINE && !HANDOVER) {
    console.log('\n— §D an inline helper takes the same pause-and-probe road —')
    const results = parentToolResults(parentRecords, 'Agent')
    check("D1 the helper's tool result leads with the pause — 'paused — provider overloaded', the probing named — never a bare 'Agent execution failed: API Error: 529'", results.length >= 1 && results.some(r => /Agent execution failed: paused — provider overloaded/.test(r) && /Mercury probes it for up to/.test(r)) && !results.some(r => /Agent execution failed: API Error: 529/.test(r)), results.map(r => flat(r).slice(0, 160)).join(' | ').slice(0, 400))
    check('D2 Mercury probed the provider while the helper was paused, and a probe was answered before it resumed', probeHits.length >= 1 && probeHits.some(h => h.answer === 'up'), `${probeHits.length} probes`)
    check(`D3 the helper finished by itself once the provider answered: ${LANE_DONE} in its transcript with no message from the parent`, done && sendMessages === 0, `${LANE_DONE}=${done} SendMessage=${sendMessages}`)
    check("D4 the helper's completion reached the parent as its own line, and no 'failed' notice with the resume door rode the episode", notices.some(n => n.status === 'completed') && !notices.some(n => n.status === 'failed'), notices.map(n => n.status).join(','))
  }
}

if (!KEEP) {
  for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${home} cwd=${cwd}`)
}
console.log(failures === 0 ? '\n✅ overload-lane-resume drive GREEN' : `\n❌ overload-lane-resume drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
