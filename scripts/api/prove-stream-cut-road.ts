#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'stream-cut-road-'))
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_CUSTOM_OAUTH_URL = 'http://127.0.0.1:1'
process.env.MERCURY_MAX_RETRIES = '2'
for (const key of ['NODE_ENV', 'CI', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_HOME', 'MERCURY_DISABLE_NONSTREAMING_FALLBACK']) delete process.env[key]
writeFileSync(join(home, '.mercury.json'), JSON.stringify({ customApiKeyResponses: { approved: ['proof-key-ci-gate-not-a-real-key'.slice(-20)], rejected: [] } }))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the stream-cut road proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const evidenceModule = (await import('../../src/services/api/transportEvidence.js')) as unknown as Record<string, unknown>
const retry = await import('../../src/services/api/withRetry.js')
const proxy = await import('../../src/utils/proxy.js')
type Cut = { code: string; words: string }
const absent = (name: string) => (): null => {
  console.log(`  (transportEvidence exports no ${name} on this tree)`)
  return null
}
const evidence = {
  isStaleSocketCode: evidenceModule.isStaleSocketCode as (code: string) => boolean,
  transportCutOf: (typeof evidenceModule.transportCutOf === 'function' ? evidenceModule.transportCutOf : absent('transportCutOf')) as (error: unknown) => Cut | null,
  transportCutWords: (typeof evidenceModule.transportCutWords === 'function' ? evidenceModule.transportCutWords : absent('transportCutWords')) as (road: string, cut: Cut) => string | null,
}

const h2StreamReset = (): TypeError =>
  new TypeError('terminated', { cause: Object.assign(new Error('Stream closed with error code NGHTTP2_INTERNAL_ERROR'), { code: 'ERR_HTTP2_STREAM_ERROR', http2ErrorCode: 2 }) })
const h2SessionGone = (): TypeError =>
  new TypeError('terminated', { cause: Object.assign(new Error('Session closed with error code 2'), { code: 'ERR_HTTP2_SESSION_ERROR', http2ErrorCode: 2 }) })
const h1SocketClosed = (): TypeError =>
  new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
class APIConnectionError extends Error {}
const h2ResetBeforeHeaders = (): Error =>
  Object.assign(new APIConnectionError('Connection error.'), {
    cause: new TypeError('fetch failed', { cause: Object.assign(new Error('Stream closed with error code NGHTTP2_INTERNAL_ERROR'), { code: 'ERR_HTTP2_STREAM_ERROR' }) }),
  })

section('§1 the predicate: the exact objects the runtime produces for a cut connection')
{
  const reset = evidence.transportCutOf(h2StreamReset())
  check('an HTTP/2 RST_STREAM mid-body (TypeError terminated → ERR_HTTP2_STREAM_ERROR) is a cut with its code and words', reset?.code === 'ERR_HTTP2_STREAM_ERROR' && reset.words === 'Stream closed with error code NGHTTP2_INTERNAL_ERROR', JSON.stringify(reset))
  check('an HTTP/2 GOAWAY that closes the session mid-body (ERR_HTTP2_SESSION_ERROR) is a cut', evidence.transportCutOf(h2SessionGone())?.code === 'ERR_HTTP2_SESSION_ERROR')
  check('the HTTP/1.1 twin (the socket closed under the body, UND_ERR_SOCKET) is the same cut', evidence.transportCutOf(h1SocketClosed())?.code === 'UND_ERR_SOCKET')
  check('every HTTP/2 stream and session code is a stale-socket code for the API loop and MCP', ['ERR_HTTP2_STREAM_ERROR', 'ERR_HTTP2_STREAM_CANCEL', 'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_SESSION_ERROR', 'ERR_HTTP2_INVALID_SESSION'].every(code => evidence.isStaleSocketCode(code)))
  check('a reset before the headers (the SDK connection error over fetch failed) is a stale connection: the retry rebuilds the client on a fresh pool', retry.isStaleConnectionError(h2ResetBeforeHeaders()) && evidence.transportCutOf(h2ResetBeforeHeaders()) === null)
  check('the mid-body cut is a stale connection for the retry loop', retry.isStaleConnectionError(h2StreamReset()) && retry.isStaleConnectionError(h1SocketClosed()))
  check('the mid-body cut is retryable', retry.isRetryableError(h2StreamReset()) && retry.isRetryableError(h2SessionGone()))
  check('a bare Error naming ECONNRESET is neither a cut nor stale (an auth failure must still fail the turn)', evidence.transportCutOf(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })) === null && !retry.isStaleConnectionError(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })))
  check('a terminated body whose cause is not a socket event (ENOTFOUND) is not a cut', evidence.transportCutOf(new TypeError('terminated', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })) === null)
  check('a terminated body with no cause at all is not a cut', evidence.transportCutOf(new TypeError('terminated')) === null && !retry.isRetryableError(new TypeError('terminated')))
  check('the words name the road, the event and the code', reset !== null && evidence.transportCutWords('Anthropic', reset) === 'Anthropic cut the connection mid-response — Stream closed with error code NGHTTP2_INTERNAL_ERROR (ERR_HTTP2_STREAM_ERROR)')
}

