#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FAKE_TENSORFOLD_VERSION = '1.2.2'
export const FAKE_TENSORFOLD_CHIP = 'apple-m5'
export const FAKE_LIBJPEG_WARNING = 'warning: libturbojpeg.0.dylib is not libjpeg-turbo 3.1.4.1; JPEG images are refused until it is'
export const FAKE_REPLY_PREFIX = 'fake TensorFold says: '
export const FAKE_TOKENS_PER_SECOND = 110
export const FAKE_FIRST_TOKEN_SECONDS = 0.04

const args = process.argv.slice(2)
const env = process.env
const cacheRoot = env.FAKE_TENSORFOLD_CACHE ?? join(env.HOME ?? '/tmp', '.cache', 'huggingface', 'hub')

function capabilities(): string {
  return JSON.stringify({
    schema: 1,
    engine: 'zig',
    version: FAKE_TENSORFOLD_VERSION,
    chip: FAKE_TENSORFOLD_CHIP,
    backends: [env.FAKE_TENSORFOLD_BACKEND ?? 'metal'],
    families: {
      qwen3_5: ['mlx-q4g32', 'mlx-q4g64', 'mlx-q8g64'],
      nemotron_h: ['mlx-q4g64', 'mlx-q8g64'],
      gemma4: ['mlx-q4g64'],
    },
    serve: { flags: { '--port': {}, '--name': {}, '--context': {}, '--drafter': {}, '--prompt-cache-gib': {}, '--api-key-file': {}, '--host': {}, '--parallel': {} } },
    env: ['TENSORFOLD_API_KEY', 'TENSORFOLD_NO_LIVE', 'HF_HOME', 'HF_HUB_CACHE'],
    optional_libraries: [
      { name: 'libjpeg-turbo', feature: 'JPEG inputs (--vision)', soname: 'libturbojpeg.0.dylib', found: true, usable: false, problem: 'JPEG images need libjpeg-turbo 3.1.4.1 (libturbojpeg); the library has another release, whose pixels can differ' },
      { name: 'TensorFold grammar', feature: 'structured output and required tool calls (HTTP 400 when missing)', soname: 'libtfgrammar.dylib', found: true, usable: null, problem: null },
    ],
    profiles: { default: 'stable', available: ['stable'] },
  })
}

function cacheDir(repo: string): string {
  return join(cacheRoot, `models--${repo.replace('/', '--')}`)
}

function snapshotOf(repo: string): string | undefined {
  const base = cacheDir(repo)
  try {
    const main = readFileSync(join(base, 'refs', 'main'), 'utf8').trim()
    return existsSync(join(base, 'snapshots', main, 'config.json')) ? join(base, 'snapshots', main) : undefined
  } catch {
    return undefined
  }
}

function fail(line: string, code = 1): never {
  process.stderr.write(`tensorfold: ${line}\n`)
  process.exit(code)
}

async function pull(spec: string): Promise<void> {
  const [repo, revision] = spec.split('@')
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    process.stderr.write(`${spec} is not a Hugging Face repo id (owner/name)\n`)
    process.exit(2)
  }
  const sha = revision ?? 'fakefakefakefakefakefakefakefakefakefake'
  const base = cacheDir(repo)
  const blobs = join(base, 'blobs')
  mkdirSync(blobs, { recursive: true })
  const total = Number(env.FAKE_TENSORFOLD_PULL_BYTES ?? 2_000_000)
  const steps = Number(env.FAKE_TENSORFOLD_PULL_STEPS ?? 10)
  const stepMs = Number(env.FAKE_TENSORFOLD_PULL_STEP_MS ?? 100)
  const blob = join(blobs, 'weightsblob')
  const partial = `${blob}.incomplete`
  process.stdout.write(`[tensorfold] downloading ${repo}@${revision ?? 'main'} from Hugging Face\n`)
  let have = existsSync(partial) ? statSync(partial).size : existsSync(blob) ? total : 0
  let stopping = false
  process.on('SIGTERM', () => {
    stopping = true
  })
  while (have < total) {
    if (stopping) process.exit(143)
    const next = Math.min(total, have + Math.ceil(total / steps))
    writeFileSync(partial, Buffer.alloc(next))
    have = next
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
  if (existsSync(partial)) renameSync(partial, blob)
  const snapshot = join(base, 'snapshots', sha)
  mkdirSync(snapshot, { recursive: true })
  mkdirSync(join(base, 'refs'), { recursive: true })
  writeFileSync(join(base, 'refs', 'main'), sha)
  writeFileSync(join(snapshot, 'config.json'), JSON.stringify({ model_type: env.FAKE_TENSORFOLD_MODEL_TYPE ?? 'qwen3_5', max_position_embeddings: 262144, num_hidden_layers: 24, num_key_value_heads: 2, head_dim: 256, full_attention_interval: 4 }))
  if (!existsSync(join(snapshot, 'model.safetensors'))) symlinkSync(join('..', '..', 'blobs', 'weightsblob'), join(snapshot, 'model.safetensors'))
  process.stdout.write(`[tensorfold] ${repo}: ${total} bytes on disk\n`)
}

