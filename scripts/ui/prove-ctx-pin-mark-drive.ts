#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(import.meta.dir, '../..')
const DIST = resolve(arg('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
const FRAMES = arg('--frames')
const SIZES = (arg('--sizes') ?? '80x21,80x14,82x17,120x40').split(',').map(size => size.split('x').map(Number) as [number, number])
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const node = existsSync(vendoredNode) ? vendoredNode : 'node'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-pin-mark-')))
const work = join(SCRATCH, 'work')
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'README.md'), '# ctx pin mark fixture\n')
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'import-home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'MERCURY_MODEL']) {
  delete process.env[k]
}
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

const GPT_ID = 'gpt-6-astra'
const SERVED_WINDOW = 272_000
const DECLARED_CEILING = 872_000
const modelsHits: number[] = []
const others: string[] = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && url.endsWith('/models')) {
      modelsHits.push(Date.now())
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          models: [
            {
              slug: GPT_ID,
              display_name: 'GPT-6 Astra',
              visibility: 'list',
              priority: 1,
              supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
              default_reasoning_level: 'medium',
              context_window: SERVED_WINDOW,
              max_context_window: DECLARED_CEILING,
              input_modalities: ['text', 'image'],
              supported_in_api: true,
            },
          ],
        }),
      )
      return
    }
    if (req.method === 'POST' && url.endsWith('/responses')) {
      const rid = `resp_pin_${Date.now()}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        sse({ type: 'response.created', response: { id: rid } }) +
          sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }) +
          sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 12, output_tokens: 6 } } }),
      )
      return
    }
    others.push(`${req.method} ${url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
const port = await new Promise<number>(resolveRun => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolveRun(typeof address === 'object' && address !== null ? address.port : 0)
  })
})
const base = `http://127.0.0.1:${port}`

