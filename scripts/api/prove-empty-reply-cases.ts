#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

export const EMPTY_REPLY_CASES_ASK = 'say what the readme holds, in one line'
export const EMPTY_REPLY_CASES_END = 'the readme holds one heading'
export const EMPTY_REPLY_CASES_MODEL = 'gpt-5.6-sol'
export const CAP_REASONING_TOKENS = 127_900
export const SILENCE_REASONING_TOKENS = 21

export const SILENCE_WORDS = 'finished this response with nothing said'
export const CAP_WORDS = 'stopped this response at its output cap'
export const EMPTY_WORDS = 'returned an empty reply'
export const RESEND_WORDS = 'sending the same request again'

export type EmptyReplyCase = 'silence-reasoning' | 'silence-empty-message' | 'cap' | 'empty'
export const EMPTY_REPLY_CASES: readonly EmptyReplyCase[] = ['silence-reasoning', 'silence-empty-message', 'cap', 'empty']

export type Captured = { n: number; path: string; body: Record<string, unknown>; at: number }
export type CasesFixture = { base: string; captured: Captured[]; close: () => Promise<void> }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

const OPENAI_MODELS_BODY = {
  models: [
    {
      slug: EMPTY_REPLY_CASES_MODEL,
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

const reasoningItem = (n: number) => ({
  type: 'reasoning',
  id: `rs_${n}`,
  summary: [],
  content: [],
  encrypted_content: `sealed-${n}`,
})
const emptyMessageItem = (n: number) => ({
  type: 'message',
  id: `msg_${n}`,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: '', annotations: [] }],
})

export function responsesSseFor(kind: EmptyReplyCase, n: number, answerText?: string): string {
  const id = `resp_${n}`
  const out: string[] = [sse({ type: 'response.created', response: { id } })]
  if (answerText !== undefined) {
    out.push(sse({ type: 'response.output_text.delta', delta: answerText }))
    out.push(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answerText }] } }))
    out.push(sse({ type: 'response.completed', response: { id, usage: { input_tokens: 8, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } }))
    return out.join('')
  }
  if (kind === 'silence-reasoning' || kind === 'silence-empty-message') {
    out.push(sse({ type: 'response.output_item.added', item: reasoningItem(n) }))
    out.push(sse({ type: 'response.output_item.done', item: reasoningItem(n) }))
    if (kind === 'silence-empty-message') {
      out.push(sse({ type: 'response.output_item.added', item: emptyMessageItem(n) }))
      out.push(sse({ type: 'response.output_item.done', item: emptyMessageItem(n) }))
    }
    out.push(sse({
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        usage: { input_tokens: 337_129, output_tokens: 27, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: SILENCE_REASONING_TOKENS } },
      },
    }))
    return out.join('')
  }
  if (kind === 'cap') {
    out.push(sse({ type: 'response.output_item.added', item: reasoningItem(n) }))
    out.push(sse({ type: 'response.output_item.done', item: reasoningItem(n) }))
    out.push(sse({
      type: 'response.incomplete',
      response: {
        id,
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 337_129, output_tokens: 128_000, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: CAP_REASONING_TOKENS } },
      },
    }))
    return out.join('')
  }
  out.push(sse({ type: 'response.completed', response: { id, usage: { input_tokens: 8, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } }))
  return out.join('')
}

export async function startCasesFixture(kind: EmptyReplyCase): Promise<CasesFixture> {
  const captured: Captured[] = []
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
      if (req.method !== 'POST' || !path.endsWith('/responses')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
      }
      const n = captured.length + 1
      captured.push({ n, path, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesSseFor(kind, n, kind === 'empty' && n >= 2 ? EMPTY_REPLY_CASES_END : undefined))
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

export function casesEnv(base: string, home: string, config: string): NodeJS.ProcessEnv {
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
  }
}

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
export function persistedNotices(config: string): string[] {
  const out: string[] = []
  const projects = join(config, 'projects')
  if (!existsSync(projects)) return out
  for (const slug of readdirSync(projects)) {
    const dir = join(projects, slug)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (!line.startsWith('{')) continue
        try {
          const record = JSON.parse(line) as { payload?: { kind?: string; content?: unknown } }
          if (record.payload?.kind === 'notice' && typeof record.payload.content === 'string') out.push(record.payload.content)
        } catch {
        }
      }
    }
  }
  return out
}
function inputOf(c: Captured): unknown[] {
  const b = c.body
  return Array.isArray(b.input) ? (b.input as unknown[]) : []
}

export type CaseRun = { exit: number | null; frames: Frame[]; requests: Captured[]; notices: string[]; stderr: string; home: string }

