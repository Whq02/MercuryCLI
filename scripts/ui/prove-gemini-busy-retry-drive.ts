#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
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
const SIZES_ARG = arg('--sizes')
const SIZES = (SIZES_ARG ?? '120x40,80x21').split(',').map(size => size.split('x').map(Number) as [number, number])
const WORLDS = (arg('--worlds') ?? 'spent,recover,stop').split(',')
const ROADS = (arg('--roads') ?? 'gemini,openai,deepseek').split(',')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const node = existsSync(vendoredNode) ? vendoredNode : 'node'

const WORLD_ROOT = existsSync('/private/tmp/mw') ? '/private/tmp/mw' : realpathSync(tmpdir())
mkdirSync(WORLD_ROOT, { recursive: true })
const SCRATCH = realpathSync(mkdtempSync(join(WORLD_ROOT, 'gemini-busy-')))
const work = join(SCRATCH, 'work')
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'README.md'), '# busy retry fixture\n')
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'import-home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MERCURY_MODEL', 'MERCURY_BUSY_RETRY_SCALE']) {
  delete process.env[k]
}
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

const GEMINI_MODEL = 'gemini-3.5-flash'
const WARM_PROMPT = 'warm up'
const WARM_ANSWER = 'ROAD-WARM-ANSWER'
const PROMPT = 'say the word'
const ANSWER = 'ROAD-BUSY-ANSWER'
const ACCESS = 'ya29.fixture-secret-access-busy'
const REFRESH = '1//fixture-secret-refresh-busy'
type Seen = { n: number; atMs: number; status: number }
const requests: Seen[] = []
let refusalsBeforeAnswer = Infinity
let worldRequests = 0
const SLOW_ANSWER_MS = 1500
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
type Road = {
  name: string
  provider: string
  model: string
  tag: string
  status: number
  code: string
  busyWords: string
  busyFragment: string
  env: (base: string) => Record<string, string>
  list: (url: string) => unknown | undefined
  modelRoad: (url: string) => boolean
  refuse: (res: ServerResponse) => void
  answer: (res: ServerResponse, text: string) => void
}
const roads: Road[] = [
  {
    name: 'gemini',
    provider: 'Gemini',
    model: GEMINI_MODEL,
    tag: '[compat:gemini]',
    status: 503,
    code: 'api-UNAVAILABLE',
    busyWords: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
    busyFragment: 'high demand',
    env: base => ({ MERCURY_GEMINI_API_BASE: `${base}/v1beta`, MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/google/authorize`, MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/google/token` }),
    list: url => (url === '/v1beta/models' ? { models: [{ name: `models/${GEMINI_MODEL}`, displayName: 'Gemini fixture', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 100000, outputTokenLimit: 8192 }] } : undefined),
    modelRoad: url => url === `/v1beta/models/${GEMINI_MODEL}:streamGenerateContent`,
    refuse: res => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 503, message: roads[0]!.busyWords, status: 'UNAVAILABLE' } }))
    },
    answer: (res, text) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] } }] }))
      res.end(sse({ candidates: [{ index: 0, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 9, totalTokenCount: 30 } }))
    },
  },
  {
    name: 'openai',
    provider: 'OpenAI',
    model: 'gpt-5.6-sol',
    tag: '[openai]',
    status: 503,
    code: 'openai-server_error',
    busyWords: 'The requested model is temporarily overloaded.',
    busyFragment: 'temporarily overloaded',
    env: base => ({ OPENAI_API_KEY: 'fixture-openai-key', MERCURY_OPENAI_API_BASE: `${base}/openai/v1` }),
    list: url => (url === '/openai/v1/models' ? { data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] } : undefined),
    modelRoad: url => url === '/openai/v1/responses',
    refuse: res => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'server_error', message: roads[1]!.busyWords } }))
    },
    answer: (res, text) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ type: 'response.created', response: { id: 'resp_fixture' } }))
      res.write(sse({ type: 'response.output_text.delta', delta: text }))
      res.write(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }))
      res.end(sse({ type: 'response.completed', response: { id: 'resp_fixture', usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } }))
    },
  },
  {
    name: 'deepseek',
    provider: 'DeepSeek',
    model: 'deepseek-chat',
    tag: '[compat:deepseek]',
    status: 503,
    code: 'http-503',
    busyWords: 'The server is overloaded due to high traffic. Please retry your request after a brief wait.',
    busyFragment: 'overloaded due to high traffic',
    env: base => ({ DEEPSEEK_API_KEY: 'fixture-deepseek-key', MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek` }),
    list: url => (url === '/deepseek/models' ? { object: 'list', data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }] } : undefined),
    modelRoad: url => url === '/deepseek/chat/completions',
    refuse: res => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: roads[2]!.busyWords } }))
    },
    answer: (res, text) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ choices: [{ delta: { role: 'assistant' } }] }))
      res.write(sse({ choices: [{ delta: { content: text } }] }))
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }))
      res.end('data: [DONE]\n\n')
    },
  },
]
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'POST' && url === '/google/token') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }))
      return
    }
    for (const road of roads) {
      const listed = req.method === 'GET' ? road.list(url) : undefined
      if (listed !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(listed))
        return
      }
      if (req.method === 'POST' && road.modelRoad(url)) {
        const n = requests.length + 1
        const nthInWorld = ++worldRequests
        const warm = nthInWorld === 1
        const refused = !warm && nthInWorld - 1 <= refusalsBeforeAnswer
        requests.push({ n, atMs: Date.now(), status: refused ? road.status : 200 })
        const answer = (): void => (refused ? road.refuse(res) : road.answer(res, warm ? WARM_ANSWER : ANSWER))
        if (nthInWorld > 2) setTimeout(answer, SLOW_ANSWER_MS)
        else answer()
        return
      }
    }
    res.writeHead(404, { 'content-type': 'application/json' })
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

function seedHome(name: string, road: Road): string {
  const home = join(SCRATCH, name)
  mkdirSync(home, { recursive: true })
  seedFirstRun(home, [work])
  writeFileSync(join(home, 'settings.json'), '{}\n')
  if (road.name === 'gemini') {
    const authFile = join(home, '.gemini-auth.json')
    writeFileSync(
      authFile,
      JSON.stringify({
        version: 1,
        preferredSource: 'oauth',
        client: { clientId: 'fixture-client', clientSecret: 'fixture-client-secret' },
        tokens: {
          accessToken: ACCESS,
          refreshToken: REFRESH,
          accessTokenExpiresAtMs: Date.now() + 3600000,
          scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever',
        },
      }, null, 2) + '\n',
      { mode: 0o600 },
    )
    chmodSync(authFile, 0o600)
    recordSignIn('gemini', 'oauth', { home })
  }
  return home
}

function childEnv(home: string, scale: string, road: Road): NodeJS.ProcessEnv {
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
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_UPDATE_NOTICE: '0',
    MERCURY_OPERATOR: 'sam',
    DEBUG: '1',
    MERCURY_MODEL: road.model,
    MERCURY_BUSY_RETRY_SCALE: scale,
    MERCURY_GEMINI_API_BASE: 'http://127.0.0.1:9/gemini',
    MERCURY_GEMINI_OAUTH_AUTH_BASE: 'http://127.0.0.1:9/google/authorize',
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: 'http://127.0.0.1:9/google/token',
    MERCURY_OPENAI_API_BASE: 'http://127.0.0.1:9/openai',
    MERCURY_OPENAI_AUTH_BASE: 'http://127.0.0.1:9',
    MERCURY_OPENAI_CHATGPT_BASE: 'http://127.0.0.1:9/chatgpt',
    MERCURY_DEEPSEEK_API_BASE: 'http://127.0.0.1:9/deepseek',
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    BROWSER: '/usr/bin/true',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    COLORTERM: 'truecolor',
    ...road.env(base),
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

type Send = Record<string, unknown>
type Cell = { c?: string; fg?: string; bold?: boolean }
type Grid = Cell[][]
type Mark = { label: string; atMs: number; grid: Grid }
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
const rowCells = (grid: Grid, needle: string): Cell[] | null => {
  for (const row of grid) {
    const text = row.map(c => c.c ?? ' ').join('')
    const at = text.indexOf(needle)
    if (at >= 0) return row.slice(at, at + needle.length)
  }
  return null
}
async function capture(tag: string, home: string, scale: string, road: Road, cols: number, rows: number, sends: Send[], readyText: string): Promise<{ marks: Record<string, string>; grids: Record<string, Grid>; markMs: Record<string, number>; final: string; sends: number; receipts: number; spawnedAtMs: number }> {
  const dir = join(SCRATCH, `capture-${tag}`)
  mkdirSync(dir, { recursive: true })
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: [node, DIST], cwd: work, cols, rows, total: 600, sends, readyText: [readyText], stableTicks: 4, out: outPath }))
  const spawnedAtMs = Date.now()
  const refusal = await new Promise<string | null>((resolveRun, rejectRun) => {
    execFile(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { env: childEnv(home, scale, road), timeout: vshotBudgetMs(300_000) }, (error, _stdout, stderr) => {
      if (error && !existsSync(outPath)) rejectRun(new Error(`${String(error)}\n${stderr}`))
      else resolveRun(error ? String(stderr).split('\n').find(line => line.includes('[vshot]')) ?? String(error) : null)
    })
  })
  if (refusal !== null) console.log(`  (the capture ended refused: ${refusal.slice(0, 160)})`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Mark[] }
  const marks: Record<string, string> = {}
  const grids: Record<string, Grid> = {}
  const markMs: Record<string, number> = {}
  for (const m of payload.marks ?? []) {
    marks[m.label] = gridText(m.grid)
    grids[m.label] = m.grid
    markMs[m.label] = m.atMs
  }
  const final = gridText(payload.grid)
  if (FRAMES !== undefined) {
    for (const [label, text] of Object.entries(marks)) writeFileSync(join(FRAMES, `${tag}-${label}.txt`), text + '\n')
    writeFileSync(join(FRAMES, `${tag}-final.txt`), final + '\n')
  }
  return { marks, grids, markMs, final, sends: sends.length, receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0, spawnedAtMs }
}

const FACE: Send = { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3 }
const linesWith = (frame: string, needle: string): string[] => frame.split('\n').filter(line => line.includes(needle)).map(line => line.trim())
const count = (frame: string, needle: string): number => frame.split(needle).length - 1
const retryLineOf = (frame: string): { seconds: number; attempt: number; of: number } | null => {
  const m = /Retrying in (\d+) seconds?… \(attempt (\d+)\/(\d+)\)/.exec(frame) ?? /Retrying now… \(attempt (\d+)\/(\d+)\)/.exec(frame)
  if (!m) return null
  return m.length === 4 ? { seconds: Number(m[1]), attempt: Number(m[2]), of: Number(m[3]) } : { seconds: 0, attempt: Number(m[1]), of: Number(m[2]) }
}
const debugLinesOf = (home: string): string[] => {
  const debugDir = join(home, 'debug')
  return existsSync(debugDir) ? readdirSync(debugDir).flatMap(name => readFileSync(join(debugDir, name), 'utf8').split('\n')) : []
}
const DEBUG_FLUSH_MS = 1200
async function settledDebugLines(home: string): Promise<string[]> {
  let lines = debugLinesOf(home)
  for (let round = 0; round < 5; round++) {
    await new Promise(resolveWait => setTimeout(resolveWait, DEBUG_FLUSH_MS))
    const again = debugLinesOf(home)
    if (again.length === lines.length) return again
    lines = again
  }
  return lines
}
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sizesFor = (road: Road): Array<[number, number]> => (SIZES_ARG !== undefined || road.name === 'gemini' ? SIZES : [SIZES[0]!])

console.log("a provider's 'try again later' refusal is retried quietly on a growing wait on every road; the retry line only past the quiet window, the red line only when the ladder is spent, one calm line naming the provider on a recovery, and the operator's stop ends a wait at once — the built cockpit in a PTY")
console.log(`  bundle ${DIST}\n  fixture ${base}\n  scratch ${SCRATCH}`)

try {
  for (const road of roads.filter(candidate => ROADS.includes(candidate.name))) {
    const RED_LINE = `API Error: ${road.provider} stream failed (${road.code})`
    const CALM_LINE = `${road.provider} was busy · answered after`
    for (const [cols, rows] of sizesFor(road)) {
      const cockpit = cols >= 100 && rows >= 26
      const settled = cockpit ? '← back' : '1 session on'
      const idle = cockpit ? 'ready · ' : '1 session on'
      const boot: Send[] = [
        FACE,
        { data: '', atTick: 999, awaitText: settled, requireAwait: true, minTick: 4, awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'boot' },
        { data: `${WARM_PROMPT}\r`, atTick: 999, awaitText: settled, requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
        { data: '', atTick: 999, awaitText: WARM_ANSWER, requireAwait: true, minTick: 2, awaitSettleTicks: 6, awaitStableTicks: 4, mark: 'warm' },
        { data: `${PROMPT}\r`, atTick: 999, awaitText: idle, requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
      ]
      for (const world of WORLDS) {
        const tag = `${road.name}-${cols}x${rows}-${world}`
        const home = seedHome(`home-${tag}`, road)
        console.log(`\n── ${tag}${cockpit ? '' : ' (the compact layout)'}`)
        const before = requests.length
        worldRequests = 0
        let sends: Send[]
        let scale: string
        let readyText: string
        if (world === 'spent') {
          refusalsBeforeAnswer = Infinity
          scale = '0.25'
          readyText = 'API Error'
          sends = [
            ...boot,
            { data: '', afterPrevTicks: 8, mark: 'quiet' },
            { data: '', atTick: 999, awaitText: 'Retrying', requireAwait: true, minTick: 2, awaitSettleTicks: 1, mark: 'retry' },
            { data: '', atTick: 999, awaitText: 'API Error', requireAwait: true, minTick: 2, awaitSettleTicks: 6, awaitStableTicks: 3, mark: 'spent' },
          ]
        } else if (world === 'recover') {
          refusalsBeforeAnswer = 2
          scale = '0.25'
          readyText = ANSWER
          sends = [
            ...boot,
            { data: '', afterPrevTicks: 3, mark: 'quiet' },
            { data: '', atTick: 999, awaitText: ANSWER, requireAwait: true, minTick: 2, awaitSettleTicks: 8, awaitStableTicks: 4, mark: 'landed' },
            { data: '\x0f', atTick: 999, awaitText: ANSWER, requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
            { data: '', atTick: 999, awaitText: `HTTP ${road.status}`, requireAwait: true, minTick: 3, awaitSettleTicks: 6, awaitStableTicks: 3, mark: 'expanded' },
          ]
        } else {
          refusalsBeforeAnswer = Infinity
          scale = '8'
          readyText = 'nterrupted'
          sends = [
            ...boot,
            { data: '\x1b', afterPrevTicks: 8, mark: 'stopping' },
            { data: '', atTick: 999, awaitText: 'nterrupted', requireAwait: true, minTick: 2, awaitSettleTicks: 10, awaitStableTicks: 4, mark: 'stopped' },
          ]
        }
        let shot: Awaited<ReturnType<typeof capture>>
        try {
          shot = await capture(tag, home, scale, road, cols, rows, sends, readyText)
        } catch (err) {
          check(`${tag}: the capture ran`, false, err instanceof Error ? err.message.slice(0, 400) : String(err))
          continue
        }
        const seenAll = requests.slice(before)
        console.log(`  requests: ${JSON.stringify(seenAll.map(r => ({ n: r.n - before, status: r.status, atMs: r.atMs - shot.spawnedAtMs })))}`)
        check(`${tag}: every send became due`, shot.receipts === shot.sends, `${shot.receipts}/${shot.sends}`)
        check(`${tag}: the warm-up turn answered at once and painted`, seenAll[0]?.status === 200 && (shot.marks.warm ?? '').includes(WARM_ANSWER), `${seenAll[0]?.status}`)
        const seen = seenAll.slice(1)
        const debugLines = await settledDebugLines(home)
        const attemptLines = debugLines.filter(line => new RegExp(`${escape(road.tag)} busy refusal .* — retry \\d+ of \\d+ after `).test(line))
        if (world === 'spent') {
          const quiet = shot.marks.quiet ?? ''
          const quietAt = shot.spawnedAtMs + (shot.markMs.quiet ?? 0)
          check(`${tag}: the fixture had refused at least once before the quiet frame`, seen.some(r => r.status === road.status && r.atMs <= quietAt), `first refusal ${seen[0] ? seen[0].atMs - shot.spawnedAtMs : 'none'} ms, quiet frame ${shot.markMs.quiet} ms after the spawn`)
          check(`${tag}: nothing is painted inside the quiet window (no retry line, no red line, no ${road.status} words)`, !quiet.includes('Retrying') && !quiet.includes('API Error') && !quiet.includes(String(road.status)) && !quiet.includes(road.busyFragment), linesWith(quiet, 'Retry').concat(linesWith(quiet, 'API Error'), linesWith(quiet, road.busyFragment)).join(' | '))
          const retry = shot.marks.retry ?? ''
          const line = retryLineOf(retry)
          check(`${tag}: past the quiet window the retry line carries true seconds and true counts`, line !== null && line.seconds >= 1 && line.of >= 2 && line.attempt >= 2 && line.attempt <= line.of, line === null ? linesWith(retry, 'Retry').join(' | ') || '(no retry line)' : JSON.stringify(line))
          check(`${tag}: the retry line stands beside the provider's own words`, retry.includes(road.busyFragment), linesWith(retry, 'Error').join(' | '))
          const spent = shot.marks.spent ?? ''
          check(`${tag}: the spent ladder ends the turn with the red line, once, naming ${road.provider}`, count(spent, 'API Error') === 1 && spent.includes(`${road.provider} stayed busy`) && spent.includes(road.code), linesWith(spent, 'API Error').join(' | ') || '(no red line)')
          check(`${tag}: the retry line is gone once the red line stands`, !spent.includes('Retrying'), linesWith(spent, 'Retrying').join(' | '))
          check(`${tag}: seven requests reached the fixture, every one refused`, seen.length === 7 && seen.every(r => r.status === road.status), `${seen.length} requests`)
          check(`${tag}: the debug log carries every retry with its wait`, attemptLines.length === 6, `${attemptLines.length} attempt lines among ${debugLines.length} debug lines`)
        } else if (world === 'recover') {
          const quiet = shot.marks.quiet ?? ''
          check(`${tag}: nothing is painted while the retries run (no retry line, no red line)`, !quiet.includes('Retrying') && !quiet.includes('API Error'), linesWith(quiet, 'Retry').concat(linesWith(quiet, 'API Error')).join(' | '))
          const landed = shot.marks.landed ?? ''
          check(`${tag}: the answer landed`, landed.includes(ANSWER), landed.slice(-300))
          check(`${tag}: the recovery paints the one calm line naming ${road.provider}`, count(landed, CALM_LINE) === 1 && /answered after \d+ retries \(\d+ s\)/.test(landed), linesWith(landed, 'busy').join(' | ') || '(no calm line)')
          check(`${tag}: no red line and no retry line in the default view`, !landed.includes('API Error') && !landed.includes('Retrying') && !landed.includes(RED_LINE), linesWith(landed, 'API Error').concat(linesWith(landed, 'Retrying')).join(' | '))
          check(`${tag}: no warning triangle names the refusal`, !landed.split('\n').some(line => line.includes('▲') && new RegExp(`busy|${road.status}|${escape(road.busyFragment)}`, 'i').test(line)), linesWith(landed, '▲').join(' | '))
          check(`${tag}: three requests reached the fixture, the third answered`, seen.length === 3 && seen[2]?.status === 200, JSON.stringify(seen.map(r => r.status)))
          const grid = shot.grids.landed
          const cells = grid ? rowCells(grid, CALM_LINE) : null
          if (cells) {
            const wordCell = cells[0]
            check(`${tag}: the calm line wears one colour, no red`, cells.every(c => c.fg === wordCell?.fg), Array.from(new Set(cells.map(c => c.fg))).join(','))
            const countRow = grid!.find(row => row.map(c => c.c ?? ' ').join('').includes(CALM_LINE))
            const rowText = countRow ? countRow.map(c => c.c ?? ' ').join('') : ''
            const countAt = rowText.indexOf('answered after ') + 'answered after '.length
            const countCell = countRow?.[countAt]
            check(`${tag}: the count is bold and the words are not`, countCell?.bold === true && wordCell?.bold !== true, `count ${JSON.stringify(countCell)} word ${JSON.stringify(wordCell)}`)
          }
          const expanded = shot.marks.expanded ?? ''
          const expandedWords = expanded.split('\n').map(line => { const first = line.indexOf('│'); const last = line.lastIndexOf('│'); return first >= 0 && last > first ? line.slice(first + 1, last) : line }).join(' ').replace(/\s+/g, ' ')
          check(`${tag}: the expansion names the status, the provider's words and the waits`, expandedWords.includes(`HTTP ${road.status}`) && expandedWords.includes(road.busyFragment) && /retried after \d+ s/.test(expandedWords) && /request was answered/.test(expandedWords), linesWith(expanded, String(road.status)).concat(linesWith(expanded, 'retried')).join(' | '))
          check(`${tag}: the debug log carries both retries`, attemptLines.length === 2, `${attemptLines.length} attempt lines among ${debugLines.length} debug lines`)
        } else {
          const stopping = shot.marks.stopping ?? ''
          check(`${tag}: the stop landed inside a quiet wait (one refusal, nothing painted)`, seen.length >= 1 && !stopping.includes('Retrying') && !stopping.includes('API Error'), `${seen.length} requests; ${linesWith(stopping, 'Retry').concat(linesWith(stopping, 'API Error')).join(' | ')}`)
          const stopped = shot.marks.stopped ?? ''
          check(`${tag}: the turn ended as interrupted, with no red line`, /nterrupted/.test(stopped) && !stopped.includes('API Error'), linesWith(stopped, 'API Error').join(' | ') || stopped.slice(-200))
          const stopAt = shot.spawnedAtMs + (shot.markMs.stopping ?? 0)
          check(`${tag}: no request left after the stop`, seen.every(r => r.atMs <= stopAt + 400), JSON.stringify(seen.map(r => r.atMs - stopAt)))
          check(`${tag}: exactly one request reached the fixture`, seen.length === 1, `${seen.length} requests`)
        }
      }
    }
  }
} finally {
  server.close()
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log(`\n${failures === 0 ? 'prove-gemini-busy-retry-drive: ALL LAWS HOLD' : `prove-gemini-busy-retry-drive: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
