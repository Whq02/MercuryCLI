;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { Options } from '../../src/services/providers/anthropic/streamCore.ts'

const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const REPO = join(import.meta.dir, '..', '..')
const DIST = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const RECORDS_ARG = argAfter('--records')
const RECORDS = RECORDS_ARG !== undefined ? resolve(RECORDS_ARG) : undefined
const VENDORED_NODE = join(DIST, '..', 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const WIRE_MODEL = 'deepseek-v4-pro'
const CHAT_PATH = '/chat/completions'
const DEAD = 'http://127.0.0.1:1'
const FIXTURE_KEY = 'sk-fixture-deepseek'
const FIXTURE_TEXT = 'FIXTURE-SETTLED.'
const CHILD_TIMEOUT_MS = 45_000

const SCRATCH = mkdtempSync(join(realpathSync(tmpdir()), 'deepseek-effort-wire-'))
const OWN_HOME = join(SCRATCH, 'own-home')
const OWN_CWD = join(SCRATCH, 'own-cwd')

function seedHome(home: string, cwd: string): void {
  mkdirSync(join(home, 'tmp'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  writeFileSync(
    join(home, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }),
  )
  writeFileSync(join(home, 'settings.json'), '{}')
}

for (const k of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'ZAI_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_THINKING_BUDGET',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]) {
  delete process.env[k]
}
seedHome(OWN_HOME, OWN_CWD)
process.env.HOME = OWN_HOME
process.env.TMPDIR = join(OWN_HOME, 'tmp')
process.env.MERCURY_CONFIG_DIR = OWN_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.DEEPSEEK_API_KEY = FIXTURE_KEY
process.env.ANTHROPIC_BASE_URL = DEAD
process.env.MERCURY_ZAI_API_BASE = DEAD
process.env.MERCURY_COMPAT_BASE_URL = DEAD
process.env.MERCURY_LOCAL_BASE_URL = DEAD

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

type Capture = {
  tag: string
  path: string
  method: string
  bearer: boolean
  keyInBody: boolean
  raw: string
  body: Record<string, unknown>
}

const captures: Capture[] = []
const strayRequests: string[] = []
let currentTag = 'boot'

const SSE_EVENTS = [
  {
    id: 'ds-fixture-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: WIRE_MODEL,
    choices: [{ index: 0, delta: { role: 'assistant', content: FIXTURE_TEXT }, finish_reason: null, logprobs: null }],
  },
  {
    id: 'ds-fixture-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: WIRE_MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 3,
      total_tokens: 14,
      prompt_cache_hit_tokens: 4,
      prompt_cache_miss_tokens: 7,
    },
  },
]

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise(resolve => {
    let s = ''
    req.on('data', (c: Buffer) => {
      s += c.toString('utf8')
    })
    req.on('end', () => resolve(s))
  })

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const raw = await readBody(req)
    const path = req.url ?? ''
    const method = req.method ?? ''
    if (method === 'POST' && path === CHAT_PATH) {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = {}
      }
      const auth = req.headers.authorization
      captures.push({
        tag: currentTag,
        path,
        method,
        bearer: auth === `Bearer ${FIXTURE_KEY}`,
        keyInBody: raw.includes(FIXTURE_KEY),
        raw,
        body,
      })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const e of SSE_EVENTS) res.write(`data: ${JSON.stringify(e)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    strayRequests.push(`${method} ${path}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'USD', total_balance: '10.00', granted_balance: '10.00', topped_up_balance: '0.00' }],
      }),
    )
  })()
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
const PORT = (server.address() as { port: number }).port
const BASE = `http://127.0.0.1:${PORT}`
process.env.MERCURY_DEEPSEEK_API_BASE = BASE

process.chdir(OWN_CWD)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { deepseekLaneProfile } = await import('../../src/services/providers/deepseek/deepseekCallModel.ts')

