import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..', '..')
const distArg = process.argv.indexOf('--dist')
if (distArg >= 0 && (!process.argv[distArg + 1] || process.argv[distArg + 1]!.startsWith('--'))) throw new Error('--dist needs a built mercury.mjs path.')
export const dist = distArg < 0 ? join(root, 'dist', 'mercury.mjs') : resolve(process.argv[distArg + 1]!)
export function nodeFor(distPath: string): string {
  const vendored = join(dirname(distPath), 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
  return existsSync(vendored) ? vendored : Bun.which('node') ?? 'node'
}

export const LOCAL_FIXTURE_MODEL = 'qwen3.5-2b'
const LOCAL_FIXTURE_WINDOW = 32768
const CLOUD_FIXTURE_MODEL = 'glm-5.3'

export type ScriptedReply =
  | { kind: 'text'; text: string }
  | { kind: 'tool_calls'; calls: Array<{ name: string; args: Record<string, unknown> }> }

export interface ChatFunction {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }>
  tools?: Array<{ type: string; function: ChatFunction }>
}

interface RoadCapture {
  requests: ChatRequest[]
  code: number | null
  stdout: string
  stderr: string
  home: string
  cwd: string
  normalize(value: string): string
}

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

function replyBody(reply: ScriptedReply, n: number): string {
  const usage = { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 }
  const done = [sse({ id: `chat_${n}`, object: 'chat.completion.chunk', choices: [], usage }), 'data: [DONE]\n\n']
  if (reply.kind === 'text') {
    return [
      sse({ id: `chat_${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: reply.text } }] }),
      sse({ id: `chat_${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ...done,
    ].join('')
  }
  const calls = reply.calls.map((call, index) => ({ index, id: `call_${n}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }))
  return [
    sse({ id: `chat_${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: calls } }] }),
    sse({ id: `chat_${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ...done,
  ].join('')
}

const TENSORFOLD_MODELS = { object: 'list', data: [{ id: LOCAL_FIXTURE_MODEL, object: 'model', created: 1, owned_by: 'tensorfold', context_length: LOCAL_FIXTURE_WINDOW, max_model_len: LOCAL_FIXTURE_WINDOW, reasoning: { default_enabled: false } }] }

const FIXED_GIT_DATE = '2026-01-01T00:00:00Z'

export function seedProject(cwd: string, home: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true })
    writeFileSync(join(cwd, name), text)
  }
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com', GIT_AUTHOR_DATE: FIXED_GIT_DATE, GIT_COMMITTER_DATE: FIXED_GIT_DATE, HOME: join(home, 'user-home') }
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Dev'], ['config', 'user.email', 'dev@example.com'], ['add', ...Object.keys(files)], ['commit', '-q', '-m', 'Initial import']]) {
    execFileSync('git', args, { cwd, env: gitEnv, stdio: 'ignore' })
  }
  writeFileSync(join(home, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', numStartups: 10, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  writeFileSync(join(home, 'settings.json'), '{}')
}

export function scratchHome(prefix: string): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`))
  const cwd = mkdtempSync(join(tmpdir(), `${prefix}-project-`))
  mkdirSync(join(home, 'user-home'))
  return { home, cwd }
}

export function runEnv(home: string, extra: Record<string, string>, distPath: string = dist): Record<string, string> {
  return {
    HOME: join(home, 'user-home'),
    PATH: [dirname(nodeFor(distPath)), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(process.platform === 'win32' ? ';' : ':'),
    TERM: 'dumb', NO_COLOR: '1', LANG: 'en_US.UTF-8',
    MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0',
    ...extra,
  }
}

export function runMercury(args: string[], cwd: string, env: Record<string, string>, deadlineMs: number, distPath: string = dist): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolveRun => {
    const child = spawn(nodeFor(distPath), [distPath, ...args], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const deadline = setTimeout(() => child.kill('SIGKILL'), deadlineMs)
    child.on('close', code => { clearTimeout(deadline); resolveRun({ code, stdout, stderr }) })
  })
}

function normalizerFor(home: string, cwd: string): (value: string) => string {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return (value: string) => value
    .replaceAll(home, '<home>')
    .replaceAll(cwd, '<project>')
    .replaceAll(key, '<project-key>')
    .replace(/Scratchpad directory: \S+/g, 'Scratchpad directory: <scratchpad>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/Today's date is \d{4}-\d{2}-\d{2}/g, 'Today\'s date is <date>')
    .replace(/(Platform|Shell|OS Version): [^\n\\"]+/g, '$1: <machine>')
    .replace(/(capsule-digest:|generation )[0-9a-f]{6,}/g, '$1<digest>')
}

const POD_FIXTURE_MODEL = 'compat/pod-fixture/qwen3.8-27b'

function seedPod(home: string, base: string, engine: string): void {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ compatProvider: { 'pod-fixture': { baseUrl: `${base}/v1`, hostPodId: 'fixturepod', dialect: engine === 'vllm' ? 'vllm' : 'chat-completions', models: ['qwen3.8-27b'] } } }))
  mkdirSync(join(home, 'host', 'pods'), { recursive: true })
  mkdirSync(join(home, 'host', 'boxes'), { recursive: true })
  writeFileSync(join(home, 'host', 'pods', 'fixturepod.json'), JSON.stringify({ vendor: 'runpod', id: 'fixturepod', name: 'fixture pod', recipe: `fixture-${engine}`, price: 1.19, startedAt: FIXED_GIT_DATE, status: 'RUNNING', jobState: 'ready', recipeRow: { id: `fixture-${engine}`, engine } }))
  writeFileSync(join(home, 'host', 'boxes', 'pod-fixturepod.json'), JSON.stringify({ name: 'pod-fixturepod', kind: 'ssh', target: { host: '127.0.0.1', user: 'root', port: 22 }, os: 'linux', arch: 'x86_64', home: '/root', memoryGb: 32, unifiedMemory: false, gpus: [{ name: 'NVIDIA RTX 5090', memory: 32 }], engines: [{ kind: engine, path: `/workspace/mercury-host/fixture-${engine}/bin/${engine}`, version: '1.2.2', port: 8080 }], bankPaths: [], discoveredAt: FIXED_GIT_DATE }))
}

export async function captureRoad(options: {
  road: 'local' | 'zai' | 'pod' | 'llamacpp'
  podEngine?: string
  task: string
  reply: (request: ChatRequest, index: number) => ScriptedReply
  maxTurns: number
  mode?: string
  env?: Record<string, string>
  files?: Record<string, string>
  reuse?: { home: string; cwd: string }
}): Promise<RoadCapture> {
  const requests: ChatRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (request.method === 'GET' && options.road === 'llamacpp' && path === '/props') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ default_generation_settings: { n_ctx: LOCAL_FIXTURE_WINDOW }, build_info: 'fixture' }))
        return
      }
      if (request.method === 'GET' && path.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(options.road === 'local' ? TENSORFOLD_MODELS : options.road === 'pod' ? { object: 'list', data: [{ id: 'qwen3.8-27b', object: 'model', created: 1, owned_by: options.podEngine ?? 'tensorfold' }] } : options.road === 'llamacpp' ? { object: 'list', data: [{ id: LOCAL_FIXTURE_MODEL, object: 'model', created: 1, owned_by: 'llamacpp', meta: { n_ctx: LOCAL_FIXTURE_WINDOW } }] } : { data: [] }))
        return
      }
      if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequest
      requests.push(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(replyBody(options.reply(body, requests.length - 1), requests.length))
    })
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address unavailable')
  const base = `http://127.0.0.1:${address.port}`
  const { home, cwd } = options.reuse ?? scratchHome(`local-profile-${options.road}`)
  try {
    if (options.reuse === undefined) seedProject(cwd, home, options.files ?? { 'README.md': '# Fixture project\n', 'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node test.js' } }) })
    if (options.road === 'pod') seedPod(home, base, options.podEngine ?? 'tensorfold')
    const roadEnv: Record<string, string> = options.road === 'local'
      ? { MERCURY_LOCAL_BASE_URL: `${base}/v1` }
      : options.road === 'llamacpp'
        ? { MERCURY_LOCAL_PROBE_TARGETS: `llamacpp=${base}` }
        : options.road === 'pod'
          ? {}
          : { MERCURY_ZAI_API_BASE: `${base}/zai/v4`, ZAI_API_KEY: 'local-profile-fixture-key-not-real' }
    const model = options.road === 'local' || options.road === 'llamacpp' ? `local/${LOCAL_FIXTURE_MODEL}` : options.road === 'pod' ? POD_FIXTURE_MODEL : CLOUD_FIXTURE_MODEL
    const result = await runMercury(['run', options.task, '--model', model, '--format', 'rows', '--mode', options.mode ?? 'default', '--max-turns', String(options.maxTurns)], cwd, runEnv(home, { ...roadEnv, ...(options.env ?? {}) }), 120_000)
    return { requests, ...result, home, cwd, normalize: normalizerFor(home, cwd) }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
}