function seedHome(name: string): string {
  const home = join(SCRATCH, name)
  mkdirSync(home, { recursive: true })
  seedFirstRun(home, [work])
  writeFileSync(join(home, 'settings.json'), '{}\n')
  const now = Date.now()
  const authFile = join(home, '.openai-auth.json')
  writeFileSync(
    authFile,
    JSON.stringify(
      {
        version: 1,
        tokens: {
          idToken: 'fixture-id-astra',
          accessToken: 'fixture-access-astra',
          refreshToken: 'fixture-refresh-astra',
          accountId: 'acct-fixture-astra',
          planType: 'plus',
          email: 'ana@example.com',
          accessTokenExpiresAtMs: now + 86_400_000,
        },
        lastRefreshMs: now,
        preferredSource: 'chatgpt-subscription',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  chmodSync(authFile, 0o600)
  recordSignIn('openai', 'subscription', { home })
  return home
}

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_UPDATE_NOTICE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_MODEL: GPT_ID,
    MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`,
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    BROWSER: '/usr/bin/true',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    COLORTERM: 'truecolor',
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

type Send = Record<string, unknown>
type Cell = { c?: string }
type Grid = Cell[][]
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
async function capture(tag: string, home: string, cols: number, rows: number, sends: Send[], readyText: string): Promise<{ marks: Record<string, string>; final: string; sends: number; receipts: number }> {
  const dir = join(SCRATCH, `capture-${tag}`)
  mkdirSync(dir, { recursive: true })
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: [node, DIST],
      cwd: work,
      cols,
      rows,
      total: 450,
      sends,
      readyText: [readyText],
      stableTicks: 4,
      out: outPath,
    }),
  )
  const refusal = await new Promise<string | null>((resolveRun, rejectRun) => {
    execFile(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { env: childEnv(home), timeout: vshotBudgetMs(240_000) }, (error, _stdout, stderr) => {
      if (error && !existsSync(outPath)) rejectRun(new Error(`${String(error)}\n${stderr}`))
      else resolveRun(error ? String(stderr).split('\n').find(line => line.includes('[vshot]')) ?? String(error) : null)
    })
  })
  if (refusal !== null) console.log(`  (the capture ended refused: ${refusal.slice(0, 160)})`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }> }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  const final = gridText(payload.grid)
  if (FRAMES !== undefined) {
    for (const [label, text] of Object.entries(marks)) writeFileSync(join(FRAMES, `${tag}-${label}.txt`), text + '\n')
    writeFileSync(join(FRAMES, `${tag}-final.txt`), final + '\n')
  }
  return { marks, final, sends: sends.length, receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0 }
}

const FACE_THEN_COMPOSER: Send[] = [
  { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3 },
]
const ctxRowOf = (frame: string): string => frame.split('\n').find(line => /\bctx\b/.test(line))?.trim() ?? ''

console.log("the ctx figure marks a GPT pin until the session's runner reports the live list — the built cockpit in a PTY at four sizes")
console.log(`  bundle ${DIST}\n  fixture ${base}\n  scratch ${SCRATCH}`)

try {
  for (const [cols, rows] of SIZES) {
    const tag = `${cols}x${rows}`
    const home = seedHome(`home-${tag}`)
    const cockpit = cols >= 100 && rows >= 26
    console.log(`\n── ${tag}${cockpit ? '' : ' (below the cockpit chrome: no rail; the header carries the percent alone)'}`)
    const readyText = cockpit ? '? for shortcuts' : 'Type a prompt'
    const sends: Send[] = cockpit
      ? [
          ...FACE_THEN_COMPOSER,
          { data: '', atTick: 999, awaitText: '1050k', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'boot' },
          { data: 'hello\r', atTick: 999, awaitText: '· ready', requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
          { data: '', atTick: 999, awaitText: '· 872k', requireAwait: true, minTick: 3, awaitSettleTicks: 4, mark: 'landed' },
          { data: '/model\r', atTick: 999, awaitText: readyText, requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
          { data: '\x1b', atTick: 999, awaitText: '· model IDs', requireAwait: true, minTick: 3, awaitSettleTicks: 2 },
          { data: '', atTick: 999, awaitText: '· 872k', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'live' },
        ]
      : [...FACE_THEN_COMPOSER, { data: '', atTick: 999, awaitText: readyText, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'boot' }]
    const hitsBefore = modelsHits.length
    let shot: Awaited<ReturnType<typeof capture>>
    try {
      shot = await capture(tag, home, cols, rows, sends, readyText)
    } catch (err) {
      check(`${tag}: the capture ran`, false, err instanceof Error ? err.message.slice(0, 400) : String(err))
      continue
    }
    check(`${tag}: every send became due`, shot.receipts === shot.sends, `${shot.receipts}/${shot.sends}`)
    const boot = shot.marks.boot ?? ''
    if (!cockpit) {
      check(`${tag}: the composer painted`, boot.includes(readyText), boot.slice(-200))
      check(`${tag}: the ctx figure here is the percent alone — no window size, no pin word`, /\bctx —/.test(ctxRowOf(boot)) && !/\d+k/.test(ctxRowOf(boot)) && !/\d+k pin\b/.test(boot), ctxRowOf(boot) || '(no ctx row)')
      continue
    }
    const bootRow = ctxRowOf(boot)
    check(`${tag}: before the session's first turn, the rail's ctx row carries the pinned window with the mark`, /ctx — · 1050k pin\b/.test(bootRow), bootRow || '(no ctx row)')
    const landed = shot.marks.landed ?? ''
    const landedRow = ctxRowOf(landed)
    check(`${tag}: after the session's own turn, the figure is the list's ceiling and the mark is gone — no picker opened`, /ctx \S+ · 872k(?!\s*pin)/.test(landedRow) && !/\bpin\b/.test(landedRow), landedRow || `the mark never fired; the final row reads ${JSON.stringify(ctxRowOf(shot.final))}`)
    const live = shot.marks.live ?? ''
    const liveRow = ctxRowOf(live)
    check(`${tag}: after the picker's own read, the figure holds and stays unmarked`, /ctx \S+ · 872k(?!\s*pin)/.test(liveRow) && !/\bpin\b/.test(liveRow), liveRow || `the mark never fired; the final row reads ${JSON.stringify(ctxRowOf(shot.final))}`)
    check(`${tag}: the runner primes the list and the picker refreshes it once on open`, modelsHits.length - hitsBefore === 2, String(modelsHits.length - hitsBefore))
  }
} finally {
  server.close()
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}\n  other requests: ${JSON.stringify(others)}`)
}

console.log(`\n${failures === 0 ? 'prove-ctx-pin-mark-drive: ALL LAWS HOLD' : `prove-ctx-pin-mark-drive: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
