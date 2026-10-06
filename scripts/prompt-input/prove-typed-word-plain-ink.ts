#!/usr/bin/env bun
// gate-watch: src/components/PromptInput/PromptInput.tsx src/components/PromptInput/ShimmeredInput.tsx
// gate-watch: src/components/messages/HighlightedThinkingText.tsx src/utils/textHighlighting.ts
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = process.env.MERCURY_PROOF_BUNDLE ?? join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error(`prove-typed-word-plain-ink: ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { vshotBudgetMs, resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-typed-word-plain-ink: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'
const CONTROL = 'plainword'
const TRIGGERS = ['deepthink', 'supercode', 'ultrathink']
const TYPED = `${TRIGGERS.join(' ')} ${CONTROL}`
const REPLY = 'ink-noted'

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
function textAnswer(model: string, text: string): string {
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_ink_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
async function startFixture(): Promise<{ base: string; close(): Promise<void> }> {
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
      let model = 'fixture'
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }
        if (typeof body.model === 'string') model = body.model
      } catch {
        model = 'fixture'
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(textAnswer(model, REPLY))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

type Cell = { c?: string; fg?: string }
type Grid = Array<Array<Cell | string>>
type Frame = { text: string; grid: Grid }
const rowText = (row: Array<Cell | string>): string => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('')
const gridFrame = (grid: Grid): Frame => ({ text: grid.map(r => rowText(r).trimEnd()).join('\n'), grid })
type Capture = { marks: Record<string, Frame>; receipts: number; endReason: string; stderr: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'typed-word-ink-cfg-'))
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
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, Frame> = {}
  for (const mk of payload.marks ?? []) marks[mk.label] = gridFrame(mk.grid)
  rmSync(dir, { recursive: true, force: true })
  return { marks, receipts: payload.sendReceipts?.length ?? 0, endReason: payload.endReason ?? '', stderr: stderr.join('') }
}

function wordInks(frame: Frame | undefined, rowNeedle: RegExp, word: string): { row: string; inks: string[] } | null {
  if (!frame) return null
  for (const row of frame.grid) {
    const text = rowText(row)
    if (!rowNeedle.test(text)) continue
    const at = text.indexOf(word)
    if (at < 0) continue
    const inks: string[] = []
    for (let i = at; i < at + word.length; i++) {
      const cell = row[i]
      inks.push(typeof cell === 'object' && cell !== null ? String(cell.fg ?? 'default').toLowerCase() : 'default')
    }
    return { row: text.trimEnd(), inks }
  }
  return null
}

const distinct = (inks: string[]): string => [...new Set(inks)].sort().join(',')

function driveEnv(home: string, fixtureBase: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENAI_API_KEY: '',
    MERCURY_CRITTER: 'crab',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
  }
}

const KEEP = process.env.TYPED_WORD_INK_KEEP === '1'
function dump(label: string, frame: Frame | undefined): void {
  console.log(`\n── ${label} ──`)
  if (!frame) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.text.split('\n')) if (row.trim()) console.log(`│ ${row}`)
}

console.log('============================================================')
console.log(' a typed word wears the ink of any word — real bundle, PTY')
console.log('============================================================')
console.log(`  bundle: ${BIN}`)
const fixture = await startFixture()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'typed-word-ink-home-')))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'typed-word-ink-cwd-')))
seedFirstRun(home, [cwd])
let cap: Capture | null = null
try {
  cap = await capture(
    {
      argv: ['node', BIN],
      cwd,
      cols: 120,
      rows: 40,
      sends: [
        { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
        { data: TYPED, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: '', awaitText: CONTROL, requireAwait: true, minTick: 2, awaitStableTicks: 4, awaitSettleTicks: 2, mark: 'composer' },
        { data: '\r', awaitText: CONTROL, requireAwait: true, minTick: 1, awaitSettleTicks: 1 },
        { data: '', awaitText: REPLY, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'row' },
      ],
      stableTicks: 6,
      total: 400,
    },
    driveEnv(home, fixture.base),
    150_000,
  )
} catch (error) {
  check('the capture ran', false, String(error).slice(0, 400))
} finally {
  await fixture.close()
}
if (cap) {
  if (KEEP) for (const [label, frame] of Object.entries(cap.marks)) dump(label, frame)
  check('every send became due', cap.receipts === 5, `${cap.receipts}/5 · end ${cap.endReason}`)
  const composerNeedle = new RegExp(`❯.*${TYPED}`)
  const control = wordInks(cap.marks['composer'], composerNeedle, CONTROL)
  check(`the composer shows the typed line with "${CONTROL}"`, control !== null, control ? control.row.slice(0, 100) : 'no composer row')
  for (const word of TRIGGERS) {
    const typed = wordInks(cap.marks['composer'], composerNeedle, word)
    check(`the composer paints "${word}" in the ink of "${CONTROL}", every cell`, typed !== null && control !== null && distinct(typed.inks) === distinct(control.inks), typed && control ? `${word}: ${distinct(typed.inks)} · ${CONTROL}: ${distinct(control.inks)}` : 'no composer row')
  }
  const rowNeedle = new RegExp(`\\[sam\\].*${TYPED}`)
  const rowControl = wordInks(cap.marks['row'], rowNeedle, CONTROL)
  check(`the sent row shows the line with "${CONTROL}"`, rowControl !== null, rowControl ? rowControl.row.slice(0, 100) : 'no user row')
  for (const word of TRIGGERS) {
    const sent = wordInks(cap.marks['row'], rowNeedle, word)
    check(`the sent row paints "${word}" in the ink of "${CONTROL}", every cell`, sent !== null && rowControl !== null && distinct(sent.inks) === distinct(rowControl.inks), sent && rowControl ? `${word}: ${distinct(sent.inks)} · ${CONTROL}: ${distinct(rowControl.inks)}` : 'no user row')
  }
  if (failures > 0 && !KEEP) for (const [label, frame] of Object.entries(cap.marks)) dump(label, frame)
}
if (!KEEP) {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
} else console.log(`[kept] ${home} ${cwd}`)
console.log(failures === 0 ? '\nprove-typed-word-plain-ink: green' : `\nprove-typed-word-plain-ink: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
