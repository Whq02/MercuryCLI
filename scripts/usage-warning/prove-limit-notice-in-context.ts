#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
  process.exit(1)
}
const VENDORED_NODE = join(DIST, '..', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'limit-notice-')))
const subscriberHome = join(SCRATCH, 'subscriber-home')
const keyHome = join(SCRATCH, 'key-home')
const work = join(SCRATCH, 'work')
for (const d of [subscriberHome, keyHome, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# limit notice fixture\n')
process.env.MERCURY_CONFIG_DIR = subscriberHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.CI
for (const k of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_API_KEY_FILE_DESCRIPTOR',
  'MERCURY_MODEL',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'MERCURY_CAP_FAILOVER',
  'MERCURY_MOCK_LIMITS',
  'MERCURY_MOCK_USAGE_PAYLOAD',
  'MERCURY_USAGE_SEED',
]) {
  delete process.env[k]
}

const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
seedFirstRun(subscriberHome, [work])
seedFirstRun(keyHome, [work])
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const auth = await import('../../src/utils/auth.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
const { storeOAuthAccountInfo } = await import('../../src/services/oauth/client.ts')
storeOAuthAccountInfo({ accountUuid: '00000000-0000-4000-8000-0000000000aa', emailAddress: 'sam@example.com' })
const saved = auth.saveOAuthTokensIfNeeded({
  accessToken: 'fixture-access-token',
  refreshToken: 'fixture-refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
})
if (!saved.success) throw new Error(`the credential store refused the sign-in: ${saved.warning ?? '?'}`)
auth.clearOAuthTokenCache()
recordSignIn('anthropic', 'oauth')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)

const NOTICE_MARK = 'Usage limit near'
const ROAD_ASK = 'NOTICE-ROAD: list the readme'
const AFTER_ASK = 'AFTER-ROAD: say the road is behind us'
const KEY_ASK = 'KEY-ROAD: list the readme'
const MODEL_WORD = 'claude-opus-4-8'
const nowSeconds = Math.floor(Date.now() / 1000)
const RESET_ONE = nowSeconds + 2 * 3600
const RESET_TWO = RESET_ONE + 5 * 3600
const WEEK_RESET = nowSeconds + 6 * 24 * 3600

type Hit = { n: number; ask: string; notices: number; texts: string[]; model: string }
const hits: Hit[] = []
const others: string[] = []
const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
type Block = { type?: string; text?: string }
type Item = { role?: string; content?: unknown }
function askOf(body: Record<string, unknown>): string {
  const items = Array.isArray(body.messages) ? (body.messages as Item[]) : []
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'user') continue
    const content = item.content
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? (content as Block[]).map(b => (typeof b.text === 'string' ? b.text : '')).filter(t => t !== '')
          : []
    const asks = texts.filter(t => !t.trimStart().startsWith('<'))
    if (asks.length > 0) return asks[asks.length - 1]!
  }
  return ''
}
function unifiedHeaders(utilization: string, reset: number, warning: boolean): Record<string, string> {
  return {
    'anthropic-ratelimit-unified-status': warning ? 'allowed_warning' : 'allowed',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': String(reset),
    'anthropic-ratelimit-unified-5h-status': warning ? 'allowed_warning' : 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': utilization,
    'anthropic-ratelimit-unified-5h-reset': String(reset),
    ...(warning ? { 'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.8' } : {}),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.2',
    'anthropic-ratelimit-unified-7d-reset': String(WEEK_RESET),
  }
}
const usage = { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
function open(res: ServerResponse, n: number, model: string, headers: Record<string, string>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', ...headers })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_notice_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
}
const close = (stop: 'end_turn' | 'tool_use', index: number): string =>
  sse('content_block_stop', { type: 'content_block_stop', index }) +
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage }) +
  sse('message_stop', { type: 'message_stop' })
function answerText(res: ServerResponse, n: number, model: string, text: string, headers: Record<string, string>): void {
  open(res, n, model, headers)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.end(close('end_turn', 0))
}
function answerGlob(res: ServerResponse, n: number, model: string, headers: Record<string, string>): void {
  open(res, n, model, headers)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_notice_${n}`, name: 'Glob', input: {} } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ pattern: 'README.md' }) } }))
  res.end(close('tool_use', 0))
}
let roadStep = 0
let keyStep = 0
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = {}
      }
      const ask = askOf(body)
      const model = String(body.model ?? '')
      const notices = raw.split(NOTICE_MARK).length - 1
      const texts = [...raw.matchAll(/Usage limit near [^"\\]{0,200}/g)].map(m => m[0])
      const n = hits.length + 1
      hits.push({ n, ask: ask.slice(0, 60), notices, texts, model })
      if (ask.includes('NOTICE-ROAD')) {
        roadStep += 1
        if (roadStep === 1 || roadStep === 2) return answerGlob(res, n, model, unifiedHeaders('0.85', RESET_ONE, true))
        if (roadStep === 3) return answerGlob(res, n, model, unifiedHeaders('0.20', RESET_TWO, false))
        if (roadStep === 4) return answerGlob(res, n, model, unifiedHeaders('0.88', RESET_TWO, true))
        return answerText(res, n, model, 'the road is walked', unifiedHeaders('0.88', RESET_TWO, true))
      }
      if (ask.includes('AFTER-ROAD')) return answerText(res, n, model, 'the road is behind us', unifiedHeaders('0.88', RESET_TWO, true))
      if (ask.includes('KEY-ROAD')) {
        keyStep += 1
        if (keyStep <= 2) return answerGlob(res, n, model, unifiedHeaders('0.85', RESET_ONE, true))
        return answerText(res, n, model, 'the key road is walked', unifiedHeaders('0.85', RESET_ONE, true))
      }
      return answerText(res, n, model, 'ok', {})
    }
    others.push(`${req.method} ${url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
const port = await new Promise<number>(resolve => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(typeof address === 'object' && address !== null ? address.port : 0)
  })
})
const base = `http://127.0.0.1:${port}`

