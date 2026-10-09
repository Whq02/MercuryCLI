#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, NODE } from '../daemon/dupline-world.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const DEAD = 'http://127.0.0.1:1'
const FAKE_OPENROUTER_KEY = `sk-or-v1-${'0'.repeat(64)}`
const FIRST_ROW = 'fixture-lab/first-row'

const SCRUB = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_MODEL',
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_DEFAULT_HAIKU_MODEL',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'XAI_MANAGEMENT_API_KEY',
  'MODEL_API_KEY',
  'META_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENROUTER_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_LOCAL_API_KEY',
]
const BASES = [
  'ANTHROPIC_BASE_URL',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_MOONSHOT_API_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_ZAI_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
  'MERCURY_XAI_API_BASE',
  'MERCURY_XAI_MANAGEMENT_API_BASE',
  'MERCURY_META_API_BASE', 'MERCURY_ZEN_API_BASE', 'MERCURY_ZEN_GO_API_BASE',
]

type Row = { id: string; status: string; evidence?: string }
type Home = { env: NodeJS.ProcessEnv; work: string }
type Ran = { status: number | null; stdout: string; stderr: string }

const world = realpathSync(mkdtempSync(join(tmpdir(), 'route-surfaces-')))
console.log(`build under proof: ${DIST}`)

function home(tag: string, extra: Record<string, string> = {}, settings?: Record<string, unknown>): Home {
  const root = mkdtempSync(join(world, `${tag}-`))
  const config = join(root, 'config')
  const osHome = join(root, 'os')
  const work = join(root, 'work')
  for (const dir of [config, osHome, work]) mkdirSync(dir)
  if (settings !== undefined) writeFileSync(join(config, 'settings.json'), JSON.stringify(settings))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: osHome,
    USERPROFILE: osHome,
    MERCURY_CONFIG_DIR: config,
    MERCURY_DAEMON_DIR: join(root, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    CI: 'true',
  }
  for (const name of SCRUB) delete env[name]
  for (const name of BASES) env[name] = DEAD
  env.MERCURY_OPENROUTER_API_BASE = `${DEAD}/api/v1`
  return { env: { ...env, ...extra }, work }
}