const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')
const MODEL = 'claude-sonnet-5'
const event = (type: string, body: unknown): string => `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`
const head = [
  event('message_start', { type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }),
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
]
const streamedTail = (text: string): string[] => [
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
  event('content_block_stop', { type: 'content_block_stop', index: 0 }),
  event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } }),
  event('message_stop', { type: 'message_stop' }),
]
const collectedJson = JSON.stringify({ id: 'msg_ns', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'recovered without streaming' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 6, output_tokens: 2 } })

type Step = 'cut' | 'full'
type Seen = { stream: boolean; step: Step }
function scriptedFetch(plan: Step[], cutError: () => Error): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  const encoder = new TextEncoder()
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean }
    const stream = body.stream === true
    const step = plan.shift() ?? 'full'
    seen.push({ stream, step })
    const chunks = stream ? (step === 'cut' ? [...head, event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the partial words' } })] : [...head, ...streamedTail('the whole reply')]) : step === 'cut' ? [collectedJson.slice(0, 40)] : [collectedJson]
    const readable = new ReadableStream<Uint8Array>({
      start(sink) {
        for (const chunk of chunks) sink.enqueue(encoder.encode(chunk))
        if (step === 'cut') setTimeout(() => sink.error(cutError()), 40)
        else sink.close()
      },
    })
    return new Response(readable, { status: 200, headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } })
  }) as unknown as typeof fetch
  return { fetchImpl, seen }
}

type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type Notice = { type: 'system'; subtype: string; content?: string; code?: string; road?: string; error?: { message?: string } }
async function drive(plan: Step[], cutError: () => Error): Promise<{ seen: Seen[]; notices: Notice[]; answers: string[]; errors: string[]; threw: unknown; poolReset: boolean }> {
  const { fetchImpl, seen } = scriptedFetch(plan, cutError)
  const notices: Notice[] = []
  const answers: string[] = []
  const errors: string[] = []
  let threw: unknown
  proxy._resetApiDispatcherForTesting()
  const before = proxy.getApiDispatcher()
  try {
    for await (const item of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'go' })],
      systemPrompt: asSystemPrompt(['fixture']),
      thinkingConfig: { type: 'disabled' as const },
      tools: [],
      signal: new AbortController().signal,
      options: { model: MODEL, fetchOverride: fetchImpl, querySource: 'agent:stream-cut-fixture', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64 } as never,
    })) {
      const typed = item as { type?: string }
      if (typed.type === 'system') notices.push(item as unknown as Notice)
      if (typed.type === 'assistant') {
        const a = item as AssistantMessage
        const text = Array.isArray(a.message.content) ? a.message.content.map(block => ((block as { text?: string }).text ?? '')).join('') : ''
        if (a.isApiErrorMessage) errors.push(text)
        else answers.push(text)
      }
    }
  } catch (error) {
    threw = error
  }
  const poolReset = proxy.getApiDispatcher() !== before
  proxy._resetApiDispatcherForTesting()
  return { seen, notices, answers, errors, threw, poolReset }
}
const cutNotices = (notices: Notice[]): Notice[] => notices.filter(n => n.subtype === 'stream_cut')
const apiErrorWords = (notices: Notice[]): string => notices.filter(n => n.subtype === 'api_error').map(n => n.error?.message ?? '').join(' | ')

