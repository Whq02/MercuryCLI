#!/usr/bin/env bun
import { execFileSync, spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')
const REPLY = 'the quiet wire answered'
const ASK = 'quiet boot: say hello'
const RELEASE_HOST = ['api', 'github', 'com'].join('.')
const IDLE_TICKS = 300

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 600) : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`prove-quiet-boot-journey: SKIPPED — no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(0)
}
if (!existsSync(DIST)) {
  console.log('prove-quiet-boot-journey: SKIPPED — dist/mercury.mjs absent (bun run build.ts first)')
  process.exit(0)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'quiet-boot-journey-')))
const shimDir = join(scratch, 'bin')
const shimLog = join(scratch, 'shim.log')
mkdirSync(shimDir, { recursive: true })
for (const exe of ['git', 'ssh']) {
  const path = join(shimDir, exe)
  writeFileSync(path, `#!/bin/sh\necho "${exe} $*" >> "$SHIM_LOG"\nexit 128\n`)
  chmodSync(path, 0o755)
}
const shimLines = (): string[] => (existsSync(shimLog) ? readFileSync(shimLog, 'utf8').split('\n').filter(l => l.trim() !== '') : [])
const NETWORK_VERBS = /^(git|ssh) (fetch|push|pull|clone|ls-remote|remote|submodule)\b|^ssh /

const preload = join(scratch, 'tripwire.cjs')
writeFileSync(
  preload,
  `'use strict'
const fs = require('node:fs')
const net = require('node:net')
const tls = require('node:tls')
const LOG = process.env.PROOF_NETLOG
const log = line => { try { fs.appendFileSync(LOG, line + '\\n') } catch {} }
const isLocal = host => host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === undefined || host === ''
const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] }
  if (opts.path) return origConnect.apply(this, args)
  const host = opts.host || 'localhost'
  if (isLocal(host)) { log('tcp-local ' + host + ':' + opts.port); return origConnect.apply(this, args) }
  log('tcp ' + host + ':' + opts.port)
  throw new Error('tripwire: tcp ' + host + ':' + opts.port)
}
const origTls = tls.connect
tls.connect = function (...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] }
  const host = opts.host || opts.servername || 'localhost'
  if (isLocal(host)) { log('tls-local ' + host + ':' + (opts.port ?? '')); return origTls.apply(this, args) }
  log('tls ' + host + ':' + (opts.port ?? ''))
  throw new Error('tripwire: tls ' + host)
}
try { require('node:module').syncBuiltinESMExports() } catch {}
const origFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const target = typeof input === 'string' ? input : String((input && input.url) || input)
  let host = ''
  try { host = new URL(target).hostname } catch {}
  if (isLocal(host)) { log('fetch-local ' + target); return origFetch(input, init) }
  log('fetch ' + target)
  return Promise.reject(new Error('tripwire: fetch ' + target))
}
`,
)

