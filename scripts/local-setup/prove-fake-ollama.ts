#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FAKE_OLLAMA_CAPABILITIES,
  FAKE_OLLAMA_LAYERS,
  FAKE_OLLAMA_MODEL,
  FAKE_OLLAMA_MODEL_SIZE,
  FAKE_OLLAMA_REPLY,
  FAKE_OLLAMA_REPLY_PREFIX,
  FAKE_OLLAMA_TRAINED_CONTEXT,
  FAKE_OLLAMA_VERSION,
  createFakeOllama,
  fakeOllamaFetch,
  fakeOllamaReplyFor,
  parseOllamaHost,
} from './fixtures/fake-ollama.ts'

const HOME = mkdtempSync(join(tmpdir(), 'fake-ollama-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.OLLAMA_HOST

const { discoverLocalServers } = await import('../../src/services/providers/local/localDiscovery.ts')
const { readLocalServerTruth } = await import('../../src/services/localServer/localServerTruth.ts')
const { kvGeometryOf, kvCacheBytes, projectLoad } = await import('../../src/services/localServer/localServerMemory.ts')
const { streamOllamaChat } = await import('../../src/services/providers/local/ollamaChatTransport.ts')

const REPO = join(import.meta.dir, '..', '..')
const FIXTURES = join(import.meta.dir, 'fixtures')
const SERVER = join(FIXTURES, 'fake-ollama.ts')
const BUN = process.execPath
const KEEP = process.env.FAKE_OLLAMA_PROOF_KEEP === '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

async function waitForVersion(root: string, budgetMs: number): Promise<boolean> {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    try {
      const response = await fetch(`${root}/api/version`, { signal: AbortSignal.timeout(500) })
      if (response.ok) return true
    } catch {
      void 0
    }
    await sleep(100)
  }
  return false
}

async function ndjson(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text()
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

async function firstRowsThenCancel(response: Response, rows: number): Promise<Record<string, unknown>[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const seen: Record<string, unknown>[] = []
  while (seen.length < rows) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') seen.push(JSON.parse(line) as Record<string, unknown>)
  }
  await reader.cancel()
  return seen
}

section('the in-process seam: the product modules read the fixture through an injected fetch')
{
  const fixture = createFakeOllama({ sleep: async () => {}, chatDelayMs: 2100 })
  const fetchImpl = fakeOllamaFetch(fixture)
  const root = 'http://127.0.0.1:11434'
  const env = { MERCURY_LOCAL_PROBE_TARGETS: `ollama=${root}` } as NodeJS.ProcessEnv
  const empty = await discoverLocalServers({ env, fetchImpl })
  check('discovery finds the server with no model before a pull', empty.servers.length === 1 && empty.servers[0]!.kind === 'ollama' && empty.servers[0]!.models.length === 0 && empty.servers[0]!.version === FAKE_OLLAMA_VERSION, JSON.stringify(empty))
  const pull = await fetchImpl(`${root}/api/pull`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, stream: true }) })
  const rows = await ndjson(pull)
  check('the pull streams manifest → three digest rows with completed/total → verifying → writing → success', rows[0]?.status === 'pulling manifest' && rows.at(-1)?.status === 'success' && rows.some(r => r.status === 'verifying sha256 digest') && rows.some(r => r.status === 'writing manifest') && new Set(rows.filter(r => typeof r.digest === 'string').map(r => r.digest)).size === 3 && rows.filter(r => typeof r.completed === 'number').every(r => (r.completed as number) <= (r.total as number)), rows.map(r => r.status).join(' | '))
  const totals = FAKE_OLLAMA_LAYERS.reduce((sum, layer) => sum + layer.total, 0)
  check('the layer totals sum to the model size the tags list', totals === FAKE_OLLAMA_MODEL_SIZE, `${totals} vs ${FAKE_OLLAMA_MODEL_SIZE}`)
  const found = await discoverLocalServers({ env, fetchImpl })
  const model = found.servers[0]?.models[0]
  check('after the pull discovery lists qwen3.5:9b with tools and thinking declared and the trained maximum', model?.id === FAKE_OLLAMA_MODEL && model.toolsDeclared === true && model.thinkingDeclared === true && model.modelMaxContext === FAKE_OLLAMA_TRAINED_CONTEXT && model.contextWindow === undefined && model.loaded === false, JSON.stringify(model))
  const truth = await readLocalServerTruth({ env, fetchImpl, platform: 'darwin', home: HOME, totalMemoryBytes: 48 * 1024 ** 3, run: async () => undefined })
  const listed = truth.listed[0]
  check('the server truth reads the geometry the memory module needs: 32 kv heads over 8 attention layers, k/v length 256', listed?.name === FAKE_OLLAMA_MODEL && listed.trainedContext === FAKE_OLLAMA_TRAINED_CONTEXT && listed.geometry?.kvHeads === 32 && listed.geometry.attentionLayers === 8 && listed.geometry.keyLength === 256 && listed.geometry.valueLength === 256 && listed.geometry.blockCount === 32, JSON.stringify(listed))
  const show = rec(await (await fetchImpl(`${root}/api/show`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL }) })).json())
  const geometry = kvGeometryOf(rec(show.model_info))
  check('kvGeometryOf parses /api/show and the 128k cache projects to 4.0 GiB (32 KiB per token at f16)', geometry !== undefined && kvCacheBytes(geometry, 131_072, 1) === 4 * 1024 ** 3 && projectLoad({ name: FAKE_OLLAMA_MODEL, weightsBytes: FAKE_OLLAMA_MODEL_SIZE, geometry }, 131_072, 1).totalBytes === FAKE_OLLAMA_MODEL_SIZE + 4 * 1024 ** 3, JSON.stringify(geometry))
  check('/api/show states qwen35.context_length 262144 and the capabilities completion · tools · thinking', rec(show.model_info)['qwen35.context_length'] === FAKE_OLLAMA_TRAINED_CONTEXT && ['completion', 'tools', 'thinking'].every(c => (show.capabilities as string[]).includes(c)) && (show.capabilities as string[]).length === FAKE_OLLAMA_CAPABILITIES.length, JSON.stringify(show.capabilities))
  const events: string[] = []
  let text = ''
  let usage: unknown
  for await (const event of streamOllamaChat({ url: `${root}/api/chat`, fetchImpl, request: { model: FAKE_OLLAMA_MODEL, messages: [{ role: 'user', content: 'reply with the single word ready' }] } }, { numCtx: 131_072, think: false })) {
    events.push(event.type)
    if (event.type === 'text-delta') text += event.text
    if (event.type === 'usage') usage = event.usage
  }
  check('the native transport streams the canned reply "ready" with usage and a stop finish', text === FAKE_OLLAMA_REPLY && events.includes('served-model') && events.includes('usage') && events.at(-1) === 'finish' && rec(usage).inputTokens !== undefined, `${events.join(',')} · "${text}"`)
  const chatRequest = fixture.state.requests.find(r => r.path === '/api/chat')
  check('the chat request carried options.num_ctx 131072 · stream · truncate:false (the window rides on every request)', rec(rec(chatRequest?.body).options).num_ctx === 131_072 && rec(chatRequest?.body).stream === true && rec(chatRequest?.body).truncate === false, JSON.stringify(chatRequest?.body).slice(0, 300))
  const afterChat = await discoverLocalServers({ env, fetchImpl })
  check('after the chat /api/ps lists the model loaded at the requested window (context_length 131072)', afterChat.servers[0]?.models[0]?.loaded === true && afterChat.servers[0]?.models[0]?.contextWindow?.tokens === 131_072 && afterChat.servers[0]?.models[0]?.contextWindow?.source === 'served', JSON.stringify(afterChat.servers[0]?.models[0]))
  const seamRows = await ndjson(await fetchImpl(`${root}/api/chat`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, messages: [{ role: 'user', content: 'reply with the single word ready' }], stream: true }) }))
  const seamDone = seamRows.at(-1) ?? {}
  check('the done row carries the load, ingest and eval timings the ready row reads (load_duration = the chat delay in ns)', seamDone.done === true && seamDone.load_duration === 2_100_000_000 && (seamDone.prompt_eval_count as number) > 0 && (seamDone.eval_count as number) > 0 && (seamDone.total_duration as number) === (seamDone.load_duration as number) + (seamDone.prompt_eval_duration as number) + (seamDone.eval_duration as number), JSON.stringify(seamDone))
  check('the canned reply law: a prompt naming ready gets the one word; any other prompt gets the echo that begins with ready', fakeOllamaReplyFor('reply with the single word ready') === 'ready' && fakeOllamaReplyFor('what are you') === `${FAKE_OLLAMA_REPLY_PREFIX}what are you` && fakeOllamaReplyFor('what are you').startsWith('ready'))
  check('OLLAMA_HOST parses host:port, a bare port-less host, and an http root', JSON.stringify(parseOllamaHost('127.0.0.1:58731')) === JSON.stringify({ host: '127.0.0.1', port: 58731 }) && JSON.stringify(parseOllamaHost('http://127.0.0.1:5000/')) === JSON.stringify({ host: '127.0.0.1', port: 5000 }) && parseOllamaHost('0.0.0.0')?.port === 11434 && parseOllamaHost(undefined) === undefined)
}

