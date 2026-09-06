#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`✗ capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}
const KEEP = process.env.PARK_KEEP === '1'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number, everyMs = 200): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await sleep(everyMs)
  }
  return false
}

const TITLE = 'Park probe'
const ASK = 'park-probe: commit the probe and report the sha'
const PROBE_COMMIT = 'park-probe'
const WRITING_COMMAND = `git commit --allow-empty -q -m ${PROBE_COMMIT} && git rev-parse --short HEAD`
const BLOCK_REASON = 'park-probe: the fixture safety check blocks the probe commit'
const REPORT_LEAD = 'park-probe: sha='
const MODEL = 'claude-opus-5'
const FIXTURE_API_KEY = 'fixture-key-000'
const WAIT_WORDS = 'waiting for your answer'
const BOARD_WORDS = 'STATUS & TITLE'
const CARD_WORDS = 'Do you want to proceed?'
const CARD_BLOCK_WORDS = "Flow's safety check blocked this"
const DENIAL_WORDS = ['has been denied', 'auto-denied', 'was denied', 'was declined', 'declined this tool call', 'tool_use_error', 'was rejected', 'blocked this action']
const isDenial = (text: string): boolean => DENIAL_WORDS.some(word => text.includes(word))

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'parked-ask-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CREW_DIR

const git = (args: string[]): string => {
  const r = spawnSync('git', ['-C', work, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}
git(['init', '-q'])
git(['config', 'user.name', 'probe'])
git(['config', 'user.email', 'probe@example.invalid'])
writeFileSync(join(work, 'README.md'), 'the parked-ask probe repository\n')
git(['add', 'README.md'])
git(['commit', '-q', '-m', 'the probe commit'])
const shaBefore = git(['rev-parse', '--short', 'HEAD'])
const commitCount = (): string => git(['rev-list', '--all', '--count'])
const isCommit = (sha: string): boolean => spawnSync('git', ['-C', work, 'cat-file', '-t', sha], { encoding: 'utf8' }).stdout.trim() === 'commit'

seedFirstRun(home, [work])
{
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, hasSeenAutoDefaultNotice: true, hasSeenAutoDefaultNudge: true }, null, 2) + '\n')
  writeFileSync(join(home, 'settings.json'), '{}\n')
}

const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { readSessionAsks } = await import('../../src/services/engine-connector/seatProjections.ts')
const obligations = await import('../../src/services/crew/obligations.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

type Route = 'classifier' | 'seat-1' | 'seat-done' | 'side'
interface Hit {
  n: number
  route: Route
  streaming: boolean
  results: string[]
}
type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(b => ((b as { type?: string; text?: string }).type === 'text' ? ((b as { text?: string }).text ?? '') : '')).join('')
      : ''
function routeOf(body: unknown): { route: Route; results: string[] } {
  const tools = ((body as { tools?: unknown[] })?.tools ?? []).map(t => (t as { name?: unknown }).name).filter((n): n is string => typeof n === 'string')
  const results: string[] = []
  const userTexts: string[] = []
  for (const m of (body as { messages?: unknown[] })?.messages ?? []) {
    const msg = m as { role?: string; content?: unknown }
    if (msg.role !== 'user') continue
    const text = textOf(msg.content)
    if (text.trim() !== '') userTexts.push(text)
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content as Array<{ type?: string; content?: unknown }>) if (block.type === 'tool_result') results.push(textOf(block.content))
  }
  if (tools.includes('classify_result')) return { route: 'classifier', results }
  if (userTexts.some(t => t.includes('park-probe:'))) return { route: results.length === 0 ? 'seat-1' : 'seat-done', results }
  return { route: 'side', results }
}
const firstLine = (text: string | undefined): string => (text ?? '').trim().split('\n')[0]?.trim() ?? ''
function jsonAnswer(n: number, model: string, blocks: Block[]): string {
  const content = blocks.map((b, i) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: `toolu_pk_${n}_${i}`, name: b.name, input: b.input }))
  return JSON.stringify({ id: `msg_pk_${n}`, type: 'message', role: 'assistant', model, content, stop_reason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 } })
}
function sseAnswer(n: number, model: string, blocks: Block[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts = [`event: message_start\n${sse({ type: 'message_start', message: { id: `msg_pk_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`]
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      parts.push(`event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`, `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } })}`, `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`)
    } else {
      parts.push(`event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_pk_${n}_${index}`, name: b.name, input: {} } })}`, `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })}`, `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`)
    }
  })
  parts.push(`event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 } })}`, `event: message_stop\n${sse({ type: 'message_stop' })}`)
  return parts.join('')
}
const hits: Hit[] = []
const fixture = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
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
    const streaming = (body as { stream?: unknown })?.stream === true
    const { route, results } = routeOf(body)
    const n = hits.length + 1
    hits.push({ n, route, streaming, results })
    let blocks: Block[]
    switch (route) {
      case 'classifier':
        blocks = [{ type: 'tool_use', name: 'classify_result', input: { thinking: 'The command writes a commit to the working directory.', shouldBlock: true, reason: BLOCK_REASON } }]
        break
      case 'seat-1':
        blocks = [{ type: 'tool_use', name: 'Bash', input: { command: WRITING_COMMAND, description: 'the probe commit and its sha' } }]
        break
      case 'seat-done': {
        const last = firstLine(results[results.length - 1])
        blocks = [{ type: 'text', text: /^[0-9a-f]{7,12}$/.test(last) ? `${REPORT_LEAD}${last}` : `park-probe: not-a-sha (${(results[results.length - 1] ?? '').trim().replace(/\s+/g, ' ').slice(0, 200)})` }]
        break
      }
      default:
        blocks = [{ type: 'text', text: 'ok' }]
    }
    if (!streaming) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(jsonAnswer(n, model, blocks))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(sseAnswer(n, model, blocks))
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`

const logPath = join(SCRATCH, 'daemon.log')
const logFd = openSync(logPath, 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    HOME: home,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    ANTHROPIC_BASE_URL: base,
    OPENAI_API_KEY: '',
    MERCURY_PERMISSION_ASK_EXPIRY_MINUTES: '0.05',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
  },
  stdio: ['ignore', logFd, logFd],
})
const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  try {
    daemon.kill('SIGTERM')
  } catch {
  }
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (failures === 0 && !KEEP) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

interface Capture {
  text: string
  marks: Record<string, string>
  sends: number
  receipts: number
  endReason: string
}
type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string => grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
async function capture(cfg: Record<string, unknown>, env: Record<string, string>): Promise<Capture> {
  const cfgPath = join(SCRATCH, 'vshot-cfg.json')
  const outPath = join(SCRATCH, 'vshot-grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(240_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  return { text: gridText(payload.grid), marks, sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0, receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0, endReason: payload.endReason ?? '' }
}
const listRowOf = (frame: string): string => frame.split('\n').find(r => !r.includes(`"${TITLE}"`) && !r.includes('enter session') && new RegExp(`${TITLE}\\s{2,}`).test(r)) ?? ''
function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  for (const row of (frame ?? '(no frame)').split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, 160)}`)
}

