#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { ENGINE_ENV, ROOT, engineLaneState, type Engine } from './shell-engine-parity.ts'

const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const note = (text: string): void => console.log(`        note: ${text}`)

const ASK = 'shell-drive: run the six'
const lane = engineLaneState()

interface ToolResultSeen {
  index: number
  text: string
  isError: boolean
}
interface Fixture {
  base: string
  results: ToolResultSeen[]
  descriptions: string[]
  stamps: Record<number, number>
  close(): Promise<void>
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

function lastUserText(body: unknown): string {
  const messages = (body as { messages?: unknown[] })?.messages ?? []
  let last = ''
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown }
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') {
      if (msg.content.trim() !== '') last = msg.content
      continue
    }
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content as Array<{ type?: string; text?: string }>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') last = block.text
    }
  }
  return last
}

function toolResults(body: unknown): ToolResultSeen[] {
  const out: ToolResultSeen[] = []
  const messages = (body as { messages?: unknown[] })?.messages ?? []
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown }
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as Array<{ type?: string; content?: unknown; is_error?: boolean }>) {
      if (block.type !== 'tool_result') continue
      let text = ''
      if (typeof block.content === 'string') text = block.content
      else if (Array.isArray(block.content)) text = (block.content as Array<{ type?: string; text?: string }>).map(b => (b.type === 'text' ? b.text ?? '' : '')).join('')
      out.push({ index: out.length + 1, text, isError: block.is_error === true })
    }
  }
  return out
}

function bashDescription(body: unknown): string | null {
  const tools = (body as { tools?: unknown[] })?.tools
  if (!Array.isArray(tools)) return null
  const bash = tools.find(t => (t as { name?: string })?.name === 'Bash') as { description?: string } | undefined
  return bash?.description ?? null
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }

function answer(model: string, blocks: Block[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_drive_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
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
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_drive_${Date.now() % 100000}_${index}`, name: block.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 30 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

const SUBDIR_NAME = 'drive-sub'
const MISSING_DIR = 'nonexistent-dir-for-the-shell-drive'

function callFor(count: number, cwd: string): Block[] | null {
  const sub = join(cwd, SUBDIR_NAME)
  switch (count) {
    case 0:
      return [
        { type: 'text', text: 'setting state' },
        { type: 'tool_use', name: 'Bash', input: { command: `DRIVE_VAR=persisted; drive_fn() { echo "fn-$1"; }; cd "${sub}"`, description: 'set a variable, a function, and cd' } },
      ]
    case 1:
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'echo "[${DRIVE_VAR:-none}]"; drive_fn x 2>/dev/null || echo fn-missing; pwd', description: 'read the variable, the function, and the directory' } }]
    case 2:
      return [{ type: 'tool_use', name: 'Bash', input: { command: `printf 'alpha\\nbeta\\ngamma\\n' | grep a | sed 's/a/A/g' | awk '{print NR ":" $1}'`, description: 'a grep sed awk pipeline' } }]
    case 3:
      return [{ type: 'tool_use', name: 'Bash', input: { command: `ls "${join(cwd, MISSING_DIR)}"`, description: 'a command that fails' } }]
    case 4:
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 30', timeout: 3000, description: 'a command past its timeout' } }]
    case 5:
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 15; echo bg-done', run_in_background: true, description: 'a background call' } }]
    default:
      return null
  }
}

async function startFixture(port: number, cwd: string): Promise<Fixture> {
  const results: ToolResultSeen[] = []
  const descriptions: string[] = []
  const stamps: Record<number, number> = {}
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = req.url ?? ''
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
      const ours = lastUserText(body).includes('shell-drive:') || toolResults(body).length > 0
      let blocks: Block[]
      if (!ours) {
        blocks = [{ type: 'text', text: 'ok' }]
      } else {
        const seen = toolResults(body)
        stamps[seen.length] ??= Date.now()
        for (const r of seen) if (!results.some(k => k.index === r.index)) results.push(r)
        const description = bashDescription(body)
        if (description !== null && !descriptions.includes(description)) descriptions.push(description)
        blocks = callFor(seen.length, cwd) ?? [{ type: 'text', text: 'shell-drive: done' }]
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(answer(model, blocks))
    })
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? address.port : port
  return {
    base: `http://127.0.0.1:${bound}`,
    results,
    descriptions,
    stamps,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
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
  const dir = mkdtempSync(join(tmpdir(), 'shell-drive-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(200_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as {
    grid: Grid
    sendReceipts?: unknown[]
    marks?: Array<{ label: string; grid: Grid }>
    endReason?: string
  }
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'shell-drive-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'shell-drive-cwd-')))
  mkdirSync(join(cwd, SUBDIR_NAME))
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] }, skipSovereignConsentPrompt: true }, null, 2))
  return { home, cwd }
}

function driveEnv(home: string, fixtureBase: string, engine: Engine): Record<string, string> {
  const env: Record<string, string> = {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_SKIP_PERMISSIONS: '1',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    OPENAI_API_KEY: '',
    SHELL: existsSync('/bin/bash') ? '/bin/bash' : (process.env.SHELL ?? '/bin/sh'),
  }
  if (engine === 'brush') env[ENGINE_ENV] = 'brush'
  return env
}

