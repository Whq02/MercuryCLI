#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'
import { resolveExecutionProfile } from '../lib/executionProfile.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { readAllTranscriptEntries } from '../../src/utils/sessionStorage/materialize.ts'

const ROOT = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs')
const KEEP = process.argv.includes('--keep')
const LEGS = new Set((argAfter('--legs') ?? 'pasted,typed').split(','))
const VENDORED_NODE = join(dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : (Bun.which('node') ?? 'node')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks += 1
  if (!cond) failures += 1
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

const driver = resolveCaptureDriver()
const hosted = resolveExecutionProfile(ROOT).kind === 'hosted-gate'
function refuse(reason: string): never {
  if (hosted) {
    console.error(`  [FAIL] the hosted gate cannot capture — ${reason}`)
    process.exit(1)
  }
  console.log(`__SUITE_SKIPPED unknown-command-consumed: ${reason}`)
  process.exit(0)
}
if (driver.kind === 'unavailable') refuse(`${driver.reason} (${driver.remedy})`)
if (driver.kind !== 'posix-pty') refuse(`the ${driver.kind} capture driver is not driven by this suite`)
const preflight = preflightCaptureDriver(driver, ROOT)
if (!preflight.ok) refuse(describeCapturePreflight(preflight))
if (!existsSync(DIST)) {
  console.error(`${DIST} missing — build first`)
  process.exit(1)
}

const SCRATCH = join(realpathSync(tmpdir()), `unknown-consumed-${process.pid}`)
mkdirSync(SCRATCH, { recursive: true })

const UNKNOWN_LINE = '/nosuch some long text here'
const PASTE_TAIL = 'second line of the paste\nthird line of the paste'
const ORDINARY = 'ordinary prompt please'
const QUEUED = 'queued while the tool runs'
const THIRD = 'third prompt now'
const ESCAPED = '//nosuch literal words to the model'
const SLOW_TOOL = 'sleep 14; echo slow-done'

type Block = { type?: string; text?: string }
type Item = { role?: string; content?: unknown }
type Hit = { n: number; users: string[]; last: string; answer: string }
const textOf = (content: unknown): string => (typeof content === 'string' ? content : Array.isArray(content) ? (content as Block[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') : '')
const unreminded = (t: string): string => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

async function startFixture(): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = []
  const open = new Set<ServerResponse>()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: { model?: string; messages?: Item[]; tools?: unknown[] } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        body = {}
      }
      const items = body.messages ?? []
      const users = items.filter(i => i.role === 'user').map(i => unreminded(textOf(i.content)))
      const lastItem = items[items.length - 1]
      const lastHasResult = lastItem?.role === 'user' && Array.isArray(lastItem.content) && (lastItem.content as Block[]).some(b => b.type === 'tool_result')
      const last = lastItem?.role === 'user' ? unreminded(textOf(lastItem.content)) : ''
      const n = hits.length + 1
      const slow = !lastHasResult && last.includes(ORDINARY) && (body.tools ?? []).length > 0
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write(sse('message_start', { type: 'message_start', message: { id: `msg_uc_${n}`, type: 'message', role: 'assistant', model: body.model ?? 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }))
      if (slow) {
        res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_uc_${n}`, name: 'Bash', input: {} } }))
        res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: SLOW_TOOL, description: 'the slow tool' }) } }))
        res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
        res.end(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }) + sse('message_stop', { type: 'message_stop' }))
      } else {
        res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
        res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `fixture answer ${n} done` } }))
        res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
        res.end(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }) + sse('message_stop', { type: 'message_stop' }))
      }
      hits.push({ n, users, last, answer: slow ? 'tool' : `answer ${n}` })
      open.add(res)
      res.on('close', () => open.delete(res))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>(resolve => {
        for (const res of open) res.destroy()
        server.close(() => resolve())
      }),
  }
}

type Leg = { name: string; home: string; cwd: string; cfg: string; grid: string; log: string; unknown: string; composerNeedle: string }
function seedLeg(name: string): Leg {
  const home = join(SCRATCH, `home-${name}`)
  const cwd = join(SCRATCH, `cwd-${name}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# the unknown-command fixture\n')
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { sovereignConsentSeen: true }, activity: { tips: { enabled: false } } }))
  const unknown = name === 'pasted' ? `\x1b[200~${UNKNOWN_LINE}\n${PASTE_TAIL}\x1b[201~` : UNKNOWN_LINE
  return { name, home, cwd, cfg: join(SCRATCH, `${name}-cfg.json`), grid: join(SCRATCH, `${name}-grid.json`), log: join(SCRATCH, `${name}-engine.log`), unknown, composerNeedle: name === 'pasted' ? 'Pasted text #1' : 'some long text here' }
}
function childEnv(leg: Leg, fixtureUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: leg.home,
    MERCURY_DAEMON_DIR: './daemon',
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_UPDATE_NOTICE: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_DESKTOP_DRIVER: 'none',
    MERCURY_OASIS_BG: '0',
    ANTHROPIC_BASE_URL: fixtureUrl,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    BROWSER: '/usr/bin/true',
  }
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_REDUCED_MOTION', 'NODE_ENV', 'CI']) delete env[key]
  return env
}

