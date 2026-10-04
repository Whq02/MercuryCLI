#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = resolve(join(import.meta.dir, '..', '..'))
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const KEEP = process.argv.includes('--keep')
const ONLY_ROAD = argAfter('--road')
const VENDORED_NODE = join(dirname(DIST), 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const ASK = 'say what the readme holds, in one line'
const ANSWER = 'the readme holds one heading'
const PARTIAL = 'the partial words'
const MARKER = 'ended the stream before its first event'
const TRIES = 3

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
if (!existsSync(DIST)) {
  console.log(`no bundle at ${DIST}`)
  process.exit(1)
}
const SCRATCH = join(realpathSync(process.env.MERCURY_CONFIG_DIR ?? tmpdir()), `empty-stream-retry-${process.pid}`)
mkdirSync(SCRATCH, { recursive: true })
process.on('exit', () => {
  if (!KEEP && failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
})
console.log(`bundle: ${DIST}\nnode: ${NODE}`)

type Road = 'anthropic' | 'deepseek'
type Mode = 'empty' | 'mid'
type Seen = { n: number; stream: boolean; empty: boolean; at: number }
type Fixture = { base: string; seen: Seen[]; close: () => Promise<void> }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const anthropicEvent = (type: string, body: unknown): string => `event: ${type}\n${sse(body)}`
const anthropicUsage = { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 }
const anthropicStart = (): string => anthropicEvent('message_start', { type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { ...anthropicUsage, output_tokens: 1 } } })
const anthropicStream = (text: string): string =>
  anthropicStart() +
  anthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  anthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
  anthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  anthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: anthropicUsage }) +
  anthropicEvent('message_stop', { type: 'message_stop' })
const anthropicJson = (text: string): string => JSON.stringify({ id: 'msg_ns', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 6, output_tokens: 2 } })
const chatChunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>): string => sse({ id: 'chatcmpl-fx', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })
const chatStream = (text: string): string => chatChunk({ role: 'assistant', content: text }, null) + chatChunk({}, 'stop', { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 }) + 'data: [DONE]\n\n'

async function startFixture(emptyTries: number, mode: Mode): Promise<Fixture> {
  const seen: Seen[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [] }))
        return
      }
      const anthropic = req.method === 'POST' && path.endsWith('/v1/messages')
      const chat = req.method === 'POST' && path.endsWith('/chat/completions')
      if (!anthropic && !chat) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: { stream?: unknown } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: unknown }
      } catch {}
      const stream = body.stream === true
      const n = seen.length + 1
      const empty = n <= emptyTries
      seen.push({ n, stream, empty, at: Date.now() })
      if (empty) {
        res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' })
        if (mode === 'mid' && stream) {
          res.write(anthropic ? anthropicStart() : chatChunk({ role: 'assistant', content: PARTIAL }, null))
          setTimeout(() => res.end(), 50)
          return
        }
        res.end()
        return
      }
      if (anthropic) {
        res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' })
        res.end(stream ? anthropicStream(ANSWER) : anthropicJson(ANSWER))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatStream(ANSWER))
    })
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>(done => server.close(() => done())) }
}

type Row = Record<string, unknown>
type Run = { exit: number | null; rows: Row[]; seen: Seen[]; notices: Row[]; answers: string[]; stderr: string; debug: string; home: string }