section('the HTTP server: every route over a real socket, its request log, and the pull pace')
const logFile = join(HOME, 'requests.jsonl')
const pidfile = join(HOME, 'server.pid')
const server: ChildProcess = spawn(BUN, ['run', SERVER, '--port', '0', '--log', logFile, '--pidfile', pidfile, '--pull-step-ms', '40', '--pull-steps', '12', '--chat-delay-ms', '150'], { stdio: ['ignore', 'pipe', 'pipe'] })
let serverOut = ''
const port = await new Promise<number>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the fixture never printed PORT')), 15_000)
  server.stdout!.on('data', chunk => {
    serverOut += String(chunk)
    const match = /PORT (\d+)/.exec(serverOut)
    if (match && /ROOT http/.test(serverOut)) {
      clearTimeout(timer)
      resolve(Number(match[1]))
    }
  })
  server.stderr!.on('data', chunk => {
    serverOut += String(chunk)
  })
  server.on('exit', code => {
    clearTimeout(timer)
    reject(new Error(`the fixture exited ${code}: ${serverOut}`))
  })
}).catch(error => {
  console.log(`  [FAIL] ${String(error)}`)
  process.exit(1)
})
const root = `http://127.0.0.1:${port}`
try {
  check('the server prints PORT and ROOT and writes its pidfile', serverOut.includes(`ROOT ${root}`) && existsSync(pidfile) && Number(readFileSync(pidfile, 'utf8').trim()) === server.pid, serverOut)
  const version = rec(await (await fetch(`${root}/api/version`)).json())
  check('GET /api/version → {"version":"0.34.4"}', version.version === FAKE_OLLAMA_VERSION, JSON.stringify(version))
  const tagsBefore = rec(await (await fetch(`${root}/api/tags`)).json())
  check('GET /api/tags is empty before a pull', Array.isArray(tagsBefore.models) && tagsBefore.models.length === 0, JSON.stringify(tagsBefore))
  const showBefore = await fetch(`${root}/api/show`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL }) })
  check('POST /api/show answers 404 with the not-found error before the pull', showBefore.status === 404 && /not found/.test(String(rec(await showBefore.json()).error)))
  const chatBefore = await fetch(`${root}/api/chat`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, messages: [{ role: 'user', content: 'hi' }] }) })
  check('POST /api/chat before the pull answers 404 "try pulling it first"', chatBefore.status === 404 && /try pulling it first/.test(String(rec(await chatBefore.json()).error)))
  const unknown = await fetch(`${root}/api/pull`, { method: 'POST', body: JSON.stringify({ model: 'llama9:1b' }) })
  check('POST /api/pull of a tag outside the fixture library answers the manifest error (500)', unknown.status === 500 && /manifest/.test(String(rec(await unknown.json()).error)))
  const started = Date.now()
  const partial = await firstRowsThenCancel(await fetch(`${root}/api/pull`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, stream: true }) }), 4)
  const tagsAfterCancel = rec(await (await fetch(`${root}/api/tags`)).json())
  check('a pull cancelled mid-way leaves the model unpulled (the stream is the transaction)', partial.length === 4 && partial[2]?.completed !== undefined && (tagsAfterCancel.models as unknown[]).length === 0, JSON.stringify(partial.map(r => r.status)))
  const pullResponse = await fetch(`${root}/api/pull`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, stream: true }) })
  check('the pull answers application/x-ndjson', /x-ndjson/.test(pullResponse.headers.get('content-type') ?? ''), pullResponse.headers.get('content-type') ?? '')
  const rows = await ndjson(pullResponse)
  const elapsed = Date.now() - started
  const weightRows = rows.filter(r => r.digest === FAKE_OLLAMA_LAYERS[0]!.digest && typeof r.completed === 'number')
  check('the weights layer streams twelve progress rows climbing to its total, at the pace the flags set (≥ 12 × 40 ms)', weightRows.length === 12 && weightRows.at(-1)?.completed === FAKE_OLLAMA_LAYERS[0]!.total && weightRows.every((r, i) => i === 0 || (r.completed as number) > (weightRows[i - 1]!.completed as number)) && elapsed >= 12 * 40, `${weightRows.length} rows in ${elapsed} ms`)
  check('the stream ends on success after verifying and writing rows', rows.at(-1)?.status === 'success' && rows.at(-2)?.status === 'writing manifest' && rows.at(-3)?.status === 'verifying sha256 digest', rows.slice(-4).map(r => r.status).join(' | '))
  const tagsAfter = rec(await (await fetch(`${root}/api/tags`)).json())
  const listed = rec((tagsAfter.models as unknown[])[0])
  check('GET /api/tags lists qwen3.5:9b with the 9B details and its size after the pull', listed.name === FAKE_OLLAMA_MODEL && listed.size === FAKE_OLLAMA_MODEL_SIZE && rec(listed.details).parameter_size === '9.7B' && rec(listed.details).quantization_level === 'Q4_K_M', JSON.stringify(listed).slice(0, 300))
  const psBefore = rec(await (await fetch(`${root}/api/ps`)).json())
  check('GET /api/ps is empty before a load', (psBefore.models as unknown[]).length === 0)
  const load = rec(await (await fetch(`${root}/api/generate`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, options: { num_ctx: 131_072 } }) })).json())
  const psAfter = rec(await (await fetch(`${root}/api/ps`)).json())
  const loadedRow = rec((psAfter.models as unknown[])[0])
  check('POST /api/generate with no prompt loads the model (done_reason load) and /api/ps states context_length 131072', load.done === true && load.done_reason === 'load' && loadedRow.model === FAKE_OLLAMA_MODEL && loadedRow.context_length === 131_072 && typeof loadedRow.expires_at === 'string' && typeof loadedRow.size_vram === 'number', JSON.stringify(loadedRow).slice(0, 300))
  const chat = await fetch(`${root}/api/chat`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'reply with the single word ready' }], stream: true, options: { num_ctx: 131_072 } }) })
  const chatRows = await ndjson(chat)
  const done = chatRows.at(-1) ?? {}
  check('POST /api/chat streams NDJSON rows whose content concatenates to "ready" and a done row with prompt_eval_count · eval_count · durations', /x-ndjson/.test(chat.headers.get('content-type') ?? '') && chatRows.slice(0, -1).map(r => String(rec(r.message).content)).join('') === FAKE_OLLAMA_REPLY && done.done === true && done.done_reason === 'stop' && typeof done.prompt_eval_count === 'number' && typeof done.eval_count === 'number' && typeof done.load_duration === 'number' && (done.load_duration as number) === 150_000_000 && typeof done.prompt_eval_duration === 'number' && typeof done.eval_duration === 'number' && typeof done.total_duration === 'number', JSON.stringify(done))
  const echo = rec(await (await fetch(`${root}/api/chat`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, messages: [{ role: 'user', content: 'what are you' }], stream: false }) })).json())
  check('a chat with stream:false answers one object; a prompt without "ready" gets the echo reply', rec(echo.message).content === `${FAKE_OLLAMA_REPLY_PREFIX}what are you` && echo.done === true, JSON.stringify(echo).slice(0, 300))
  const thinking = await ndjson(await fetch(`${root}/api/chat`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, messages: [{ role: 'user', content: 'ready?' }], stream: true, think: true }) }))
  check('think:true adds one thinking row before the content', typeof rec(thinking[0]?.message).thinking === 'string' && thinking.slice(1, -1).map(r => String(rec(r.message).content)).join('') === FAKE_OLLAMA_REPLY, JSON.stringify(thinking[0]))
  const generate = await ndjson(await fetch(`${root}/api/generate`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, prompt: 'reply with the single word ready' }) }))
  check('POST /api/generate with a prompt streams response rows and a done row', generate.slice(0, -1).map(r => String(r.response)).join('') === FAKE_OLLAMA_REPLY && generate.at(-1)?.done === true, JSON.stringify(generate.at(-1)))
  const sse = await fetch(`${root}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, messages: [{ role: 'user', content: 'reply with the single word ready' }], stream: true }) })
  const sseText = await sse.text()
  const chunks = sseText.split('\n\n').filter(l => l.startsWith('data: ') && !l.startsWith('data: [DONE]')).map(l => JSON.parse(l.slice(6)) as Record<string, unknown>)
  const sseContent = chunks.map(c => String(rec(rec((c.choices as unknown[])[0]).delta).content ?? '')).join('')
  check('POST /v1/chat/completions streams SSE chunks that concatenate to "ready", a stop chunk with usage, then [DONE]', /event-stream/.test(sse.headers.get('content-type') ?? '') && sseContent === FAKE_OLLAMA_REPLY && sseText.trimEnd().endsWith('data: [DONE]') && chunks.some(c => rec((c.choices as unknown[])[0]).finish_reason === 'stop' && c.usage !== undefined), sseText.slice(-300))
  const completion = rec(await (await fetch(`${root}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, messages: [{ role: 'user', content: 'what are you' }] }) })).json())
  check('a non-streamed /v1/chat/completions answers one chat.completion object', completion.object === 'chat.completion' && rec(rec((completion.choices as unknown[])[0]).message).content === `${FAKE_OLLAMA_REPLY_PREFIX}what are you`, JSON.stringify(completion).slice(0, 300))
  const models = rec(await (await fetch(`${root}/v1/models`)).json())
  check('GET /v1/models lists the pulled model on the old road', rec((models.data as unknown[])[0]).id === FAKE_OLLAMA_MODEL)
  const unload = rec(await (await fetch(`${root}/api/generate`, { method: 'POST', body: JSON.stringify({ model: FAKE_OLLAMA_MODEL, keep_alive: 0 }) })).json())
  const psUnloaded = rec(await (await fetch(`${root}/api/ps`)).json())
  check('keep_alive 0 unloads: done_reason unload and /api/ps empties', unload.done_reason === 'unload' && (psUnloaded.models as unknown[]).length === 0)
  const bad = await fetch(`${root}/api/chat`, { method: 'POST', body: '{not json' })
  check('a malformed POST body answers 400', bad.status === 400)
  const missing = await fetch(`${root}/api/nothing`)
  check('an unknown route answers 404 page not found', missing.status === 404 && (await missing.text()) === '404 page not found')
  const rootAnswer = await fetch(root)
  check('GET / answers "Ollama is running"', (await rootAnswer.text()) === 'Ollama is running')
  const log = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; path: string; body: unknown })
  const routes = new Set(log.map(entry => `${entry.method} ${entry.path}`))
  check('the request log names every route the road speaks', ['GET /api/version', 'GET /api/tags', 'POST /api/show', 'POST /api/pull', 'GET /api/ps', 'POST /api/generate', 'POST /api/chat', 'POST /v1/chat/completions', 'GET /v1/models'].every(r => routes.has(r)), [...routes].join(', '))
  check('the log keeps each request body (the pull body reads model qwen3.5:9b, stream true)', log.some(entry => entry.path === '/api/pull' && rec(entry.body).model === FAKE_OLLAMA_MODEL && rec(entry.body).stream === true))
} finally {
  server.kill('SIGTERM')
}
await sleep(300)
check('SIGTERM removes the pidfile', !existsSync(pidfile))

