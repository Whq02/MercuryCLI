import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { ggufOnDisk, ggufPaths, hfCacheRoot } from '../hfCache.js'
import { GIB, TENSORFOLD_RUNTIME_MARGIN } from '../starting.js'
import { ADAPTER_CHILD_PREFIX, ADAPTER_SERVED_BY, ADAPTER_SPEAKER, ADAPTER_VERSION, cpuModelWords, llamaCppWords } from './identity.js'
import { readLlamaServerVersion, resolveLlamaServer, type LlamaServerVersion } from './llama.js'
import { ADAPTER_CHECKPOINTS, adapterCheckpointOf, type AdapterCheckpoint } from './models.js'

export type ServeArgs = { repo: string; name?: string; window: number; port: number; host: string; promptCacheGib: number; apiKeyFile?: string; drafter?: string }

export type ServeIo = {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  llamaServer?: string
  stderr?: (line: string) => void
  spawnImpl?: typeof spawn
  drainSeconds?: number
  readyPollMs?: number
}

export const ADAPTER_ADMISSION_SHARE = 0.7
export const ADAPTER_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'] as const
const DEFAULT_PROMPT_CACHE_GIB = 1

export class ServeRefusal extends Error {
  constructor(message: string, public readonly code = 1) {
    super(message)
  }
}

export function parseServeArgs(argv: readonly string[]): ServeArgs {
  const repo = argv[0]
  if (repo === undefined || repo.startsWith('--')) throw new ServeRefusal('serve needs a model', 2)
  const out: ServeArgs = { repo, window: 32_768, port: 8080, host: '127.0.0.1', promptCacheGib: DEFAULT_PROMPT_CACHE_GIB }
  for (let at = 1; at < argv.length; at += 2) {
    const flag = argv[at]!
    const value = argv[at + 1]
    if (value === undefined) throw new ServeRefusal(`${flag} needs a value`, 2)
    switch (flag) {
      case '--name':
        out.name = value
        break
      case '--context':
        out.window = Number(value)
        break
      case '--port':
        out.port = Number(value)
        break
      case '--host':
        out.host = value
        break
      case '--prompt-cache-gib':
        out.promptCacheGib = Number(value)
        break
      case '--api-key-file':
        out.apiKeyFile = value
        break
      case '--drafter':
        out.drafter = value
        break
      case '--parallel':
        break
      default:
        throw new ServeRefusal(`unknown flag ${flag}`, 2)
    }
  }
  if (!Number.isInteger(out.window) || out.window <= 0) throw new ServeRefusal('--context needs a whole number of tokens', 2)
  if (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535) throw new ServeRefusal('--port needs a port from 1 to 65535', 2)
  if (!Number.isFinite(out.promptCacheGib) || out.promptCacheGib < 0) throw new ServeRefusal('--prompt-cache-gib needs a number of GiB', 2)
  return out
}

const gib2 = (bytes: number): string => (bytes / GIB).toFixed(2)

export function admission(point: AdapterCheckpoint, window: number, promptCacheGib: number, ramBytes: number): { needBytes: number; limitBytes: number; line?: string } {
  const cache = point.kvBytesPerToken * window
  const fixed = point.weightsBytes + promptCacheGib * GIB + TENSORFOLD_RUNTIME_MARGIN
  const needBytes = fixed + cache
  const limitBytes = Math.round(ramBytes * ADAPTER_ADMISSION_SHARE)
  if (needBytes <= limitBytes) return { needBytes, limitBytes }
  const left = Math.max(0, limitBytes - fixed)
  return { needBytes, limitBytes, line: `${point.family}: one stream at a ${window}-token window takes ${gib2(cache)} GiB, more than the ${gib2(left)} GiB left under the load limit; lower --context` }
}

export function readKeyFile(path: string): string[] {
  const keys = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(line => (line.includes(':') ? line.slice(line.indexOf(':') + 1).trim() : line))
    .filter(key => key !== '')
  if (keys.length === 0) throw new ServeRefusal(`${path} holds no key`, 2)
  return keys
}