type Run = { rc: number; out: string; err: string }
function runPrint(home: string, args: string[], extraEnv: Record<string, string>): Promise<Run> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_BASE_URL: base,
      MERCURY_MODEL: MODEL_WORD,
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_VERIFY_EVIDENCE: '0',
      MERCURY_UPDATE_NOTICE: '0',
      BROWSER: '/usr/bin/true',
      ...extraEnv,
    }
    const child = spawn(NODE, [DIST, '-p', ...args], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (err += String(d)))
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, 150_000)
    child.on('close', rc => {
      clearTimeout(killer)
      resolve({ rc: rc ?? -1, out, err })
    })
  })
}
function transcriptNoticeRows(home: string): number {
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return 0
  let count = 0
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.jsonl')) count += readFileSync(p, 'utf8').split('"attachmentType":"usage_limit_notice"').length - 1
    }
  }
  walk(projects)
  return count
}
const brief = (): string => j(hits.map(h => [h.n, h.ask.slice(0, 12), h.notices]))

console.log('the usage-limit notice in the session context — a headless seat on the built bundle, the wire at a fixture')
console.log(`  bundle ${DIST}\n  home ${subscriberHome}\n  fixture ${base}`)

try {
  section('§1 the subscriber road: one notice per window, once more after the reset')
  const road = await runPrint(subscriberHome, [ROAD_ASK], {})
  check('the seat ran to its end', road.rc === 0, `rc=${road.rc} ${road.err.slice(-300)}`)
  check('the fixture saw the five requests of the road (four tool rounds and the settle)', hits.length >= 5, brief())
  const [h1, h2, h3, h4, h5] = hits
  check('request 1 carries no notice (nothing observed yet)', h1?.notices === 0, brief())
  check('request 2 carries ONE notice: the round after the 85% headers landed', h2?.notices === 1, brief())
  check(
    "the notice names the provider, the window and the percent in the warning's own words",
    (h2?.texts[0] ?? '').includes('Anthropic: 85% of session limit used') && (h2?.texts[0] ?? '').includes('resets'),
    j(h2?.texts),
  )
  check('the notice says what to do', (h2?.texts[0] ?? '').includes('commit what is done'), j(h2?.texts))
  check('request 3 carries the same ONE notice: no repeat inside the window', h3?.notices === 1, brief())
  check('request 4 carries still ONE: the calm window after the reset adds nothing', h4?.notices === 1, brief())
  check('request 5 carries TWO: the next window closing in fires once more', h5?.notices === 2, brief())
  check('the second notice carries the new percent', (h5?.texts[1] ?? '').includes('88%'), j(h5?.texts))
  check('the transcript keeps the two notice rows', transcriptNoticeRows(subscriberHome) === 2, String(transcriptNoticeRows(subscriberHome)))

  section('§2 the resumed seat: the transcript remembers the window, no third notice')
  const before = hits.length
  const after = await runPrint(subscriberHome, ['--continue', AFTER_ASK], {})
  check('the resumed seat ran to its end', after.rc === 0, `rc=${after.rc} ${after.err.slice(-300)}`)
  const h6 = hits[before]
  check('the resumed request carries the two notices of the history and no third', h6 !== undefined && h6.notices === 2, brief())

  section('§3 a source with no percent-shaped signal: no notice, however the wire reads')
  const beforeKey = hits.length
  const keyRun = await runPrint(keyHome, [KEY_ASK], { ANTHROPIC_API_KEY: FIXTURE_API_KEY })
  check('the keyed seat ran to its end', keyRun.rc === 0, `rc=${keyRun.rc} ${keyRun.err.slice(-300)}`)
  const keyHits = hits.slice(beforeKey)
  check('the keyed seat made its three requests', keyHits.length >= 3, brief())
  check('no request of the keyed seat carries a notice', keyHits.every(h => h.notices === 0), brief())
} finally {
  server.close()
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}\n  other requests: ${j(others)}`)
}

console.log(`\n${failures === 0 ? 'prove-limit-notice-in-context: ALL LAWS HOLD' : `prove-limit-notice-in-context: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