section('the fixture binary, the installer and the fixture Homebrew: steps 2b and 3 run for real inside a scratch prefix')
const listing = (dir: string): string => (existsSync(dir) ? readdirSync(dir).sort().join(',') : '(absent)')
const fixturesBefore = listing(FIXTURES)
const agentsBefore = listing(join(homedir(), 'Library', 'LaunchAgents'))
{
  const world = join(HOME, 'world')
  const bin = join(world, 'bin')
  const state = join(world, 'state')
  mkdirSync(bin, { recursive: true })
  mkdirSync(state, { recursive: true })
  const servePort = await freePort()
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${join(FIXTURES, 'homebrew')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: world,
    TMPDIR: world,
    FAKE_OLLAMA_BIN: bin,
    FAKE_OLLAMA_STATE: state,
    FAKE_OLLAMA_BUN: BUN,
    FAKE_OLLAMA_SCRIPT: SERVER,
    FAKE_OLLAMA_PIDFILE: join(state, 'server.pid'),
    FAKE_OLLAMA_PULL_STEP_MS: '5',
    OLLAMA_HOST: `127.0.0.1:${servePort}`,
  }
  const run = (cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(cmd, args, { env, encoding: 'utf8', cwd: world, timeout: 20_000 })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  check('with the fixture PATH empty, `which ollama` finds nothing and `which brew` finds the fixture Homebrew', run('which', ['ollama']).status !== 0 && run('which', ['brew']).stdout.trim() === join(FIXTURES, 'homebrew', 'brew'), run('which', ['brew']).stdout)
  const listBefore = run('brew', ['list', '--formula', 'ollama'])
  check('`brew list --formula ollama` fails with the no-such-keg error before the install', listBefore.status === 1 && /No such keg/.test(listBefore.stderr), listBefore.stderr)
  const install = run('brew', ['install', 'ollama'])
  check('`brew install ollama` installs the fixture binary into FAKE_OLLAMA_BIN and prints the caveats', install.status === 0 && existsSync(join(bin, 'ollama')) && /brew services start ollama/.test(install.stdout), install.stdout + install.stderr)
  const which = run('which', ['ollama'])
  check('`which ollama` now answers the fixture binary on PATH', which.status === 0 && which.stdout.trim() === join(bin, 'ollama'), which.stdout)
  const version = run('ollama', ['--version'])
  check('`ollama --version` answers "ollama version is 0.34.4"', version.status === 0 && version.stdout.trim() === `ollama version is ${FAKE_OLLAMA_VERSION}`, version.stdout + version.stderr)
  const listAfter = run('brew', ['list', '--formula', 'ollama'])
  check('`brew list --formula ollama` succeeds after the install', listAfter.status === 0 && listAfter.stdout.trim() === 'ollama')
  const noServer = run('ollama', ['list'])
  check('`ollama list` before a server answers the could-not-connect error', noServer.status === 1 && /could not connect to ollama server/.test(noServer.stderr), noServer.stderr)
  const start = run('brew', ['services', 'start', 'ollama'])
  const up = await waitForVersion(`http://127.0.0.1:${servePort}`, 10_000)
  check('`brew services start ollama` starts the fixture server detached on OLLAMA_HOST and /api/version answers', start.status === 0 && /Successfully started/.test(start.stdout) && up, start.stdout + start.stderr)
  const again = run('brew', ['services', 'start', 'ollama'])
  check('a second start says the service is already started', again.status === 0 && /already started/.test(again.stdout), again.stdout)
  const pull = run('ollama', ['pull', FAKE_OLLAMA_MODEL])
  check('`ollama pull qwen3.5:9b` walks the stream to success through the API', pull.status === 0 && /success/.test(pull.stdout) && /pulling dec52a44569a \d+%/.test(pull.stdout), pull.stdout + pull.stderr)
  const list = run('ollama', ['list'])
  check('`ollama list` names the pulled model', list.status === 0 && /qwen3\.5:9b/.test(list.stdout), list.stdout)
  const services = run('brew', ['services', 'list'])
  check('`brew services list` reads ollama started', /ollama started/.test(services.stdout), services.stdout)
  const stop = run('brew', ['services', 'stop', 'ollama'])
  await sleep(300)
  const down = !(await waitForVersion(`http://127.0.0.1:${servePort}`, 300))
  check('`brew services stop ollama` stops it and the port goes quiet', stop.status === 0 && down, stop.stdout + stop.stderr)
  const serveChild = spawn('ollama', ['serve'], { env, cwd: world, stdio: ['ignore', 'pipe', 'pipe'] })
  const serveUp = await waitForVersion(`http://127.0.0.1:${servePort}`, 10_000)
  serveChild.kill('SIGTERM')
  check('`ollama serve` in the foreground binds OLLAMA_HOST and answers /api/version', serveUp)
  const installer = spawnSync(join(FIXTURES, 'install-ollama.sh'), [], { env: { ...env, FAKE_OLLAMA_BIN: join(world, 'bin2') }, encoding: 'utf8' })
  check('the installer alone installs into a fresh FAKE_OLLAMA_BIN and says so', installer.status === 0 && existsSync(join(world, 'bin2', 'ollama')) && /Install complete/.test(installer.stdout), installer.stdout + installer.stderr)
  const noBin = spawnSync(join(FIXTURES, 'install-ollama.sh'), [], { env: { PATH: env.PATH! }, encoding: 'utf8' })
  check('the installer refuses without FAKE_OLLAMA_BIN (it never guesses a real prefix)', noBin.status !== 0 && /FAKE_OLLAMA_BIN/.test(noBin.stderr), noBin.stderr)
  check('nothing landed outside the scratch world: the tracked fixtures folders and the real launch-agents folder are unchanged', listing(FIXTURES) === fixturesBefore && listing(join(FIXTURES, 'homebrew')) === 'brew' && listing(join(homedir(), 'Library', 'LaunchAgents')) === agentsBefore && !existsSync(join(REPO, 'ollama')), `${listing(FIXTURES)} · ${listing(join(homedir(), 'Library', 'LaunchAgents'))}`)
}

if (!KEEP) rmSync(HOME, { recursive: true, force: true })
else console.log(`\n  kept: ${HOME}`)
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' fake-ollama: EVERY ROUTE ANSWERS AS THE REAL SERVER DOES' : ` fake-ollama: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
