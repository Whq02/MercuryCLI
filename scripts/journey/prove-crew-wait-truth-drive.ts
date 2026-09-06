#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  console.error(`prove-crew-wait-truth-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'
const LAUNCHED = 'WAIT-LAUNCHED'
const NOTED = 'WAIT-NOTED'
const SEAT_MARK = 'crew-seat:'
const NOTES_FILE = 'wait-notes.txt'
const GPT_ID = 'gpt-5.6-sol'
const SEATS = { fable: 'crew-fable', gpt: 'crew-gpt' } as const
type Seat = keyof typeof SEATS
const HOLD_MS = 3000
const THINK_MS = 3000
const THINK_STEP_MS = 400
const TEXT_STEP_MS = 300
const TOOL_NAME = 'Bash'
const TOOL_INPUT = { command: 'sleep 2', description: 'wait two seconds' }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

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
function seatOfAnthropic(items: Item[]): Seat | null {
  const userText = items.filter(i => i.role === 'user').map(i => textOf(i.content)).filter(t => !t.includes('task-notification')).join('\n')
  for (const seat of Object.keys(SEATS) as Seat[]) if (userText.includes(`${SEAT_MARK}${seat}`)) return seat
  return null
}
const USAGE_START = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
const USAGE_END = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
let msgSeq = 0
let toolSeq = 0
function anthropicHead(model: string): string {
  return `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_wait_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: USAGE_START } })}`
}
function anthropicTextBlock(index: number, text: string): string {
  return [
    `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
  ].join('')
}
function anthropicToolBlock(index: number, id: string, name: string, input: Record<string, unknown>): string {
  return [
    `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
  ].join('')
}
function anthropicTail(stop: 'end_turn' | 'tool_use'): string {
  return `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: USAGE_END })}event: message_stop\n${sse({ type: 'message_stop' })}`
}
const agentLaunch = (seat: Seat, extra: Record<string, unknown>): string =>
  anthropicToolBlock(seat === 'fable' ? 0 : 1, `toolu_wait_agent_${++toolSeq}`, 'Agent', {
    description: SEATS[seat],
    prompt: `${SEAT_MARK}${seat} read the notes file once, then report in one line`,
    subagent_type: 'mercury-general',
    run_in_background: true,
    ...extra,
  })

