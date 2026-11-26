#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { removeScratch } from '../lib/removeScratch.ts'

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

const SID = 'a14a14a1-0000-4000-8000-00000000c4e1'
const DEAD_ID = 'a14a14a1-0000-4000-8000-00000000dead'
const ASK = 'crew-drive: launch the crew'
const ACK = 'crew-drive: all landed.'
const AGAIN = 'crew-drive: after the resume'
const AGAIN_ACK = 'crew-drive: resumed.'
const BIG_FILE = 5 * 1024 * 1024
const HINT = 'a transcript over 5 MB with at least half its bytes dead loads through the pre-parse prune, selectBranchIds in src/sessions/transcripts/branchSelection.ts; it must keep the board notes under a kept note and a Crewmate result the writer recorded under its call\'s board notes, as decorateOf in src/sessions/transcripts/rowGraph.ts restores them on a full load'

type Seat = { name: string; delayMs: number; input: number; output: number }
const SEATS: Seat[] = [
  { name: 'tide-gauges', delayMs: 6000, input: 950, output: 60 },
  { name: 'reef-survey', delayMs: 1000, input: 1900, output: 120 },
]

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let served = 0
function answer(model: string, blocks: Block[], usage: { input: number; output: number }, calls: string[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const id = `msg_big_resume_${++served}`
  const parts = [`event: message_start\n${sse({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`]
  blocks.forEach((block, index) => {
    const callId = `toolu_big_resume_${served}_${index}`
    if (block.type === 'tool_use') calls.push(callId)
    const start = block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: callId, name: block.name, input: {} }
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

type WireBlock = { type?: string; id?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; text?: unknown }
type Turn = { role?: string; content?: unknown }
const turnsOf = (body: unknown): Turn[] => {
  const messages = typeof body === 'object' && body !== null && 'messages' in body ? body.messages : undefined
  return Array.isArray(messages) ? messages : []
}
const blocksOf = (turn: Turn): WireBlock[] => (Array.isArray(turn.content) ? turn.content : [])
const textsOf = (turn: Turn): string[] => (typeof turn.content === 'string' ? [turn.content] : blocksOf(turn).flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])))
const resultsIn = (body: unknown): number => turnsOf(body).reduce((n, turn) => n + (turn.role === 'user' ? blocksOf(turn).filter(b => b.type === 'tool_result').length : 0), 0)

interface Fixture { base: string; hits: string[]; calls: string[]; resumed: unknown[]; close(): Promise<void> }
async function startFixture(): Promise<Fixture> {
  const hits: string[] = []
  const calls: string[] = []
  const resumed: unknown[] = []
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
      const model = typeof body === 'object' && body !== null && 'model' in body && typeof body.model === 'string' ? body.model : 'fixture'
      const userTexts = turnsOf(body).filter(turn => turn.role === 'user').flatMap(textsOf)
      const marked = userTexts.filter(text => text.includes('crew-seat:') || text.includes('crew-drive:')).at(-1) ?? ''
      const send = (blocks: Block[], usage: { input: number; output: number }): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(answer(model, blocks, usage, calls))
      }
      const seat = marked.includes('crew-seat:') ? SEATS.find(s => marked.includes(`crew-seat: ${s.name}`)) : undefined
      if (seat !== undefined) {
        hits.push(`seat:${seat.name}`)
        setTimeout(() => send([{ type: 'text', text: `seat ${seat.name} done.` }], seat), seat.delayMs)
        return
      }
      if (marked.includes(AGAIN)) {
        hits.push('resumed')
        resumed.push(body)
        send([{ type: 'text', text: AGAIN_ACK }], { input: 1700, output: 10 })
        return
      }
      if (marked.includes(ASK)) {
        const results = resultsIn(body)
        hits.push(results === 0 ? 'parent' : 'parent-ack')
        if (results === 0) send(SEATS.map(s => ({ type: 'tool_use' as const, name: 'Crewmate', input: { description: s.name, prompt: `crew-seat: ${s.name}`, crewmate_type: 'mercury-crew' } })), { input: 1200, output: 80 })
        else send([{ type: 'text', text: ACK }], { input: 1500, output: 30 })
        return
      }
      hits.push('side')
      send([{ type: 'text', text: 'ok' }], { input: 20, output: 2 })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, hits, calls, resumed, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