function callParams(
  effortValue: string | undefined,
  thinkingEnabled: boolean,
  maxOutputTokensOverride: number | undefined,
): CompatCallModelParams {
  return {
    messages: [],
    systemPrompt: asSystemPrompt(['You are the DeepSeek wire fixture.']),
    thinkingConfig: thinkingEnabled ? { type: 'enabled', budgetTokens: 4096 } : { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: {
      model: WIRE_MODEL,
      querySource: 'repl_main_thread',
      isNonInteractiveSession: true,
      getToolPermissionContext: async () => ({}) as never,
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
      effortValue,
      maxOutputTokensOverride,
    } as unknown as Options,
  }
}

type TransportRun = { settledText: string; errorCount: number; capture: Capture | undefined; count: number }

async function driveTransport(
  tag: string,
  effortValue: string | undefined,
  thinkingEnabled: boolean,
  maxOutputTokensOverride: number | undefined,
): Promise<TransportRun> {
  currentTag = tag
  const yields: Record<string, unknown>[] = []
  for await (const y of compatChatCallModel(deepseekLaneProfile, callParams(effortValue, thinkingEnabled, maxOutputTokensOverride))) {
    yields.push(y as Record<string, unknown>)
  }
  const assistants = yields.filter(y => y.type === 'assistant')
  const settledText = assistants
    .filter(a => a.isApiErrorMessage !== true)
    .map(a => {
      const content = (a.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(content)) {
        return content.map(b => ((b as { type?: string }).type === 'text' ? String((b as { text?: string }).text ?? '') : '')).join('')
      }
      return String(content ?? '')
    })
    .join('')
  const mine = captures.filter(c => c.tag === tag)
  return {
    settledText,
    errorCount: assistants.filter(a => a.isApiErrorMessage === true).length,
    capture: mine.at(-1),
    count: mine.length,
  }
}

const thinkingOf = (c: Capture | undefined): Record<string, unknown> | undefined =>
  c && typeof c.body.thinking === 'object' && c.body.thinking !== null ? (c.body.thinking as Record<string, unknown>) : undefined

function checkTurn(tag: string, run: TransportRun): void {
  check(`${tag}: exactly one chat request reached the fixture`, run.count === 1, `count=${run.count}`)
  check(`${tag}: the turn settled cleanly on the fixture answer`, run.settledText.includes(FIXTURE_TEXT) && run.errorCount === 0, JSON.stringify({ text: run.settledText, errors: run.errorCount }))
}

function checkThinking(tag: string, c: Capture | undefined, expectedType: string): void {
  const t = thinkingOf(c)
  check(`${tag}: the thinking object is EXACTLY { type }`, t !== undefined && JSON.stringify(Object.keys(t).sort()) === JSON.stringify(['type']), JSON.stringify(t))
  check(`${tag}: thinking.type is ${expectedType}`, t?.type === expectedType, JSON.stringify(t))
  check(`${tag}: no effort nested inside thinking`, t !== undefined && !('reasoning_effort' in t), JSON.stringify(t))
}

section('§1 the DeepSeek transport over a local HTTP fixture: the request body on the wire')

{
  const tag = 'transport-high'
  const run = await driveTransport(tag, 'high', true, undefined)
  const c = run.capture
  checkTurn(tag, run)
  check(`${tag}: POST ${CHAT_PATH} exactly`, c?.method === 'POST' && c?.path === CHAT_PATH, `${c?.method} ${c?.path}`)
  check(`${tag}: the bearer key rides the header`, c?.bearer === true)
  check(`${tag}: the key never rides the body`, c?.keyInBody === false)
  check(`${tag}: model is ${WIRE_MODEL}`, c?.body.model === WIRE_MODEL, String(c?.body.model))
  check(`${tag}: stream:true`, c?.body.stream === true)
  check(`${tag}: reasoning_effort sits at the TOP LEVEL`, c?.body.reasoning_effort === 'high', JSON.stringify({ top: c?.body.reasoning_effort, thinking: thinkingOf(c) }))
  checkThinking(tag, c, 'enabled')
  check(`${tag}: stream_options.include_usage rides`, JSON.stringify(c?.body.stream_options) === JSON.stringify({ include_usage: true }), JSON.stringify(c?.body.stream_options))
  check(`${tag}: no max_tokens without an explicit override`, c !== undefined && !('max_tokens' in c.body))
}

{
  const tag = 'transport-low'
  const run = await driveTransport(tag, 'low', true, undefined)
  checkTurn(tag, run)
  check(`${tag}: low rides top-level verbatim`, run.capture?.body.reasoning_effort === 'low', String(run.capture?.body.reasoning_effort))
  checkThinking(tag, run.capture, 'enabled')
}

{
  const tag = 'transport-max'
  const run = await driveTransport(tag, 'max', true, 4096)
  const c = run.capture
  checkTurn(tag, run)
  check(`${tag}: max rides top-level verbatim`, c?.body.reasoning_effort === 'max', String(c?.body.reasoning_effort))
  check(`${tag}: an explicit override rides max_tokens`, c?.body.max_tokens === 4096, String(c?.body.max_tokens))
  checkThinking(tag, c, 'enabled')
}

{
  const tag = 'transport-xhigh'
  const run = await driveTransport(tag, 'xhigh', true, undefined)
  checkTurn(tag, run)
  check(`${tag}: xhigh resolves nearest-below to high, top-level`, run.capture?.body.reasoning_effort === 'high', String(run.capture?.body.reasoning_effort))
  checkThinking(tag, run.capture, 'enabled')
}

{
  const tag = 'transport-medium'
  const run = await driveTransport(tag, 'medium', true, undefined)
  checkTurn(tag, run)
  check(`${tag}: medium resolves nearest-below to low, top-level`, run.capture?.body.reasoning_effort === 'low', String(run.capture?.body.reasoning_effort))
  checkThinking(tag, run.capture, 'enabled')
}

{
  const tag = 'transport-no-effort'
  const run = await driveTransport(tag, undefined, true, undefined)
  const c = run.capture
  checkTurn(tag, run)
  check(`${tag}: no effort asked ⇒ no reasoning_effort key at all`, c !== undefined && !('reasoning_effort' in c.body), String(c?.body.reasoning_effort))
  checkThinking(tag, c, 'enabled')
}

{
  const tag = 'transport-thinking-off'
  const run = await driveTransport(tag, 'max', false, undefined)
  const c = run.capture
  checkTurn(tag, run)
  check(`${tag}: thinking off ⇒ no top-level effort`, c !== undefined && !('reasoning_effort' in c.body), String(c?.body.reasoning_effort))
  checkThinking(tag, c, 'disabled')
}

section('§2 the BUILT dist/mercury.mjs headless under vendored Node, same fixture')

function childEnv(home: string, cwd: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: join(home, 'tmp'),
    LANG: 'en_US.UTF-8',
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_DEEPSEEK_API_BASE: BASE,
    DEEPSEEK_API_KEY: FIXTURE_KEY,
    ANTHROPIC_BASE_URL: DEAD,
    MERCURY_ZAI_API_BASE: DEAD,
    MERCURY_COMPAT_BASE_URL: DEAD,
    MERCURY_LOCAL_BASE_URL: DEAD,
    BROWSER: '/usr/bin/true',
    PWD: cwd,
    ...extra,
  }
}