type Cell = string | { c?: string } | null
type Grid = Cell[][]
const cellGlyph = (cell: Cell | undefined): string => (typeof cell === 'object' && cell !== null ? (cell.c ?? ' ') : String(cell ?? ' '))
const gridText = (grid: Grid): string => grid.map(row => row.map(c => cellGlyph(c)).join('').trimEnd()).join('\n')
type Payload = { grid: Grid; endReason?: string; sendReceipts?: Array<{ atTick: number }>; marks?: Array<{ label: string; grid: Grid }> }
type Capture = { status: number | null; marks: Record<string, string>; receipts: number; sends: number; endReason: string; output: string }

const QUEUED_ROW = `[sam] ❯ ${QUEUED}`
const ESCAPED_TAIL = 'literal words to the model'
const ANSWER_2 = 'fixture answer 2 done'
const ANSWER_3 = 'fixture answer 3 done'
const ANSWER_4 = 'fixture answer 4 done'

async function capture(leg: Leg, fixtureUrl: string): Promise<Capture> {
  const sends: Array<Record<string, unknown>> = [
    { data: '\r', atTick: 60, awaitText: '↑↓ choose', requireAwait: true, minTick: 3, awaitSettleTicks: 2, mark: 'boot' },
    { data: leg.unknown, atTick: 999, awaitText: '← back', requireAwait: true, minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'typed-unknown' },
    { data: '\r', atTick: 999, awaitText: leg.composerNeedle, requireAwait: true, minTick: 1, awaitSettleTicks: 2, mark: 'sent-unknown' },
    { data: '', atTick: 999, awaitText: 'Unknown command: /nosuch', requireAwait: true, minTick: 1, awaitSettleTicks: 8, awaitStableTicks: 3, mark: 'after-unknown' },
    { data: ORDINARY, atTick: 999, awaitText: 'Unknown command: /nosuch', requireAwait: true, minTick: 1, awaitSettleTicks: 1 },
    { data: '\r', atTick: 999, awaitText: ORDINARY, requireAwait: true, minTick: 1, awaitSettleTicks: 2, mark: 'sent-ordinary' },
    { data: QUEUED, atTick: 999, awaitText: 'sleep 14', requireAwait: true, minTick: 1, awaitSettleTicks: 4, mark: 'typed-queued' },
    { data: '\r', atTick: 999, awaitText: QUEUED, requireAwait: true, minTick: 1, awaitSettleTicks: 2, mark: 'sent-queued' },
    { data: '', atTick: 999, awaitText: QUEUED_ROW, requireAwait: true, minTick: 1, awaitSettleTicks: 3, mark: 'mid-tool' },
    { data: '\x1b', atTick: 999, awaitText: QUEUED_ROW, requireAwait: true, minTick: 1, awaitSettleTicks: 1, mark: 'esc' },
    { data: '', atTick: 999, awaitText: ANSWER_2, requireAwait: true, minTick: 1, awaitSettleTicks: 8, awaitStableTicks: 4, mark: 'after-esc' },
    { data: THIRD, atTick: 999, awaitText: ANSWER_2, requireAwait: true, minTick: 1, awaitSettleTicks: 1 },
    { data: '\r', atTick: 999, awaitText: THIRD, requireAwait: true, minTick: 1, awaitSettleTicks: 2, mark: 'sent-third' },
    { data: ESCAPED, atTick: 999, awaitText: ANSWER_3, requireAwait: true, minTick: 1, awaitSettleTicks: 6, awaitStableTicks: 3, mark: 'after-third' },
    { data: '\r', atTick: 999, awaitText: ESCAPED_TAIL, requireAwait: true, minTick: 1, awaitSettleTicks: 2, mark: 'sent-escaped' },
    { data: '', atTick: 999, awaitText: ANSWER_4, requireAwait: true, minTick: 1, awaitSettleTicks: 8, awaitStableTicks: 4, mark: 'end' },
  ]
  const cfg = { argv: [NODE, DIST, '--sovereign'], cwd: leg.cwd, cols: 120, rows: 56, sends, resizes: [], total: 320, out: leg.grid, readyText: [ANSWER_4] }
  writeFileSync(leg.cfg, JSON.stringify(cfg))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), leg.cfg], { cwd: leg.cwd, env: childEnv(leg, fixtureUrl), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', c => { output += String(c) })
  child.stderr.on('data', c => { output += String(c) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(320 * 200 + 60_000))
    child.once('error', error => { output += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  writeFileSync(leg.log, output)
  const payload = existsSync(leg.grid) ? (JSON.parse(readFileSync(leg.grid, 'utf8')) as Payload) : null
  const marks: Record<string, string> = {}
  for (const m of payload?.marks ?? []) marks[m.label] = gridText(m.grid)
  if (payload) marks.final = gridText(payload.grid)
  return { status, marks, receipts: payload?.sendReceipts?.length ?? 0, sends: sends.length, endReason: payload?.endReason ?? '', output }
}

async function transcriptRows(home: string): Promise<Array<{ type?: string; text: string }>> {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/^[0-9a-f-]{36}\.jsonl$/.test(name)) files.push(p)
    }
  }
  if (existsSync(join(home, 'projects'))) walk(join(home, 'projects'))
  const rows: Array<{ type?: string; text: string }> = []
  for (const file of files) {
    for (const entry of await readAllTranscriptEntries(file)) {
      const r = entry as { type?: string; message?: { content?: unknown }; content?: unknown }
      rows.push({ type: r.type, text: textOf(r.message?.content ?? r.content ?? '') })
    }
  }
  return rows
}