type Hit = { lane: 'parent' | 'fable' | 'gpt' | 'models' | 'other'; url: string; atMs: number; call?: number }
async function startFixture(port: number, cwd: string): Promise<{ base: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = []
  const seatCalls: Record<Seat, number> = { fable: 0, gpt: 0 }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        const url = (req.url ?? '').split('?')[0] ?? ''
        if (req.method === 'GET' && url.endsWith('/models')) {
          hits.push({ lane: 'models', url, atMs: Date.now() })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              data: [
                {
                  id: GPT_ID,
                  display_name: 'GPT-5.6 Sol',
                  supported_reasoning_levels: ['low', 'medium', 'high'],
                  default_reasoning_level: 'medium',
                  visibility: 'public',
                  supported_in_api: true,
                  priority: 1,
                  context_window: 400_000,
                  input_modalities: ['text', 'image'],
                },
              ],
            }),
          )
          return
        }
        let body: unknown = null
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          body = null
        }
        if (req.method === 'POST' && url.endsWith('/responses')) {
          const call = ++seatCalls.gpt
          hits.push({ lane: 'gpt', url, atMs: Date.now(), call })
          const rid = `resp_wait_${msgSeq++}`
          if (call === 1) {
            await sleep(HOLD_MS)
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
            res.write(sse({ type: 'response.created', response: { id: rid } }))
            const steps = Math.max(1, Math.round(THINK_MS / THINK_STEP_MS))
            for (let i = 0; i < steps; i++) {
              res.write(sse({ type: 'response.reasoning_summary_text.delta', item_id: `rs_${rid}`, output_index: 0, summary_index: 0, delta: 'weighing the notes ' }))
              await sleep(THINK_STEP_MS)
            }
            const callId = `call_wait_${++toolSeq}`
            const args = JSON.stringify(TOOL_INPUT)
            res.write(sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: `fc_${callId}`, name: TOOL_NAME, call_id: callId, arguments: '' } }))
            res.write(sse({ type: 'response.function_call_arguments.delta', item_id: `fc_${callId}`, output_index: 1, delta: args }))
            res.write(sse({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: `fc_${callId}`, name: TOOL_NAME, call_id: callId, arguments: args } }))
            res.end(sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 900, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } } } }))
            return
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.write(sse({ type: 'response.created', response: { id: rid } }))
          const words = ['SEAT-', 'DONE-', 'gpt']
          for (const w of words) {
            res.write(sse({ type: 'response.output_text.delta', item_id: `msg_${rid}`, output_index: 0, content_index: 0, delta: w }))
            await sleep(TEXT_STEP_MS)
          }
          res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `msg_${rid}`, role: 'assistant', content: [{ type: 'output_text', text: words.join('') }] } }))
          res.end(sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 900, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } } } }))
          return
        }
        if (!url.includes('/v1/messages')) {
          hits.push({ lane: 'other', url, atMs: Date.now() })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
        const items = itemsOf(body)
        const seat = seatOfAnthropic(items)
        if (seat === 'fable') {
          const call = ++seatCalls.fable
          hits.push({ lane: 'fable', url, atMs: Date.now(), call })
          if (call === 1) {
            await sleep(HOLD_MS)
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
            res.write(anthropicHead(model))
            res.write(`event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}`)
            const steps = Math.max(1, Math.round(THINK_MS / THINK_STEP_MS))
            for (let i = 0; i < steps; i++) {
              res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing the notes ' } })}`)
              await sleep(THINK_STEP_MS)
            }
            res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } })}`)
            res.write(`event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`)
            res.write(anthropicToolBlock(1, `toolu_wait_tool_${++toolSeq}`, TOOL_NAME, TOOL_INPUT))
            res.end(anthropicTail('tool_use'))
            return
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.write(anthropicHead(model))
          res.write(`event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`)
          for (const w of ['SEAT-', 'DONE-', 'fable']) {
            res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } })}`)
            await sleep(TEXT_STEP_MS)
          }
          res.write(`event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`)
          res.end(anthropicTail('end_turn'))
          return
        }
        hits.push({ lane: 'parent', url, atMs: Date.now() })
        const lastUser = [...items].reverse().find(i => i.role === 'user')
        const lastUserText = lastUser ? textOf(lastUser.content) : ''
        const answered = answeredTool(items)
        let bodyOut: string
        if (lastUserText.includes('task-notification')) bodyOut = anthropicTextBlock(0, NOTED) + anthropicTail('end_turn')
        else if (answered === 'Agent') bodyOut = anthropicTextBlock(0, LAUNCHED) + anthropicTail('end_turn')
        else if (lastUserText.includes('wait-drive: launch')) bodyOut = agentLaunch('fable', {}) + agentLaunch('gpt', { model: GPT_ID }) + anthropicTail('tool_use')
        else bodyOut = anthropicTextBlock(0, 'side') + anthropicTail('end_turn')
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(anthropicHead(model) + bodyOut)
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
type Capture = { text: string; marks: Array<{ label: string; atTick: number; text: string }>; receipts: Array<{ atTick: number; ts: number }>; endReason: string; stderr: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'crew-wait-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
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
  rmSync(dir, { recursive: true, force: true })
  return {
    text: gridText(payload.grid),
    marks: (payload.marks ?? []).map(m => ({ label: m.label, atTick: m.atTick, text: gridText(m.grid) })),
    receipts: payload.sendReceipts ?? [],
    endReason: payload.endReason ?? '',
    stderr: stderr.join(''),
  }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'crew-wait-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'crew-wait-cwd-')))
  writeFileSync(join(cwd, NOTES_FILE), 'the wait notes\n')
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
    OPENAI_API_KEY: 'sk-test-crew-wait-openai',
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
    DEBUG: '1',
  }
}