const COLS = 160
const ROWS = 50
const bootSends = (ask: string): Array<Record<string, unknown>> => [
  { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 5, awaitStableTicks: 6, awaitSettleTicks: 4 },
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

const flat = (s: string): string => s.replace(/\s+/g, ' ')

async function leg(engine: Engine, port: number): Promise<void> {
  const contract: Engine = engine === 'brush' && lane.state === 'wired' ? 'brush' : 'system'
  console.log(`\n— leg: ${engine} (judged by the ${contract} contract${engine === 'brush' && contract === 'system' ? `; lane ${lane.state}: ${lane.reason}` : ''}) —`)
  const { home, cwd } = seedWorld()
  const fixture = await startFixture(port, cwd)
  const sub = join(cwd, SUBDIR_NAME)
  let cap: Capture | null = null
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 320,
        cwd,
        argv: ['node', DIST, '--dangerously-bypass-permissions'],
        sends: [
          ...bootSends(ASK),
          { data: '', atTick: 999, awaitText: 'setting state', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'text' },
          { data: '', atTick: 999, awaitText: 'bash commands', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'tools' },
          { data: '', atTick: 999, awaitText: 'Background command', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'background' },
          { data: '', atTick: 999, awaitText: 'shell-drive: done', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'done' },
        ],
        stableTicks: 6,
      },
      driveEnv(home, fixture.base, engine),
    )
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  const keep = process.env.DRIVE_KEEP === '1'
  if (keep) for (const [label, frame] of Object.entries(marks)) dump(`${engine} · ${label}`, frame)
  check(`${engine}: every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  const results = fixture.results
  check(`${engine}: the model saw six tool results on the wire`, results.length === 6, `${results.length}: ${results.map(r => JSON.stringify(r.text.slice(0, 40))).join(' ')}`)
  const r = (n: number): ToolResultSeen => results[n - 1] ?? { index: n, text: '', isError: false }
  note(`${engine}: result 2 = ${JSON.stringify(r(2).text.trim())}`)
  if (contract === 'brush') {
    check(`${engine}: call 2 reads the variable, the function, and the directory from call 1`, r(2).text.includes('[persisted]') && r(2).text.includes('fn-x') && r(2).text.includes(sub), JSON.stringify(r(2).text.slice(0, 160)))
  } else {
    check(`${engine}: call 2 reads the honest reset — no variable, no function, the directory kept`, r(2).text.includes('[none]') && r(2).text.includes('fn-missing') && r(2).text.includes(sub), JSON.stringify(r(2).text.slice(0, 160)))
  }
  check(`${engine}: the pipeline's rows reach the model`, /1:AlphA\s+2:betA\s+3:gAmmA/.test(flat(r(3).text)), JSON.stringify(r(3).text.slice(0, 120)))
  check(`${engine}: the exit-1 command is an error result carrying its stderr text`, r(4).isError && /No such file/.test(r(4).text), `isError ${r(4).isError} ${JSON.stringify(r(4).text.slice(0, 160))}`)
  check(`${engine}: the timed-out command tells the model it timed out`, /timed out/i.test(r(5).text), JSON.stringify(r(5).text.slice(0, 200)))
  note(`${engine}: result 5 = ${JSON.stringify(r(5).text.trim().slice(0, 240))}`)
  const bgTurnMs = (fixture.stamps[6] ?? 0) - (fixture.stamps[5] ?? 0)
  note(`${engine}: result 6 = ${JSON.stringify(r(6).text.trim().slice(0, 160))}; the background turn took ${bgTurnMs}ms (the command sleeps 15s)`)
  check(`${engine}: the run_in_background call returns the task receipt at once — the turn is not blocked by the sleeping command`, fixture.stamps[6] !== undefined && bgTurnMs > 0 && bgTurnMs < 8_000, `${bgTurnMs}ms`)
  check(`${engine}: the receipt names the background task`, /background/i.test(r(6).text), JSON.stringify(r(6).text.slice(0, 160)))
  const description = fixture.descriptions[0] ?? ''
  note(`${engine}: the tool's word — ${JSON.stringify((description.match(/[^.]*(persist|reset)[^.]*\./i) ?? [''])[0].trim())}`)
  if (contract === 'brush') {
    check(`${engine}: the tool's description says state persists across calls`, /persist/i.test(description) && !/resets between calls/i.test(description), description.slice(0, 200))
    check(`${engine}: the tool's description says a run_in_background call runs in its own shell`, /run_in_background.*own shell/i.test(description), description.slice(0, 200))
  } else {
    check(`${engine}: the tool's description says the directory persists and everything else resets`, /working directory persists/i.test(description) && /resets between calls/i.test(description), description.slice(0, 200))
  }
  check(`${engine}: the transcript painted the model's turn text`, /setting state/.test(marks['text'] ?? cap.text))
  check(`${engine}: the transcript collapsed the turn's bash calls into one group`, /Ran \d+ bash commands/.test(marks['tools'] ?? cap.text), JSON.stringify((flat(marks['tools'] ?? cap.text).match(/Ran \d+ bash commands/) ?? ['no group'])[0]))
  check(`${engine}: the run_in_background completion surfaced in the transcript (exit code 0)`, /Background command .*completed \(exit code 0\)/.test(flat(marks['background'] ?? cap.text)), JSON.stringify((flat(marks['background'] ?? cap.text).match(/Background command.{0,60}/) ?? ['no bg line'])[0]))
  check(`${engine}: the transcript painted the closing line`, /shell-drive: done/.test(marks['done'] ?? cap.text))
  if (failures > 0 && !keep) for (const [label, frame] of Object.entries(marks)) dump(`${engine} · ${label}`, frame)
  if (failures > 0 || keep) dump(`${engine} · final grid`, cap.text)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

const LEG = process.env.DRIVE_LEG ?? 'both'
if (LEG !== 'brush') await leg('system', Number(process.env.DRIVE_PORT_SYSTEM ?? '0'))
if (LEG !== 'system') await leg('brush', Number(process.env.DRIVE_PORT_BRUSH ?? '0'))

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ THE SHELL-ENGINE DRIVE HOLDS')
else console.log(` ❌ ${failures} SHELL-ENGINE DRIVE CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