async function runProduct(road: Road, emptyTries: number, mode: Mode): Promise<Run> {
  const home = join(SCRATCH, `${road}-${mode}-${emptyTries}`)
  rmSync(home, { recursive: true, force: true })
  const cwd = join(home, 'work')
  const config = join(home, 'config')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(config, { recursive: true })
  mkdirSync(join(home, 'os-home'), { recursive: true })
  mkdirSync(join(home, 'tmp'), { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  seedFirstRun(config, [cwd])
  writeFileSync(join(config, 'settings.json'), '{}')
  const fixture = await startFixture(emptyTries, mode)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(home, 'os-home'),
    TMPDIR: join(home, 'tmp'),
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: config,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREWS_DIR: join(home, 'crews'),
    MERCURY_HOME: join(home, 'product-home'),
    MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
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
    ANTHROPIC_BASE_URL: `${fixture.base}/anthropic`,
    DEEPSEEK_API_KEY: 'fixture-deepseek-key',
    MERCURY_DEEPSEEK_API_BASE: `${fixture.base}/deepseek`,
    MERCURY_NONSTREAMING_FALLBACK_TIMEOUT_MS: '20000',
  }
  const model = road === 'anthropic' ? 'claude-sonnet-5' : 'deepseek-chat'
  const debugFile = join(home, 'debug.txt')
  const proc = spawn(NODE, [DIST, 'run', '--model', model, '--mode', 'sovereign', '--format', 'rows', '--log-file', debugFile, ASK], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', chunk => { stdout += String(chunk) })
  proc.stderr.on('data', chunk => { stderr += String(chunk) })
  const deadline = setTimeout(() => { stderr += '\nthe proof deadline passed\n'; proc.kill('SIGTERM') }, vshotBudgetMs(120_000))
  const exit = await new Promise<number | null>((done, fail) => { proc.once('exit', done); proc.once('error', fail) })
  clearTimeout(deadline)
  await fixture.close()
  const rows = stdout.split('\n').filter(line => line.startsWith('{')).flatMap(line => {
    try { return [JSON.parse(line) as Row] } catch { return [] }
  })
  const notices: Row[] = []
  const outputs = new Map<string, string>()
  const projects = join(config, 'projects')
  if (existsSync(projects)) {
    for (const slug of readdirSync(projects)) {
      for (const name of readdirSync(join(projects, slug))) {
        if (!name.endsWith('.jsonl')) continue
        for (const line of readFileSync(join(projects, slug, name), 'utf8').split('\n')) {
          if (!line.startsWith('{')) continue
          try {
            const record = JSON.parse(line) as { recordId?: string; payload?: Row & { kind?: string; fields?: Row; content?: unknown } }
            const payload = record.payload
            if (payload?.kind === 'notice') notices.push({ ...payload, ...(payload.fields ?? {}) })
            if (payload?.kind === 'output' && Array.isArray(payload.content)) {
              const text = payload.content.map(block => (block as { text?: string }).text ?? '').join('')
              if (text !== '') outputs.set(record.recordId ?? String(outputs.size), text)
            }
          } catch {}
        }
      }
    }
  }
  return { exit, rows, seen: fixture.seen, notices, answers: [...outputs.values()], stderr, debug: existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : '', home }
}

const retryRows = (run: Run): Row[] => run.rows.filter(row => row.type === 'wait' && row.state === 'retry')
const textRows = (run: Run): string[] => run.rows.filter(row => row.type === 'text').map(row => String(row.text ?? ''))
const outcome = (run: Run): Row | undefined => run.rows.find(row => row.type === 'outcome')
const places = (run: Run): string => retryRows(run).map(row => `${row.attempt} of ${row.of}`).join(', ')
const wire = (run: Run): string => run.seen.map(s => `#${s.n}${s.stream ? '' : '(collected)'}${s.empty ? ' empty' : ' answered'}`).join(', ')
const tail = (run: Run): string => run.stderr.split('\n').filter(line => line.trim() !== '').slice(-3).join(' | ')
const emptyNotices = (run: Run): Row[] => run.notices.filter(notice => notice.noticeKind === 'api_error' && String((notice.errorDetail as { message?: string } | undefined)?.message ?? '').includes(MARKER))
const label: Record<Road, string> = { anthropic: 'Anthropic', deepseek: 'DeepSeek' }
const failClass: Record<Road, string> = { anthropic: 'model', deepseek: 'server' }

async function proveAnswered(road: Road, emptyTries: number): Promise<void> {
  section(`${label[road]} — the stream ends before its first event ${emptyTries} time${emptyTries === 1 ? '' : 's'}, then answers`)
  const run = await runProduct(road, emptyTries, 'empty')
  const before = failures
  const places_ = Array.from({ length: emptyTries }, (_, i) => `${i + 2} of ${TRIES}`).join(', ')
  check('the turn settles with the answer, exit 0', run.exit === 0 && outcome(run)?.answer === ANSWER, `exit ${String(run.exit)} answer=${JSON.stringify(outcome(run)?.answer ?? outcome(run)?.error)} ${tail(run)}`)
  check('the transcript holds ONE answer and the rows paint it once', run.answers.length === 1 && run.answers[0] === ANSWER && textRows(run).length === 1, `transcript answers ${JSON.stringify(run.answers)} · text rows ${JSON.stringify(textRows(run))}`)
  check(`${emptyTries + 1} requests reached the provider, every one a stream — no collected fallback request`, run.seen.length === emptyTries + 1 && run.seen.every(s => s.stream), wire(run))
  check(`the retry rows say ${places_} — the capacity retries' row, no new row type`, places(run) === places_ && retryRows(run).every(row => row.type === 'wait' && row.state === 'retry'), `rows: ${places(run) || '(none)'} · wire ${wire(run)}`)
  const delays = retryRows(run).map(row => Number(row.delay_ms))
  check('each wait is the capacity ladder\'s first rung with its jitter: 750 ms to 1250 ms', delays.length === emptyTries && delays.every(ms => ms >= 750 && ms <= 1250), JSON.stringify(delays))
  const gaps = run.seen.slice(1).map((s, i) => s.at - run.seen[i]!.at)
  check('the wire shows the wait between the tries (at least 700 ms each)', gaps.length === emptyTries && gaps.every(ms => ms >= 700), JSON.stringify(gaps))
  const notices = emptyNotices(run)
  check(`the transcript's retry notices name the empty stream and their place (${places_})`, notices.length === emptyTries && notices.every((notice, i) => notice.retryAttempt === i + 2 && notice.maxRetries === TRIES), JSON.stringify(notices.map(n => [(n.errorDetail as { message?: string }).message, n.retryAttempt, n.maxRetries])).slice(0, 600))
  check('the notice reads "<Provider> ended the stream before its first event (…)"', notices.every(n => String((n.errorDetail as { message?: string }).message).startsWith(`${label[road]} ${MARKER} (`)), JSON.stringify(notices.map(n => (n.errorDetail as { message?: string }).message)))
  if (failures === before) rmSync(run.home, { recursive: true, force: true })
  else console.log(`  [forensics] the world stays at ${run.home}\n${run.debug.split('\n').filter(l => /ERROR|WARN/.test(l)).slice(-8).join('\n')}`)
}

async function proveSpent(road: Road): Promise<void> {
  section(`${label[road]} — the stream ends before its first event three times: the turn fails like an exhausted capacity retry`)
  const run = await runProduct(road, TRIES, 'empty')
  const before = failures
  const error = outcome(run)?.error as { message?: string; class?: string } | undefined
  check('the turn fails (exit 1) with one line', run.exit === 1 && typeof error?.message === 'string', `exit ${String(run.exit)} ${JSON.stringify(error)} ${tail(run)}`)
  check(`the line reads "API Error: ${label[road]} ended the stream before its first event 3 times in a row over N s — …"`, new RegExp(`^API Error: ${label[road]} ${MARKER} 3 times in a row over \\d+ s — `).test(error?.message ?? ''), error?.message ?? '(no error)')
  check(`the error class is the one this road's failure carries today (${failClass[road]}) — no new class`, error?.class === failClass[road], JSON.stringify(error))
  check('exactly three requests reached the provider, all streams — never a fourth', run.seen.length === TRIES && run.seen.every(s => s.stream), wire(run))
  check(`the retry rows say 2 of ${TRIES}, 3 of ${TRIES} before the failure`, places(run) === `2 of ${TRIES}, 3 of ${TRIES}`, places(run) || '(none)')
  check('no answer was painted; the transcript holds the one error row and no answer', textRows(run).length === 0 && run.answers.length === 1 && run.answers.every(text => text.startsWith('API Error: ')), JSON.stringify([textRows(run), run.answers]))
  if (failures === before) rmSync(run.home, { recursive: true, force: true })
  else console.log(`  [forensics] the world stays at ${run.home}\n${run.debug.split('\n').filter(l => /ERROR|WARN/.test(l)).slice(-8).join('\n')}`)
}

async function proveMidAnswer(road: Road): Promise<void> {
  section(`${label[road]} — the stream dies AFTER its first event: this law is off, today's road stands`)
  const run = await runProduct(road, 1, 'mid')
  const before = failures
  check('no retry row of this law (none says "of 3")', retryRows(run).every(row => row.of !== TRIES) && emptyNotices(run).length === 0, `${places(run) || '(none)'} · ${emptyNotices(run).length} empty-stream notices`)
  check('the turn still settles with the answer, exit 0', run.exit === 0 && outcome(run)?.answer === ANSWER, `exit ${String(run.exit)} ${JSON.stringify(outcome(run)?.answer ?? outcome(run)?.error)} ${tail(run)}`)
  if (road === 'anthropic') {
    check('the second request is the collected (non-streamed) recovery, as today', run.seen.length === 2 && run.seen[1]?.stream === false, wire(run))
    check('its notice is the recovery notice of today: attempt 1 of 1', places(run) === '1 of 1', places(run) || '(none)')
  } else {
    const cut = run.notices.filter(notice => notice.noticeKind === 'stream_cut').map(notice => String(notice.content ?? notice.text ?? ''))
    check('the partial words stand and the continuation notice of today follows (continuation 1 of 1)', textRows(run)[0] === PARTIAL && cut.length === 1 && /continuation 1 of 1/.test(cut[0] ?? ''), `${JSON.stringify(textRows(run))} · ${JSON.stringify(cut)}`)
    check('two streamed requests: the cut one and the continuation', run.seen.length === 2 && run.seen.every(s => s.stream), wire(run))
  }
  if (failures === before) rmSync(run.home, { recursive: true, force: true })
  else console.log(`  [forensics] the world stays at ${run.home}\n${run.debug.split('\n').filter(l => /ERROR|WARN/.test(l)).slice(-8).join('\n')}`)
}

const roads: Road[] = (['anthropic', 'deepseek'] as Road[]).filter(road => ONLY_ROAD === undefined || road === ONLY_ROAD)
for (const road of roads) {
  await proveAnswered(road, 1)
  await proveAnswered(road, 2)
  await proveSpent(road)
  await proveMidAnswer(road)
}
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-empty-stream-retry: ALL LAWS HOLD' : `prove-empty-stream-retry: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
