#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { CAP_WORDS, EMPTY_WORDS, OLD_RESEND_WORDS, RETRY_WORDS, SILENCE_WORDS, jsonNeedle, lastRowIsUserCarrying, persistedNotices } from './prove-empty-reply-cases.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
export const REPO = resolve(join(import.meta.dir, '..', '..'))
export const DIST = resolve(arg('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))

export const ZAI_CASES_ASK = 'say what the readme holds, in one line'
export const ZAI_CASES_END = 'the readme holds one heading'
export const ZAI_CASES_MODEL = 'glm-5.2'
export const ZAI_CASES_PROMPT_TOKENS = 337_129
export const ZAI_CASES_CAP_OUTPUT_TOKENS = 131_072
export const NO_COUNT_WORDS = 'a reasoning token count the provider did not state'

export type ZaiEmptyReplyCase = 'silence' | 'cap' | 'empty' | 'no-finish'
export const ZAI_EMPTY_REPLY_CASES: readonly ZaiEmptyReplyCase[] = ['silence', 'cap', 'empty', 'no-finish']

export type Captured = { n: number; path: string; body: Record<string, unknown>; at: number }
export type ZaiCasesFixture = { base: string; captured: Captured[]; close: () => Promise<void> }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const DONE = 'data: [DONE]\n\n'

const usageOf = (completionTokens: number): Record<string, unknown> => ({
  prompt_tokens: ZAI_CASES_PROMPT_TOKENS,
  completion_tokens: completionTokens,
  prompt_tokens_details: { cached_tokens: 0 },
  total_tokens: ZAI_CASES_PROMPT_TOKENS + completionTokens,
})
const chunk = (n: number, delta: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>): string =>
  sse({
    id: `chatcmpl-${n}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: ZAI_CASES_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })

export function chatSseFor(kind: ZaiEmptyReplyCase, n: number, answerText?: string): string {
  if (answerText !== undefined) {
    return chunk(n, { role: 'assistant', content: answerText }, null) + chunk(n, {}, 'stop', usageOf(6)) + DONE
  }
  if (kind === 'silence') {
    return chunk(n, { role: 'assistant', content: '' }, null) + chunk(n, {}, 'stop', usageOf(27)) + DONE
  }
  if (kind === 'cap') {
    return chunk(n, { role: 'assistant', content: '' }, null) + chunk(n, {}, 'length', usageOf(ZAI_CASES_CAP_OUTPUT_TOKENS)) + DONE
  }
  if (kind === 'empty') return DONE
  return ''
}

export async function startZaiCasesFixture(kind: ZaiEmptyReplyCase): Promise<ZaiCasesFixture> {
  const captured: Captured[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [] }))
        return
      }
      if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
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
      res.end(chatSseFor(kind, n, (kind === 'empty' || kind === 'no-finish') && n >= 2 ? ZAI_CASES_END : undefined))
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

export function zaiCasesEnv(base: string, home: string, config: string): NodeJS.ProcessEnv {
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
    MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
    ZAI_API_KEY: 'fixture-zai-key',
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
function messagesOf(c: Captured): unknown[] {
  const b = c.body
  return Array.isArray(b.messages) ? (b.messages as unknown[]) : []
}

export type CaseRun = { exit: number | null; frames: Frame[]; requests: Captured[]; notices: string[]; stderr: string; home: string }

export async function runZaiCase(kind: ZaiEmptyReplyCase, dist = DIST): Promise<CaseRun> {
  const home = join(tmpdir(), `mercury-empty-reply-zai-${kind}-${process.pid}`)
  rmSync(home, { recursive: true, force: true })
  const cwd = join(home, 'work')
  const config = join(home, 'config')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(config, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  seedFirstRun(config, [cwd])
  writeFileSync(join(config, 'settings.json'), '{}')
  const fixture = await startZaiCasesFixture(kind)
  const env = zaiCasesEnv(fixture.base, home, config)
  const node = join(dirname(dist), 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
  const proc = spawn(existsSync(node) ? node : 'node', [dist, '-p', '--model', ZAI_CASES_MODEL, '--output-format', 'stream-json', ZAI_CASES_ASK], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  const requests = fixture.captured.filter(c => c.body.model === ZAI_CASES_MODEL)
  return { exit, frames, requests, notices: persistedNotices(config), stderr, home }
}

async function proveCase(kind: ZaiEmptyReplyCase): Promise<void> {
  const titles: Record<ZaiEmptyReplyCase, string> = {
    silence: 'silence: the provider finished with finish_reason stop and no words',
    cap: "the provider's output cap: finish_reason length before any words, no reasoning count in usage",
    empty: 'a true empty stream: [DONE] alone, no chunk, no finish_reason, no usage',
    'no-finish': 'a stream that closed with nothing at all: the route re-sends by itself, without the note',
  }
  section(`${kind} — ${titles[kind]}`)
  const before = failures
  const run = await runZaiCase(kind)
  const result = run.frames.find(f => f.type === 'result')
  const resultText = String(result?.result ?? '')
  const texts = assistantTexts(run.frames)
  const notes = texts.filter(t => t.startsWith('[zai]'))
  const systems = run.notices
  const tail = run.stderr.split('\n').filter(l => l.trim() !== '').slice(-4).join(' | ')
  const resent = systems.some(t => t.includes(RETRY_WORDS) || t.includes(OLD_RESEND_WORDS))
  const unchanged = run.requests.length === 2 && JSON.stringify(messagesOf(run.requests[1]!)) === JSON.stringify(messagesOf(run.requests[0]!))
  check(`${kind}: the turn settled with a result`, run.exit === 0 && result !== undefined, `exit ${String(run.exit)} ${tail}`)
  if (kind === 'silence') {
    check(`${kind}: the note names silence`, notes.some(t => t.includes(SILENCE_WORDS)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: the note does not call the reply cut`, !texts.some(t => t.includes(EMPTY_WORDS)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: one request, no round trip for the same words`, run.requests.length === 1, `${run.requests.length} request(s)`)
    check(`${kind}: no re-send notice`, !resent, JSON.stringify(systems).slice(0, 300))
    check(`${kind}: the note stands as the turn's result`, resultText.includes(SILENCE_WORDS), `result: ${JSON.stringify(resultText.slice(0, 200))}`)
  } else if (kind === 'cap') {
    check(`${kind}: the note names the provider's output cap`, notes.some(t => t.includes(CAP_WORDS)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: the note says the provider stated no reasoning count`, notes.some(t => t.includes(NO_COUNT_WORDS)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: the note does not call the reply an empty reply`, !texts.some(t => t.includes(EMPTY_WORDS)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: one request, no round trip for the same cap`, run.requests.length === 1, `${run.requests.length} request(s)`)
    check(`${kind}: no re-send notice`, !resent, JSON.stringify(systems).slice(0, 300))
    check(`${kind}: the note stands as the turn's result`, resultText.includes(CAP_WORDS), `result: ${JSON.stringify(resultText.slice(0, 200))}`)
  } else if (kind === 'empty') {
    const { EMPTY_REPLY_RECOVERY_NUDGE } = await import('../../src/services/api/errors.ts')
    const first = run.requests[0] === undefined ? [] : messagesOf(run.requests[0])
    const second = run.requests[1] === undefined ? [] : messagesOf(run.requests[1])
    check(`${kind}: the note keeps its words`, notes.some(t => t.includes(EMPTY_WORDS)), JSON.stringify(notes).slice(0, 300))
    check(`${kind}: the request was sent again once, with the nudge as its last user row`, run.requests.length === 2 && lastRowIsUserCarrying(second, EMPTY_REPLY_RECOVERY_NUDGE) && !lastRowIsUserCarrying(first, EMPTY_REPLY_RECOVERY_NUDGE), `${run.requests.length} request(s); last row: ${JSON.stringify(second.at(-1)).slice(0, 300)}`)
    check(`${kind}: the retry is not byte-identical to the first request`, run.requests.length === 2 && !unchanged, `${run.requests.length} request(s)`)
    check(`${kind}: the nudge rides once`, JSON.stringify(second).split(jsonNeedle(EMPTY_REPLY_RECOVERY_NUDGE)).length === 2, JSON.stringify(second).slice(-300))
    check(`${kind}: the retry notice shows and the old re-send words are gone`, systems.some(t => t.includes(`${RETRY_WORDS} (retry 1 of 1)`)) && !systems.some(t => t.includes(OLD_RESEND_WORDS)), JSON.stringify(systems).slice(0, 300))
    check(`${kind}: the turn's result is the answer from the retry`, resultText === ZAI_CASES_END, `result: ${JSON.stringify(resultText.slice(0, 200))}`)
  } else {
    check(`${kind}: no empty-reply note at all`, notes.length === 0, JSON.stringify(notes).slice(0, 300))
    check(`${kind}: the route sent the request again once, unchanged`, unchanged, `${run.requests.length} request(s)`)
    check(`${kind}: no re-send notice: the retry is the route's own`, !resent, JSON.stringify(systems).slice(0, 300))
    check(`${kind}: the turn's result is the answer from the retry`, resultText === ZAI_CASES_END, `result: ${JSON.stringify(resultText.slice(0, 200))}`)
  }
  if (failures === before) rmSync(run.home, { recursive: true, force: true })
  else console.log(`  [forensics] the world stays at ${run.home}\n${run.stderr.split('\n').slice(-8).join('\n')}`)
}

if (import.meta.main) {
  const only = arg('--case') as ZaiEmptyReplyCase | undefined
  for (const kind of ZAI_EMPTY_REPLY_CASES) {
    if (only !== undefined && kind !== only) continue
    await proveCase(kind)
  }
  console.log(`\n${checks} checks, ${failures} failures`)
  console.log(failures === 0 ? 'prove-empty-reply-cases-zai: ALL LAWS HOLD' : `prove-empty-reply-cases-zai: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