export function llamaServerArgs(model: string, name: string, window: number, innerPort: number, promptCacheGib: number): string[] {
  return [
    '--model',
    model,
    '--alias',
    name,
    '--host',
    '127.0.0.1',
    '--port',
    String(innerPort),
    '--ctx-size',
    String(window),
    '--parallel',
    '1',
    '--jinja',
    '--flash-attn',
    'on',
    '--cache-type-k',
    'f16',
    '--cache-type-v',
    'f16',
    '--device',
    'none',
    '--cache-ram',
    String(Math.round(promptCacheGib * 1024)),
    '--no-webui',
  ]
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export function translateRequest(body: Rec): { body: Rec; effort?: string; thinking?: boolean } {
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined
  const out: Rec = { ...body }
  delete out.thinking_budget
  if (effort === undefined) return { body: out }
  const thinking = effort !== 'none'
  out.chat_template_kwargs = { ...(rec(body.chat_template_kwargs) ?? {}), enable_thinking: thinking }
  if (!thinking) delete out.reasoning_effort
  if (thinking && num(body.thinking_budget) !== undefined) out.thinking_budget_tokens = Math.max(1, Math.round(num(body.thinking_budget)!))
  return { body: out, effort, thinking }
}

export type RuntimeFacts = { effort?: string; thinking?: boolean; llama: LlamaServerVersion }

export function tensorFoldBlockOf(timings: Rec | undefined, facts: RuntimeFacts): Rec | undefined {
  if (timings === undefined) return undefined
  const promptMs = num(timings.prompt_ms)
  const predictedMs = num(timings.predicted_ms)
  return {
    engine: llamaCppWords(facts.llama),
    served_by: ADAPTER_SERVED_BY,
    ...(facts.thinking !== undefined ? { enable_thinking: facts.thinking } : {}),
    ...(facts.effort !== undefined ? { reasoning_effort: facts.effort } : {}),
    ...(num(timings.predicted_per_second) !== undefined ? { tokens_per_second: num(timings.predicted_per_second)! } : {}),
    ...(promptMs !== undefined ? { time_to_first_token: promptMs / 1000, prefill_seconds: promptMs / 1000 } : {}),
    ...(predictedMs !== undefined ? { seconds: predictedMs / 1000 } : {}),
    ...(num(timings.prompt_per_second) !== undefined ? { prefill_tokens_per_second: num(timings.prompt_per_second)! } : {}),
  }
}

export function translateReply(chunk: Rec, facts: RuntimeFacts): Rec {
  const timings = rec(chunk.timings)
  const usage = rec(chunk.usage)
  const block = tensorFoldBlockOf(timings, facts)
  const cached = num(rec(usage?.prompt_tokens_details)?.cached_tokens) ?? num(timings?.cache_n)
  const { timings: _timings, ...rest } = chunk
  return {
    ...rest,
    ...(usage !== undefined ? { usage: { ...usage, prompt_tokens_details: { ...(rec(usage.prompt_tokens_details) ?? {}), cached_tokens: cached ?? 0 } } } : {}),
    ...(block !== undefined ? { tensorfold: block } : {}),
  }
}

export class SseTransformer {
  private rest = ''
  constructor(private readonly facts: RuntimeFacts, private readonly onTimings?: (timings: Rec) => void) {}

  push(text: string): string {
    const lines = (this.rest + text).split('\n')
    this.rest = lines.pop() ?? ''
    return lines.map(line => this.line(line)).join('')
  }

  flush(): string {
    const tail = this.rest
    this.rest = ''
    return tail === '' ? '' : this.line(tail)
  }

  private line(line: string): string {
    if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') return `${line}\n`
    let parsed: unknown
    try {
      parsed = JSON.parse(line.slice('data: '.length))
    } catch {
      return `${line}\n`
    }
    const chunk = rec(parsed)
    if (chunk === undefined) return `${line}\n`
    const timings = rec(chunk.timings)
    if (timings !== undefined) this.onTimings?.(timings)
    return `data: ${JSON.stringify(translateReply(chunk, this.facts))}\n`
  }
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers })
  response.end(text)
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    request.on('data', chunk => parts.push(chunk as Buffer))
    request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    request.on('error', reject)
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

function rssBytes(pid: number, platform: NodeJS.Platform): Promise<number | undefined> {
  return new Promise(resolve => {
    const done = (stdout: string): void => {
      if (platform === 'win32') {
        const cell = stdout.split(',').pop()?.replace(/[^0-9]/g, '')
        resolve(cell ? Number(cell) * 1024 : undefined)
        return
      }
      const kib = Number(stdout.trim())
      resolve(Number.isFinite(kib) && kib > 0 ? kib * 1024 : undefined)
    }
    try {
      if (platform === 'win32') execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 3_000, windowsHide: true }, (error, stdout) => (error ? resolve(undefined) : done(String(stdout))))
      else execFile('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000 }, (error, stdout) => (error ? resolve(undefined) : done(String(stdout))))
    } catch {
      resolve(undefined)
    }
  })
}

async function innerHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) })
    return response.status === 200
  } catch {
    return false
  }
}

