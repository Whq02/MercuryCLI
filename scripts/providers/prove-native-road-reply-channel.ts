#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
const HOME = mkdtempSync(join(tmpdir(), 'native-road-reply-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.OLLAMA_HOST
delete process.env.NODE_ENV
delete process.env.DEBUG
const DEBUG_FILE = join(HOME, 'debug.txt')
process.argv.push(`--debug-file=${DEBUG_FILE}`)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const transport = (await import('../../src/services/providers/local/ollamaChatTransport.js')) as Record<string, unknown> & typeof import('../../src/services/providers/local/ollamaChatTransport.js')
const { streamOllamaChat } = transport
const { flushDebugLogs } = await import('../../src/utils/debug.js')

type Fault = { kind: string; code: string; message: string; retryable: boolean }
type Event = { type: string; text?: string; reason?: string; rawReason?: string; toolCalls?: Array<{ name: string; arguments?: unknown }>; reasoningOnly?: boolean; fault?: Fault; usage?: Record<string, unknown> }

const MODEL = 'qwen3.5:9b'
const encoder = new TextEncoder()
const row = (data: Record<string, unknown>): string => `${JSON.stringify({ model: MODEL, created_at: '2026-01-01T00:00:00Z', ...data })}\n`
const think = (text: string): string => row({ message: { role: 'assistant', content: '', thinking: text }, done: false })
const say = (text: string): string => row({ message: { role: 'assistant', content: text }, done: false })
const done = (extra: Record<string, unknown> = {}): string => row({ message: { role: 'assistant', content: '' }, done_reason: 'stop', done: true, total_duration: 44_000_000_000, load_duration: 1_000_000, prompt_eval_count: 11_034, prompt_eval_duration: 30_000_000_000, eval_count: 59, eval_duration: 4_000_000_000, ...extra })

const OWNER_WORDS = 'Done — `csgo-menu.html` updated. Now it features a polished design with an Options modal that opens on click, animated particles, gradient overlays, custom checkboxes and sliders, and a matching Settings modal with config submenus. Open in a browser to try clicking the Options button.'
const pieces = (text: string, size: number): string[] => {
  const out: string[] = []
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size))
  return out
}