export async function runCase(kind: EmptyReplyCase, dist = DIST): Promise<CaseRun> {
  const home = join(tmpdir(), `mercury-empty-reply-${kind}-${process.pid}`)
  rmSync(home, { recursive: true, force: true })
  const cwd = join(home, 'work')
  const config = join(home, 'config')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(config, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  seedFirstRun(config, [cwd])
  writeFileSync(join(config, 'settings.json'), '{}')
  const fixture = await startCasesFixture(kind)
  const env = casesEnv(fixture.base, home, config)
  const node = join(dirname(dist), 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
  const proc = spawn(existsSync(node) ? node : 'node', [dist, '-p', '--model', EMPTY_REPLY_CASES_MODEL, '--output-format', 'stream-json', EMPTY_REPLY_CASES_ASK], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  const requests = fixture.captured.filter(c => c.body.model === EMPTY_REPLY_CASES_MODEL)
  return { exit, frames, requests, notices: persistedNotices(config), stderr, home }
}

async function proveCase(kind: EmptyReplyCase): Promise<void> {
  const titles: Record<EmptyReplyCase, string> = {
    'silence-reasoning': 'silence: a completed response carrying a reasoning item and no text',
    'silence-empty-message': 'silence: a completed response carrying a reasoning item and a message with no text',
    cap: 'the provider\'s output cap: an incomplete response, reason max_output_tokens, reasoning tokens in usage',
    empty: 'a true empty stream: a completed response with no output items at all',
  }
  section(`${kind} — ${titles[kind]}`)
  const before = failures
  const run = await runCase(kind)
  const result = run.frames.find(f => f.type === 'result')
  const resultText = String(result?.result ?? '')
  const texts = assistantTexts(run.frames)
  const notes = texts.filter(t => t.startsWith('[openai]'))
  const systems = run.notices
  const tail = run.stderr.split('\n').filter(l => l.trim() !== '').slice(-4).join(' | ')
  const resent = systems.some(t => t.includes(RESEND_WORDS))
  check(`${kind}: the turn settled with a result`, run.exit === 0 && result !== undefined, `exit ${String(run.exit)} ${tail}`)
  if (kind === 'silence-reasoning' || kind === 'silence-empty-message') {
    check(`${kind}: the note names silence`, notes.some(t => t.includes(SILENCE_WORDS)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: the note does not call the reply cut`, !texts.some(t => t.includes(EMPTY_WORDS)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: one request, no round trip for the same words`, run.requests.length === 1, `${run.requests.length} request(s)`)
    check(`${kind}: no re-send notice`, !resent, JSON.stringify(systems).slice(0, 300))
    check(`${kind}: the note stands as the turn's result`, resultText.includes(SILENCE_WORDS), `result: ${JSON.stringify(resultText.slice(0, 200))}`)
  } else if (kind === 'cap') {
    check(`${kind}: the note names the provider's output cap`, notes.some(t => t.includes(CAP_WORDS)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: the note carries the reasoning token count from usage`, notes.some(t => t.includes(`${CAP_REASONING_TOKENS} reasoning tokens`)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: the note does not call the reply an empty reply`, !texts.some(t => t.includes(EMPTY_WORDS)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: one request, no round trip for the same cap`, run.requests.length === 1, `${run.requests.length} request(s)`)
    check(`${kind}: no re-send notice`, !resent, JSON.stringify(systems).slice(0, 300))
    check(`${kind}: the note stands as the turn's result`, resultText.includes(CAP_WORDS), `result: ${JSON.stringify(resultText.slice(0, 200))}`)
  } else {
    check(`${kind}: the note keeps its words`, notes.some(t => t.includes(EMPTY_WORDS)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: the request was sent again once, unchanged`, run.requests.length === 2 && JSON.stringify(inputOf(run.requests[1]!)) === JSON.stringify(inputOf(run.requests[0]!)), `${run.requests.length} request(s)`)
    check(`${kind}: the re-send notice shows`, resent, JSON.stringify(systems).slice(0, 300))
    check(`${kind}: the turn's result is the answer from the re-send`, resultText === EMPTY_REPLY_CASES_END, `result: ${JSON.stringify(resultText.slice(0, 200))}`)
  }
  if (failures === before) rmSync(run.home, { recursive: true, force: true })
  else console.log(`  [forensics] the world stays at ${run.home}\n${run.stderr.split('\n').slice(-8).join('\n')}`)
}

if (import.meta.main) {
  const only = arg('--case') as EmptyReplyCase | undefined
  for (const kind of EMPTY_REPLY_CASES) {
    if (only !== undefined && kind !== only) continue
    await proveCase(kind)
  }
  console.log(`\n${checks} checks, ${failures} failures`)
  console.log(failures === 0 ? 'prove-empty-reply-cases: ALL LAWS HOLD' : `prove-empty-reply-cases: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
