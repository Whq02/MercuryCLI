#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

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

const FIXTURE_API_KEY = 'fixture-key-000'
const FIRST = 'claude-sonnet-5'
const FIRST_PROBE_MARK = 'sonnet'
const SECOND = 'fable'
const SECOND_LABEL = 'Fable 5.1'
const PROBE_HOLD_MS = 3_000

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function streamedOk(model: string): string {
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_${Date.now() % 1e6}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
function jsonOk(model: string): string {
  return JSON.stringify({ id: `msg_${Date.now() % 1e6}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } })
}

interface Fixture {
  base: string
  probes: number
  holds: number
  asks: string[]
  close(): Promise<void>
}
const HOLD_ASK = 'hold this turn'
const HOLD_MS = 5_000
function lastUserText(body: { messages?: Array<{ role?: string; content?: unknown }> }): string {
  const last = [...(body.messages ?? [])].reverse().find(m => m.role === 'user')
  const content = last?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>).filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text as string).join('\n')
}
async function startFixture(): Promise<Fixture> {
  const state = { probes: 0, holds: 0, asks: [] as string[] }
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
      let body: { model?: string; stream?: boolean; max_tokens?: number; tools?: unknown[]; messages?: Array<{ role?: string; content?: unknown }> } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        body = {}
      }
      const model = typeof body.model === 'string' ? body.model : 'fixture'
      const streaming = body.stream === true
      const ask = lastUserText(body)
      if (Array.isArray(body.tools) && body.tools.length > 0) state.asks.push(ask)
      if (process.env.FIELD_KEEP === '1') console.log(`[fixture] ${req.method} ${url} model=${model} stream=${String(body.stream)} max_tokens=${String(body.max_tokens)}`)
      const answer = (): void => {
        if (streaming) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.end(streamedOk(model))
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(jsonOk(model))
        }
      }
      if (streaming && Array.isArray(body.tools) && body.tools.length > 0 && ask.includes(HOLD_ASK)) {
        state.holds++
        const frames = streamedOk(model)
        const cut = frames.indexOf('event: content_block_delta')
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(frames.slice(0, cut))
        setTimeout(() => res.end(frames.slice(cut)), HOLD_MS)
        return
      }
      if (model.includes(FIRST_PROBE_MARK)) {
        state.probes++
        setTimeout(answer, PROBE_HOLD_MS)
        return
      }
      answer()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    get probes() {
      return state.probes
    },
    get holds() {
      return state.holds
    },
    get asks() {
      return state.asks
    },
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
  const dir = mkdtempSync(join(tmpdir(), 'field-commands-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'field-commands-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'field-commands-cwd-')))
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

const COLS = 140
const ROWS = 44
const flat = (s: string): string => s.replace(/\s+/g, ' ')

const bootSends: Array<Record<string, unknown>> = [
  { data: '\r', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: '', atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'chat' },
]

function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, COLS)}`)
}

function stripModel(frame: string): string | null {
  for (const line of frame.split('\n')) {
    const m = line.match(/│ ([A-Za-z][^│]*?) · ● (?:low|medium|high|max)/)
    if (m) return m[1]!.trim()
  }
  return null
}

type CensusRow = { site: string; at: number; name?: string; rearmed?: boolean; result?: string }
function traceRows(path: string): CensusRow[] {
  if (!existsSync(path)) return []
  const rows: CensusRow[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as Partial<CensusRow>
      if (typeof row.site === 'string' && row.site.startsWith('repl-dialog-') && typeof row.at === 'number') {
        rows.push({ site: row.site, at: row.at, ...(row.name !== undefined ? { name: row.name } : {}), ...(row.rearmed !== undefined ? { rearmed: row.rearmed } : {}), ...(row.result !== undefined ? { result: row.result } : {}) })
      }
    } catch {
    }
  }
  return rows
}

const LEG = process.env.FIELD_LEG ?? 'all'

async function leg(name: 'law' | 'tight'): Promise<void> {
  if (LEG !== 'all' && LEG !== name) return
  console.log(`\n— ${name}: two /model rows ${name === 'law' ? 'one second' : 'two ticks'} apart —`)
  const gap = name === 'law' ? 5 : 2
  const fixture = await startFixture()
  const { home, cwd } = seedWorld()
  const tracePath = join(home, 'submit-trace.jsonl')
  let cap: Capture
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 320,
        cwd,
        argv: ['node', DIST],
        sends: [
          ...bootSends,
          { data: `/model ${FIRST}`, afterPrevTicks: 2 },
          { data: '\r', afterPrevTicks: 2, mark: 'first-enter' },
          { data: `/model ${SECOND}`, afterPrevTicks: gap },
          { data: '\r', afterPrevTicks: 1, mark: 'second-enter' },
          { data: '', afterPrevTicks: 3, mark: 'after-second' },
          { data: '', afterPrevTicks: Math.ceil(PROBE_HOLD_MS / 200) + 4, mark: 'first-landed' },
          { data: '', afterPrevTicks: 40, mark: 'settled' },
        ],
        stableTicks: 5,
      },
      { ...driveEnv(home, fixture.base), MERCURY_SUBMIT_TRACE: tracePath },
    )
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  const tag = name
  if (process.env.FIELD_KEEP === '1') for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
  check(`${tag}: every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  check(`${tag}: the first row's model was validated on the wire (the held probe — the first command was in flight while the second landed)`, fixture.probes >= 1, `probes ${fixture.probes}`)
  const afterSecond = flat(marks['after-second'] ?? '')
  check(`${tag}: the composer said the second row was queued behind the first`, /\/model queued/.test(afterSecond), afterSecond.match(/[^.]*queued[^.]*/)?.[0] ?? 'no queued word')
  const trace = traceRows(tracePath)
  const events = trace.map(r => `${r.site.replace('repl-dialog-', '')}${r.rearmed === true ? ':rearmed' : ''}`)
  check(
    `${tag}: the census reads dispatch(first) → queued(second) → done(first) → dispatch(second, re-armed) → done(second), in order`,
    events.join(' ') === 'dispatch queued done dispatch:rearmed done',
    events.join(' ') || 'no census rows',
  )
  const dispatches = trace.filter(r => r.site === 'repl-dialog-dispatch')
  check(`${tag}: the second row ran only once the first had settled (after the held probe answered)`, dispatches.length === 2 && dispatches[1]!.at - dispatches[0]!.at >= PROBE_HOLD_MS, dispatches.length === 2 ? `${dispatches[1]!.at - dispatches[0]!.at} ms apart` : `${dispatches.length} dispatches`)
  const dones = trace.filter(r => r.site === 'repl-dialog-done').map(r => r.result ?? '')
  check(`${tag}: both dialogs completed with an applied receipt (the first's model, then the second's)`, dones.length === 2 && /Model set to Sonnet/.test(dones[0]!) && dones[1]!.includes(`Model set to ${SECOND_LABEL}`), dones.join(' ‖ ') || 'no done rows')
  const settled = marks['settled'] ?? ''
  const model = stripModel(settled)
  check(`${tag}: the session strip names the SECOND model once both settled — the second row was applied, after the first`, model === SECOND_LABEL, `strip reads ${model ?? '∅'} · done: ${dones.join(' ‖ ')}`)
  if (failures > 0 && process.env.FIELD_KEEP !== '1') for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
  if (failures > 0 || process.env.FIELD_KEEP === '1') dump(`${tag} · final grid`, cap.text)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

import { createHash as _createHash } from 'node:crypto'
const EFFORTR_DIGEST = _createHash('sha256').update('/effortr').digest('hex').slice(0, 8)

function submitRows(path: string): Array<{ site: string; digest?: string; len?: number }> {
  if (!existsSync(path)) return []
  const rows: Array<{ site: string; digest?: string; len?: number }> = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as { site?: unknown; digest?: unknown; len?: unknown }
      if (typeof row.site === 'string') rows.push({ site: row.site, ...(typeof row.digest === 'string' ? { digest: row.digest } : {}), ...(typeof row.len === 'number' ? { len: row.len } : {}) })
    } catch {
    }
  }
  return rows
}