interface Served {
  method: string
  path: string
  atMs: number
  shape: string
}
function shapeOf(raw: string): string {
  try {
    const body = JSON.parse(raw) as { tools?: unknown[]; messages?: Array<{ role?: string; content?: unknown }> }
    const tools = Array.isArray(body.tools) ? body.tools.length : 0
    let last = ''
    for (const m of body.messages ?? []) {
      if (m.role !== 'user') continue
      if (typeof m.content === 'string') last = m.content
      else if (Array.isArray(m.content)) {
        for (const block of m.content as Array<{ type?: string; text?: string }>) if (block.type === 'text' && typeof block.text === 'string') last = block.text
      }
    }
    return `tools=${tools} user="${last.replace(/\s+/g, ' ').slice(0, 70)}"`
  } catch {
    return 'unparsed'
  }
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function messagesAnswer(model: string): string {
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_quiet_${Date.now() % 1e6}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 12, output_tokens: 5 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
const served: Served[] = []
let fixtureStartedAt = Date.now()
const fixture = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const raw = Buffer.concat(chunks).toString('utf8')
    served.push({ method: req.method ?? '', path, atMs: Date.now() - fixtureStartedAt, shape: req.method === 'POST' ? shapeOf(raw) : '' })
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      let model = 'fixture'
      try {
        model = String((JSON.parse(raw) as { model?: string }).model ?? model)
      } catch {
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(messagesAnswer(model))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
const port = await new Promise<number>(resolvePort => {
  fixture.listen(0, '127.0.0.1', () => {
    const address = fixture.address()
    resolvePort(typeof address === 'object' && address !== null ? address.port : 0)
  })
})
const FIXTURE_BASE = `http://127.0.0.1:${port}`

function childEnv(home: string, netlog: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
    SHIM_LOG: shimLog,
    PROOF_NETLOG: netlog,
    NODE_OPTIONS: `--require ${preload}`,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    MERCURY_TEAMS_DIR: join(scratch, 'teams'),
    MERCURY_TABULA_DIR: join(scratch, 'tabula'),
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_TERMINAL_TITLE: '0',
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    ANTHROPIC_BASE_URL: FIXTURE_BASE,
    BROWSER: 'true',
  }
  for (const key of [
    'ANTHROPIC_AUTH_TOKEN',
    'MERCURY_OAUTH_TOKEN',
    'MERCURY_CUSTOM_OAUTH_URL',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'HF_TOKEN',
    'ZAI_API_KEY',
    'MOONSHOT_API_KEY',
    'DEEPSEEK_API_KEY',
    'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_TELEMETRY',
    'MERCURY_UPDATE_NOTICE',
    'MERCURY_CONCOURSE',
    'MERCURY_CONCOURSE_FIXTURE',
    'NODE_ENV',
    'CI',
  ]) {
    delete env[key]
  }
  Object.assign(env, extra)
  return env
}

const netlines = (netlog: string): string[] => (existsSync(netlog) ? readFileSync(netlog, 'utf8').split('\n').filter(l => l.trim() !== '') : [])
const isLoopbackLine = (l: string): boolean => l.startsWith('tcp-local') || l.startsWith('tls-local') || l.startsWith('fetch-local')
const isReleaseListing = (l: string): boolean => l.includes(RELEASE_HOST)
const strayLines = (lines: string[]): string[] => lines.filter(l => !isLoopbackLine(l) && !isReleaseListing(l))
const uniq = (lines: string[]): string[] => [...new Set(lines)]

interface DriveResult {
  status: number | null
  marks: Record<string, string>
  stderr: string
  endReason: string
  receipts: number
}
type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')

async function drive(tag: string, home: string, netlog: string, sends: unknown[], total: number, extra: Record<string, string> = {}): Promise<DriveResult> {
  const grid = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-vshot.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', DIST, '--chat'], sends, total, cols: 120, rows: 40, out: grid, title: tag }))
  const stderr: string[] = []
  const status = await new Promise<number | null>((resolveStatus, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], {
      env: childEnv(home, netlog, extra),
      cwd: join(scratch, 'cwd'),
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(Math.round(total * 200 * 2.5) + 60_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(deadline)
      resolveStatus(code)
    })
  })
  await new Promise<void>(r => setTimeout(r, 200))
  const marks: Record<string, string> = {}
  let endReason = ''
  let receipts = 0
  if (existsSync(grid)) {
    const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
      marks?: Array<{ label: string; grid: Grid }>
      endReason?: string
      sendReceipts?: unknown[]
    }
    for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
    endReason = payload.endReason ?? ''
    receipts = Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0
  }
  return { status, marks, stderr: stderr.join('').trim(), endReason, receipts }
}

mkdirSync(join(scratch, 'cwd'), { recursive: true })
const seededHome = (name: string): string => {
  const home = join(scratch, name)
  seedFirstRun(home, [join(scratch, 'cwd')])
  return home
}