function flagValue(name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

function readKeyFile(path: string): string {
  const line = readFileSync(path, 'utf8').split('\n').find(row => row.trim() !== '' && !row.trim().startsWith('#'))
  if (line === undefined) fail(`${path} holds no key`, 2)
  const colon = line.indexOf(':')
  return (colon >= 0 ? line.slice(colon + 1) : line).trim()
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let text = ''
    request.on('data', chunk => {
      text += String(chunk)
    })
    request.on('end', () => resolve(text))
  })
}

async function serve(): Promise<void> {
  const repo = args[1]
  if (!repo) fail('serve needs a model', 2)
  const mode = env.FAKE_TENSORFOLD_SERVE ?? 'ok'
  const port = Number(flagValue('--port') ?? 8080)
  const asked = flagValue('--host') ?? '127.0.0.1'
  const host = env.FAKE_TENSORFOLD_BIND_LOOPBACK === '1' ? '127.0.0.1' : asked
  const name = flagValue('--name') ?? repo.slice(repo.lastIndexOf('/') + 1)
  const context = Number(flagValue('--context') ?? 32768)
  const loadMs = Number(env.FAKE_TENSORFOLD_LOAD_MS ?? 300)
  const keyFile = flagValue('--api-key-file')
  const key = keyFile === undefined ? undefined : readKeyFile(keyFile)
  if (snapshotOf(repo) === undefined && env.FAKE_TENSORFOLD_CACHE !== undefined) fail(`${repo} is not in the Hugging Face cache; the native engine does not download: run tensorfold pull ${repo} first`)
  await new Promise(resolve => setTimeout(resolve, loadMs))
  if (mode === 'refuse-memory') fail(`qwen3_5: one stream at a ${context}-token window takes ${(context / 16384).toFixed(2)} GiB, more than the 5.12 GiB left under the load limit; lower --context`)
  if (mode === 'refuse-27b') fail(`--parallel 1 needs 8.00 GiB for its streams and 8-row prompt scratch at a ${context}-token context; 5.12 GiB remains beside the weights and an 8 GiB margin: lower --parallel or --context`)
  if (mode === 'refuse-cache') fail(`--prompt-cache-gib 1 would take this server past 70% of this Mac's memory: it holds 6.0 GiB once loaded, 70% of 8 GiB is 5.6 GiB, and 2 GiB stays free for prompt buffers, so 0 GiB is left for kept prompt states. Pass a smaller one, leave --prompt-cache-gib out for the default 0 GiB, or add --prompt-cache-over-cap to keep 1 GiB anyway.`)
  if (mode === 'exit-9') {
    process.stderr.write(`serving ${name} at http://${host}:${port}/v1 (loaded in 0.3s)\n`)
    process.kill(process.pid, 'SIGKILL')
  }
  let draining = false
  let inFlight = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`)
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      if (draining) return json(response, 503, { status: 'draining', requests_in_progress: inFlight })
      if (key !== undefined) return json(response, 200, { status: 'ok' })
      return json(response, 200, { status: 'ok', model: name, model_ids: [name], max_batch_size: 8, warming: false, memory: { active: 3_015_330_576, cache: 0, peak: 3_015_330_576 }, live: { connections: inFlight, waiting: 0, decode_tokens_per_second: 0, prefill_tokens_per_second: 0 }, version: FAKE_TENSORFOLD_VERSION, backend: 'metal', device: 'Apple M5 Pro' })
    }
    if (key !== undefined && request.headers.authorization !== `Bearer ${key}`) return json(response, 401, { error: { message: 'unauthorized: this server asks for a key', type: 'invalid_request_error', param: null, code: 'unauthorized' } })
    if (request.method === 'GET' && url.pathname.endsWith('/models')) {
      return json(response, 200, { object: 'list', data: [{ id: name, object: 'model', created: 1_700_000_000, owned_by: 'tensorfold', context_length: context, max_model_len: context, reasoning: { default_enabled: true, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'] } }] })
    }
    if (request.method === 'GET' && (url.pathname === '/memory' || url.pathname === '/v1/memory')) {
      return json(response, 200, { schema_version: 1, context_window: context, context_fitted: false, process: { source: 'darwin_rusage_info_v4', physical_footprint_bytes: 3_015_330_576 } })
    }
    if (request.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      if (draining) return json(response, 503, { error: { message: 'the server is shutting down', type: 'server_error', param: null, code: 'draining' } })
      inFlight += 1
      const body = await readBody(request)
      let prompt = ''
      let stream = false
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }>; stream?: boolean }
        const last = parsed.messages?.filter(m => m.role === 'user').pop()
        prompt = typeof last?.content === 'string' ? last.content : Array.isArray(last?.content) ? (last!.content as Array<{ text?: string }>).map(part => part.text ?? '').join(' ') : ''
        stream = parsed.stream === true
      } catch {
        prompt = ''
      }
      const text = `${FAKE_REPLY_PREFIX}${prompt.split('\n')[0]?.slice(0, 60) ?? ''}`
      const usage = { prompt_tokens: 18, completion_tokens: 3, total_tokens: 21, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } }
      const runtime = { tensorfold: { enable_thinking: false, reasoning_effort: 'none', engine: 'zig', tokens_per_second: FAKE_TOKENS_PER_SECOND, time_to_first_token: FAKE_FIRST_TOKEN_SECONDS, prefill_seconds: 0.02 } }
      const id = 'chatcmpl-fake'
      if (!stream) {
        inFlight -= 1
        return json(response, 200, { id, object: 'chat.completion', created: 1_700_000_000, model: name, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage, ...runtime })
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}): string => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1_700_000_000, model: name, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
      response.write(chunk({ role: 'assistant' }, null))
      for (const word of text.split(' ')) {
        response.write(chunk({ content: `${word} ` }, null))
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      response.write(chunk({}, 'stop', runtime))
      response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1_700_000_000, model: name, choices: [], usage })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
      inFlight -= 1
      return
    }
    json(response, 404, { error: { message: `unknown path ${url.pathname}` } })
  })
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') fail(`cannot listen on ${host}:${port} (AddressInUse)`)
    fail(`cannot listen on ${host}:${port} (${error.code ?? 'BindFailed'})`)
  })
  server.listen(port, host, () => {
    process.stderr.write(`serving ${name} at http://${asked}:${port}/v1 (sampling: default; drafts: none; context: ${context}; loaded in ${(loadMs / 1000).toFixed(1)}s)\n`)
  })
  const stop = (signal: string): void => {
    if (draining) process.exit(0)
    draining = true
    process.stderr.write(`shutting down (${signal}): draining: new requests get 503; ${inFlight} request(s) in progress may finish within ${env.TF_DRAIN_S ?? '20'}.0 s\n`)
    setTimeout(() => {
      server.close()
      process.stderr.write('shutting down: drained\n')
      process.exit(0)
    }, Number(env.FAKE_TENSORFOLD_DRAIN_MS ?? 100))
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

if (!import.meta.main) {
} else if (args[0] === '--version') {
  process.stdout.write(`tensorfold-native ${FAKE_TENSORFOLD_VERSION}\n`)
} else if (args[0] === 'capabilities' && args[1] === '--json' && args.length === 2) {
  process.stderr.write(`${FAKE_LIBJPEG_WARNING}\n`)
  process.stdout.write(`${capabilities()}\n`)
} else if (args[0] === 'models') {
  if (args.length > 1) {
    process.stderr.write('usage: tensorfold models\n')
    process.exit(2)
  }
  const rows = existsSync(cacheRoot) ? readdirSync(cacheRoot).filter(name => name.startsWith('models--')) : []
  if (rows.length === 0) process.stdout.write(`no checkpoints on disk: the Hugging Face cache at ${cacheRoot} does not exist yet; run: tensorfold pull OWNER/NAME\n`)
  for (const row of rows) process.stdout.write(`${row.slice('models--'.length).replace('--', '/')}: Qwen3.5-2B or Qwen3.8-27B (qwen3_5)\n`)
} else if (args[0] === 'info') {
  const repo = args[1] ?? ''
  const snapshot = snapshotOf(repo)
  if (snapshot === undefined) {
    process.stderr.write(`${repo} is not in the Hugging Face cache; run: tensorfold pull ${repo}\n`)
    process.exit(1)
  }
  const bytes = statSync(join(snapshot, 'model.safetensors')).size
  process.stdout.write(`family: Qwen3.5-2B or Qwen3.8-27B (qwen3_5)\nformat: 4-bit, group 64\nweights: ${(bytes / 1024 ** 3).toFixed(2)} GiB (${bytes} bytes)\nmemory floor: ${(bytes / 1024 ** 3 + 2).toFixed(2)} GiB (weights plus a 2.00 GiB runtime margin)\n`)
} else if (args[0] === 'pull') {
  await pull(args[1] ?? '')
} else if (args[0] === 'serve') {
  await serve()
} else {
  process.stderr.write('usage: tensorfold --version | capabilities --json | models | info MODEL | pull REPO[@REVISION] | serve MODEL [flags]\n')
  process.exit(2)
}
