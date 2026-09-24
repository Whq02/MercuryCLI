#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const repo = resolve(import.meta.dir, '../..')
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const dist = resolve(arg('--dist') ?? join(repo, 'dist/mercury.mjs'))
if (!existsSync(dist)) throw new Error('build the product before running the drive')
const prefix = arg('--world-prefix') ?? 'mercury-cap-facts-'
if (!/^[a-zA-Z0-9-]+$/.test(prefix)) throw new Error('the world prefix must be a basename')
const home = mkdtempSync(join(realpathSync(tmpdir()), prefix))
const cwd = join(home, 'fixture-repo')
const budgetMs = vshotBudgetMs(180_000)
const controlled = !process.argv.includes('--observe-only')
const key = 'proof-key-ci-gate-not-a-real-key'
mkdirSync(cwd)
writeFileSync(join(home, '.mercury.json'), JSON.stringify({
  hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', numStartups: 10, theme: 'dark',
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
}))
writeFileSync(join(home, 'settings.json'), '{}')
writeFileSync(join(home, '.openai-auth.json'), JSON.stringify({ version: 1, tokens: {
  idToken: 'fixture-id-token', accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token',
  accountId: 'acct_fixture', planType: 'plus', email: 'sam@example.test', accessTokenExpiresAtMs: Date.now() + 86400000,
} }))
writeFileSync(join(home, 'facts-window.json'), JSON.stringify({ enabled: controlled, budgetMs }))
const wirePath = join(home, 'wire.jsonl')
writeFileSync(wirePath, '')
const fixture = spawn('node', [join(import.meta.dir, 'cap-offer-fixture-server.ts'), wirePath], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: home, TMPDIR: realpathSync(tmpdir()) },
})
process.on('exit', () => { if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill() })
const port = await new Promise<number>((resolvePort, reject) => {
  const timer = setTimeout(() => reject(new Error('fixture never announced its port')), vshotBudgetMs(15_000))
  let output = ''
  fixture.stdout!.on('data', data => {
    output += data.toString()
    const match = /PORT (\d+)/.exec(output)
    if (match) { clearTimeout(timer); resolvePort(Number(match[1])) }
  })
  fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exit ${code}`)) })
}).catch(error => { fixture.kill(); throw error })
const base = `http://127.0.0.1:${port}`
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, TMPDIR: realpathSync(tmpdir()), TERM: 'xterm-256color', LANG: 'en_US.UTF-8', SHELL: '/bin/zsh',
  MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true',
  ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: base,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`, MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_AUTH_BASE: 'http://127.0.0.1:9',
  MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_SLEEP: '0',
  MERCURY_OPERATOR: 'sam', MERCURY_TURN_RECEIPT: '0', MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'), MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_TEAMS_DIR: join(home, 'teams'),
  MERCURY_TABULA_DIR: join(home, 'tabula'), MERCURY_HOME: join(home, 'proof-home'), MERCURY_FAILOVER_LINE_MS: String(budgetMs),
  MERCURY_CONNECTOR_TRACE: join(home, 'connector-trace.jsonl'),
  ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
  NODE_OPTIONS: `--import=${pathToFileURL(join(import.meta.dir, 'cap-facts-window.mjs')).href}`,
}
const sends = [
  { requireAwait: true, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r', mark: 'boot' },
  { requireAwait: true, awaitText: '← back', awaitSettleTicks: 4, data: 'hello sol\r', mark: 'home' },
  { requireAwait: true, awaitText: 'OpenAI usage window', awaitSettleTicks: 4, data: '\r', mark: 'offer' },
  { requireAwait: true, awaitText: 'Set model to', awaitSettleTicks: 2, data: '', mark: 'confirm' },
  { requireAwait: true, awaitText: 'ready · ', awaitSettleTicks: 4, data: 'pick up from gpt pls\r', mark: 'pickup-send' },
  { requireAwait: true, awaitText: 'fable picked up the handoff', awaitSettleTicks: 4, data: '', mark: 'pickup' },
  { requireAwait: true, awaitText: 'Fable 5.1 ·', awaitSettleTicks: 4, data: '', mark: 'settled' },
  { requireAwait: true, awaitText: 'ready · ', awaitSettleTicks: 4, data: '/model sonnet\r', mark: 'model-send' },
  { requireAwait: true, awaitText: 'Sonnet 5 ·', awaitSettleTicks: 2, data: '', mark: 'sonnet-confirm' },
  { requireAwait: true, awaitText: 'Sonnet 5 ·', awaitSettleTicks: 4, data: '', mark: 'sonnet' },
]
type Grid = Array<Array<{ c: string }>>
type Payload = { grid: Grid; marks?: Array<{ label: string; grid: Grid }>; sendReceipts?: Array<{ ts: number }>; endReason?: string }
type Event = { event: string; at: number; atMs?: number; sid?: string; model?: { effective: string; setting: string }; pendingModel?: string | null; held?: boolean; reason?: string; count?: number; requestId?: string; hash?: string; response?: { model?: string; at?: string } }
const output = join(home, 'grid.json')
const config = join(home, 'cfg.json')
writeFileSync(config, JSON.stringify({ argv: ['node', dist, '--model', 'gpt-5.6-sol'], cwd, sends, stableTicks: 4, total: 500, cols: 120, rows: 40, out: output }))
const result = spawnSync('/usr/bin/python3', [join(repo, 'scripts/ui/vshot.py'), config], { cwd, env, encoding: 'utf8', timeout: budgetMs })
console.log(`world=${home}\ndist=${dist}\ncontrolled=${controlled} vshot=${result.status}\n${result.stderr}`)
if (!existsSync(output)) throw new Error(`no capture: ${result.error ?? result.stdout}`)
const payload = JSON.parse(readFileSync(output, 'utf8')) as Payload
const text = (grid: Grid): string => grid.map(row => row.map(cell => cell.c || ' ').join('')).join('\n')
for (const mark of payload.marks ?? []) {
  const frame = text(mark.grid)
  writeFileSync(join(home, `frame-${mark.label}.txt`), frame)
  console.log(`frame ${mark.label}: ${frame.split('\n').filter(row => /failover|Fable 5|Sonnet 5|GPT-5.6|ready|Set model/.test(row)).map(row => row.trim()).join(' | ')}`)
}
writeFileSync(join(home, 'frame-final.txt'), text(payload.grid))
const frame = (label: string): string => {
  const mark = payload.marks?.find(entry => entry.label === label)
  return mark ? text(mark.grid) : ''
}
const records = <T>(file: string): T[] => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T) : []
const events = records<Event>(join(home, 'facts-events.jsonl'))
const wire = records<{ kind: string; body?: { model?: string }; at: number }>(wirePath)
let failures = 0
let checks = 0
function check(label: string, yes: boolean): void {
  checks++
  console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}`)
  if (!yes) failures++
}
check('every send reached its product gate', payload.sendReceipts?.length === sends.length && result.status === 0)
check('the offer stood and its lossless handoff settled directly', frame('offer').includes('OpenAI usage window') && frame('confirm').includes('Set model to') && !frame('confirm').includes('Model switch preview'))
const ack = events.findIndex(event => event.event === 'model-ack' && event.response?.at === 'now' && event.response.model === 'claude-fable-5-1')
check('the runner acknowledged the failover model applied now', ack >= 0)
const release = events.findIndex(event => event.event === 'facts-release')
const readAfter = events.findIndex((event, index) => index > ack && event.event === 'read-after-ack')
if (controlled) {
  const held = events.filter(event => event.event === 'facts-answer' && event.held)
  check('fresh answers were withheld after acknowledgement', ack >= 0 && held.length > 0 && held.every(event => event.model?.setting === 'claude-fable-5-1'))
  check('the cockpit read a real publication before the fresh answers were released', readAfter > ack && release > readAfter && events.some(event => event.event === 'facts-write' && event.sid === events[readAfter]!.sid && event.atMs === events[readAfter]!.atMs))
  check('product facts and the pickup released the window, not the watchdog', release >= 0 && events[release]!.reason === 'facts-read-and-pickup' && events[release]!.count === held.length)
  const forwarded = events.filter(event => event.event === 'facts-forward')
  check('every withheld answer was forwarded byte-for-byte in order', held.length > 0 && held.length === forwarded.length && held.every((event, index) => event.requestId === forwarded[index]!.requestId && event.hash === forwarded[index]!.hash))
}
check('the cockpit eventually read the fresh Fable model with no pending switch', events.some((event, index) => index > (controlled ? release : ack) && event.event === 'facts-read' && event.model?.setting === 'claude-fable-5-1' && event.pendingModel === null))
check('Anthropic received the pickup with the exact switched model and history', wire.some(row => row.kind === 'anthropic' && row.body?.model === 'claude-fable-5-1' && JSON.stringify(row.body).includes('pick up from gpt pls') && JSON.stringify(row.body).includes('hello sol')))
check('the switched reply painted', frame('pickup').includes('fable picked up the handoff'))
check('the settled failover sentence remains', frame('settled').includes('on the anthropic failover lane · Fable 5.1'))
check('the settled strip retains its failover mark', frame('settled').includes('Fable 5.1 · failover'))
check('the later model switch retains the note', frame('sonnet').includes('failover lane · Sonnet 5') && frame('sonnet').includes('Sonnet 5 · failover'))
for (const event of events) console.log(`[record] ${JSON.stringify(event)}`)
console.log(`${checks} checks, ${failures} failures; endReason=${payload.endReason}`)
console.log(`Evidence kept at ${home}`)
process.exitCode = failures ? 1 : 0
fixture.kill()