export function commitChange(cwd: string, home: string, file: string, text: string): void {
  writeFileSync(join(cwd, file), text)
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com', GIT_AUTHOR_DATE: FIXED_GIT_DATE, GIT_COMMITTER_DATE: FIXED_GIT_DATE, HOME: join(home, 'user-home') }
  for (const args of [['add', file], ['commit', '-q', '-m', `Change ${file}`]]) execFileSync('git', args, { cwd, env: gitEnv, stdio: 'ignore' })
}

export function systemTextOf(request: ChatRequest): string {
  return request.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('')
}

export function reminderTextsOf(request: ChatRequest): string[] {
  return request.messages
    .filter(message => message.role === 'user' && typeof message.content === 'string' && (message.content as string).startsWith('<system-reminder>'))
    .map(message => message.content as string)
}

export function toolNamesOf(request: ChatRequest): string[] {
  return (request.tools ?? []).map(tool => tool.function.name)
}

export async function tokenizedTokens(tokenizer: string, request: Pick<ChatRequest, 'model' | 'messages' | 'tools'>): Promise<number[] | undefined> {
  try {
    const response = await fetch(`${tokenizer.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: request.model, messages: request.messages, ...(request.tools !== undefined && request.tools.length > 0 ? { tools: request.tools } : {}) }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { tokens?: unknown }
    return Array.isArray(body.tokens) && body.tokens.every(token => typeof token === 'number') ? (body.tokens as number[]) : undefined
  } catch {
    return undefined
  }
}

export async function tokenizedCount(tokenizer: string, request: Pick<ChatRequest, 'model' | 'messages' | 'tools'>): Promise<number | undefined> {
  return (await tokenizedTokens(tokenizer, request))?.length
}

export function userContextReminderOf(request: ChatRequest): string {
  return reminderTextsOf(request).find(text => text.includes('# currentDate')) ?? ''
}
