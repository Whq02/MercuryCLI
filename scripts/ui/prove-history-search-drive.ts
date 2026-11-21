#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'
import { resolveExecutionProfile } from '../lib/executionProfile.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs')
const KEEP = process.argv.includes('--keep')
const VSHOT = join(import.meta.dir, 'vshot.py')
const VENDORED_NODE = join(dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : (Bun.which('node') ?? 'node')

const COLS = 140
const ROWS = 40
const ESC = '\x1b'
const CTRL_R = '\x12'
const CTRL_C = '\x03'
const CTRL_U = '\x15'
const DEAD = 'http://127.0.0.1:9'

const PROMPT_1 = 'needle-alpha first release check'
const PROMPT_2 = 'needle-beta memory budget audit'
const PROMPT_3 = 'needle-alpha second bundle check'
const DRAFT_1 = 'keep-my-draft'
const DRAFT_2 = 'restore-this-draft'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (title: string): void => console.log(`\n── ${title} ──`)

const driver = resolveCaptureDriver()
const hosted = resolveExecutionProfile(ROOT).kind === 'hosted-gate'
function refuse(reason: string): never {
  if (hosted) {
    console.error(`  [FAIL] the hosted gate cannot capture — ${reason}`)
    process.exit(1)
  }
  console.log(`__SUITE_SKIPPED history-search-drive: ${reason}`)
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

const PYTHON = driver.python
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'history-search-drive-')))

type Cell = string | { c?: string } | null
type Grid = Cell[][]
type Frame = { text: string }
const cellGlyph = (cell: Cell | undefined): string => (typeof cell === 'object' && cell !== null ? (cell.c ?? ' ') : String(cell ?? ' '))
const gridText = (grid: Grid): string => grid.map(row => row.map(c => cellGlyph(c)).join('')).join('\n')
const rowsOf = (frame: Frame | undefined): string[] => (frame?.text ?? '').split('\n')
const has = (frame: Frame | undefined, needle: string): boolean => (frame?.text ?? '').includes(needle)
const composerRow = (frame: Frame | undefined): string => rowsOf(frame).find(r => r.startsWith('│❯'))?.trimEnd() ?? '(no composer row)'