section('§2 one HTTP/2 reset mid-reply: the stream-cut notice names the road, the reply is streamed again on a fresh connection')
{
  const o = await drive(['cut', 'full'], h2StreamReset)
  const cuts = cutNotices(o.notices)
  check('the turn settled on the streamed reply, never an error row', o.threw === undefined && o.errors.length === 0 && o.answers.at(-1) === 'the whole reply', `threw=${String(o.threw)} errors=${o.errors.join('|')} answers=${o.answers.join('|')} notices=${apiErrorWords(o.notices)}`)
  check('exactly one stream-cut notice, naming Anthropic and the HTTP/2 code', cuts.length === 1 && cuts[0]?.road === 'Anthropic' && cuts[0].code === 'ERR_HTTP2_STREAM_ERROR' && (cuts[0].content ?? '').startsWith('Anthropic cut the connection mid-response — Stream closed with error code NGHTTP2_INTERNAL_ERROR (ERR_HTTP2_STREAM_ERROR)'), JSON.stringify(o.notices.map(n => [n.subtype, n.content ?? n.error?.message])))
  check('the reissue is a STREAMING request (the seat stays live), not the blocking fallback', o.seen.map(s => `${s.step}${s.stream ? '' : '(collected)'}`).join(',') === 'cut,full', JSON.stringify(o.seen))
  check('the connection pool was dropped before the reissue (a fresh connection, never the cut one)', o.poolReset)
}

section('§3 the reissue is cut too: the fallback names the cut, and its own cut is retried on a fresh connection instead of ending the turn')
{
  const o = await drive(['cut', 'cut', 'cut', 'full'], h2StreamReset)
  check('the turn settled on the collected reply after two stream cuts and one fallback cut', o.threw === undefined && o.errors.length === 0 && o.answers.at(-1) === 'recovered without streaming', `threw=${String(o.threw)} errors=${o.errors.join('|')} answers=${o.answers.join('|')}`)
  check('four requests: stream, reissued stream, collected, collected again', o.seen.map(s => `${s.step}${s.stream ? '' : '(collected)'}`).join(',') === 'cut,cut,cut(collected),full(collected)', JSON.stringify(o.seen))
  const words = apiErrorWords(o.notices)
  check('the fallback notice names the second cut in words, never a bare "terminated"', /Anthropic cut the connection mid-response — .*\(ERR_HTTP2_STREAM_ERROR\), twice — waiting up to/.test(words) && !/^terminated/.test(words), words)
  check('the fallback\'s own cut yields a retry row naming the cut and the fresh connection', /The provider cut the connection mid-response — .*\(ERR_HTTP2_STREAM_ERROR\); retrying on a fresh connection/.test(words), words)
}

section('§4 the HTTP/1.1 twin: a socket closed under the body walks the same road')
{
  const o = await drive(['cut', 'full'], h1SocketClosed)
  const cuts = cutNotices(o.notices)
  check('one stream-cut notice carrying UND_ERR_SOCKET, then the streamed reply', o.threw === undefined && o.errors.length === 0 && o.answers.at(-1) === 'the whole reply' && cuts.length === 1 && cuts[0]?.code === 'UND_ERR_SOCKET', `answers=${o.answers.join('|')} notices=${JSON.stringify(o.notices.map(n => [n.subtype, n.code ?? n.error?.message]))}`)
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