function ndjsonFetch(rows: string[], seen: string[] = []): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${String(input)}`)
    if (init?.method !== 'POST') return new Response('{"version":"0.34.4"}', { status: 200, headers: { 'content-type': 'application/json' } })
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const line of rows) {
          controller.enqueue(encoder.encode(line))
          await new Promise(resolve => setTimeout(resolve, 1))
        }
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
  }) as unknown as typeof fetch
}

async function play(rows: string[]): Promise<{ events: Event[]; reasoning: string; text: string; finish: Event | undefined; seen: string[] }> {
  const seen: string[] = []
  const events: Event[] = []
  for await (const event of streamOllamaChat({ url: 'http://127.0.0.1:1/api/chat', fetchImpl: ndjsonFetch(rows, seen), request: { model: MODEL, messages: [{ role: 'user', content: 'update the menu' }] } }, { numCtx: 131_072, think: true })) events.push(event as Event)
  const reasoning = events.filter(e => e.type === 'reasoning-delta').map(e => e.text ?? '').join('')
  const text = events.filter(e => e.type === 'text-delta').map(e => e.text ?? '').join('')
  return { events, reasoning, text, finish: events.find(e => e.type === 'finish'), seen }
}
const types = (events: Event[]): string => events.map(e => e.type).join(',')

console.log('============================================================')
console.log(' native road — the reply channel: thinking rows, content rows, and a turn that closes inside its thinking')
console.log('============================================================')

section('A · the documented thinking-model shape: rows with message.thinking, then rows with message.content, then done:true')
{
  const run = await play([think('The user asked for'), think(' an updated menu.'), say('Done — `csgo-menu.html`'), say(' updated.'), done()])
  check('every thinking row is a reasoning delta, in order', run.reasoning === 'The user asked for an updated menu.', run.reasoning)
  check('every content row is a text delta, in order, never filed into the reasoning', run.text === 'Done — `csgo-menu.html` updated.' && !run.reasoning.includes('Done'), j({ text: run.text, reasoning: run.reasoning }))
  check('the events run served-model · reasoning · reasoning · text · text · usage · finish', types(run.events) === 'served-model,reasoning-delta,reasoning-delta,text-delta,text-delta,usage,finish', types(run.events))
  check('the finish is a plain stop with no tool call', run.finish?.reason === 'stop' && run.finish.rawReason === 'stop' && run.finish.toolCalls?.length === 0, j(run.finish))
  check('a turn that carried a reply is NOT reported reasoning-only', run.finish !== undefined && run.finish.reasoningOnly !== true, j(run.finish))
  const usage = run.events.find(e => e.type === 'usage')?.usage
  check('the done row\'s counts ride the usage event (prompt_eval_count 11034 · eval_count 59)', usage?.inputTokens === 11_034 && usage?.outputTokens === 59, j(usage))
}

section('B · thinking and content non-empty in the SAME row (the think-close and the first words in one chunk)')
{
  const run = await play([think('Let me finish the thought'), row({ message: { role: 'assistant', content: 'Done — updated.', thinking: ' and answer.' }, done: false }), say(' Open it in a browser.'), done()])
  check('the shared row yields its thinking first, then its content — two deltas, each on its own channel', types(run.events) === 'served-model,reasoning-delta,reasoning-delta,text-delta,text-delta,usage,finish', types(run.events))
  check('the reasoning is exactly the thinking fields', run.reasoning === 'Let me finish the thought and answer.', run.reasoning)
  check('the text is exactly the content fields', run.text === 'Done — updated. Open it in a browser.', run.text)
  check('not reasoning-only', run.finish !== undefined && run.finish.reasoningOnly !== true, j(run.finish))
}

section('C · the owner\'s closing shape: the model never closes its thinking — every row is thinking, content empty throughout, done:true stop, no tool call')
{
  const run = await play([...pieces(OWNER_WORDS, 24).map(think), done()])
  check('the transport files every row as reasoning: the closing words are the reasoning, byte for byte (285 chars)', run.reasoning === OWNER_WORDS && OWNER_WORDS.length === 285, run.reasoning)
  check('no text delta was ever yielded — the transport did not invent a reply, and it did not lose one', run.text === '' && !run.events.some(e => e.type === 'text-delta'), run.text)
  check('the finish is a plain stop with no tool call', run.finish?.reason === 'stop' && run.finish.toolCalls?.length === 0, j(run.finish))
  check('THE FACT: the finish event reports reasoningOnly: true (thinking rows, no non-blank content, no tool call)', run.finish?.reasoningOnly === true, j(run.finish))
}

section('C2 · the same closing with whitespace-only content rows after the thinking (a bare newline is not a reply)')
{
  const run = await play([think('Done — the file is updated.'), say('\n'), say('\n'), done()])
  check('the whitespace rows are still filed as text deltas (nothing is dropped)', run.text === '\n\n', j(run.text))
  check('the turn is still reported reasoning-only', run.finish?.reasoningOnly === true, j(run.finish))
}

section('C3 · thinking rows followed by a tool call and no content: a tool call is a reply, so not reasoning-only')
{
  const run = await play([think('I should read the file first.'), row({ message: { role: 'assistant', content: '', tool_calls: [{ function: { index: 0, name: 'Read', arguments: { file_path: '/tmp/a.txt' } } }] }, done: false }), done()])
  check('the finish settles the tool call', run.finish?.reason === 'tool_calls' && run.finish.toolCalls?.[0]?.name === 'Read', j(run.finish))
  check('not reasoning-only', run.finish !== undefined && run.finish.reasoningOnly !== true, j(run.finish))
}

section('D · the wire dump: the debug log carries the stream\'s first 2,000 characters and its shape, so the next such case is readable from the log')
{
  const longThought = 'x'.repeat(3_000)
  const run = await play([think(longThought), done()])
  await flushDebugLogs()
  const log = existsSync(DEBUG_FILE) ? readFileSync(DEBUG_FILE, 'utf8') : ''
  const dumps = log.split('\n').filter(line => line.includes('[compat:local] /api/chat stream'))
  const last = dumps.at(-1) ?? ''
  check('the transport logged one dump line per stream (four shapes and this one so far: at least five)', dumps.length >= 5, `${dumps.length} lines; file ${DEBUG_FILE} ${log.length} chars`)
  check('the line names the shape: 2 rows · thinking 3000 chars · content 0 chars · tool calls 0 · done_reason stop · reasoning-only', /2 rows · thinking 3000 chars · content 0 chars · tool calls 0 · done_reason stop · reasoning-only/.test(last), last.slice(0, 300))
  const head = /head \(first (\d+) of (\d+) chars\): (.*)$/.exec(last)
  check('the head is bounded to the first 2,000 characters of the raw stream and states the total', head !== null && Number(head[1]) === 2_000 && Number(head[2]) > 3_000 && head[3]!.length === 2_000, head === null ? last.slice(-200) : `${head[1]} of ${head[2]}, kept ${head[3]!.length}`)
  check('the head IS the raw stream: it opens with the first row as Ollama sent it', head !== null && head[3]!.startsWith(`{"model":"${MODEL}","created_at":"2026-01-01T00:00:00Z","message":{"role":"assistant","content":"","thinking":"xxx`), head?.[3]?.slice(0, 120))
  const ownerLine = dumps.find(line => line.includes('reasoning-only') && line.includes('thinking 285 chars'))
  check("the owner's shape (C) logged as 13 rows · thinking 285 chars · content 0 chars · reasoning-only, with the words readable in the head row by row", ownerLine !== undefined && /13 rows · thinking 285 chars · content 0 chars · tool calls 0 · done_reason stop · reasoning-only/.test(ownerLine) && ownerLine.includes('"thinking":"Done — `csgo-menu.html` "') && ownerLine.includes('"thinking":"updated. Now it features'), ownerLine?.slice(0, 300))
  check('the run itself was unaffected by the dump', run.reasoning.length === 3_000 && run.finish?.reasoningOnly === true)
}

section('E · the runtime road: the real Ollama profile over a fixture server — the settled message carries the fact, the row carried the promise')
{
  let mode: 'thinking-only' | 'reply' = 'thinking-only'
  const posts: Array<{ url: string; body: Record<string, unknown> }> = []
  const server = createServer((req, res) => {
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/api/tags') return json({ models: [{ name: MODEL, model: MODEL, size: 6_000_000_000, details: { family: 'qwen35', parameter_size: '9.4B', quantization_level: 'Q4_K_M' } }] })
    if (req.method === 'GET' && req.url === '/api/version') return json({ version: '0.34.4' })
    if (req.method === 'GET' && req.url === '/api/ps') return json({ models: [{ name: MODEL, model: MODEL, context_length: 131_072 }] })
    if (req.method === 'POST' && req.url === '/api/show') return json({ capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262_144 } })
    if (req.method === 'POST' && req.url === '/api/chat') {
      let raw = ''
      req.on('data', chunk => {
        raw += String(chunk)
      })
      req.on('end', () => {
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(raw) as Record<string, unknown>
        } catch {
          body = {}
        }
        posts.push({ url: req.url ?? '', body })
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        const rows = mode === 'thinking-only' ? [...pieces(OWNER_WORDS, 40).map(think), done()] : [think('A quick reply.'), say('pong'), done({ eval_count: 4 })]
        for (const line of rows) res.write(line)
        res.end()
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>(resolvePort => server.listen(0, '127.0.0.1', () => resolvePort()))
  const port = (server.address() as { port: number }).port
  const root = `http://127.0.0.1:${port}`
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const discovery = await import('../../src/services/providers/local/localDiscovery.js')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.js')
  const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.js')
  const windows = await import('../../src/services/providers/local/localWindow.js')
  discovery.__resetLocalDiscoveryForTest()
  await discovery.refreshLocalDiscovery({ force: true, env: { MERCURY_LOCAL_PROBE_TARGETS: `ollama=${root}` } as NodeJS.ProcessEnv, timeoutMs: 2_000 })
  const record = discovery.localModelRecord(MODEL)
  check('the fixture server was discovered as the model\'s own Ollama (never 11434), thinking declared, loaded', record?.baseUrl === `${root}/v1` && record.thinkingDeclared === true && record.loaded === true, j(record))
  windows.__resetLocalWindowsForTest()
  windows.decideLocalWindow(record!, 5_000, undefined)
  type Settled = { type?: string; isApiErrorMessage?: boolean; reasoningOnly?: boolean; message?: { stop_reason?: string; content?: Array<{ type?: string; text?: string; thinking?: string }> } }
  async function drive(): Promise<{ settled: Settled[]; waits: Array<Record<string, unknown> | null> }> {
    const settled: Settled[] = []
    const waits: Array<Record<string, unknown> | null> = []
    const gen = compatChatCallModel(localLaneProfileFor(record!), {
      messages: [createUserMessage({ content: 'update the menu' })] as never,
      systemPrompt: ['fixture system prompt'] as never,
      thinkingConfig: { type: 'enabled', budget_tokens: 1024 } as never,
      tools: [] as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: `local/${MODEL}`,
        isNonInteractiveSession: true,
        querySource: 'agent:builtin:test',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        onWait: (wait: Record<string, unknown> | null) => waits.push(wait === null ? null : { ...wait }),
      } as never,
    })
    for await (const item of gen) {
      const m = item as Settled
      if (m.type === 'assistant') settled.push(m)
    }
    return { settled, waits }
  }
  const first = await drive()
  const real = first.settled.filter(m => m.isApiErrorMessage !== true)
  const blocks = real.flatMap(m => m.message?.content ?? [])
  check('one POST reached the fixture, on /api/chat, carrying think:true and the held num_ctx (the window the fit decided for this record — the base doubled the estimate to 32k, the fit rule gives the biggest rung that fits the machine)', posts.length === 1 && posts[0]!.url === '/api/chat' && posts[0]!.body.think === true && (posts[0]!.body.options as Record<string, unknown> | undefined)?.num_ctx === windows.heldLocalWindow(record!)?.window && typeof windows.heldLocalWindow(record!)?.window === 'number', j(posts.map(p => ({ url: p.url, think: p.body.think, options: p.body.options }))))
  check('the settlement is ONE thinking block carrying the closing words and no text block, no tool use, no api error', blocks.length === 1 && blocks[0]!.type === 'thinking' && blocks[0]!.thinking === OWNER_WORDS && !first.settled.some(m => m.isApiErrorMessage === true), j(blocks.map(b => ({ type: b.type, text: (b.text ?? b.thinking ?? '').slice(0, 60) }))))
  check('the turn ended as end_turn (the model chose to stop; done_reason stop)', real.at(-1)?.message?.stop_reason === 'end_turn', String(real.at(-1)?.message?.stop_reason))
  check('THE FACT ON THE MESSAGE: the last settled assistant message carries reasoningOnly: true', real.at(-1)?.reasoningOnly === true, j({ reasoningOnly: real.at(-1)?.reasoningOnly }))
  const promise = first.waits.find(w => w !== null && w.kind === 'first-byte')
  check('the row carried the local PROMISE through the profile (promise: true), not the generic deadline', promise !== undefined && promise !== null && promise.promise === true, j(first.waits[0]))
  await flushDebugLogs()
  const log = existsSync(DEBUG_FILE) ? readFileSync(DEBUG_FILE, 'utf8') : ''
  const runtimeDump = log.split('\n').filter(line => line.includes('[compat:local] /api/chat stream') && line.includes('reasoning-only') && line.includes('thinking 285 chars')).at(-1)
  check('the runtime stream was dumped to the debug log with the owner\'s shape (9 rows · thinking 285 chars · reasoning-only)', runtimeDump !== undefined && /9 rows · thinking 285 chars · content 0 chars · tool calls 0 · done_reason stop · reasoning-only/.test(runtimeDump), runtimeDump?.slice(0, 240))
  mode = 'reply'
  const second = await drive()
  const secondReal = second.settled.filter(m => m.isApiErrorMessage !== true)
  const secondBlocks = secondReal.flatMap(m => m.message?.content ?? [])
  check('a turn that answered (thinking, then "pong") settles a thinking block and a text block', secondBlocks.map(b => b.type).join(',') === 'thinking,text' && secondBlocks[1]!.text === 'pong', j(secondBlocks.map(b => b.type)))
  check('and carries no reasoningOnly fact', secondReal.every(m => m.reasoningOnly === undefined), j(secondReal.map(m => m.reasoningOnly)))
  server.close()
  discovery.__resetLocalDiscoveryForTest()
}

console.log(failures === 0 ? '\nprove-native-road-reply-channel: all green' : `\nprove-native-road-reply-channel: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