type Block = { type?: string; text?: string }
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[]).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text!).join('\n')
}
const stripReminders = (text: string): string => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const receivedPrompts: string[] = []
const apiServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url ?? '').split('?')[0] ?? ''
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(Buffer.from(c)))
  req.on('end', () => {
    if (req.method === 'POST' && path.endsWith('/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 64 }))
      return
    }
    if (req.method === 'POST' && path.endsWith('/messages')) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string; messages?: Array<{ role?: string; content?: unknown }> }
      const model = body.model ?? 'claude-sonnet-4-5-20250929'
      const users = (body.messages ?? []).filter(m => m.role === 'user').map(m => stripReminders(extractText(m.content))).filter(t => t !== '')
      const latest = users.at(-1) ?? ''
      receivedPrompts.push(latest)
      const n = receivedPrompts.length
      const reply = `reply-${n}:${latest}`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write(sse('message_start', {
        type: 'message_start',
        message: {
          id: `msg_hs_${n}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
        },
      }))
      res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }))
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
      res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }))
      res.write(sse('message_stop', { type: 'message_stop' }))
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => apiServer.listen(0, '127.0.0.1', resolve))
const API_BASE = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`

function driveEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_FULLSCREEN: '1',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER: 'clam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_JEV_BASE: 'http://127.0.0.1:1',
    MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
    ANTHROPIC_BASE_URL: API_BASE,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
    MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
    MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
    MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
    MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`,
    MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
    MERCURY_DEEPSEEK_API_BASE: DEAD,
    BROWSER: '/usr/bin/true',
    SHELL: existsSync('/bin/bash') ? '/bin/bash' : (process.env.SHELL ?? '/bin/sh'),
  }
  for (const key of ['NODE_ENV', 'MERCURY_DEMO', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'TYPESAFE_API_KEY', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'TERMINAL_EMULATOR']) {
    delete env[key]
  }
  return env
}

type Send = Record<string, unknown>
const gated = (data: string, awaitText: string, extra: Send = {}): Send => ({ data, atTick: 999, awaitText, requireAwait: true, minTick: 1, awaitSettleTicks: 3, ...extra })
const after = (data: string, ticks: number, extra: Send = {}): Send => ({ data, afterPrevTicks: ticks, ...extra })

type Capture = { marks: Record<string, Frame>; sends: number; receipts: number; stderr: string; endReason: string; status: number | null }
async function capture(name: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<Capture> {
  const cfgPath = join(scratch, `${name}.cfg.json`)
  const outPath = join(scratch, `${name}.grid.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const status = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(PYTHON, [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(300_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(deadline)
      resolve(code)
    })
  })
  if (!existsSync(outPath)) throw new Error(`the capture wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, Frame> = {}
  for (const m of payload.marks ?? []) marks[m.label] = { text: gridText(m.grid) }
  marks.final = { text: gridText(payload.grid) }
  return { marks, sends: (cfg.sends as unknown[]).length, receipts: payload.sendReceipts?.length ?? 0, stderr: stderr.join(''), endReason: payload.endReason ?? '', status }
}

try {
  const home = join(scratch, 'home')
  const cwd = join(scratch, 'cwd', 'fixture-cwd')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({
    guardrails: { sovereignConsentSeen: true },
    view: { reducedMotion: true },
    activity: { tips: { enabled: false } },
  }, null, 2))

  const sends: Send[] = [
    gated('\r', 'New Session', { minTick: 5, awaitStableTicks: 6, awaitSettleTicks: 4 }),
    gated(ESC + '[I', 'shortcuts', { minTick: 2, awaitSettleTicks: 6 }),
    gated('', '← back', { minTick: 2, awaitSettleTicks: 6, mark: 'land' }),

    after(`${PROMPT_1}\r`, 3),
    gated('', `reply-1:${PROMPT_1}`, { awaitSettleTicks: 5 }),
    after(`${PROMPT_2}\r`, 3),
    gated('', `reply-2:${PROMPT_2}`, { awaitSettleTicks: 5 }),
    after(`${PROMPT_3}\r`, 3),
    gated('', `reply-3:${PROMPT_3}`, { awaitSettleTicks: 6, mark: 'seeded' }),

    after(CTRL_R, 3),
    gated('', 'search prompts:', { awaitSettleTicks: 3, mark: 'opened' }),
    after('needle-alpha', 3),
    gated('', `│❯ ${PROMPT_3}`, { awaitSettleTicks: 4, mark: 'firstMatch' }),
    after(CTRL_R, 3),
    gated('', `│❯ ${PROMPT_1}`, { awaitSettleTicks: 4, mark: 'cycledMatch' }),
    after('\r', 3),
    gated('', `reply-4:${PROMPT_1}`, { awaitSettleTicks: 6, mark: 'submitted' }),

    after(DRAFT_1, 3),
    gated('', `│❯ ${DRAFT_1}`, { awaitSettleTicks: 3, mark: 'draft1' }),
    after(CTRL_R, 3),
    gated('', 'search prompts:', { awaitSettleTicks: 3 }),
    after('zzz-no-hit', 3),
    gated('', 'no matching prompt:', { awaitSettleTicks: 4, mark: 'noMatch' }),
    after(ESC, 3),
    gated('', `│❯ ${DRAFT_1}`, { awaitPattern: '\\A(?![\\s\\S]*no matching prompt:)', awaitSettleTicks: 4, mark: 'escAfterNoMatch' }),

    after(CTRL_R, 3),
    gated('', 'search prompts:', { awaitSettleTicks: 3 }),
    after('needle-beta', 3),
    gated('', `│❯ ${PROMPT_2}`, { awaitSettleTicks: 4, mark: 'betaMatch' }),
    after(ESC, 3),
    gated('', `│❯ ${PROMPT_2}`, { awaitPattern: '\\A(?![\\s\\S]*search prompts:)', awaitSettleTicks: 4, mark: 'escAccepted' }),

    after(CTRL_U, 3),
    after(DRAFT_2, 3),
    gated('', `│❯ ${DRAFT_2}`, { awaitSettleTicks: 3, mark: 'draft2' }),
    after(CTRL_R, 3),
    gated('', 'search prompts:', { awaitSettleTicks: 3 }),
    after('needle-beta', 3),
    gated('', `│❯ ${PROMPT_2}`, { awaitSettleTicks: 4, mark: 'beforeCancel' }),
    after(CTRL_C, 3),
    gated('', `│❯ ${DRAFT_2}`, { awaitPattern: '\\A(?![\\s\\S]*search prompts:)', awaitSettleTicks: 4, mark: 'cancelled' }),
  ]

  const cap = await capture('history-search-140x40', { cols: COLS, rows: ROWS, total: 1400, cwd, argv: [NODE, DIST], sends, stableTicks: 4 }, driveEnv(home))
  const m = cap.marks

  section('1. Drive completion and seeded prompts')
  check('every send became due and vshot exited 0', cap.receipts === cap.sends && cap.status === 0, `${cap.receipts}/${cap.sends} · status ${cap.status} · end ${cap.endReason} · ${cap.stderr.slice(-300)}`)
  check('chat landed with empty composer and all 3 initial prompts completed', has(m.land, 'Type a prompt') && has(m.seeded, `reply-3:${PROMPT_3}`), m.seeded?.text.slice(-300))

  section('2. ctrl+r opens search, typing matches newest, second ctrl+r cycles older, Enter submits')
  check('ctrl+r opens the search prompts bar', has(m.opened, 'search prompts:'), m.opened?.text.slice(-300))
  check('typing needle-alpha matches the newest matching prompt in the composer', has(m.firstMatch, 'search prompts:') && has(m.firstMatch, 'needle-alpha') && composerRow(m.firstMatch).includes(PROMPT_3), composerRow(m.firstMatch))
  check('pressing ctrl+r again cycles to the older matching prompt', has(m.cycledMatch, 'search prompts:') && composerRow(m.cycledMatch).includes(PROMPT_1), composerRow(m.cycledMatch))
  check('pressing Enter closes search and submits the cycled prompt to the model', !has(m.submitted, 'search prompts:') && has(m.submitted, `reply-4:${PROMPT_1}`), m.submitted?.text.slice(-300))

  section('3. no matching prompt + Esc keeps draft; Esc on match accepts without submitting; ctrl+c restores draft')
  check('unmatched query paints no matching prompt:', has(m.noMatch, 'no matching prompt:') && has(m.noMatch, 'zzz-no-hit'), m.noMatch?.text.slice(-300))
  check('Esc after no-match search closes the bar and keeps the typed draft', !has(m.escAfterNoMatch, 'no matching prompt:') && !has(m.escAfterNoMatch, 'search prompts:') && composerRow(m.escAfterNoMatch).includes(DRAFT_1), composerRow(m.escAfterNoMatch))
  check('Esc after a match accepts the match into the composer without submitting', !has(m.escAccepted, 'search prompts:') && composerRow(m.escAccepted).includes(PROMPT_2), composerRow(m.escAccepted))
  check('ctrl+c cancels a matched search and restores the original typed draft', has(m.beforeCancel, PROMPT_2) && !has(m.cancelled, 'search prompts:') && composerRow(m.cancelled).includes(DRAFT_2), composerRow(m.cancelled))

  section('4. Loopback API received exactly 4 turns (3 seeded + 1 submitted via Enter)')
  check('loopback API received the 3 initial prompts plus the cycled Enter submission and nothing from Esc/ctrl+c',
    receivedPrompts.length === 4 &&
    receivedPrompts[0] === PROMPT_1 &&
    receivedPrompts[1] === PROMPT_2 &&
    receivedPrompts[2] === PROMPT_3 &&
    receivedPrompts[3] === PROMPT_1,
    JSON.stringify(receivedPrompts),
  )
} finally {
  apiServer.closeAllConnections?.()
  apiServer.close()
  if (failures === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
  else console.log(`scratch kept: ${scratch}`)
}

console.log(failures === 0 ? '\nPASS history search drive' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
