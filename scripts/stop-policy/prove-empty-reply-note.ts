#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
export const REPO = resolve(join(import.meta.dir, '..', '..'))
export const DIST = resolve(arg('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const NODE = join(dirname(DIST), 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')

export const EMPTY_REPLY_ASK = 'read the readme, then say what it holds'
export const EMPTY_REPLY_END = 'done: the readme holds one heading'
export const EMPTY_REPLY_NOTE_WORDS = 'returned an empty reply'
export const ZAI_SILENCE_WORDS = 'finished this response with nothing said'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

export type Dialect = 'responses' | 'chat'
export type Captured = { n: number; dialect: Dialect; path: string; body: Record<string, unknown>; at: number }
export type EmptyReplyFixture = { base: string; captured: Captured[]; close: () => Promise<void> }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

const OPENAI_MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}

type Turn = { call: { id: string; name: string; args: string } } | { empty: true } | { text: string }

function responsesSse(turn: Turn, n: number): string {
  const out: string[] = [sse({ type: 'response.created', response: { id: `resp_${n}` } })]
  if ('call' in turn) {
    const itemId = `fc_${n}`
    out.push(sse({ type: 'response.output_item.added', item: { type: 'function_call', id: itemId, call_id: turn.call.id, name: turn.call.name, arguments: '' } }))
    out.push(sse({ type: 'response.function_call_arguments.delta', item_id: itemId, delta: turn.call.args }))
    out.push(sse({ type: 'response.output_item.done', item: { type: 'function_call', id: itemId, call_id: turn.call.id, name: turn.call.name, arguments: turn.call.args } }))
  } else if ('text' in turn) {
    out.push(sse({ type: 'response.output_text.delta', delta: turn.text }))
    out.push(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.text }] } }))
  }
  out.push(sse({ type: 'response.completed', response: { id: `resp_${n}`, usage: { input_tokens: 8, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } }))
  return out.join('')
}

function chatSse(turn: Turn): string {
  const out: string[] = []
  const usage = { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }
  const chunk = (delta: Record<string, unknown>, finish: string | null, withUsage = false): string =>
    sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...(withUsage ? { usage } : {}) })
  if ('call' in turn) {
    out.push(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: turn.call.id, type: 'function', function: { name: turn.call.name, arguments: turn.call.args } }] }, null))
    out.push(chunk({}, 'tool_calls', true))
  } else if ('text' in turn) {
    out.push(chunk({ role: 'assistant', content: turn.text }, null))
    out.push(chunk({}, 'stop', true))
  } else {
    out.push(chunk({ role: 'assistant' }, 'stop', true))
  }
  out.push('data: [DONE]\n\n')
  return out.join('')
}

export async function startEmptyReplyFixture(readmePath: string): Promise<EmptyReplyFixture> {
  const captured: Captured[] = []
  const counts: Record<Dialect, number> = { responses: 0, chat: 0 }
  const turnFor = (dialect: Dialect): Turn => {
    const n = ++counts[dialect]
    if (n === 1) return { call: { id: `call_${dialect}_1`, name: 'Read', args: JSON.stringify({ file_path: readmePath }) } }
    if (n === 2) return { empty: true }
    return { text: EMPTY_REPLY_END }
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(path.startsWith('/openai/') ? JSON.stringify(OPENAI_MODELS_BODY) : JSON.stringify({ object: 'list', data: [] }))
        return
      }
      const dialect: Dialect | undefined = path.endsWith('/responses') ? 'responses' : path.endsWith('/chat/completions') ? 'chat' : undefined
      if (req.method !== 'POST' || dialect === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
      }
      captured.push({ n: captured.length + 1, dialect, path, body, at: Date.now() })
      const turn = turnFor(dialect)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(dialect === 'responses' ? responsesSse(turn, counts[dialect]) : chatSse(turn))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    captured,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

export function routeEnv(base: string, home: string, config: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: config,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'product-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_AUTO_COMPACT: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    BROWSER: '/usr/bin/true',
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
    ANTHROPIC_BASE_URL: `${base}/anthropic`,
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
    MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
    OPENAI_API_KEY: 'fixture-openai-key',
    MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
    ZAI_API_KEY: 'fixture-zai-key',
  }
}

export const ROUTES: ReadonlyArray<{ route: string; model: string; dialect: Dialect }> = [
  { route: 'openai', model: 'gpt-5.6-sol', dialect: 'responses' },
  { route: 'zai', model: 'glm-5.2', dialect: 'chat' },
]