function runnerOpenaiTimeline(home: string, fromMs: number, toMs: number): string[] {
  const dir = join(home, 'debug')
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.txt')) continue
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      const stamp = Date.parse(line.slice(0, 24))
      if (!Number.isFinite(stamp) || stamp < fromMs - 500 || stamp > toMs + 500) continue
      if (/openai|catalogue|qualif|dispatch|responses|gpt|engine|schema|first-byte|wait/i.test(line)) out.push(`${name.slice(0, 8)} ${line.slice(0, 200)}`)
    }
  }
  return out
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
const seatRow = (frame: string, seat: Seat): string | null => {
  const rows = frame.split('\n')
  const at = rows.findIndex(r => r.includes(`(${SEATS[seat]})`))
  if (at < 0) return null
  return flat(`${rows[at]} ${rows[at + 1] ?? ''}`)
}
const PHASE_WORDS = ['request sent', 'waiting for the first byte', 'first byte in', 'reasoning', 'streaming', 'sleep', 'wait two seconds', 'Bash']
const bootFetch = (hits: Hit[], at: number): boolean => hits.some(h => h.lane === 'other' && h.url === '/' && at - h.atMs >= 0 && at - h.atMs < 800)

console.log('============================================================')
console.log(' the wait tells its truth — a Fable seat and a GPT seat, real bundle, PTY')
console.log('============================================================')
const KEEP = process.env.CREW_WAIT_KEEP === '1'
const { home, cwd } = seedWorld()
const fixture = await startFixture(Number(process.env.CREW_WAIT_PORT ?? 25199), cwd)
const FRAMES = 40
const sends: Array<Record<string, unknown>> = [
  { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: 'wait-drive: launch\r', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'boot' },
]
for (let i = 1; i <= FRAMES; i++) sends.push({ data: '', afterPrevTicks: 2, mark: `w${i}` })
sends.push({ data: '', afterPrevTicks: 25, mark: 'end' })
let cap: Capture | null = null
try {
  cap = await capture({ argv: ['node', BIN], cwd, cols: 120, rows: 40, sends, stableTicks: 6, total: 900 }, driveEnv(home, fixture.base), 240_000)
} catch (error) {
  check('the capture ran', false, String(error).slice(0, 400))
}
await fixture.close()

