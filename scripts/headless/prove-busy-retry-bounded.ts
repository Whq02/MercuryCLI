#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { BUSY_RETRY_QUIET_MS, BUSY_RETRY_RUNGS_MS } = await import('../../src/services/providers/busyRetry.ts')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(import.meta.dir, '../..')
const DIST = resolve(arg('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
const ROADS = (arg('--roads') ?? 'gemini,openai,deepseek').split(',')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
if (!existsSync(DIST)) {
  check('dist/mercury.mjs exists (build first — this prover drives the artifact)', false)
  console.log('\nprove-busy-retry-bounded: 1 FAILURE(S)')
  process.exit(1)
}
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const node = existsSync(vendoredNode) ? vendoredNode : 'node'
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'busy-bounded-')))
const work = join(SCRATCH, 'work')
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'README.md'), '# busy retry fixture\n')
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MERCURY_MODEL', 'MERCURY_BUSY_RETRY_SCALE', 'MERCURY_HEADLESS_IDLE_MINUTES']) delete process.env[k]

const GEMINI_MODEL = 'gemini-3.5-flash'
const PROMPT = 'say the word'
const ANSWER = 'BUSY-ROAD-ANSWER'
const BUSY_WORDS: Record<string, string> = {
  gemini: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
  openai: 'The requested model is temporarily overloaded.',
  deepseek: 'The server is overloaded due to high traffic. Please retry your request after a brief wait.',
}
const ACCESS = 'ya29.fixture-secret-access-bounded'
const ANSWER_DELAY_MS = 200
const IDLE_LIMIT_MINUTES = 0.05
const BOOT_ALLOWANCE_MS = 30_000
type Seen = { atMs: number; status: number }
let requests: Seen[] = []
let refusalsBeforeAnswer = Infinity
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
type Road = {
  name: string
  provider: string
  model: string
  tag: string
  spentLine: RegExp
  env: (base: string) => Record<string, string>
  list: (url: string) => unknown | undefined
  modelRoad: (url: string) => boolean
  refuse: (res: ServerResponse) => void
  answer: (res: ServerResponse) => void
}
const roads: Road[] = [
  {
    name: 'gemini',
    provider: 'Gemini',
    model: GEMINI_MODEL,
    tag: '[compat:gemini]',
    spentLine: /^API Error: Gemini stayed busy through 6 retries over \d+ s — Gemini stream failed \(api-UNAVAILABLE\) — /,
    env: base => ({ MERCURY_GEMINI_API_BASE: `${base}/v1beta`, MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/google/authorize`, MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/google/token` }),
    list: url => (url === '/v1beta/models' ? { models: [{ name: `models/${GEMINI_MODEL}`, displayName: 'Gemini fixture', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 100000, outputTokenLimit: 8192 }] } : undefined),
    modelRoad: url => url === `/v1beta/models/${GEMINI_MODEL}:streamGenerateContent`,
    refuse: res => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 503, message: BUSY_WORDS.gemini, status: 'UNAVAILABLE' } }))
    },
    answer: res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ANSWER }] } }] }))
      res.end(sse({ candidates: [{ index: 0, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 9, totalTokenCount: 30 } }))
    },
  },
  {
    name: 'openai',
    provider: 'OpenAI',
    model: 'gpt-5.6-sol',
    tag: '[openai]',
    spentLine: /^API Error: OpenAI stayed busy through 6 retries over \d+ s — OpenAI stream failed \(openai-server_error\) — /,
    env: base => ({ OPENAI_API_KEY: 'fixture-openai-key', MERCURY_OPENAI_API_BASE: `${base}/openai/v1` }),
    list: url => (url === '/openai/v1/models' ? { data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] } : undefined),
    modelRoad: url => url === '/openai/v1/responses',
    refuse: res => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'server_error', message: BUSY_WORDS.openai } }))
    },
    answer: res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ type: 'response.created', response: { id: 'resp_fixture' } }))
      res.write(sse({ type: 'response.output_text.delta', delta: ANSWER }))
      res.write(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ANSWER }] } }))
      res.end(sse({ type: 'response.completed', response: { id: 'resp_fixture', usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } }))
    },
  },
  {
    name: 'deepseek',
    provider: 'DeepSeek',
    model: 'deepseek-chat',
    tag: '[compat:deepseek]',
    spentLine: /^API Error: DeepSeek stayed busy through 6 retries over \d+ s — DeepSeek stream failed \(http-503\) — /,
    env: base => ({ DEEPSEEK_API_KEY: 'fixture-deepseek-key', MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek` }),
    list: url => (url === '/deepseek/models' ? { object: 'list', data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }] } : undefined),
    modelRoad: url => url === '/deepseek/chat/completions',
    refuse: res => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: BUSY_WORDS.deepseek } }))
    },
    answer: res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ choices: [{ delta: { role: 'assistant' } }] }))
      res.write(sse({ choices: [{ delta: { content: ANSWER } }] }))
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
        const nth = requests.length + 1
        const refused = nth <= refusalsBeforeAnswer
        requests.push({ atMs: Date.now(), status: refused ? 503 : 200 })
        const answer = (): void => (refused ? road.refuse(res) : road.answer(res))
        if (nth > 1) setTimeout(answer, ANSWER_DELAY_MS)
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
    writeFileSync(authFile, JSON.stringify({
      version: 1,
      preferredSource: 'oauth',
      client: { clientId: 'fixture-client', clientSecret: 'fixture-client-secret' },
      tokens: { accessToken: ACCESS, refreshToken: '1//fixture-secret-refresh-bounded', accessTokenExpiresAtMs: Date.now() + 3600000, scope: 'https://www.googleapis.com/auth/cloud-platform' },
    }) + '\n', { mode: 0o600 })
    chmodSync(authFile, 0o600)
  }
  return home
}
function childEnv(home: string, scale: string, road: Road): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_UPDATE_NOTICE: '0',
    MERCURY_MODEL: road.model,
    MERCURY_BUSY_RETRY_SCALE: scale,
    MERCURY_HEADLESS_IDLE_MINUTES: String(IDLE_LIMIT_MINUTES),
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
    DEBUG: '1',
    ...road.env(base),
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}
type Frame = Record<string, unknown>
type Run = { code: number | null; signal: string | null; frames: Frame[]; stdout: string; stderr: string; elapsedMs: number; endedBy: 'child' | 'deadline' }
async function run(home: string, scale: number, road: Road): Promise<Run> {
  const ladderMs = BUSY_RETRY_RUNGS_MS.reduce((sum, ms) => sum + ms, 0) * scale
  const deadlineMs = BOOT_ALLOWANCE_MS + ladderMs + (BUSY_RETRY_RUNGS_MS.length + 1) * ANSWER_DELAY_MS + IDLE_LIMIT_MINUTES * 60_000 * 2
  const child = spawn(node, [DIST, '-p', PROMPT, '--model', road.model, '--output-format', 'stream-json'], { cwd: work, env: childEnv(home, String(scale), road), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const startedAt = Date.now()
  let endedBy: Run['endedBy'] = 'child'
  const killer = setTimeout(() => { endedBy = 'deadline'; child.kill('SIGKILL') }, deadlineMs)
  const exit = await new Promise<{ code: number | null; signal: string | null }>(resolveRun => child.once('exit', (code, signal) => resolveRun({ code, signal })))
  clearTimeout(killer)
  const frames = stdout.split('\n').filter(line => line.trim() !== '').map(line => { try { return JSON.parse(line) as Frame } catch { return null } }).filter((frame): frame is Frame => frame !== null)
  return { ...exit, frames, stdout, stderr, elapsedMs: Date.now() - startedAt, endedBy }
}
function transcriptRecords(home: string): Array<Record<string, unknown>> {
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return []
  const files: Array<{ path: string; mtime: number }> = []
  for (const dir of readdirSync(projects)) {
    const full = join(projects, dir)
    if (!statSync(full).isDirectory()) continue
    for (const name of readdirSync(full)) if (name.endsWith('.jsonl')) files.push({ path: join(full, name), mtime: statSync(join(full, name)).mtimeMs })
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const newest = files[0]
  if (newest === undefined) return []
  return readFileSync(newest.path, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } }).filter((record): record is Record<string, unknown> => record !== null)
}
const noticesOf = (records: Array<Record<string, unknown>>, kind: string) => records.filter(record => { const payload = record.payload as { kind?: string; noticeKind?: string } | undefined; return payload?.kind === 'notice' && payload.noticeKind === kind })
const debugLinesOf = (home: string): string[] => {
  const debugDir = join(home, 'debug')
  return existsSync(debugDir) ? readdirSync(debugDir).filter(name => name.endsWith('.txt')).flatMap(name => readFileSync(join(debugDir, name), 'utf8').split('\n')) : []
}
const textOf = (frames: Frame[]): string => frames.map(frame => JSON.stringify(frame)).join('\n')
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

console.log("a headless run against a provider that stays busy ends by the product's own ladder, inside its budget, with the red line — never by a hang, never by the unattended-turn watchdog; a quiet recovery leaves one calm row on the record and no retry frame — on the Gemini, OpenAI and DeepSeek roads")
console.log(`  bundle ${DIST}\n  fixture ${base}\n  scratch ${SCRATCH}`)
try {
  for (const road of roads.filter(candidate => ROADS.includes(candidate.name))) {
    console.log(`\n── the ${road.provider} road`)
    {
      const scale = 0.02
      refusalsBeforeAnswer = Infinity
      requests = []
      const home = seedHome(`home-${road.name}-spent`, road)
      const spent = await run(home, scale, road)
      const retryFrames = spent.frames.filter(frame => frame.type === 'system' && frame.subtype === 'api_retry')
      const debugLines = debugLinesOf(home)
      const quietLines = debugLines.filter(line => new RegExp(`${escape(road.tag)} busy refusal .* — retry \\d+ of 6 after .* inside the quiet window`).test(line))
      const loudLines = debugLines.filter(line => new RegExp(`${escape(road.tag)} busy refusal .* — retry \\d+ of 6 after `).test(line) && !line.includes('inside the quiet window'))
      const records = transcriptRecords(home)
      const out = textOf(spent.frames)
      console.log(`  spent: exit ${spent.code}/${spent.signal} by the ${spent.endedBy} after ${spent.elapsedMs} ms; ${requests.length} requests; ${retryFrames.length} api_retry frames; ${quietLines.length} quiet retries, ${loudLines.length} loud`)
      check(`${road.name}: the run ended by itself, inside the boot allowance plus the ladder budget and the fixture latencies`, spent.endedBy === 'child' && spent.code !== null, `ended by the ${spent.endedBy}, code ${spent.code}, signal ${spent.signal}`)
      check(`${road.name}: seven requests reached the fixture and every one was refused`, requests.length === 7 && requests.every(r => r.status === 503), `${requests.length} requests`)
      const redFrames = spent.frames.filter(frame => frame.type === 'assistant' && road.spentLine.test((((frame.message as { content?: Array<{ text?: string }> } | undefined)?.content ?? []).map(block => block.text ?? '').join(''))))
      const result = spent.frames.find(frame => frame.type === 'result') as { is_error?: boolean; errors?: unknown } | undefined
      check(`${road.name}: the run exits non-zero with one red line naming how long ${road.provider} stayed busy, and the result frame carries it as its error`, spent.code !== 0 && redFrames.length === 1 && result?.is_error === true && JSON.stringify(result.errors ?? '').includes('stayed busy through 6 retries'), `${redFrames.length} red frames; ${out.slice(-400)}`)
      check(`${road.name}: every retry that began inside the quiet window sent no api_retry frame; every later one sent exactly one, with its true wait and place`, quietLines.length + loudLines.length === 6 && retryFrames.length === loudLines.length && retryFrames.length >= 1 && retryFrames.every(frame => frame.max_retries === 6 && typeof frame.attempt === 'number' && (frame.attempt as number) >= 1 && (frame.attempt as number) <= 6 && BUSY_RETRY_RUNGS_MS.map(ms => Math.round(ms * scale)).includes(frame.retry_delay_ms as number)), JSON.stringify(retryFrames.map(frame => [frame.attempt, frame.max_retries, frame.retry_delay_ms])))
      check(`${road.name}: the transcript carries exactly the loud notices and no calm row`, noticesOf(records, 'api_error').length === retryFrames.length && noticesOf(records, 'busy_recovery').length === 0, `${noticesOf(records, 'api_error').length} api_error notices among ${records.length} records`)
      check(`${road.name}: the unattended-turn watchdog (${IDLE_LIMIT_MINUTES * 60} s here, above the ${Math.round(BUSY_RETRY_QUIET_MS * scale)} ms quiet window) never fired`, !spent.stderr.includes('unattended turn') && !out.includes('unattended turn'), spent.stderr.slice(-300))
      check(`${road.name}: the waits between requests grew with the rungs`, requests.length === 7 && requests.slice(1).every((r, i) => r.atMs - requests[i]!.atMs >= Math.round(BUSY_RETRY_RUNGS_MS[i]! * scale) - 2), JSON.stringify(requests.slice(1).map((r, i) => r.atMs - requests[i]!.atMs)))
    }
    {
      const scale = 0.6
      refusalsBeforeAnswer = 2
      requests = []
      const home = seedHome(`home-${road.name}-recover`, road)
      const recovered = await run(home, scale, road)
      const retryFrames = recovered.frames.filter(frame => frame.type === 'system' && frame.subtype === 'api_retry')
      const records = transcriptRecords(home)
      const calm = noticesOf(records, 'busy_recovery')
      const calmAt = records.findIndex(record => (record.payload as { noticeKind?: string } | undefined)?.noticeKind === 'busy_recovery')
      const answerAt = records.findIndex(record => { const payload = record.payload as { kind?: string; content?: unknown } | undefined; return payload?.kind === 'output' && JSON.stringify(payload.content ?? '').includes(ANSWER) })
      const payload = calm[0]?.payload as { content?: string; fields?: { retries?: number; provider?: string } } | undefined
      const fields = payload?.fields === undefined ? undefined : { ...payload.fields, content: payload.content }
      console.log(`  recover: exit ${recovered.code}/${recovered.signal} by the ${recovered.endedBy} after ${recovered.elapsedMs} ms; ${requests.length} requests; ${retryFrames.length} api_retry frames`)
      check(`${road.name}: a refusal that clears on the third request answers: exit 0 with the answer in the result`, recovered.endedBy === 'child' && recovered.code === 0 && textOf(recovered.frames).includes(ANSWER), `code ${recovered.code}; ${recovered.stderr.slice(-300)}`)
      check(`${road.name}: the two quiet retries sent no api_retry frame and wrote no api_error notice`, retryFrames.length === 0 && noticesOf(records, 'api_error').length === 0, `${retryFrames.length} frames, ${noticesOf(records, 'api_error').length} notices`)
      check(`${road.name}: one calm busy_recovery row is on the record before the answer, naming ${road.provider} and 2 retries`, calm.length === 1 && calmAt >= 0 && answerAt > calmAt && fields?.retries === 2 && fields.provider === road.provider && /retried after 1 s and 1 s, and the third request was answered\.$/.test(fields.content ?? ''), JSON.stringify(fields))
      check(`${road.name}: three requests reached the fixture, the third answered`, requests.length === 3 && requests[2]?.status === 200, JSON.stringify(requests.map(r => r.status)))
    }
  }
} finally {
  server.close()
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}
console.log(`\n${failures === 0 ? 'prove-busy-retry-bounded: ALL LAWS HOLD' : `prove-busy-retry-bounded: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
