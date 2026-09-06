#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-compact-fold-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const SIZE = process.env.FOLD_DRIVE_SIZE === '100x30' ? { cols: 100, rows: 30 } : { cols: 120, rows: 40 }
const SID = {
  fold: '00000000-0000-4000-8000-00000000c0a1',
  cancel: '00000000-0000-4000-8000-00000000c0a2',
  refuse: '00000000-0000-4000-8000-00000000c0a3',
  auto: '00000000-0000-4000-8000-00000000c0a4',
} as const
const FOLD_NEEDLE = 'Reply with prose only'
const SUMMARY_CHUNKS = 48
const SUMMARY_CHUNK_MS = 160
const RESTORE_HOLD_S = 1.5
const AUTO_PCT = '1.5'
const { FOLD_ROW_HEAD: ROW_HEAD } = await import('../../src/services/compact/foldStatus.ts')
const CARD = 'Compacted —'
const { ERROR_MESSAGE_USER_ABORT: CANCELLED_LINE } = await import('../../src/services/compact/compact.ts')
const FAILED_LINE = 'Error during compaction'
const AUTO_ASK = 'station 61: survey the ledger row and report'
const POST_FOLD_ASK = 'station 31: survey the ledger row and report'
const READ_ASK = 'station 0: read the notes files and report'
const READ_DONE = 'READ-DONE'
const NOTES = ['notes-a.txt', 'notes-b.txt'] as const
const AUTO_REPLY = 'ok — surveyed.'