const OPENING: unknown[] = [
  { data: '\r', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
]
const rows = (text: string, needle: string): string => text.split('\n').filter(l => l.includes(needle)).join(' · ')

console.log('============================================================')
console.log(' the quiet boot — nothing leaves until the first turn')
console.log('============================================================')

console.log('[0] poison control — the tripwire trips on a non-loopback fetch, the fixture ledgers a loopback request')
{
  const netlog = join(scratch, 'poison-net.log')
  let tripped = false
  try {
    execFileSync('node', ['-e', "fetch('http://203.0.113.9:80/v1/messages').then(() => process.exit(0), () => process.exit(3))"], {
      env: childEnv(join(scratch, 'poison-home'), netlog),
      cwd: scratch,
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    tripped = true
  }
  check('control: a poison-host fetch trips and logs', tripped && netlines(netlog).some(l => l.startsWith('fetch ')), netlines(netlog).join(' · '))
  try {
    await fetch(`${FIXTURE_BASE}/control`)
  } catch {
  }
  await new Promise<void>(r => setTimeout(r, 100))
  check('control: a loopback request reaches the fixture and lands in its ledger', served.some(s => s.path === '/control'), JSON.stringify(served))
  served.length = 0
  rmSync(shimLog, { force: true })
}

console.log('[A] idle — boot, first paint, sixty seconds, /help, quit: the wire stays empty')
{
  const netlog = join(scratch, 'idle-net.log')
  fixtureStartedAt = Date.now()
  const res = await drive(
    'idle',
    seededHome('home-idle'),
    netlog,
    [
      ...OPENING,
      { data: '', atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'painted' },
      { data: '/help', afterPrevTicks: IDLE_TICKS, mark: 'idle' },
      { data: '\r', afterPrevTicks: 3 },
      { data: '', afterPrevTicks: 20, mark: 'help' },
      { data: '/exit', afterPrevTicks: 3 },
      { data: '\r', afterPrevTicks: 2 },
      { data: '', afterPrevTicks: 12, mark: 'quit' },
    ],
    IDLE_TICKS + 140,
  )
  check('the drive delivered every send (a real boot)', res.status === 0 && res.receipts === 8, `vshot ${res.status} · receipts ${res.receipts} · ${res.endReason} · ${res.stderr.slice(-300)}`)
  check('the chat painted its composer', (res.marks.painted ?? '').includes('ype a prompt'), rows(res.marks.painted ?? '', '❯'))
  check('/help answered on the screen', (res.marks.help ?? '') !== '' && (res.marks.help ?? '') !== (res.marks.idle ?? ''), 'the screen did not change after /help')
  const lines = netlines(netlog)
  const stray = uniq(strayLines(lines))
  const ledger = served.map(s => `${s.method} ${s.path} @${Math.round(s.atMs / 1000)}s`)
  check('the model wire served NOTHING before a turn (the fixture ledger is empty)', served.length === 0, ledger.join(' · '))
  check('no non-loopback connect left the child (the release listing read excepted)', stray.length === 0, stray.join(' · '))
  const listing = uniq(lines.filter(isReleaseListing))
  if (listing.length > 0) console.log(`  – the release listing read was attempted (allowed, our own repository): ${listing.join(' · ')}`)
  const netVerbs = shimLines().filter(l => NETWORK_VERBS.test(l))
  check('no git/ssh network verb spawned', netVerbs.length === 0, netVerbs.join(' · '))
  if (shimLines().length > 0) console.log(`  – local git spawns seen (allowed): ${uniq(shimLines().map(l => l.split(' ').slice(0, 2).join(' '))).join(' · ')}`)
}
served.length = 0
rmSync(shimLog, { force: true })

console.log('[B] one turn — the only requests are model requests')
{
  const netlog = join(scratch, 'turn-net.log')
  fixtureStartedAt = Date.now()
  const res = await drive(
    'turn',
    seededHome('home-turn'),
    netlog,
    [
      ...OPENING,
      { data: ASK, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
      { data: '\r', afterPrevTicks: 4 },
      { data: '', requireAwait: true, awaitText: REPLY, awaitStableTicks: 3, mark: 'answered' },
      { data: '', afterPrevTicks: 30, mark: 'settled' },
    ],
    160,
  )
  check('the drive delivered every send', res.status === 0 && res.receipts === 5, `vshot ${res.status} · receipts ${res.receipts} · ${res.endReason} · ${res.stderr.slice(-300)}`)
  check("the fixture's reply landed in the transcript", (res.marks.answered ?? '').includes(REPLY), rows(res.marks.settled ?? res.marks.answered ?? '', 'quiet'))
  const ledger = served.map(s => `${s.method} ${s.path} @${Math.round(s.atMs / 1000)}s`)
  check('the wire carried at least the turn', served.length >= 1, 'the fixture served nothing')
  check('every request the fixture served was a model request (POST /v1/messages) — no other road', served.every(s => s.method === 'POST' && s.path.endsWith('/v1/messages')), ledger.join(' · '))
  console.log(`  – model requests served in the turn leg: ${served.length}`)
  for (const s of served) console.log(`      ${s.method} ${s.path} @${Math.round(s.atMs / 1000)}s · ${s.shape}`)
  const stray = uniq(strayLines(netlines(netlog)))
  check('no non-loopback connect left the child (the release listing read excepted)', stray.length === 0, stray.join(' · '))
  const netVerbs = shimLines().filter(l => NETWORK_VERBS.test(l))
  check('no git/ssh network verb spawned', netVerbs.length === 0, netVerbs.join(' · '))
}

served.length = 0
rmSync(shimLog, { force: true })

console.log('[C] a connected OpenAI account beside the key — boot idle: no catalogue prime, no usage clock')
{
  const netlog = join(scratch, 'openai-idle-net.log')
  fixtureStartedAt = Date.now()
  const res = await drive(
    'openai-idle',
    seededHome('home-openai'),
    netlog,
    [
      ...OPENING,
      { data: '', atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'painted' },
      { data: '', afterPrevTicks: 100, mark: 'idle' },
    ],
    180,
    {
      OPENAI_API_KEY: 'sk-fixture-quiet-boot-000000000000000000',
      MERCURY_OPENAI_API_BASE: `${FIXTURE_BASE}/openai/v1`,
      MERCURY_OPENAI_CHATGPT_BASE: `${FIXTURE_BASE}/openai/chatgpt`,
      MERCURY_OPENAI_AUTH_BASE: `${FIXTURE_BASE}/openai/auth`,
    },
  )
  check('the drive delivered every send (a real boot)', res.status === 0 && res.receipts === 3, `vshot ${res.status} · receipts ${res.receipts} · ${res.endReason} · ${res.stderr.slice(-300)}`)
  check('the chat painted its composer', (res.marks.painted ?? '').includes('ype a prompt'), rows(res.marks.painted ?? '', '❯'))
  const ledger = served.map(s => `${s.method} ${s.path} @${Math.round(s.atMs / 1000)}s`)
  check('no catalogue was primed and no meter read on a clock (the fixture ledger is empty through twenty idle seconds)', served.length === 0, ledger.join(' · '))
  const stray = uniq(strayLines(netlines(netlog)))
  check('no non-loopback connect left the child (the release listing read excepted)', stray.length === 0, stray.join(' · '))
  const netVerbs = shimLines().filter(l => NETWORK_VERBS.test(l))
  check('no git/ssh network verb spawned', netVerbs.length === 0, netVerbs.join(' · '))
}

await new Promise<void>(resolveClose => fixture.close(() => resolveClose()))
if (failures > 0) {
  console.log(`\nprove-quiet-boot-journey: RED (${failures}) — grids and logs kept under ${scratch}`)
  process.exit(1)
}
rmSync(scratch, { recursive: true, force: true })
console.log('\nprove-quiet-boot-journey: green')
process.exit(0)
