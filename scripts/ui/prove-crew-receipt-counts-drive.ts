#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'

const ROOT = join(import.meta.dir, '..', '..')
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

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ASK = 'crew-drive: launch the crew'
const ACK = 'crew-drive: all landed.'
const HINT = 'a Crewmate result that lands before an earlier call\'s is recorded under the board rows of its own call; buildScreenConversation in src/sessions/transcripts/rowGraph.ts must restore it beside the kept call, and injectTurnReceipts in src/screen/cockpit/turnReceipt.ts counts what that chain holds'

type Seat = { name: string; delayMs: number; input: number; output: number; background?: true; fails?: true }
type Case = { label: string; seats: Seat[]; receipt: string }

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let served = 0
function answer(model: string, blocks: Block[], usage: { input: number; output: number }): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const id = `msg_crew_receipt_${++served}`
  const parts = [`event: message_start\n${sse({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`]
  blocks.forEach((block, index) => {
    const start = block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: `toolu_crew_receipt_${served}_${index}`, name: block.name, input: {} }
    const delta = block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
    parts.push(
      `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: start })}`,
      `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta })}`,
      `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
    )
  })
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

type Turn = { role?: string; content?: unknown }
const turnsOf = (body: unknown): Turn[] => {
  const messages = (body as { messages?: unknown } | null)?.messages
  return Array.isArray(messages) ? (messages as Turn[]) : []
}
const textsOf = (turn: Turn): string[] =>
  typeof turn.content === 'string' ? [turn.content] : Array.isArray(turn.content) ? (turn.content as Array<{ type?: string; text?: unknown }>).flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])) : []
const resultsIn = (body: unknown): number =>
  turnsOf(body).reduce((n, turn) => n + (turn.role === 'user' && Array.isArray(turn.content) ? (turn.content as Array<{ type?: string }>).filter(b => b.type === 'tool_result').length : 0), 0)

interface Fixture { base: string; hits: string[]; close(): Promise<void> }
async function startFixture(seats: Seat[]): Promise<Fixture> {
  const hits: string[] = []
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
      const model = typeof (body as { model?: unknown } | null)?.model === 'string' ? (body as { model: string }).model : 'fixture'
      const userTexts = turnsOf(body).filter(turn => turn.role === 'user').flatMap(textsOf)
      const marked = userTexts.filter(text => text.includes('crew-seat:') || text.includes('crew-drive:')).at(-1) ?? ''
      const send = (blocks: Block[], usage: { input: number; output: number }): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(answer(model, blocks, usage))
      }
      const seat = marked.includes('crew-seat:') ? seats.find(s => marked.includes(`crew-seat: ${s.name}`)) : undefined
      if (seat !== undefined) {
        hits.push(`seat:${seat.name}`)
        setTimeout(() => {
          if (seat.fails) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `fixture refuses ${seat.name}` } }))
            return
          }
          send([{ type: 'text', text: `seat ${seat.name} done.` }], { input: seat.input, output: seat.output })
        }, seat.delayMs)
        return
      }
      if (userTexts.some(text => text.includes('<task-notification>')) && resultsIn(body) >= seats.length && marked.includes('crew-drive:')) {
        hits.push('notification')
        send([{ type: 'text', text: 'crew-drive: noted.' }], { input: 1600, output: 10 })
        return
      }
      if (marked.includes('crew-drive:')) {
        const results = resultsIn(body)
        hits.push(results === 0 ? 'parent' : 'parent-ack')
        if (results === 0) {
          send(
            seats.map(s => ({ type: 'tool_use' as const, name: 'Crewmate', input: { description: s.name, prompt: `crew-seat: ${s.name}`, crewmate_type: 'mercury-crew', ...(s.background ? { run_in_background: true } : {}) } })),
            { input: 1200, output: 80 },
          )
        } else send([{ type: 'text', text: ACK }], { input: 1500, output: 30 })
        return
      }
      hits.push('side')
      send([{ type: 'text', text: 'ok' }], { input: 20, output: 2 })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')

async function drive(seats: Seat[]): Promise<{ frame: string; hits: string[]; endReason: string }> {
  const fixture = await startFixture(seats)
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'crew-receipt-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'crew-receipt-cwd-')))
  const dir = mkdtempSync(join(tmpdir(), 'crew-receipt-cfg-'))
  seedFirstRun(home, [cwd])
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({
    cols: 160,
    rows: 50,
    total: 450,
    cwd,
    argv: ['node', DIST],
    stableTicks: 6,
    out: outPath,
    sends: [
      { data: '\r', atTick: 999, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
      { data: ASK, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
      { data: '\r', atTick: 999, awaitText: ASK, requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
      { data: '', atTick: 999, awaitText: ACK, requireAwait: true, minTick: 2, awaitStableTicks: 8, awaitSettleTicks: 8, mark: 'landed' },
    ],
  }))
  const env: Record<string, string> = {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixture.base,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENAI_API_KEY: '',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_TURN_RECEIPT: '1',
  }
  const stderr: string[] = []
  try {
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
  } finally {
    await fixture.close()
  }
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const landed = (payload.marks ?? []).find(m => m.label === 'landed')
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  return { frame: gridText(landed?.grid ?? payload.grid), hits: fixture.hits, endReason: landed === undefined ? `no landed mark (${payload.endReason ?? ''})` : 'landed' }
}

const counted = (row: string): string => row.split(' · ').filter(part => !part.startsWith('ctx ') && !/^<?\$/.test(part)).join(' · ')

function receiptRow(frame: string): string | null {
  const lines = frame.split('\n')
  const ack = lines.findIndex(line => line.includes(ACK))
  if (ack < 0) return null
  for (const line of lines.slice(ack + 1)) {
    const row = /∙ (.+?)\s*(?:│|$)/.exec(line)
    if (row !== null) return row[1]!
  }
  return null
}

const seat = (name: string, delayMs: number, input: number, output: number, extra: Partial<Seat> = {}): Seat => ({ name, delayMs, input, output, ...extra })
const cases: Case[] = [
  { label: 'two foreground crewmates in one message, the second lands first', seats: [seat('tide-gauges', 6000, 950, 60), seat('reef-survey', 1000, 1900, 120)], receipt: '2 crewmates · 3.0k tokens' },
  { label: 'three foreground crewmates in one message, landing last to first', seats: [seat('tide-gauges', 7000, 950, 60), seat('reef-survey', 4000, 1900, 120), seat('kelp-beds', 1000, 3800, 240)], receipt: '3 crewmates · 7.1k tokens' },
  { label: 'one foreground and one background crewmate in one message', seats: [seat('tide-gauges', 5000, 950, 60), seat('reef-survey', 20000, 1900, 120, { background: true })], receipt: '2 crewmates · 1.0k tokens' },
  { label: 'a crewmate whose result is an error stays a plain call, as it counts today', seats: [seat('tide-gauges', 1000, 950, 60), seat('reef-survey', 5000, 1900, 120, { fails: true })], receipt: 'Crewmate ×1 · 1 crewmate · 1.0k tokens' },
  { label: 'an error that lands first stays a plain call; the sibling it hands to the background is a launch', seats: [seat('tide-gauges', 6000, 950, 60), seat('reef-survey', 1000, 1900, 120, { fails: true })], receipt: 'Crewmate ×1 · 1 crewmate' },
]

for (const c of cases) {
  console.log(`\n— ${c.label} —`)
  const run = await drive(c.seats)
  const row = receiptRow(run.frame)
  console.log(`  receipt row: ${row ?? '(none under the reply)'}`)
  check('the drive ran: the parent launched, every seat was asked, the parent answered', run.endReason === 'landed' && run.hits.includes('parent') && c.seats.every(s => run.hits.includes(`seat:${s.name}`)) && run.hits.includes('parent-ack'), `${run.endReason} · hits ${run.hits.join(',')} — the fixture did not see the whole crew; the Crewmate tool was not offered or a seat never answered`)
  check(`the receipt row counts "${c.receipt}"`, row !== null && counted(row) === c.receipt, `row: ${row ?? '(none under the reply)'} — ${HINT}`)
  if (!c.receipt.startsWith('Crewmate')) check('no Crewmate call is left as a plain tool count', row !== null && !/Crewmate ×\d/.test(row), `row: ${row ?? '(none)'} — ${HINT}`)
  if (failures > 0 || process.env.CREW_RECEIPT_KEEP === '1') for (const line of run.frame.split('\n')) if (line.trim()) console.log(`  │ ${line}`)
}

console.log(failures === 0 ? '\nprove-crew-receipt-counts-drive: ALL LAWS HOLD' : `\nprove-crew-receipt-counts-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
