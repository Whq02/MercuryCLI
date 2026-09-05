#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const { CRITTERS } = await import('../../src/components/mercury-ui/sessionAccent.ts')
const { deriveAccentSoft } = await import('../../src/utils/mercuryTokens.ts')
const { BELLY, IVORY, TERRA } = await import('../../src/components/mercuryPalette.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-keyword-glow-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'
const WORDS = 'deepthink supercode'
const REPLY = 'glow-noted'
const RAINBOW = new Set(['eb5a5a', 'f08c82', 'eb9b5a', 'f0b98c', 'e5c76b', 'eeda9b', '78c790', 'a5dbb4', '6ba6ef', '9bc3f3', '8282eb', 'aaaaf1', 'ba82eb', 'cfaaf1'])
const cellHex = (hex: string): string => hex.replace('#', '').toLowerCase()
const softOf = (accent: string): string => (accent === TERRA ? BELLY : deriveAccentSoft(accent, IVORY))

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
function textAnswer(model: string, text: string): string {
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_glow_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
async function startFixture(port: number): Promise<{ base: string; close(): Promise<void> }> {
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
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(textAnswer(model, REPLY))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

type Cell = { c?: string; fg?: string }
type Grid = Array<Array<Cell | string>>
type Frame = { text: string; grid: Grid }
const rowText = (row: Array<Cell | string>): string => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('')
const gridFrame = (grid: Grid): Frame => ({ text: grid.map(r => rowText(r).trimEnd()).join('\n'), grid })
type Capture = { marks: Record<string, Frame>; receipts: number; endReason: string; stderr: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'keyword-glow-cfg-'))
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

function driveEnv(home: string, fixtureBase: string, critter: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENAI_API_KEY: '',
    MERCURY_CRITTER: critter,
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

const KEEP = process.env.KEYWORD_GLOW_KEEP === '1'
function dump(label: string, frame: Frame | undefined): void {
  console.log(`\n── ${label} ──`)
  if (!frame) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.text.split('\n')) if (row.trim()) console.log(`│ ${row}`)
}

console.log('============================================================')
console.log(' the keyword glow wears the session accent — real bundle, PTY')
console.log('============================================================')
const fixture = await startFixture(Number(process.env.KEYWORD_GLOW_PORT ?? 25203))
const worlds: string[] = []
try {
  for (const key of ['crab', 'octopus'] as const) {
    const critter = CRITTERS[key]!
    const accent = cellHex(critter.accent)
    const soft = cellHex(softOf(critter.accent))
    const home = realpathSync(mkdtempSync(join(tmpdir(), `keyword-glow-home-${key}-`)))
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), `keyword-glow-cwd-${key}-`)))
    worlds.push(home, cwd)
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
            { data: WORDS, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
            { data: '', afterPrevTicks: 6, mark: 'composer' },
            { data: '\r', afterPrevTicks: 2 },
            { data: '', awaitText: REPLY, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'row' },
          ],
          stableTicks: 6,
          total: 400,
        },
        driveEnv(home, fixture.base, key),
        150_000,
      )
    } catch (error) {
      check(`[${key}] the capture ran`, false, String(error).slice(0, 400))
      continue
    }
    console.log(`\n— ${key}: accent ${accent} · soft ${soft} —`)
    if (KEEP) for (const [label, frame] of Object.entries(cap.marks)) dump(`${key} ${label}`, frame)
    check(`[${key}] every send became due`, cap.receipts === 5, `${cap.receipts}/5 · end ${cap.endReason}`)
    const wears = (inks: string[]): boolean => inks.every(ink => ink === accent || ink === soft) && inks.filter(ink => ink === accent).length >= Math.ceil(inks.length / 2)
    for (const word of ['deepthink', 'supercode']) {
      const composer = wordInks(cap.marks['composer'], /❯.*deepthink supercode/, word)
      check(`K1 [${key}] the composer's "${word}" wears the accent (its soft companion mid-sweep), every cell`, composer !== null && wears(composer.inks), composer ? `${composer.inks.join(',')} · ${composer.row.slice(0, 80)}` : 'no composer row')
      check(`K1 [${key}] …and no cell of it wears a rainbow hue`, composer !== null && !composer.inks.some(ink => RAINBOW.has(ink)), composer?.inks.join(',') ?? '')
      const row = wordInks(cap.marks['row'], /\[sam\].*deepthink supercode/, word)
      check(`K2 [${key}] the transcript row's "${word}" wears the accent, static, every cell`, row !== null && row.inks.every(ink => ink === accent), row ? `${row.inks.join(',')} · ${row.row.slice(0, 80)}` : 'no user row')
      check(`K2 [${key}] …and no cell of it wears a rainbow hue`, row !== null && !row.inks.some(ink => RAINBOW.has(ink)), row?.inks.join(',') ?? '')
    }
    if (failures > 0 && !KEEP) for (const [label, frame] of Object.entries(cap.marks)) dump(`${key} ${label}`, frame)
  }
  check('K3 the two critters paint different accents (the glow follows the session)', cellHex(CRITTERS.crab!.accent) !== cellHex(CRITTERS.octopus!.accent))
} finally {
  await fixture.close()
  if (!KEEP) for (const d of worlds) rmSync(d, { recursive: true, force: true })
  else console.log(`[kept] ${worlds.join(' ')}`)
}
console.log(failures === 0 ? '\nprove-keyword-glow-drive: ALL LAWS HOLD' : `\nprove-keyword-glow-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