if (cap !== null) {
  const t0 = fixture.hits[0]?.atMs ?? 0
  console.log(`  hits: ${fixture.hits.map(h => `+${((h.atMs - t0) / 1000).toFixed(1)}s ${h.lane}${h.call !== undefined ? `#${h.call}` : ''}${h.lane === 'other' || h.lane === 'models' ? ` ${h.url}` : ''}`).join(' · ')}`)
  const launchTs = cap.receipts[1]?.ts ?? Number.POSITIVE_INFINITY
  const frames = cap.marks.filter(m => m.label.startsWith('w'))
  const firstPhaseTick = (seat: Seat): { tick: number; row: string } | null => {
    for (const m of frames) {
      const row = seatRow(m.text, seat)
      if (row !== null && PHASE_WORDS.some(w => row.includes(w))) return { tick: m.atTick, row }
    }
    return null
  }
  const rowsOf = (seat: Seat): string[] => frames.map(m => seatRow(m.text, seat)).filter((r): r is string => r !== null)
  for (const seat of ['fable', 'gpt'] as Seat[]) {
    console.log(`\n── ${SEATS[seat]} across the frames ──`)
    let last = ''
    for (const m of frames) {
      const row = seatRow(m.text, seat)
      if (row !== null && row !== last) {
        console.log(`  @${m.atTick}: ${row.slice(0, 150)}`)
        last = row
      }
    }
  }

  console.log('\n— W1 the phases —')
  for (const seat of ['fable', 'gpt'] as Seat[]) {
    const rows = rowsOf(seat)
    const firstByte = rows.filter(r => r.includes('waiting for the first byte'))
    check(`W1 ${SEATS[seat]}: the first-byte wait names its budget ("waiting for the first byte · Ns, within N s")`, firstByte.some(r => /waiting for the first byte · \d+s, within \d+ s/.test(r)), firstByte[0]?.slice(0, 160) ?? rows[0]?.slice(0, 160) ?? '(no row)')
    const reasoning = rows.map(r => /reasoning (\d+)s, no tokens yet/.exec(r)?.[1]).filter((v): v is string => v !== undefined).map(Number)
    check(`W1 ${SEATS[seat]}: reasoning is named with a counter that moves (${reasoning.join(',') || 'none'})`, reasoning.length >= 2 && reasoning[reasoning.length - 1]! > reasoning[0]!)
    check(`W1 ${SEATS[seat]}: the tool phase paints the running tool's own line`, rows.some(r => /sleep 2|wait two seconds|Bash/.test(r)))
    check(`W1 ${SEATS[seat]}: the row lands`, rows.some(r => r.includes('landed')) || (cap.text.includes(SEATS[seat]) && seatRow(cap.text, seat)?.includes('landed') === true), seatRow(cap.text, seat)?.slice(0, 160) ?? '(no final row)')
    const distinct = new Set(rows.map(r => PHASE_WORDS.find(w => r.includes(w)) ?? (r.includes('landed') ? 'landed' : 'other')))
    check(`W1 ${SEATS[seat]}: never one word across the run (${[...distinct].join(' → ')})`, distinct.size >= 3)
  }

  console.log('\n— W2 time-to-first-visible-output —')
  const fable = firstPhaseTick('fable')
  const gpt = firstPhaseTick('gpt')
  check('W2 both seats showed a phase word', fable !== null && gpt !== null, `fable ${fable?.tick ?? 'never'} · gpt ${gpt?.tick ?? 'never'}`)
  if (fable !== null && gpt !== null) {
    const diff = Math.abs(fable.tick - gpt.tick)
    check(`W2 the first visible output lands within three frames on both wires (fable @${fable.tick}, gpt @${gpt.tick}, ${(diff * 0.2).toFixed(1)} s apart)`, diff <= 3)
  }
  const fableFirst = fixture.hits.find(h => h.lane === 'fable' && h.call === 1)
  const gptFirst = fixture.hits.find(h => h.lane === 'gpt' && h.call === 1)
  if (fableFirst && gptFirst) {
    console.log(`  the seats' first requests reached the fixture ${Math.abs(fableFirst.atMs - gptFirst.atMs)} ms apart`)
    console.log('  the runner\'s OpenAI road between the launch and the GPT seat\'s first request:')
    for (const line of runnerOpenaiTimeline(home, launchTs, gptFirst.atMs).slice(0, 40)) console.log(`    ${line}`)
  }

  console.log('\n— W3 the catalogue hand-off —')
  const modelsAfterLaunch = fixture.hits.filter(h => h.lane === 'models' && h.atMs > launchTs)
  const seatFetches = modelsAfterLaunch.filter(h => !bootFetch(fixture.hits, h.atMs))
  const modelsBefore = fixture.hits.filter(h => h.lane === 'models' && h.atMs <= launchTs).length
  check(`W3 no seat's models-list fetch reached the fixture after the launch (${modelsBefore} fetches before it; ${modelsAfterLaunch.length - seatFetches.length} boot warm-up fetch(es) after it, each behind a reachability probe)`, seatFetches.length === 0, `${seatFetches.length} seat fetch(es)`)
  const daemonLog = ((): string => {
    try {
      return readFileSync(join(home, 'daemon', 'daemon.log'), 'utf8')
    } catch {
      return ''
    }
  })()
  check("W3 the warm claim carried the daemon's catalogue snapshot (the daemon's own line)", /warm claim carries the OpenAI catalogue: \d+ model/.test(daemonLog), daemonLog.split('\n').filter(l => l.includes('warm claim')).join(' | ').slice(0, 300))
  check('W3 the GPT seat reached the fixture (its dispatch resolved on the primed catalogue)', gptFirst !== undefined)
}

if (!KEEP) {
  for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${home} cwd=${cwd}`)
}
console.log(failures === 0 ? '\n✅ crew-wait-truth drive GREEN' : `\n❌ crew-wait-truth drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