function seedRows(sid: string, cwd: string, turns: number, fillers: number, inputTokens: number): string {
  const base = { isSidechain: false, entrypoint: 'cli', cwd, sessionId: sid, version: '1.0.0', gitBranch: 'main' }
  const rows: Record<string, unknown>[] = []
  let prev: string | null = null
  const uuid = (n: number): string => `${sid.slice(0, 24)}${String(n).padStart(12, '0')}`
  const filler = 'the ledger row holds steady against the recorded baseline and the survey continues along the marked stations. '
  for (let n = 1; n <= turns; n++) {
    const u = uuid(n * 2)
    const a = uuid(n * 2 + 1)
    const hh = String(12 + Math.floor(n / 60)).padStart(2, '0')
    const mm = String(n % 60).padStart(2, '0')
    rows.push({ ...base, parentUuid: prev, type: 'user', uuid: u, message: { role: 'user', content: `station ${n}: survey the ledger row and report` }, timestamp: `2026-06-19T${hh}:${mm}:00.000Z` })
    rows.push({
      ...base,
      parentUuid: u,
      type: 'assistant',
      uuid: a,
      requestId: `req_${n}`,
      message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: `station ${n} surveyed — ${filler.repeat(fillers)}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: inputTokens + n * 40, output_tokens: 90 } },
      timestamp: `2026-06-19T${hh}:${mm}:30.000Z`,
    })
    prev = a
  }
  return encodeSeedTranscript(rows, sid)
}

async function seedWorld(): Promise<{ home: string; cwd: string }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'fold-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'fold-cwd-')))
  writeFileSync(join(cwd, 'README.md'), '# the fold fixture\n')
  for (const name of NOTES) {
    const lines: string[] = []
    for (let i = 1; i <= 40; i++) lines.push(`${name} line ${i}: the survey notes hold steady against the recorded baseline along the marked stations.`)
    writeFileSync(join(cwd, name), `${lines.join('\n')}\n`)
  }
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: `sleep ${RESTORE_HOLD_S}` }] }] } }))
  process.env.MERCURY_CONFIG_DIR = home
  const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.ts')
  const projDir = join(home, 'projects', sanitizePath(cwd))
  mkdirSync(projDir, { recursive: true })
  for (const key of ['fold', 'cancel', 'refuse'] as const) writeFileSync(join(projDir, `${SID[key]}.jsonl`), seedRows(SID[key], cwd, 30, 3, 900))
  writeFileSync(join(projDir, `${SID.auto}.jsonl`), seedRows(SID.auto, cwd, 60, 6, 16_000))
  return { home, cwd }
}

type Hit = { route: 'fold' | 'chat' | 'read' | 'read-done' | 'side'; atMs: number; endMs: number; model: string; refused: boolean }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const USAGE = { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 }
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => (b as { type?: string }).type === 'text').map(b => String((b as { text?: string }).text ?? '')).join('\n')
}
function summaryText(): string {
  const sections = [
    '1. Operator Intent: survey every ledger station and report each one, in order, with the same care at each station.',
    '2. Technical Ground: a station ledger walked in order; each station reports the row as it stands against the baseline.',
    '3. Files and Code Touched: none — the survey read the ledger only, and no file was opened or changed during it.',
    '4. Errors and Corrections: none reported; no station returned a discrepancy and no correction was asked for.',
    '5. Problems Worked: the survey itself — keeping the pace across every station without losing the order.',
    '6. Operator Messages: the station requests, one per station, each asking for the ledger row and a report.',
    '7. Open Work: nothing outstanding; every requested station was surveyed and reported back.',
    '8. Where Work Stands: every station surveyed and reported; the ledger stands steady against the baseline.',
    '9. Next Move: await the next station request and continue the survey along the marked stations.',
  ]
  return `<analysis>The conversation is a station-by-station survey of a ledger; every station was surveyed and reported in turn, the rows held steady against the recorded baseline, and nothing outstanding remains.</analysis>\n<summary>\n${sections.join('\n')}\n</summary>`
}
let msgSeq = 0
let foldMode: 'stream' | 'refuse' = 'stream'
function startFixture(port: number, fixtureCwd: string): Promise<{ base: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (!url.includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(url.endsWith('/models') ? JSON.stringify({ object: 'list', data: [], models: [] }) : '{}')
        return
      }
      let body: { model?: string; messages?: Array<{ role?: string; content?: unknown }> } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        body = {}
      }
      const model = typeof body.model === 'string' ? body.model : 'fixture'
      const lastUser = [...(body.messages ?? [])].reverse().find(m => m.role === 'user')
      const lastText = lastUser ? textOf(lastUser.content) : ''
      const lastBlocks = Array.isArray(lastUser?.content) ? (lastUser!.content as Array<{ type?: string }>) : []
      const asks = (body.messages ?? []).filter(m => m.role === 'user').map(m => textOf(m.content)).flatMap(t => t.split('\n')).filter(line => line.startsWith('station '))
      const ask = asks.length > 0 ? asks[asks.length - 1]! : ''
      const route: Hit['route'] = lastText.includes(FOLD_NEEDLE)
        ? 'fold'
        : model.includes('haiku')
          ? 'side'
          : lastBlocks.some(b => b.type === 'tool_result')
            ? ask === READ_ASK
              ? 'read-done'
              : 'side'
            : ask === READ_ASK
              ? 'read'
              : ask !== ''
                ? 'chat'
                : 'side'
      const hit: Hit = { route, atMs: Date.now(), endMs: 0, model, refused: route === 'fold' && foldMode === 'refuse' }
      hits.push(hit)
      if (hit.refused) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'the fixture refuses the summary call' } }))
        hit.endMs = Date.now()
        return
      }
      const id = `msg_fold_${++msgSeq}`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`event: message_start\n${sse({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...USAGE, output_tokens: 1 } } })}`)
      res.write(`event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`)
      const finish = (outputTokens: number): void => {
        res.write(`event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`)
        res.write(`event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...USAGE, output_tokens: outputTokens } })}`)
        res.write(`event: message_stop\n${sse({ type: 'message_stop' })}`)
        hit.endMs = Date.now()
        res.end()
      }
      if (route === 'read') {
        res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reading the notes' } })}`)
        res.write(`event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`)
        NOTES.forEach((name, i) => {
          res.write(`event: content_block_start\n${sse({ type: 'content_block_start', index: i + 1, content_block: { type: 'tool_use', id: `toolu_fold_read_${i + 1}`, name: 'Read', input: {} } })}`)
          res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: i + 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(fixtureCwd, name) }) } })}`)
          res.write(`event: content_block_stop\n${sse({ type: 'content_block_stop', index: i + 1 })}`)
        })
        res.write(`event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { ...USAGE, output_tokens: 30 } })}`)
        res.write(`event: message_stop\n${sse({ type: 'message_stop' })}`)
        hit.endMs = Date.now()
        res.end()
        return
      }
      if (route !== 'fold') {
        res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: route === 'chat' ? AUTO_REPLY : route === 'read-done' ? READ_DONE : 'side' } })}`)
        finish(4)
        return
      }
      const text = summaryText()
      const step = Math.ceil(text.length / SUMMARY_CHUNKS)
      let at = 0
      const tick = (): void => {
        if (res.destroyed || res.writableEnded) {
          hit.endMs = Date.now()
          return
        }
        if (at >= text.length) {
          finish(Math.ceil(text.length / 4))
          return
        }
        res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(at, at + step) } })}`)
        at += step
        setTimeout(tick, SUMMARY_CHUNK_MS).unref?.()
      }
      tick()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise<void>(r => server.close(() => r())),
      }),
    )
  })
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Record<string, string>; markMs: Record<string, number>; receipts: Array<{ atTick: number; ts: number }>; endReason: string; stderr: string; startedMs: number }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'fold-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const startedMs = Date.now()
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
    marks?: Array<{ label: string; atTick: number; atMs: number; grid: Grid }>
    endReason?: string
  }
  const marks: Record<string, string> = {}
  const markMs: Record<string, number> = {}
  for (const m of payload.marks ?? []) {
    marks[m.label] = gridText(m.grid)
    markMs[m.label] = m.atMs
  }
  rmSync(dir, { recursive: true, force: true })
  return { text: gridText(payload.grid), marks, markMs, receipts: payload.sendReceipts ?? [], endReason: payload.endReason ?? '', stderr: stderr.join(''), startedMs }
}

function driveEnv(home: string, fixtureBase: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_WIRE_DUMP: join(home, 'wire'),
    MERCURY_AUTOCOMPACT_PCT_OVERRIDE: AUTO_PCT,
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

function foldRowOf(frame: string | undefined): string | null {
  const rows = rowsWith(frame, ROW_HEAD).filter(r => r.includes('└'))
  return rows.length > 0 ? flat(rows[0]!) : null
}
function rowFacts(row: string): { stage: string | null; filled: number; tokens: number | null; seconds: number | null; head: string } {
  const bar = /([█◐░]+)/.exec(row)
  const filled = bar ? (bar[1]!.match(/█/g) ?? []).length : 0
  const stage = /· (micro-compaction|summarising|restoring|session memory|compacted|cancelled|failed)/.exec(row)?.[1] ?? null
  const tokens = /↓ ([\d.]+)(k?) tokens/.exec(row)
  const tok = tokens ? Number(tokens[1]) * (tokens[2] === 'k' ? 1000 : 1) : null
  const seconds = /· (\d+)s\b/.exec(row)
  const head = row.includes(`${ROW_HEAD} (auto)`) ? `${ROW_HEAD} (auto)` : ROW_HEAD
  return { stage, filled, tokens: tok, seconds: seconds ? Number(seconds[1]) : null, head }
}
function stripOf(frame: string | undefined): { glyph: string; words: string } | null {
  const rows = rowsWith(frame, /│ [✶✦✧✳✻✽✸✹✺✷·●◐◓◑◒] [a-z]/).filter(r => !r.includes('└'))
  const row = rows.find(r => /compacting|thinking|Thinking/.test(r)) ?? null
  if (row === null) return null
  const m = /│ ([✶✦✧✳✻✽✸✹✺✷·●◐◓◑◒]) ([^│]*)│/.exec(row)
  return m ? { glyph: m[1]!, words: flat(m[2]!) } : null
}
function belowChat(frame: string | undefined): string[] {
  const lines = (frame ?? '').split('\n')
  return lines.slice(-9).map(l => l.replace(/\d+m\b|\d+s\b|\d\d:\d\d:\d\d|⤳\d+|auto-compact: \d+%/g, '#').replace(/ for #\s*/, ' ').replace(/\s+(esc interrupts)/, ' $1'))
}

function frames(prefix: string, count: number, gap = 3): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (let i = 1; i <= count; i++) out.push({ data: '', afterPrevTicks: gap, mark: `${prefix}-${String(i).padStart(2, '0')}` })
  return out
}

async function scene(label: string, sid: string, world: { home: string; cwd: string }, base: string, sends: Array<Record<string, unknown>>, total: number): Promise<Capture | null> {
  try {
    return await capture(
      {
        argv: ['node', BIN, '--resume', sid],
        cwd: world.cwd,
        cols: SIZE.cols,
        rows: SIZE.rows,
        sends: [
          { data: '', awaitText: 'ype a prompt', minTick: 5, atTick: 100, awaitSettleTicks: 5, mark: 'chat' },
          ...sends,
        ],
        stableTicks: 4,
        total,
      },
      driveEnv(world.home, base),
      240_000,
    )
  } catch (error) {
    check(`[${label}] the capture ran`, false, String(error).slice(0, 400))
    return null
  }
}

function requestParts(body: unknown): { items: number; total: number; summary: number; files: number; fileCount: number; filesNamed: number; largestFile: number; tail: number; tailRows: number; ask: number; other: number } {
  const messages = ((body as { messages?: unknown[] })?.messages ?? []) as Array<{ role?: string; content?: unknown }>
  const out = { items: messages.length, total: 0, summary: 0, files: 0, fileCount: 0, filesNamed: 0, largestFile: 0, tail: 0, tailRows: 0, ask: 0, other: 0 }
  let sawSummary = false
  const named = new Set<string>()
  for (const message of messages) {
    const blocks: Array<{ text: string; size: number }> =
      typeof message.content === 'string'
        ? [{ text: message.content, size: message.content.length }]
        : Array.isArray(message.content)
          ? (message.content as Array<Record<string, unknown>>).map(b => ({ text: typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '', size: JSON.stringify(b).length }))
          : []
    for (const block of blocks) {
      const { text, size } = block
      out.total += size
      if (message.role === 'user' && /carries on from an earlier stretch|context window turned over|conversation was summarized/i.test(text)) {
        out.summary += size
        sawSummary = true
      } else if (message.role === 'user' && text.includes(POST_FOLD_ASK)) {
        out.ask += size
      } else if (message.role === 'user' && sawSummary && NOTES.some(name => text.includes(`${name} line `))) {
        out.files += size
        out.fileCount++
        out.largestFile = Math.max(out.largestFile, size)
        for (const name of NOTES) if (text.includes(`${name} line `)) named.add(name)
      } else if (sawSummary && (message.role === 'assistant' || /^station \d+:/.test(text))) {
        out.tail += size
        out.tailRows++
      } else {
        out.other += size
      }
    }
  }
  out.filesNamed = named.size
  return out
}

function wireRows(home: string): Array<{ seq: number; at: number; url: string; model: string; body?: unknown; response: { status: number; ms: number; firstByteMs?: number; usage?: Record<string, number>; stop_reason?: string | null; error?: string } }> {
  const dir = join(home, 'wire')
  if (!existsSync(dir)) return []
  const out: ReturnType<typeof wireRows> = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as { kind?: string } & ReturnType<typeof wireRows>[number]
        if (row.kind === 'request') out.push(row)
      } catch {
      }
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

console.log('============================================================')
console.log(` the fold is a chat row with a bar — real bundle, PTY, ${SIZE.cols}x${SIZE.rows}`)
console.log('============================================================')
const KEEP = process.env.FOLD_DRIVE_KEEP === '1'
const world = await seedWorld()
const fixture = await startFixture(Number(process.env.FOLD_DRIVE_PORT ?? 25311), world.cwd)
const FOLD_FRAMES = 24
const foldMarks = (prefix: string): string[] => Array.from({ length: FOLD_FRAMES }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`)