async function keybindingLeg(): Promise<void> {
  console.log('\n— keybinding: a command:* naming no command is inert; a real one runs —')
  const fixture = await startFixture()
  const { home, cwd } = seedWorld()
  writeFileSync(join(home, 'keybindings.json'), JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+x e': 'command:effortr', 'ctrl+x b': 'command:workbench' } }] }))
  const tracePath = join(home, 'submit-trace.jsonl')
  let cap: Capture
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 260,
        cwd,
        argv: ['node', DIST],
        sends: [
          ...bootSends,
          { data: '\x18', afterPrevTicks: 4 },
          { data: 'e', afterPrevTicks: 2 },
          { data: '', afterPrevTicks: 8, mark: 'after-bad' },
          { data: '\x18', afterPrevTicks: 2 },
          { data: 'b', afterPrevTicks: 2 },
          { data: '', atTick: 999, awaitText: 'PROMPTS', requireAwait: true, minTick: 3, awaitSettleTicks: 4, mark: 'workbench' },
        ],
        stableTicks: 5,
      },
      { ...driveEnv(home, fixture.base), MERCURY_SUBMIT_TRACE: tracePath },
    )
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  if (process.env.FIELD_KEEP === '1') for (const [label, frame] of Object.entries(marks)) dump(`keybinding · ${label}`, frame)
  const afterBad = marks['after-bad'] ?? ''
  check('keybinding: the mis-bound chord painted NO "Unknown command" line', !/Unknown command/.test(afterBad), flat(afterBad).match(/Unknown command[^│]*/)?.[0] ?? 'clean')
  check('keybinding: the mis-bound chord submitted NOTHING (no /effortr in the composer or transcript)', !/effortr/.test(afterBad), flat(afterBad).match(/[^ ]*effortr[^ ]*/)?.[0] ?? 'clean')
  const rows = submitRows(tracePath)
  check('keybinding: the census carries no submit of /effortr (digest)', !rows.some(r => r.digest === EFFORTR_DIGEST), rows.filter(r => r.digest === EFFORTR_DIGEST).map(r => r.site).join(' ') || 'none')
  const workbench = marks['workbench'] ?? ''
  check('keybinding: the real command:* (workbench) still ran — its panel opened', /PROMPTS/.test(workbench), flat(workbench).slice(0, 80))
  const submits = rows.filter(r => r.site === 'repl-onSubmit')
  check('keybinding: exactly one keybinding submit reached onSubmit (the workbench, not the mis-binding)', submits.length === 1, `${submits.length} repl-onSubmit rows`)
  if (failures > 0 && process.env.FIELD_KEEP !== '1') for (const [label, frame] of Object.entries(marks)) dump(`keybinding · ${label}`, frame)
  if (failures > 0 || process.env.FIELD_KEEP === '1') dump('keybinding · final grid', cap.text)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