function product(h: Home, args: string[], timeoutMs = 180_000): Promise<Ran> {
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, ...args], { cwd: h.work, env: h.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ status: -1, stdout, stderr: `${stderr}${String(error)}` })
    })
    child.on('close', status => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

const parse = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

async function surfaces(h: Home): Promise<{
  authRan: Ran
  auth: Record<string, unknown> | null
  healthRan: Ran
  row: (id: string) => Row | undefined
  named: string | undefined
}> {
  const [authRan, healthRan] = await Promise.all([product(h, ['auth', 'status', '--json']), product(h, ['health', '--json'])])
  const sections = (parse(healthRan.stdout)?.sections ?? []) as Array<{ checks?: Row[] }>
  const rows = sections.flatMap(s => s.checks ?? [])
  const row = (id: string): Row | undefined => rows.find(r => r.id === id)
  const named = /^session model (.+?) (?:·|=) /.exec(row('model')?.evidence ?? '')?.[1]
  return { authRan, auth: parse(authRan.stdout), healthRan, row, named }
}

async function sessionModel(h: Home): Promise<{ model: string | undefined; ran: Ran }> {
  const ran = await product(h, ['run', '--format', 'rows', 'Say hi'], 240_000)
  for (const line of ran.stdout.split('\n')) {
    const parsed = parse(line)
    if (parsed?.type === 'session') return { model: typeof parsed.model === 'string' ? parsed.model : undefined, ran }
  }
  return { model: undefined, ran }
}

const catalogue = [FIRST_ROW, 'fixture-lab/second-row'].map(id => ({
  id,
  name: id,
  context_length: 131072,
  pricing: { prompt: '0', completion: '0' },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['tools'],
}))
const hits: string[] = []
const fixture: Server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  hits.push(`${req.method} ${path}`)
  req.resume()
  if (req.method === 'GET' && path === '/api/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: catalogue }))
    return
  }
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'fixture: no such key', code: 401 } }))
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const fixtureBase = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`

try {
  section('§1 a home whose only credential is an OpenRouter key and no model chosen: the run, auth status and health name one route')
  const served = home('run', { OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY, MERCURY_OPENROUTER_API_BASE: `${fixtureBase}/api/v1` })
  const run = await sessionModel(served)
  check('the run reads its default from the catalogue the fixture serves', hits.includes('GET /api/v1/models'), hits.join(' | '))
  check('the run sends the turn to the catalogue default on OpenRouter', run.model === `openrouter/${FIRST_ROW}`, `${run.model} · ${run.ran.stderr.slice(-200)}`)

  const offline = await surfaces(home('offline', { OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY }))
  check('auth status answered JSON', offline.auth !== null, offline.authRan.stdout.slice(0, 160))
  check('auth status names OpenRouter, the route the run used', offline.auth?.routedProvider === 'openrouter', `routedProvider=${String(offline.auth?.routedProvider)}`)
  check('…and exits 0: the routed family holds its credential', offline.authRan.status === 0, `status=${offline.authRan.status}`)
  check('…while the Anthropic fields keep their meaning (loggedIn false)', offline.auth?.loggedIn === false)
  const anthropic = offline.row('auth-anthropic')
  check('the health Anthropic row names the same route', anthropic?.status === 'info' && (anthropic.evidence ?? '').includes('session routes to openrouter'), JSON.stringify(anthropic))
  const frontier = offline.row('frontier')
  check('the Model pins row names no Anthropic model for a session that routes to OpenRouter', offline.named !== undefined && !offline.named.startsWith('claude-'), JSON.stringify(offline.row('model')))
  check('the Model pins row says what the Default model row says of the same session', offline.named !== undefined && (frontier?.evidence ?? '').startsWith(offline.named), `${JSON.stringify(offline.row('model'))} vs ${JSON.stringify(frontier)}`)

  section('§2 unchanged: an Anthropic credential in the home keeps the Anthropic route and its model')
  for (const [label, extra] of [
    ['an Anthropic key alone', { ANTHROPIC_API_KEY: 'fixture-anthropic-key' }],
    ['an Anthropic key beside an OpenRouter key', { ANTHROPIC_API_KEY: 'fixture-anthropic-key', OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY }],
  ] as const) {
    const s = await surfaces(home('anthropic', extra))
    check(`${label}: auth status routes to anthropic, signed in, exit 0`, s.auth?.routedProvider === 'anthropic' && s.auth.loggedIn === true && s.authRan.status === 0, `${String(s.auth?.routedProvider)} loggedIn=${String(s.auth?.loggedIn)} exit=${s.authRan.status}`)
    check(`${label}: Model pins names the Anthropic default`, /^session model claude-\S+ · no settings pin$/.test(s.row('model')?.evidence ?? ''), JSON.stringify(s.row('model')))
  }

  section('§3 unchanged: a model the user chose is routed and named exactly as before')
  {
    const s = await surfaces(home('chosen-openrouter', { OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY, MERCURY_MODEL: 'openrouter/qwen/qwen3-coder' }))
    check('MERCURY_MODEL on OpenRouter: auth status routes to openrouter, exit 0', s.auth?.routedProvider === 'openrouter' && s.authRan.status === 0, `${String(s.auth?.routedProvider)} exit=${s.authRan.status}`)
    check('…and Model pins names that model', s.row('model')?.evidence === 'session model openrouter/qwen/qwen3-coder · no settings pin', JSON.stringify(s.row('model')))
  }
  {
    const s = await surfaces(home('chosen-anthropic', { OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY, MERCURY_MODEL: 'claude-sonnet-5-5' }))
    check('MERCURY_MODEL on Anthropic without an Anthropic credential: auth status routes to anthropic and exits 1', s.auth?.routedProvider === 'anthropic' && s.authRan.status === 1, `${String(s.auth?.routedProvider)} exit=${s.authRan.status}`)
    check('…and Model pins names that model', s.row('model')?.evidence === 'session model claude-sonnet-5-5 · no settings pin', JSON.stringify(s.row('model')))
  }
  {
    const s = await surfaces(home('pinned', { OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY }, { engine: { model: 'openrouter/qwen/qwen3-coder' } }))
    check('a settings pin on OpenRouter: auth status routes to openrouter, exit 0', s.auth?.routedProvider === 'openrouter' && s.authRan.status === 0, `${String(s.auth?.routedProvider)} exit=${s.authRan.status}`)
    check('…and Model pins reads the pin as the session model', s.row('model')?.evidence === 'session model openrouter/qwen/qwen3-coder = settings pin', JSON.stringify(s.row('model')))
  }

  section('§4 unchanged: no credential anywhere, and a family whose default resolves without the catalogue')
  {
    const s = await surfaces(home('keyless'))
    check('no credential: auth status routes to anthropic and exits 1', s.auth?.routedProvider === 'anthropic' && s.authRan.status === 1, `${String(s.auth?.routedProvider)} exit=${s.authRan.status}`)
    check('…and Model pins names the Anthropic default', /^session model claude-\S+ · no settings pin$/.test(s.row('model')?.evidence ?? ''), JSON.stringify(s.row('model')))
  }
  {
    const s = await surfaces(home('deepseek', { DEEPSEEK_API_KEY: 'fixture-deepseek-key' }))
    check('a DeepSeek key alone: auth status routes to deepseek, exit 0', s.auth?.routedProvider === 'deepseek' && s.authRan.status === 0, `${String(s.auth?.routedProvider)} exit=${s.authRan.status}`)
    check('…and Model pins names its DeepSeek model', s.named?.startsWith('deepseek') === true, JSON.stringify(s.row('model')))
  }
} finally {
  await new Promise<void>(resolve => {
    fixture.closeAllConnections?.()
    fixture.close(() => resolve())
  })
  try {
    rmSync(world, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
  }
}

console.log(`\n${failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAILURE(S)`} — prove-default-route-surfaces-agree`)
process.exit(failures === 0 ? 0 : 1)