function liveRows(cap: Capture, prefix: string): Array<{ key: string; row: string; facts: ReturnType<typeof rowFacts> }> {
  const out: Array<{ key: string; row: string; facts: ReturnType<typeof rowFacts> }> = []
  for (const key of foldMarks(prefix)) {
    const row = foldRowOf(cap.marks[key])
    if (row !== null) out.push({ key, row, facts: rowFacts(row) })
  }
  return out
}
const nonDecreasing = (values: number[]): boolean => values.every((v, i) => i === 0 || v >= values[i - 1]!)

{
  const hitsBefore = fixture.hits.length
  const cap = await scene('fold', SID.fold, world, fixture.base, [
    { data: `${READ_ASK}\r`, afterPrevTicks: 2 },
    { data: '', awaitText: READ_DONE, minTick: 2, atTick: 300, awaitSettleTicks: 5, mark: 'read-done' },
    ...[41, 42, 43, 44, 45, 46].map(n => ({ data: `station ${n}: survey the ledger row and report\r`, afterPrevTicks: 9 })),
    { data: '', awaitText: 'station 46: survey', minTick: 2, atTick: 500, awaitSettleTicks: 8, mark: 'filled' },
    { data: '/compact\r', afterPrevTicks: 2, mark: 'before-send' },
    ...frames('fold', FOLD_FRAMES),
    { data: '', awaitText: CARD, minTick: 2, atTick: 700, awaitSettleTicks: 4, mark: 'card' },
    { data: `${POST_FOLD_ASK}\r`, afterPrevTicks: 4, mark: 'post-fold-send' },
    { data: '', awaitText: AUTO_REPLY, minTick: 2, atTick: 760, awaitSettleTicks: 4, mark: 'post-fold' },
    { data: '', afterPrevTicks: 4, mark: 'end' },
  ], 900)
  if (cap !== null) {
    const m = cap.marks
    const sent = cap.receipts[10]
    const foldHits = fixture.hits.slice(hitsBefore).filter(h => h.route === 'fold')
    check('[fold] the turn before the fold read both notes files', fixture.hits.slice(hitsBefore).some(h => h.route === 'read') && fixture.hits.slice(hitsBefore).some(h => h.route === 'read-done') && rowsWith(m['read-done'], READ_DONE).length > 0, fixture.hits.slice(hitsBefore).map(h => h.route).join(' → '))
    console.log(`\n[fold] sends fired ${cap.receipts.length} · end ${cap.endReason} · routes ${fixture.hits.slice(hitsBefore).map(h => h.route).join(' → ')}`)
    if (sent && foldHits[0]) console.log(`[fold] /compact sent at +0 ms · the summary call reached the wire at +${foldHits[0].atMs - sent.ts} ms · its stream ended at +${foldHits[0].endMs - sent.ts} ms`)
    dump('fold · before the send', m['before-send'])
    const live = liveRows(cap, 'fold')
    for (const key of foldMarks('fold')) {
      const frame = m[key]
      if (frame === undefined) continue
      const rel = sent ? `+${cap.startedMs + cap.markMs[key]! - sent.ts} ms` : '?'
      const strip = stripOf(frame)
      console.log(`  ${key} (${rel}) row: ${foldRowOf(frame) ?? '(none)'} · strip: ${strip ? `${strip.glyph} ${strip.words}` : '(none)'} · card: ${rowsWith(frame, CARD).length > 0 ? 'yes' : 'no'}`)
    }
    const firstLive = live[0]
    const withCard = foldMarks('fold').filter(k => rowsWith(m[k], CARD).length > 0)
    if (live.length > 0) dump(`fold · ${live[Math.min(live.length - 1, 4)]!.key} (summarising)`, m[live[Math.min(live.length - 1, 4)]!.key])
    if (live.length > 0) dump(`fold · ${live[live.length - 1]!.key} (the last live frame)`, m[live[live.length - 1]!.key])
    const blank = foldMarks('fold').find(k => m[k] !== undefined && foldRowOf(m[k]) === null && rowsWith(m[k], CARD).length === 0 && firstLive !== undefined && cap.markMs[k]! > cap.markMs[firstLive.key]!)
    if (blank !== undefined) dump(`fold · ${blank} (a frame with neither the row nor the card)`, m[blank])
    dump('fold · the card', m['card'])
    check('[fold] the summary call ran on the wire once', foldHits.length === 1, `${foldHits.length}`)
    check('F1 [fold] the row stands in the chat within a second of the send, under the echo', firstLive !== undefined && (cap.startedMs + cap.markMs[firstLive.key]! - (sent?.ts ?? 0)) < 1500 && rowsWith(m[firstLive.key], '❯ /compact').length > 0, firstLive ? `${firstLive.key} · ${firstLive.row}` : 'no live row in any frame')
    check('F1 [fold] the row carries the head, a bar and a clock', live.every(l => /compacting context · .*[█◐░]{9,12} · \d+s/.test(l.row)), live.map(l => l.row).slice(0, 3).join(' | '))
    check('F1 [fold] the row stands in every frame until the card takes its place (no blank beat)', live.length > 0 && foldMarks('fold').every(k => m[k] === undefined || foldRowOf(m[k]) !== null || rowsWith(m[k], CARD).length > 0 || cap.markMs[k]! < cap.markMs[firstLive!.key]!), foldMarks('fold').map(k => `${k}:${foldRowOf(m[k]) ? 'row' : rowsWith(m[k], CARD).length ? 'card' : '—'}`).join(' '))
    check('F1 [fold] no frame paints the live row and the card together', !foldMarks('fold').some(k => rowsWith(m[k], CARD).length > 0 && foldRowOf(m[k]) !== null && !foldRowOf(m[k])!.includes('compacted')), withCard.map(k => foldRowOf(m[k]) ?? '').filter(Boolean).join(' | '))
    check('F1 [fold] the card landed', rowsWith(m['card'], CARD).length > 0 && foldRowOf(m['card']) === null, rowsWith(m['card'], /Compact/).map(flat).join(' | ').slice(0, 200))
    const stages = live.map(l => l.facts.stage).filter((s): s is string => s !== null)
    const order = ['micro-compaction', 'summarising', 'restoring', 'compacted']
    const seen = [...new Set(stages)]
    check('F2 [fold] the stage words advance in the fold\'s order', seen.length >= 2 && seen.every(s => order.includes(s)) && nonDecreasing(seen.map(s => order.indexOf(s))), seen.join(' → '))
    check('F2 [fold] summarising and restoring were both photographed', seen.includes('summarising') && seen.includes('restoring'), seen.join(' → '))
    check('F2 [fold] the filled cells never decrease', nonDecreasing(live.map(l => l.facts.filled)), live.map(l => l.facts.filled).join(','))
    const tokens = live.filter(l => l.facts.stage === 'summarising').map(l => l.facts.tokens ?? 0)
    check('F2 [fold] the streamed tokens grow while summarising', tokens.length >= 2 && nonDecreasing(tokens) && tokens[tokens.length - 1]! > tokens[0]!, tokens.join(','))
    check('F2 [fold] the clock grows from the fold\'s own start (never the session\'s age)', nonDecreasing(live.map(l => l.facts.seconds ?? 0)) && live.every(l => (l.facts.seconds ?? 0) <= 40), live.map(l => l.facts.seconds).join(','))
    const strips = live.map(l => stripOf(m[l.key])).filter((s): s is { glyph: string; words: string } => s !== null)
    check('F3 [fold] the working strip never says thinking while the fold runs', strips.every(s => !/thinking/i.test(s.words)), strips.map(s => s.words).slice(0, 3).join(' | '))
    check('F3 [fold] the working strip\'s glyph stands still through the fold', strips.length >= 3 && new Set(strips.map(s => s.glyph)).size === 1, strips.map(s => s.glyph).join(''))
    const liveTurn = live.filter(l => l.facts.stage !== 'compacted' && stripOf(m[l.key]) !== null)
    const below = liveTurn.map(l => belowChat(m[l.key]).join('\n'))
    const variants = [...new Set(below)]
    const diff = variants.length > 1 ? variants[0]!.split('\n').map((line, i) => (line === variants[1]!.split('\n')[i] ? null : `${i}: ${line} ⇄ ${variants[1]!.split('\n')[i] ?? ''}`)).filter((x): x is string => x !== null).join('\n') : ''
    check('F6 [fold] no row below the chat moves while the row stands', below.length > 0 && variants.length === 1, variants.length > 1 ? `${variants.length} variants over ${liveTurn.length} frames — the rows that differ:\n${diff}`.slice(0, 900) : '')
    for (const row of wireRows(world.home)) {
      const rel = sent ? `+${row.at - sent.ts} ms` : '?'
      console.log(`  wire #${row.seq} ${row.url} ${row.model} at ${rel} · first byte ${row.response.firstByteMs ?? '?'} ms · total ${row.response.ms} ms · usage ${JSON.stringify(row.response.usage ?? {})} · ${row.response.stop_reason ?? row.response.error ?? '?'}`)
    }
    const postFold = wireRows(world.home).filter(r => r.model !== 'fixture' && !r.model.includes('haiku')).at(-1)
    const postFoldReply = rowsWith(m['post-fold'], AUTO_REPLY).length > 0
    check('F7 [fold] the first request after the fold landed its reply', postFoldReply, rowsWith(m['post-fold'], /station 31|surveyed/).map(flat).join(' | ').slice(0, 200))
    if (postFold !== undefined) {
      const parts = requestParts(postFold.body)
      for (const [i, item] of (((postFold.body as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [])).entries()) {
        const blocks = Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : [{ type: 'text', text: String(item.content ?? '') }]
        for (const [j, b] of blocks.entries()) {
          const text = typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : ''
          console.log(`    item ${i}.${j} ${item.role} ${String(b.type ?? 'text')}: ${JSON.stringify(b).length} chars · ${flat(text).slice(0, 80)}`)
        }
      }
      console.log(`  post-fold request: ${parts.items} items · ${parts.total} chars ≈ ${Math.round(parts.total / 4)} tokens — summary ${parts.summary} · restored files ${parts.files} (${parts.fileCount} rows) · kept tail ${parts.tail} (${parts.tailRows} rows) · the ask ${parts.ask} · other ${parts.other} · first byte ${postFold.response.firstByteMs ?? '?'} ms (the fixture's)`)
      check('F7 [fold] the post-fold request carries the summary, the ask and both restored files, no file block over the per-file limit', parts.summary > 0 && parts.ask > 0 && parts.filesNamed === 2 && parts.largestFile <= 5_000 * 4 + 400, `summary ${parts.summary} chars · ask ${parts.ask} · files named ${parts.filesNamed} in ${parts.fileCount} blocks · largest block ${parts.largestFile} chars`)
    }
  }
}

{
  const hitsBefore = fixture.hits.length
  const cap = await scene('cancel', SID.cancel, world, fixture.base, [
    { data: '/compact\r', afterPrevTicks: 2, mark: 'before-send' },
    ...frames('cancel', 5),
    { data: '\x1b', afterPrevTicks: 2, mark: 'esc' },
    ...frames('after', 8),
    { data: '', awaitText: CANCELLED_LINE, minTick: 2, atTick: 600, awaitSettleTicks: 4, mark: 'line' },
    { data: '', afterPrevTicks: 4, mark: 'end' },
  ], 660)
  if (cap !== null) {
    const m = cap.marks
    console.log(`\n[cancel] sends fired ${cap.receipts.length} · end ${cap.endReason} · routes ${fixture.hits.slice(hitsBefore).map(h => h.route).join(' → ')}`)
    for (const key of [...foldMarks('cancel').slice(0, 5), 'esc', ...Array.from({ length: 8 }, (_, i) => `after-${String(i + 1).padStart(2, '0')}`)]) {
      if (m[key] === undefined) continue
      console.log(`  ${key} row: ${foldRowOf(m[key]) ?? '(none)'} · line: ${rowsWith(m[key], CANCELLED_LINE).length > 0 ? 'yes' : 'no'}`)
    }
    dump('cancel · at esc', m['esc'])
    dump('cancel · after-01', m['after-01'])
    dump('cancel · after-03', m['after-03'])
    dump('cancel · the line', m['line'])
    check('F4 [cancel] the row stood before esc', foldRowOf(m['esc']) !== null, foldRowOf(m['esc']) ?? 'none')
    check('F4 [cancel] the cancel line lands where the row stood, and no live row remains', rowsWith(m['line'], CANCELLED_LINE).length > 0 && foldRowOf(m['line']) === null, rowsWith(m['line'], /Compact/).map(flat).join(' | ').slice(0, 200))
    check('F4 [cancel] no frame paints the live row beside the cancel line', !Object.keys(m).some(k => rowsWith(m[k], CANCELLED_LINE).length > 0 && foldRowOf(m[k]) !== null && !foldRowOf(m[k])!.includes('cancelled')))
  }
}

{
  foldMode = 'refuse'
  const hitsBefore = fixture.hits.length
  const cap = await scene('refuse', SID.refuse, world, fixture.base, [
    { data: '/compact\r', afterPrevTicks: 2, mark: 'before-send' },
    ...frames('refuse', 12),
    { data: '', awaitText: FAILED_LINE, minTick: 2, atTick: 600, awaitSettleTicks: 4, mark: 'line' },
    { data: '', afterPrevTicks: 4, mark: 'end' },
  ], 660)
  foldMode = 'stream'
  if (cap !== null) {
    const m = cap.marks
    console.log(`\n[refuse] sends fired ${cap.receipts.length} · end ${cap.endReason} · routes ${fixture.hits.slice(hitsBefore).map(h => `${h.route}${h.refused ? '(refused)' : ''}`).join(' → ')}`)
    for (const key of foldMarks('refuse').slice(0, 12)) {
      if (m[key] === undefined) continue
      console.log(`  ${key} row: ${foldRowOf(m[key]) ?? '(none)'} · line: ${rowsWith(m[key], FAILED_LINE).length > 0 ? 'yes' : 'no'}`)
    }
    dump('refuse · the line', m['line'])
    check('F4 [refuse] the summary call was refused on the wire', fixture.hits.slice(hitsBefore).some(h => h.refused))
    check('F4 [refuse] the failure line lands where the row stood, and no live row remains', rowsWith(m['line'], FAILED_LINE).length > 0 && foldRowOf(m['line']) === null, rowsWith(m['line'], /ompact/).map(flat).join(' | ').slice(0, 240))
    check('F4 [refuse] no frame paints the live row beside the failure line', !Object.keys(m).some(k => rowsWith(m[k], FAILED_LINE).length > 0 && foldRowOf(m[k]) !== null && !foldRowOf(m[k])!.includes('failed')))
  }
}

{
  const hitsBefore = fixture.hits.length
  const cap = await scene('auto', SID.auto, world, fixture.base, [
    { data: `${AUTO_ASK}\r`, afterPrevTicks: 2, mark: 'before-send' },
    ...frames('auto', FOLD_FRAMES),
    { data: '', awaitText: AUTO_REPLY, minTick: 2, atTick: 700, awaitSettleTicks: 4, mark: 'reply' },
    { data: '', afterPrevTicks: 6, mark: 'end' },
  ], 760)
  if (cap !== null) {
    const m = cap.marks
    const routes = fixture.hits.slice(hitsBefore).map(h => h.route)
    console.log(`\n[auto] sends fired ${cap.receipts.length} · end ${cap.endReason} · routes ${routes.join(' → ')}`)
    const live = liveRows(cap, 'auto')
    for (const key of foldMarks('auto')) {
      if (m[key] === undefined) continue
      console.log(`  ${key} row: ${foldRowOf(m[key]) ?? '(none)'} · reply: ${rowsWith(m[key], AUTO_REPLY).length > 0 ? 'yes' : 'no'}`)
    }
    if (live.length > 0) dump(`auto · ${live[Math.min(live.length - 1, 3)]!.key}`, m[live[Math.min(live.length - 1, 3)]!.key])
    dump('auto · the reply', m['reply'])
    check('F5 [auto] the fold ran before the turn\'s request (summary call first, then the reply)', routes.indexOf('fold') !== -1 && routes.indexOf('chat') > routes.indexOf('fold'), routes.join(' → '))
    check('F5 [auto] the automatic fold paints the row with the word auto', live.length > 0 && live.every(l => l.facts.head === `${ROW_HEAD} (auto)`), live.map(l => l.row).slice(0, 2).join(' | '))
    check('F5 [auto] the row leaves with the fold and the reply lands', rowsWith(m['reply'], AUTO_REPLY).length > 0 && foldRowOf(m['reply']) === null, rowsWith(m['reply'], /compacting|surveyed/).map(flat).join(' | ').slice(0, 200))
    check('F5 [auto] the stages walked: summarising, then restoring', live.some(l => l.facts.stage === 'summarising') && live.some(l => l.facts.stage === 'restoring'), [...new Set(live.map(l => l.facts.stage))].join(' → '))
  }
}

await fixture.close()
if (!KEEP) {
  for (const d of [world.home, world.cwd]) rmSync(d, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${world.home} cwd=${world.cwd}`)
}
console.log(failures === 0 ? '\n✅ compact-fold drive GREEN' : `\n❌ compact-fold drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