type ChildOutcome = {
  tag: string
  exitCode: number | null
  timedOut: boolean
  spawnError: string
  resultSubtype: string | undefined
  resultText: string
  frameCount: number
  stderrTail: string
}

async function runDist(tag: string, extra: Record<string, string>): Promise<ChildOutcome> {
  currentTag = tag
  const home = join(SCRATCH, `home-${tag}`)
  const cwd = join(SCRATCH, `cwd-${tag}`)
  seedHome(home, cwd)
  const proc = spawn(
    NODE,
    [DIST, '-p', '--input-format=stream-json', '--output-format=stream-json', '--model', WIRE_MODEL, '--permission-mode', 'bypassPermissions'],
    { cwd, env: childEnv(home, cwd, extra), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const frames: Record<string, unknown>[] = []
  let stdoutBuffer = ''
  let stderrText = ''
  let spawnError = ''
  let timedOut = false
  proc.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8')
    let nl: number
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, nl)
      stdoutBuffer = stdoutBuffer.slice(nl + 1)
      if (line.trim() === '') continue
      try {
        frames.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        stderrText += `[unparsed stdout] ${line}\n`
      }
    }
  })
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8')
  })
  const finished = new Promise<number | null>(resolve => {
    proc.on('close', code => resolve(code))
    proc.on('error', (err: Error) => {
      spawnError = err.message
      resolve(null)
    })
  })
  try {
    proc.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'fixture turn' }, parent_tool_use_id: null })}\n`)
    proc.stdin!.end()
  } catch (err) {
    spawnError = spawnError === '' ? String(err) : spawnError
  }
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill('SIGKILL')
    } catch {
      stderrText += '[kill failed]\n'
    }
  }, CHILD_TIMEOUT_MS)
  const exitCode = await finished
  clearTimeout(timer)
  const result = frames.find(f => f.type === 'result')
  return {
    tag,
    exitCode,
    timedOut,
    spawnError,
    resultSubtype: result?.subtype as string | undefined,
    resultText: String(result?.result ?? ''),
    frameCount: frames.length,
    stderrTail: stderrText.slice(-600),
  }
}

const outcomes: ChildOutcome[] = []

function checkChild(tag: string, outcome: ChildOutcome, capture: Capture | undefined, count: number): void {
  check(
    `${tag}: the child exited 0 with no spawn error and no timeout`,
    outcome.exitCode === 0 && outcome.timedOut === false && outcome.spawnError === '',
    JSON.stringify({ exit: outcome.exitCode, timedOut: outcome.timedOut, spawnError: outcome.spawnError, stderr: outcome.stderrTail }),
  )
  check(`${tag}: exactly one chat request reached the fixture`, count === 1, `count=${count}`)
  check(
    `${tag}: the turn settled cleanly (not a vacuous capture)`,
    outcome.resultSubtype === 'success' && outcome.resultText.includes(FIXTURE_TEXT),
    JSON.stringify({ subtype: outcome.resultSubtype, text: outcome.resultText, stderr: outcome.stderrTail }),
  )
  check(
    `${tag}: POST ${CHAT_PATH} exactly, with model and stream on the wire`,
    capture?.method === 'POST' && capture?.path === CHAT_PATH && capture?.body.model === WIRE_MODEL && capture?.body.stream === true,
    JSON.stringify({ method: capture?.method, path: capture?.path, model: capture?.body.model, stream: capture?.body.stream }),
  )
}

for (const word of ['low', 'high', 'max']) {
  const tag = `dist-${word}`
  const outcome = await runDist(tag, { MERCURY_EFFORT_LEVEL: word, MERCURY_THINKING_BUDGET: '4096' })
  outcomes.push(outcome)
  const mine = captures.filter(c => c.tag === tag)
  const c = mine.at(-1)
  checkChild(tag, outcome, c, mine.length)
  check(`${tag}: reasoning_effort '${word}' sits at the TOP LEVEL`, c?.body.reasoning_effort === word, JSON.stringify({ top: c?.body.reasoning_effort, thinking: thinkingOf(c) }))
  checkThinking(tag, c, 'enabled')
}

{
  const tag = 'dist-thinking-off'
  const outcome = await runDist(tag, { MERCURY_EFFORT_LEVEL: 'max', MERCURY_THINKING_BUDGET: '0' })
  outcomes.push(outcome)
  const mine = captures.filter(c => c.tag === tag)
  const c = mine.at(-1)
  checkChild(tag, outcome, c, mine.length)
  check(`${tag}: no top-level effort when thinking is off`, c !== undefined && !('reasoning_effort' in c.body), String(c?.body.reasoning_effort))
  checkThinking(tag, c, 'disabled')
}

section('§3 the whole wire')

check('every capture was an exact POST /chat/completions', captures.every(c => c.method === 'POST' && c.path === CHAT_PATH), captures.map(c => `${c.method} ${c.path}`).join(' '))
check('no capture ever carried the key in its body', captures.every(c => !c.keyInBody))
check('no request missed the chat path by method or spelling', strayRequests.every(r => !r.includes(CHAT_PATH)), strayRequests.join(' '))
check('no capture nested an effort inside thinking', captures.every(c => {
  const t = thinkingOf(c)
  return t === undefined || !('reasoning_effort' in t)
}), captures.filter(c => {
  const t = thinkingOf(c)
  return t !== undefined && 'reasoning_effort' in t
}).map(c => c.tag).join(' '))

if (RECORDS !== undefined) {
  mkdirSync(RECORDS, { recursive: true })
  const path = join(RECORDS, 'deepseek-effort-wire.json')
  writeFileSync(
    path,
    JSON.stringify({ base: BASE, dist: DIST, node: NODE, wireModel: WIRE_MODEL, captures, strayRequests, outcomes, checks, failures }, null, 2),
  )
  console.log(`\nrecords: ${path}`)
}

server.close()

console.log(`\nscratch: ${SCRATCH}`)
console.log(`${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'deepseek-effort-wire: ALL LAWS HOLD' : `deepseek-effort-wire: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