console.log('parked ask — a seat asks with nobody there; the board says so; focus paints the card; the answer lands; the seat resumes')
try {
  check('P1 the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const reply = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'parked-ask-1',
    prompt: ASK,
    workspaceDir: work,
    title: TITLE,
    model: MODEL,
    effort: 'high',
    permissionMode: 'flow',
  } as never)) as { ok?: boolean; sessionId?: string }
  check('P1 the session dispatched in flow mode with no screen attached', reply.ok === true && typeof reply.sessionId === 'string', JSON.stringify(reply))
  const sid = reply.sessionId ?? ''
  const transcript = join(paths.getProjectDir(work), `${sid}.jsonl`)
  const transcriptText = (): string => (existsSync(transcript) ? readFileSync(transcript, 'utf8') : '')
  const asksOf = (): ReturnType<typeof readSessionAsks> => readSessionAsks(sid, daemonDir)
  const openAsks = async (): Promise<number> => (await obligations.openObligations({ scope: 'switchboard' })).filter(o => o.sessionId === sid && (o.ref ?? '').startsWith('permission:')).length

  check('P2 the seat asked and the daemon PARKED it: one ask on the seat', await untilAsync(() => (asksOf()?.asks.length ?? 0) === 1, 90_000), `asks: ${JSON.stringify(asksOf())} · hits: ${hits.map(h => h.route).join(',')}`)
  const parked = asksOf()?.asks[0]
  check("P2 the parked ask is the seat's writing command, carrying the safety check's verdict as its reason", parked?.toolName === 'Bash' && String((parked.input as { command?: unknown }).command ?? '').includes(PROBE_COMMIT) && (parked.decisionReasonDetail as { type?: string } | undefined)?.type === 'classifier' && JSON.stringify(parked.decisionReasonDetail).includes(BLOCK_REASON), JSON.stringify(parked))
  check('P2 the needs-you row was minted for the session', await untilAsync(async () => (await openAsks()) === 1, 15_000))
  check('P2 the shell did NOT run while the ask waited', commitCount() === '1', `commits ${commitCount()}`)
  check('P2 the safety check was asked exactly once', hits.filter(h => h.route === 'classifier').length === 1 && hits.some(h => h.route === 'classifier' && !h.streaming), hits.map(h => `${h.route}${h.streaming ? '' : '/json'}`).join(','))

  const hitsAtPark = hits.length
  await sleep(8_000)
  check("P3 the session's own parked ask has NO CLOCK — still parked long past the daemon's 3-second expiry knob", (asksOf()?.asks.length ?? 0) === 1 && (asksOf()?.asks[0]?.requestId ?? '') === (parked?.requestId ?? '?'), JSON.stringify(asksOf()))
  check('P3 the needs-you row still stands; no denial reached the seat (nothing else left it)', (await openAsks()) === 1 && hits.length === hitsAtPark && transcriptText().split('\n').every(l => !isDenial(l)), `hits ${hitsAtPark}→${hits.length}`)

  const cap = await capture(
    {
      cols: 160,
      rows: 44,
      total: 900,
      cwd: work,
      argv: ['node', DIST],
      sends: [
        { data: '\t', atTick: 999, awaitText: WAIT_WORDS, requireAwait: true, minTick: 5, awaitSettleTicks: 3, mark: 'board' },
        { data: '\r', afterPrevTicks: 3, mark: 'armed' },
        { data: '\r', afterPrevTicks: 4, mark: 'entered' },
        { data: '\r', atTick: 999, awaitText: CARD_WORDS, requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'card' },
        { data: '\x1b[1;2D', atTick: 999, awaitText: REPORT_LEAD, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'answered' },
        { data: '', atTick: 999, awaitText: BOARD_WORDS, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'board-after' },
      ],
      readyText: [BOARD_WORDS],
      stableTicks: 6,
    },
    {
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_CONCOURSE: 'always',
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      OPENAI_API_KEY: '',
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_OASIS_BG: '0',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
  )
  console.log(`  evidence · sends ${cap.receipts}/${cap.sends} · end ${cap.endReason} · hits: ${hits.map(h => `${h.n}:${h.route}${h.streaming ? '' : '/json'}`).join(' ')}`)
  const board = cap.marks['board'] ?? ''
  check(`P4 the board's row for the session reads "${WAIT_WORDS}"`, listRowOf(board).includes(WAIT_WORDS), listRowOf(board) || '(no row)')
  const card = cap.marks['card'] ?? ''
  check('P5 entering the session painted the consent card for the parked ask — the command on the card', card.includes(CARD_WORDS) && card.includes('git commit --allow-empty') && !card.includes(BOARD_WORDS))
  check("P5 the card explains the block (the safety check said no; the decision is the operator's) and quotes the check's reason", card.includes(CARD_BLOCK_WORDS) && card.includes(BLOCK_REASON))
  check('P6 ↵ on Yes settled the needs-you row through the daemon', await untilAsync(async () => (await openAsks()) === 0, 15_000))
  check("P6 the seat's ask table emptied (the card leaves at once)", await untilAsync(() => (asksOf()?.asks.length ?? 0) === 0, 15_000), JSON.stringify(asksOf()))
  check("P6 the seat resumed: its report reached the session's file", await untilAsync(() => transcriptText().includes(REPORT_LEAD), 20_000), transcriptText().slice(-300))
  const shaAfter = /park-probe: sha=([0-9a-f]{7,12})/.exec(transcriptText())?.[1] ?? ''
  check('P6 the shell ran on the allow — the probe commit landed and the reported sha is a NEW commit', commitCount() === '2' && shaAfter !== '' && shaAfter !== shaBefore && isCommit(shaAfter), `commits ${commitCount()} · ${shaBefore} → ${shaAfter || '(no sha reported)'}`)
  const answered = cap.marks['answered'] ?? ''
  check('P6 …and the report painted inside the focused chat', answered.includes(`${REPORT_LEAD}${shaAfter}`) && !answered.includes(BOARD_WORDS))
  check('P6 no denial anywhere on the wire', hits.every(h => h.results.every(r => !isDenial(r))) && transcriptText().split('\n').every(l => !isDenial(l)))
  const after = cap.marks['board-after'] ?? cap.text
  check('P7 back on the board the row no longer waits', after.includes(BOARD_WORDS) && listRowOf(after) !== '' && !listRowOf(after).includes(WAIT_WORDS), listRowOf(after) || '(no row)')
  check('P8 every send became due (every frame the drive waited on painted)', cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  if (failures > 0 || KEEP) {
    for (const [mark, frame] of Object.entries(cap.marks)) dump(mark, frame)
    dump('final grid', cap.text)
    console.log(`  daemon log tail: ${readFileSync(logPath, 'utf8').slice(-1200)}`)
  }
} catch (err) {
  failures++
  console.log(`  [FAIL] the drive threw: ${String(err)}`)
  if (existsSync(logPath)) console.log(`  daemon log tail: ${readFileSync(logPath, 'utf8').slice(-1200)}`)
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n ✅ PARKED ASK — the seat asked with nobody there, the row said so, focus painted the card, the answer landed, the seat resumed' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