async function innerContext(port: number): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/props`, { signal: AbortSignal.timeout(3_000) })
    const props = rec(await response.json())
    return num(rec(props?.default_generation_settings)?.n_ctx)
  } catch {
    return undefined
  }
}

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (!key.startsWith('LLAMA_ARG_') && key !== 'LLAMA_API_KEY') out[key] = value
  out.LLAMA_LOG_COLORS = '0'
  return out
}

export function childPidFile(port: number): string {
  return join(tmpdir(), 'mercury-tensorfold-adapter', `port-${port}.pid`)
}

function isLlamaServer(pid: number, platform: NodeJS.Platform): Promise<boolean> {
  return new Promise(resolve => {
    try {
      if (platform === 'win32') execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 3_000, windowsHide: true }, (error, stdout) => resolve(!error && /llama-server/i.test(String(stdout))))
      else execFile('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000 }, (error, stdout) => resolve(!error && /llama-server/.test(String(stdout))))
    } catch {
      resolve(false)
    }
  })
}

export async function reapStaleChild(port: number, platform: NodeJS.Platform, say: (line: string) => void): Promise<void> {
  const file = childPidFile(port)
  let pid: number
  try {
    pid = Number(readFileSync(file, 'utf8').trim())
  } catch {
    return
  }
  rmSync(file, { force: true })
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return
  if (!(await isLlamaServer(pid, platform))) return
  try {
    process.kill(pid)
    say(`[${ADAPTER_SPEAKER}] stopped a llama-server left behind by an earlier serve on port ${port} (pid ${pid})`)
  } catch {
    void 0
  }
}

function rememberChild(port: number, pid: number): void {
  try {
    const file = childPidFile(port)
    mkdirSync(join(tmpdir(), 'mercury-tensorfold-adapter'), { recursive: true })
    writeFileSync(file, `${pid}\n`)
  } catch {
    void 0
  }
}

type FrontState = 'loading' | 'ready' | 'draining'

export async function runServe(args: ServeArgs, io: ServeIo = {}): Promise<number> {
  const env = io.env ?? process.env
  const platform = io.platform ?? process.platform
  const say = io.stderr ?? ((line: string) => process.stderr.write(`${line}\n`))
  const refusal = (line: string): ServeRefusal => new ServeRefusal(`${ADAPTER_SPEAKER}: ${line}`)
  const point = adapterCheckpointOf(args.repo)
  if (point === undefined) throw refusal(`no backend for ${args.repo} on Mercury's engine; it serves ${ADAPTER_CHECKPOINTS.map(row => row.repo).join(', ')}`)
  if (args.drafter !== undefined) throw refusal(`--drafter ${args.drafter} is not available on Mercury's engine; serve ${point.repo} without it`)
  const root = hfCacheRoot(env, io.home)
  if (!ggufOnDisk(root, point.gguf).complete) throw refusal(`${point.repo} is not in the Hugging Face cache; the engine does not download: run tensorfold pull ${point.repo} first`)
  const resolved = io.llamaServer !== undefined ? { found: true as const, binary: io.llamaServer, pinned: true, ...(await readLlamaServerVersion(io.llamaServer, env)) } : await resolveLlamaServer({ env, platform, ...(io.home !== undefined ? { home: io.home } : {}) })
  if (!resolved.found) throw refusal(resolved.refused ?? 'llama.cpp is not installed on this machine; /tensorfold installs it')
  const llamaBinary = resolved.binary
  const fit = admission(point, args.window, args.promptCacheGib, totalmem())
  if (fit.line !== undefined) throw refusal(fit.line)
  const keys = args.apiKeyFile !== undefined ? readKeyFile(args.apiKeyFile) : undefined
  const name = args.name ?? point.shortName
  const llama: LlamaServerVersion = { ...(resolved.version !== undefined ? { version: resolved.version } : {}), ...(resolved.build !== undefined ? { build: resolved.build } : {}), ...(resolved.commit !== undefined ? { commit: resolved.commit } : {}) }
  const facts: RuntimeFacts = { llama }
  const chip = cpuModelWords()
  const model = ggufPaths(root, point.gguf).snapshotFile
  const innerPort = await freePort()
  const begun = Date.now()
  let state: FrontState = 'loading'
  let inFlight = 0
  let lastTimings: Rec | undefined
  let lastRss: { at: number; bytes: number | undefined } = { at: 0, bytes: undefined }
  let child: ChildProcess | undefined
  let lastChildLine = ''
  let exitCode: number | undefined
  let served = args.window

  const front: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${args.host}:${args.port}`)
    const path = url.pathname
    response.setHeader('server', `Mercury-TensorFold-adapter/${ADAPTER_VERSION}`)
    if (request.method === 'GET' && (path === '/health' || path === '/')) {
      if (state === 'loading') return json(response, 503, { status: 'loading', served_by: ADAPTER_SERVED_BY })
      if (state === 'draining') return json(response, 503, { status: 'draining', requests_in_progress: inFlight, served_by: ADAPTER_SERVED_BY })
      if (keys !== undefined) return json(response, 200, { status: 'ok', served_by: ADAPTER_SERVED_BY })
      if (child?.pid !== undefined && Date.now() - lastRss.at > 2_000) lastRss = { at: Date.now(), bytes: await rssBytes(child.pid, platform) }
      return json(response, 200, {
        status: 'ok',
        model: name,
        model_ids: [name],
        max_batch_size: 1,
        warming: false,
        memory: { active: lastRss.bytes ?? 0, cache: 0, peak: lastRss.bytes ?? 0 },
        live: { connections: inFlight, waiting: 0, decode_tokens_per_second: num(lastTimings?.predicted_per_second) ?? 0, prefill_tokens_per_second: num(lastTimings?.prompt_per_second) ?? 0 },
        version: ADAPTER_VERSION,
        backend: 'cpu',
        ...(chip !== undefined ? { device: chip } : {}),
        served_by: ADAPTER_SERVED_BY,
        engine: { name: 'llama.cpp', words: llamaCppWords(llama), ...llama, binary: llamaBinary },
      })
    }
    if (keys !== undefined && !keys.some(key => request.headers.authorization === `Bearer ${key}`)) {
      return json(response, 401, { error: { message: 'unauthorized: this server asks for a key', type: 'invalid_request_error', param: null, code: 'unauthorized' } })
    }
    if (state === 'loading') return json(response, 503, { error: { message: `${name} is still loading`, type: 'server_error', param: null, code: 'loading' } })
    if (request.method === 'GET' && path.endsWith('/models')) {
      return json(response, 200, { object: 'list', data: [{ id: name, object: 'model', created: Math.round(begun / 1000), owned_by: 'tensorfold', served_by: ADAPTER_SERVED_BY, context_length: served, max_model_len: served, reasoning: { default_enabled: true, supported_efforts: [...ADAPTER_EFFORTS] } }] })
    }
    if (request.method === 'GET' && (path === '/memory' || path === '/v1/memory')) {
      if (child?.pid !== undefined && Date.now() - lastRss.at > 2_000) lastRss = { at: Date.now(), bytes: await rssBytes(child.pid, platform) }
      return json(response, 200, { schema_version: 1, context_window: served, context_fitted: served !== args.window, process: { source: 'adapter_rss', physical_footprint_bytes: lastRss.bytes ?? 0 }, served_by: ADAPTER_SERVED_BY })
    }
    if (request.method === 'POST' && path.endsWith('/chat/completions')) {
      if (state === 'draining') return json(response, 503, { error: { message: 'the server is shutting down', type: 'server_error', param: null, code: 'draining' } })
      let body: Rec | undefined
      try {
        body = rec(JSON.parse(await readBody(request)))
      } catch {
        body = undefined
      }
      if (body === undefined) return json(response, 400, { error: { message: 'the request body is not a JSON object', type: 'invalid_request_error', param: null, code: 'invalid_json' } })
      const translated = translateRequest(body)
      const requestFacts: RuntimeFacts = { ...facts, ...(translated.effort !== undefined ? { effort: translated.effort } : {}), ...(translated.thinking !== undefined ? { thinking: translated.thinking } : {}) }
      const payload = JSON.stringify(translated.body)
      inFlight += 1
      const upstream = httpRequest({ host: '127.0.0.1', port: innerPort, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), accept: String(request.headers.accept ?? '*/*') } }, reply => {
        const streaming = String(reply.headers['content-type'] ?? '').includes('text/event-stream')
        if (streaming) {
          response.writeHead(reply.statusCode ?? 200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
          const transformer = new SseTransformer(requestFacts, timings => {
            lastTimings = timings
          })
          reply.setEncoding('utf8')
          reply.on('data', (text: string) => response.write(transformer.push(text)))
          reply.on('end', () => {
            response.write(transformer.flush())
            response.end()
            inFlight -= 1
          })
          reply.on('error', () => {
            response.end()
            inFlight -= 1
          })
          return
        }
        const parts: Buffer[] = []
        reply.on('data', chunk => parts.push(chunk as Buffer))
        reply.on('end', () => {
          inFlight -= 1
          const text = Buffer.concat(parts).toString('utf8')
          let parsed: Rec | undefined
          try {
            parsed = rec(JSON.parse(text))
          } catch {
            parsed = undefined
          }
          if (parsed === undefined) {
            response.writeHead(reply.statusCode ?? 502, { 'content-type': String(reply.headers['content-type'] ?? 'application/json') })
            response.end(text)
            return
          }
          const timings = rec(parsed.timings)
          if (timings !== undefined) lastTimings = timings
          json(response, reply.statusCode ?? 200, translateReply(parsed, requestFacts))
        })
        reply.on('error', () => {
          inFlight -= 1
          response.end()
        })
      })
      upstream.on('error', error => {
        inFlight -= 1
        if (!response.headersSent) json(response, 502, { error: { message: `llama.cpp did not answer: ${error.message}`, type: 'server_error', param: null, code: 'upstream' } })
        else response.end()
      })
      let cut = false
      const dropped = (): void => {
        if (response.writableEnded || cut) return
        cut = true
        upstream.destroy()
        say(`[${ADAPTER_SPEAKER}] the client dropped the reply; the request to llama.cpp was cut`)
      }
      response.on('close', dropped)
      request.socket.on('close', dropped)
      upstream.end(payload)
      return
    }
    json(response, 404, { error: { message: `unknown path ${path}`, type: 'invalid_request_error', param: null, code: 'not_found' } })
  })

  await new Promise<void>((resolve, reject) => {
    front.once('error', (error: NodeJS.ErrnoException) => reject(new ServeRefusal(`${ADAPTER_SPEAKER}: cannot listen on ${args.host}:${args.port} (${error.code === 'EADDRINUSE' ? 'AddressInUse' : (error.code ?? 'BindFailed')})`)))
    front.listen(args.port, args.host, () => resolve())
  })

  await reapStaleChild(args.port, platform, say)
  const launch = io.spawnImpl ?? spawn
  child = launch(llamaBinary, llamaServerArgs(model, name, args.window, innerPort, args.promptCacheGib), { env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  if (child.pid !== undefined) rememberChild(args.port, child.pid)
  const take = (chunk: Buffer | string): void => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      lastChildLine = trimmed
      say(`${ADAPTER_CHILD_PREFIX}${trimmed}`)
    }
  }
  child.stdout?.on('data', take)
  child.stderr?.on('data', take)
  const drainSeconds = io.drainSeconds ?? Number(env.TF_DRAIN_S ?? 20)
  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    state = 'draining'
    say(`shutting down (${signal}): draining: new requests get 503; ${inFlight} request(s) in progress may finish within ${drainSeconds.toFixed(1)} s`)
    const deadline = Date.now() + drainSeconds * 1000
    const finish = (): void => {
      front.close()
      const running = child
      if (running === undefined || running.exitCode !== null || running.signalCode !== null) {
        say('shutting down: drained')
        process.exit(exitCode ?? 0)
      }
      running.kill()
      const hard = setTimeout(() => running.kill('SIGKILL'), 3_000)
      running.once('exit', () => {
        clearTimeout(hard)
        say('shutting down: drained')
        process.exit(exitCode ?? 0)
      })
    }
    const tick = (): void => {
      if (inFlight === 0 || Date.now() >= deadline) finish()
      else setTimeout(tick, 100)
    }
    tick()
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('exit', () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill()
    rmSync(childPidFile(args.port), { force: true })
  })
  process.on('uncaughtException', error => {
    say(`${ADAPTER_SPEAKER}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  })
  child.once('exit', (code, signal) => {
    if (stopping) return
    exitCode = code ?? 1
    say(`${ADAPTER_SPEAKER}: llama.cpp exited${signal !== null ? ` on ${signal}` : ` ${code ?? ''}`}${lastChildLine !== '' ? ` · ${lastChildLine}` : ''}`)
    front.close()
    process.exit(exitCode)
  })
  child.once('error', error => {
    if (stopping) return
    exitCode = 1
    say(`${ADAPTER_SPEAKER}: llama.cpp could not start: ${error.message}`)
    front.close()
    process.exit(1)
  })
  const poll = io.readyPollMs ?? 250
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return exitCode ?? 1
    if (await innerHealthy(innerPort)) break
    await new Promise(resolve => setTimeout(resolve, poll))
  }
  served = (await innerContext(innerPort)) ?? args.window
  state = 'ready'
  say(`serving ${name} at http://${args.host}:${args.port}/v1 (Mercury's engine: ${llamaCppWords(llama)} on the CPU; context: ${served}; prompt cache: ${args.promptCacheGib} GiB; loaded in ${((Date.now() - begun) / 1000).toFixed(1)}s)`)
  return new Promise<number>(() => undefined)
}