const rowsOf = (frame: string | undefined): string[] => (frame ?? '').split('\n')
const composerRow = (frame: string | undefined): string => rowsOf(frame).find(r => r.includes('│❯')) ?? ''
const countRows = (frame: string | undefined, needle: string): number => rowsOf(frame).filter(r => r.includes(needle)).length

async function runLeg(name: string): Promise<void> {
  console.log(`\n— ${name}: ${name === 'pasted' ? 'the unknown command pasted as a chip (the owner\'s shape)' : 'the unknown command typed on one line'} —`)
  const fixture = await startFixture()
  const leg = seedLeg(name)
  let cap: Capture
  try {
    cap = await capture(leg, fixture.url)
  } finally {
    await fixture.close()
  }
  const m = cap.marks
  const hits = fixture.hits
  console.log(`  wire: ${hits.map(h => `${h.n}:${JSON.stringify(h.last.slice(0, 48))}→${h.answer}`).join(' · ')}`)
  check(`${name} D0 the drive ran whole (engine exit 0, every send due)`, cap.status === 0 && cap.receipts === cap.sends, `exit=${cap.status} sends=${cap.receipts}/${cap.sends} end=${cap.endReason} · ${leg.log}`)
  const afterUnknown = m['after-unknown']
  check(`${name} U1 exactly ONE unknown-command row after the send`, countRows(afterUnknown, 'Unknown command: /nosuch') === 1, `${countRows(afterUnknown, 'Unknown command: /nosuch')} rows`)
  check(`${name} U2 no skill-notice echo of the words (no "was not found", no "arguments were")`, !/was not found|its arguments were/.test(afterUnknown ?? ''), rowsOf(afterUnknown).filter(r => /was not found|arguments were/.test(r)).join(' | '))
  check(`${name} U3 the operator's text is not painted as a sent row`, countRows(afterUnknown, 'some long text here') === 0 && countRows(afterUnknown, 'second line of the paste') === 0, rowsOf(afterUnknown).filter(r => /some long text here|second line/.test(r)).join(' | '))
  check(`${name} U4 the composer is empty after the unknown command`, composerRow(afterUnknown).includes('Type a prompt'), composerRow(afterUnknown).trim().slice(0, 100))
  const fin = m.final
  check(`${name} G1 the final frame still carries exactly ONE unknown-command row and no ghost of the words at the tail`, countRows(fin, 'Unknown command: /nosuch') === 1 && countRows(fin, 'some long text here') === 0 && countRows(fin, 'second line of the paste') === 0, rowsOf(fin).filter(r => /Unknown command|some long text|second line/.test(r)).map(r => r.trim().slice(0, 90)).join(' | '))
  check(`${name} G2 the "[sam] ❯" rows are the four prompts the operator sent, nothing more`, countRows(fin, '[sam] ❯') === 4, `${countRows(fin, '[sam] ❯')} rows: ${rowsOf(fin).filter(r => r.includes('[sam] ❯')).map(r => r.trim().slice(0, 70)).join(' | ')}`)
  check(`${name} G3 esc interrupted the tool turn (the interrupted row painted)`, /Request interrupted by user|the interrupt ended/.test(m['after-esc'] ?? ''), rowsOf(m['after-esc']).slice(-12).join(' | ').slice(0, 300))
  const ordinaryHit = hits.find(h => h.last === ORDINARY || h.last.endsWith(`\n\n${ORDINARY}`))
  check(`${name} W1 the model's request for the ordinary prompt carries that prompt alone — no refusal line, no caveat`, ordinaryHit !== undefined && ordinaryHit.last === ORDINARY && !ordinaryHit.users.some(u => u.includes('Unknown command') || u.includes('local-command-caveat')), ordinaryHit === undefined ? `no request ended on the ordinary prompt: ${hits.map(h => JSON.stringify(h.last.slice(0, 60))).join(' · ')}` : JSON.stringify(ordinaryHit.users).slice(0, 400))
  check(`${name} W2 the words of the unknown command reach the model in NO request`, hits.every(h => h.users.every(u => !u.includes('some long text here') && !u.includes('second line of the paste'))), hits.filter(h => h.users.some(u => u.includes('some long text here'))).map(h => `hit ${h.n}`).join(','))
  const queuedNewest = hits.filter(h => h.last.endsWith(QUEUED))
  check(`${name} W3 the message typed while the tool ran delivered after the interrupt, exactly once`, queuedNewest.length === 1 && hits.some(h => h.answer === 'tool') && (queuedNewest[0]?.n ?? 0) > (hits.find(h => h.answer === 'tool')?.n ?? 0), `${queuedNewest.length} requests ended on it: ${hits.map(h => `${h.n}:${JSON.stringify(h.last.slice(0, 40))}`).join(' · ')}`)
  check(`${name} W4 a later prompt still runs a turn after the interrupt`, hits.some(h => h.last.endsWith(THIRD)), hits.map(h => JSON.stringify(h.last.slice(0, 40))).join(' · '))
  check(`${name} W5 the // road sends the line to the model as text`, hits.some(h => h.last === ESCAPED), hits.map(h => JSON.stringify(h.last.slice(0, 40))).join(' · '))
  const rows = await transcriptRows(leg.home)
  const userRows = rows.filter(r => r.type === 'user')
  check(`${name} T1 no user row of the transcript carries the unknown command's words or the refusal as the operator's own`, userRows.every(r => !r.text.includes('some long text here') && !r.text.includes('Unknown command: /nosuch')), userRows.filter(r => /some long text here|Unknown command/.test(r.text)).map(r => r.text.slice(0, 80)).join(' | '))
  check(`${name} T2 the queued message is ONE user row of the transcript`, userRows.filter(r => r.text.endsWith(QUEUED)).length === 1, `${userRows.filter(r => r.text.endsWith(QUEUED)).length}`)
  check(`${name} T3 no transcript row echoes the paragraph in a skill notice`, rows.every(r => !r.text.includes('its arguments were')))
  if (KEEP) console.log(`  kept: ${leg.home} · ${leg.log}`)
}

console.log(`unknown-command consumed · dist ${DIST} · node ${NODE} · scratch ${SCRATCH}`)
if (LEGS.has('pasted')) await runLeg('pasted')
if (LEGS.has('typed')) await runLeg('typed')

if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`\n[keep] ${SCRATCH}`)
console.log(`\nprove-unknown-command-consumed-drive: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