function transcriptOf(home: string): string {
  const stack = [join(home, 'projects')]
  while (stack.length > 0) {
    const dir = stack.pop()!
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name === `${SID}.jsonl`) return path
    }
  }
  return ''
}

type RecordLine = { recordId?: string; parentId?: string; annotations?: Record<string, unknown>; payload?: { kind?: string; content?: unknown; noticeKind?: string } }
type RecordBlock = { kind?: string; callId?: string }
const recordBlocks = (record: RecordLine): RecordBlock[] => (Array.isArray(record.payload?.content) ? record.payload.content : [])

function deadBranchOf(lines: string[]): { lines: string[]; deadBytes: number } | null {
  const at = lines.findIndex(line => {
    const record: RecordLine = JSON.parse(line)
    return record.payload?.kind === 'input' && typeof record.payload.content === 'string' && record.payload.content.includes(ASK)
  })
  if (at < 0) return null
  const prompt: RecordLine = JSON.parse(lines[at]!)
  const dead = JSON.stringify({ ...prompt, recordId: DEAD_ID, annotations: { ...prompt.annotations, uuid: DEAD_ID }, payload: { ...prompt.payload, content: 'a long paste the operator took back. '.repeat(180_000) } })
  return { lines: [...lines.slice(0, at + 1), dead, ...lines.slice(at + 1)], deadBytes: Buffer.byteLength(dead) + 1 }
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
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

const fixture = await startFixture()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'big-resume-home-')))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'big-resume-cwd-')))
const dir = mkdtempSync(join(tmpdir(), 'big-resume-cfg-'))
seedFirstRun(home, [cwd])
const env: Record<string, string> = {
  HOME: home,
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

try {
  console.log('\n— the turn: two foreground crewmates in one message, the second lands first (a headless run of the built product) —')
  const first = await new Promise<{ code: number | null; out: string; err: string }>(resolve => {
    const child = spawn('node', [DIST, 'run', ASK, '--session-id', SID, '--model', 'claude-opus-4-8', '--format', 'rows'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: string[] = []
    const err: string[] = []
    child.stdout.on('data', c => out.push(String(c)))
    child.stderr.on('data', c => err.push(String(c)))
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(120_000))
    child.on('close', code => {
      clearTimeout(deadline)
      resolve({ code, out: out.join(''), err: err.join('') })
    })
  })
  check('the run launched both crewmates, every seat answered, the parent answered', first.code === 0 && first.out.includes(ACK) && fixture.calls.length === 2 && SEATS.every(s => fixture.hits.includes(`seat:${s.name}`)) && fixture.hits.includes('parent-ack'), `exit ${first.code} · hits ${fixture.hits.join(',')} · ${first.err.slice(-400)}`)

  const file = transcriptOf(home)
  const lines = file === '' ? [] : readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const records: RecordLine[] = lines.map(line => JSON.parse(line))
  const byId = new Map(records.map(record => [record.recordId ?? '', record]))
  const resultOf = (callId: string): RecordLine | undefined => records.find(record => record.payload?.kind === 'input' && recordBlocks(record).some(b => b.kind === 'tool-result' && b.callId === callId))
  const callOf = (callId: string): RecordLine | undefined => records.find(record => record.payload?.kind === 'output' && recordBlocks(record).some(b => b.kind === 'tool-use' && b.callId === callId))
  const [firstCall = '', secondCall = ''] = fixture.calls
  const secondParent = byId.get(resultOf(secondCall)?.parentId ?? '')
  check('the record holds the shape: the second result hangs under the board\'s rows, the first under its own call', secondParent?.payload?.kind === 'notice' && secondParent.payload.noticeKind === 'crew_chat' && resultOf(firstCall)?.parentId === callOf(firstCall)?.recordId, `second result's parent ${secondParent?.payload?.kind ?? 'none'} · transcript ${file || 'not found'} — the writer (src/sessions/transcripts/writer/chainLinks.ts) no longer records this turn as the field did; the scene needs that shape`)

  const padded = deadBranchOf(lines)
  if (padded !== null) writeFileSync(file, padded.lines.join('\n') + '\n')
  const size = file === '' ? 0 : readFileSync(file).length
  check('the transcript is a big one: over 5 MB, at least half its bytes on a dead branch (an abandoned paste beside the prompt)', padded !== null && size > BIG_FILE && padded.deadBytes * 2 >= size, `${size} bytes, ${padded?.deadBytes ?? 0} dead`)

  console.log('\n— the resume: the built product resumes that session in a terminal, then answers one more prompt —')
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({
    cols: 160,
    rows: 50,
    total: 600,
    cwd,
    argv: ['node', DIST, '--resume', SID],
    stableTicks: 6,
    out: outPath,
    sends: [
      { data: '', atTick: 999, awaitText: ACK, requireAwait: true, minTick: 2, awaitStableTicks: 8, awaitSettleTicks: 8, mark: 'resumed' },
      { data: AGAIN, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
      { data: '\r', atTick: 999, awaitText: AGAIN, requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
      { data: '', atTick: 999, awaitText: AGAIN_ACK, requireAwait: true, minTick: 2, awaitStableTicks: 8, awaitSettleTicks: 8, mark: 'answered' },
    ],
  }))
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
  const payload: { grid?: Grid; marks?: Array<{ label: string; grid: Grid }>; endReason?: string } = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {}
  const markOf = (label: string): string | null => {
    const grid = (payload.marks ?? []).find(m => m.label === label)?.grid
    return grid === undefined ? null : gridText(grid)
  }
  const resumedFrame = markOf('resumed')
  check('the resumed screen painted the old turn, and the session answered the next prompt', resumedFrame !== null && markOf('answered') !== null && fixture.resumed.length > 0, `marks ${(payload.marks ?? []).map(m => m.label).join(',') || 'none'} (${payload.endReason ?? 'no grid'}) · ${stderr.join('').slice(-400)}`)
  const row = receiptRow(resumedFrame ?? '')
  console.log(`  receipt row of the resumed turn: ${row ?? '(none under the reply)'}`)
  check('the resumed turn\'s receipt row counts "2 crewmates · 3.0k tokens"', row !== null && counted(row) === '2 crewmates · 3.0k tokens', `row: ${row ?? '(none under the reply)'} — ${HINT}`)
  check('no Crewmate call is left as a plain tool count', row !== null && !/Crewmate ×\d/.test(row), `row: ${row ?? '(none)'} — ${HINT}`)

  const wire = turnsOf(fixture.resumed[0]).flatMap(blocksOf)
  const said = (callId: string): string => JSON.stringify(wire.find(b => b.type === 'tool_result' && b.tool_use_id === callId)?.content ?? '')
  const carried = fixture.calls.map((callId, i) => ({ callId, use: wire.some(b => b.type === 'tool_use' && b.id === callId), result: wire.some(b => b.type === 'tool_result' && b.tool_use_id === callId && b.is_error !== true), report: said(callId).includes(`seat ${SEATS[i]!.name} done.`) }))
  check('the first request after the resume carries both Crewmate calls, each with its crewmate\'s report', carried.length === 2 && carried.every(c => c.use && c.result && c.report), `${JSON.stringify(carried)} — ${HINT}`)

  if (failures > 0 || process.env.BIG_RESUME_KEEP === '1') for (const line of (resumedFrame ?? '').split('\n')) if (line.trim()) console.log(`  │ ${line}`)
} finally {
  await fixture.close()
  removeScratch(dir)
  removeScratch(home)
  removeScratch(cwd)
}

console.log(failures === 0 ? '\nprove-crew-results-after-big-resume-drive: ALL LAWS HOLD' : `\nprove-crew-results-after-big-resume-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