const RECALL_WORDS = 'the words to take back'
const RECALL_DIGEST = _createHash('sha256').update(RECALL_WORDS).digest('hex').slice(0, 8)

async function recallLeg(): Promise<void> {
  console.log('\n— recall: ↑ pulls a queued line back into the composer; the census keeps two roads —')
  const fixture = await startFixture()
  const { home, cwd } = seedWorld()
  const tracePath = join(home, 'submit-trace.jsonl')
  let cap: Capture
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: 300,
        cwd,
        argv: ['node', DIST],
        sends: [
          ...bootSends,
          { data: `${HOLD_ASK}\r`, afterPrevTicks: 2 },
          { data: `${RECALL_WORDS}\r`, afterPrevTicks: 8, mark: 'words-sent' },
          { data: '', afterPrevTicks: 4, mark: 'queued' },
          { data: '\x1b[A', afterPrevTicks: 1 },
          { data: '', afterPrevTicks: 4, mark: 'recalled' },
          { data: '', afterPrevTicks: Math.ceil(HOLD_MS / 200) + 8, mark: 'settled' },
          { data: '\r', afterPrevTicks: 1 },
          { data: '', afterPrevTicks: 14, mark: 'resent' },
        ],
        stableTicks: 5,
      },
      { ...driveEnv(home, fixture.base), MERCURY_SUBMIT_TRACE: tracePath },
    )
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  if (process.env.FIELD_KEEP === '1') for (const [label, frame] of Object.entries(marks)) dump(`recall · ${label}`, frame)
  const composerLine = (frame: string): string | undefined => frame.split('\n').find(line => /^│❯ /.test(line))
  check('recall: the held turn kept the session busy (the fixture held one stream)', fixture.holds === 1, `${fixture.holds} holds`)
  check('recall: the words painted as the QUEUED row while the turn ran', /queued\s+\[sam\] ❯ the words to take back/.test(marks['queued'] ?? ''), flat(marks['queued'] ?? '').match(/[^│]*take back[^│]*/)?.[0] ?? 'no row')
  check('recall: after ↑ the composer holds the words and the queued row is gone', (composerLine(marks['recalled'] ?? '') ?? '').includes(RECALL_WORDS) && !/queued\s+\[sam\] ❯ the words to take back/.test(marks['recalled'] ?? ''), composerLine(marks['recalled'] ?? '') ?? 'no composer line')
  check('recall: the turn settled with the words still in the composer (nothing drained behind it)', (composerLine(marks['settled'] ?? '') ?? '').includes(RECALL_WORDS), composerLine(marks['settled'] ?? '') ?? 'no composer line')
  const rows = submitRows(tracePath).filter(r => r.digest === RECALL_DIGEST)
  check('recall: the census carries the words as two composer submits and two connector deliveries (the send, the re-send)', rows.filter(r => r.site === 'repl-onSubmit').length === 2 && rows.filter(r => r.site === 'connector-deliver').length === 2, rows.map(r => r.site).join(' ') || 'no rows')
  check('recall: no other writer submitted the words — the recall added no road', rows.every(r => r.site === 'repl-onSubmit' || r.site === 'connector-deliver'), rows.map(r => r.site).join(' '))
  const carrying = fixture.asks.map((ask, i) => [i, ask] as const).filter(([, ask]) => ask.includes(RECALL_WORDS))
  check('recall: the wire carried the words exactly once — the re-send, as the conversation\'s last ask', carrying.length === 1 && carrying[0]![0] === fixture.asks.length - 1, JSON.stringify(fixture.asks.map(a => a.slice(0, 40))))
  if (failures > 0 && process.env.FIELD_KEEP !== '1') for (const [label, frame] of Object.entries(marks)) dump(`recall · ${label}`, frame)
  if (failures > 0 || process.env.FIELD_KEEP === '1') dump('recall · final grid', cap.text)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

await leg('law')
await leg('tight')
if (LEG === 'all' || LEG === 'keybinding') await keybindingLeg()
if (LEG === 'all' || LEG === 'recall') await recallLeg()

console.log(failures === 0 ? '\nprove-field-findings-commands: ALL LAWS HOLD' : `\nprove-field-findings-commands: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