type Frame = Record<string, unknown>
function assistantTexts(frames: Frame[]): string[] {
  const out: string[] = []
  for (const f of frames) {
    if (f.type !== 'assistant') continue
    const content = (f.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out
}
function inputOf(c: Captured): unknown[] {
  const b = c.body
  if (Array.isArray(b.input)) return b.input as unknown[]
  if (Array.isArray(b.messages)) return b.messages as unknown[]
  return []
}

async function runRoute(route: { route: string; model: string; dialect: Dialect }): Promise<void> {
  section(`the ${route.route} route: a zero-content reply after a tool result`)
  const home = join(tmpdir(), `mercury-empty-reply-${route.route}-${process.pid}`)
  rmSync(home, { recursive: true, force: true })
  const cwd = join(home, 'work')
  const config = join(home, 'config')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(config, { recursive: true })
  const readme = join(cwd, 'README.md')
  writeFileSync(readme, '# fixture\n')
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  seedFirstRun(config, [cwd])
  writeFileSync(join(config, 'settings.json'), '{}')
  const fixture = await startEmptyReplyFixture(readme)
  const env = routeEnv(fixture.base, home, config)
  const proc = spawn(existsSync(NODE) ? NODE : 'node', [DIST, '-p', '--model', route.model, '--allowed-tools', 'Read', '--output-format', 'stream-json', EMPTY_REPLY_ASK], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', chunk => { stdout += String(chunk) })
  proc.stderr.on('data', chunk => { stderr += String(chunk) })
  const watchdog = setTimeout(() => { stderr += '\nthe proof deadline passed\n'; proc.kill('SIGTERM') }, vshotBudgetMs(120_000))
  const exit = await new Promise<number | null>((done, reject) => { proc.once('exit', done); proc.once('error', reject) })
  clearTimeout(watchdog)
  await fixture.close()
  const frames = stdout.split('\n').filter(line => line.startsWith('{')).flatMap(line => {
    try { return [JSON.parse(line) as Frame] } catch { return [] }
  })
  const result = frames.find(f => f.type === 'result')
  const resultText = String(result?.result ?? '')
  const texts = assistantTexts(frames)
  const requests = fixture.captured.filter(c => c.dialect === route.dialect)
  const tail = stderr.split('\n').filter(l => l.trim() !== '').slice(-4).join(' | ')
  check(`${route.route}: the turn settled with a result`, exit === 0 && result !== undefined, `exit ${String(exit)} ${tail}`)
  if (route.route === 'zai') {
    check(`${route.route}: the tool round ran and the second request finished with no words`, requests.length === 2 && requests[1] !== undefined, `${requests.length} request(s)`)
    check(`${route.route}: a visible note says the provider finished this response with nothing said`, texts.some(t => t.includes(ZAI_SILENCE_WORDS)), JSON.stringify(texts).slice(0, 300))
    check(`${route.route}: the note is not the old cut wording`, !texts.some(t => t.includes(EMPTY_REPLY_NOTE_WORDS)), JSON.stringify(texts).slice(0, 300))
    check(`${route.route}: silence is not re-issued`, requests.length === 2, `${requests.length} request(s)`)
    check(`${route.route}: the turn's result is the silence note, the turn's end`, resultText.includes(ZAI_SILENCE_WORDS), `result: ${JSON.stringify(resultText.slice(0, 200))}`)
  } else {
    const { EMPTY_REPLY_RECOVERY_NUDGE } = await import('../../src/services/api/errors.ts')
    const needle = JSON.stringify(EMPTY_REPLY_RECOVERY_NUDGE).slice(1, -1)
    const second = requests[1] === undefined ? [] : inputOf(requests[1])
    const third = requests[2] === undefined ? [] : inputOf(requests[2])
    const lastItem = third.at(-1) as { role?: unknown } | undefined
    check(`${route.route}: the tool round ran and the second request answered empty`, requests.length >= 2 && (requests[1] !== undefined) , `${requests.length} request(s)`)
    check(`${route.route}: a visible note says the provider returned an empty reply`, texts.some(t => t.includes(EMPTY_REPLY_NOTE_WORDS)), JSON.stringify(texts).slice(0, 300))
    check(`${route.route}: the request was re-issued once, with the nudge as its last user turn after the tool result`, requests.length === 3 && lastItem?.role === 'user' && JSON.stringify(lastItem).includes(needle) && !JSON.stringify(second).includes(needle), `${requests.length} request(s); last input item: ${JSON.stringify(lastItem).slice(0, 300)}`)
    check(`${route.route}: the re-issue is not byte-identical to the empty-answered request`, requests.length === 3 && JSON.stringify(third) !== JSON.stringify(second), `${requests.length} request(s)`)
    check(`${route.route}: the turn's result is the model's answer from the re-issue, not silence`, resultText === EMPTY_REPLY_END, `result: ${JSON.stringify(resultText.slice(0, 200))}`)
  }
  if (failures === 0) rmSync(home, { recursive: true, force: true })
  else console.log(`  [forensics] the world stays at ${home}\n${stderr.split('\n').slice(-8).join('\n')}`)
}

if (import.meta.main) {
  for (const route of ROUTES) await runRoute(route)
  console.log(`\n${checks} checks, ${failures} failures`)
  console.log(failures === 0 ? 'prove-empty-reply-note: ALL LAWS HOLD' : `prove-empty-reply-note: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
