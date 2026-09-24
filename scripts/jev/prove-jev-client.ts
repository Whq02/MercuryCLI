#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-client-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const key of ['TYPESAFE_API_KEY', 'NODE_ENV', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'MERCURY_API_UNIX_SOCKET']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

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

const PROOF_KEY = 'proof-key-jev-not-a-real-key-0001'
const DEAD_BASE = 'http://127.0.0.1:1'

const { startJevStandin, STANDIN_MODEL, STANDIN_TOKEN_FLOOR } = await import('./lib/jevStandin.ts')
const standin = await startJevStandin()
process.env.MERCURY_JEV_BASE = standin.base

const contract = await import('../../src/services/jev/jevContract.ts')
const client = await import('../../src/services/jev/jevClient.ts')
const { JEV_BASE_URL, JEV_MODEL_PIN, JEV_SYSTEMONE_PATH } = contract
const { decodeJevResponse, jevBaseUrl, jevFailureDetail, jevRetryAfterMs, jevSystemOne, jevSystemOneUrl, jevUserAgent, jevWireRequest } = client

const request = {
  state: { observed: 'lease released 1.8s early on 3 of 40 runs', diff: 'clock source changed from monotonic to wall' },
  questions: {
    skew: { type: 'noul' as const, instructions: 'Is a wall-clock adjustment sufficient on its own to explain `observed` given `diff`?' },
    next_test: {
      type: 'choice' as const,
      instructions: 'Which test separates the two causes?',
      criteria: { pin_clock: 'Pin the clock source and re-run', serialise: 'Force single-flight retries', none: 'None of these separates them' },
    },
    blast: { type: 'score' as const, instructions: 'How much of the subsystem does the change touch?', criteria: ['One file', 'One module', 'Cross-cutting'] },
  },
}

const failureOf = (outcome: Awaited<ReturnType<typeof jevSystemOne>>) => (outcome.ok ? undefined : outcome.failure)

section('§1 the base seam and the request shape')
check('MERCURY_JEV_BASE pins the base, without a trailing slash', jevBaseUrl() === standin.base && jevSystemOneUrl() === `${standin.base}${JEV_SYSTEMONE_PATH}`)
check('unset, the base is the documented API', (() => {
  const pinned = process.env.MERCURY_JEV_BASE
  delete process.env.MERCURY_JEV_BASE
  const bare = jevBaseUrl()
  process.env.MERCURY_JEV_BASE = pinned
  return bare === JEV_BASE_URL && JEV_BASE_URL === 'https://api.typesafe.ai'
})())
check('the user agent is the product identity', /^mercury\/1\.0\.0$/.test(jevUserAgent()))
const wire = jevWireRequest(request)
check('the wire body is model, state, questions with the model pinned', JSON.stringify(Object.keys(wire)) === JSON.stringify(['model', 'state', 'questions']) && wire.model === JEV_MODEL_PIN && wire.model === 'jev-1.13.0')
check('state and questions ride verbatim', wire.state === request.state && wire.questions === request.questions)

section('§2 a documented answer decodes; the request bytes on the wire are the documented shape')
const okOutcome = await jevSystemOne(request, PROOF_KEY)
check('the stand-in answered ok', okOutcome.ok === true, JSON.stringify(failureOf(okOutcome)))
check('exactly one request reached the stand-in', standin.received.length === 1)
const sent = standin.received[0]!
check('POST /v1/systemone', sent.method === 'POST' && sent.path === '/v1/systemone')
check('Authorization: Bearer <key>', sent.headers.authorization === `Bearer ${PROOF_KEY}`)
check('Content-Type: application/json', String(sent.headers['content-type']).startsWith('application/json'))
check('User-Agent is Mercury', sent.headers['user-agent'] === jevUserAgent())
check('the body is exactly the documented shape with the model pinned', JSON.stringify(sent.body) === JSON.stringify({ model: 'jev-1.13.0', state: request.state, questions: request.questions }))
if (okOutcome.ok) {
  const { response } = okOutcome
  check('model is the served id', response.model === STANDIN_MODEL)
  const noul = response.answers.skew
  check('noul decodes: type and noul only', noul?.type === 'noul' && noul.noul === 0.95 && !('confidence' in noul))
  const choice = response.answers.next_test
  check('choice decodes: choice, probabilities over every option, confidence', choice?.type === 'choice' && choice.choice === 'pin_clock' && Object.keys(choice.probabilities).length === 3 && Math.abs(Object.values(choice.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-6 && choice.confidence >= 0 && choice.confidence <= 1)
  const score = response.answers.blast
  check('score decodes: score, legend, probabilities, confidence', score?.type === 'score' && typeof score.score === 'number' && score.legend['1'] === 'One module' && Object.keys(score.probabilities).length === 3 && score.confidence >= 0 && score.confidence <= 1)
  check('usage carries the floor plus bytes/4 and free output tokens', response.usage.input_tokens === STANDIN_TOKEN_FLOOR + Math.ceil(Buffer.byteLength(sent.rawBody, 'utf8') / 4) && response.usage.output_tokens === 20)
}

section('§3 every documented refusal is one request, typed by status, with the body\'s own words')
type Case = { label: string; script: Parameters<typeof standin.next>[0]; kind: string; status: number; detail?: RegExp; retryAfterMs?: number | 'absent' | 'positive' }
const cases: Case[] = [
  { label: '401 is an invalid key', script: { status: 401, body: { error: { type: 'authentication_error', message: 'Invalid API key' } } }, kind: 'invalid-key', status: 401, detail: /^Invalid API key$/ },
  { label: '422 is a bad request naming the field', script: { status: 422, body: { error: { message: 'questions.blast.criteria: Score needs 2..10 levels' } } }, kind: 'bad-request', status: 422, detail: /questions\.blast\.criteria/ },
  { label: '429 with retry-after-ms carries the wait in ms', script: { status: 429, body: { error: { message: 'Too Many Requests' } }, headers: { 'retry-after-ms': '1500' } }, kind: 'rate-limited', status: 429, retryAfterMs: 1500 },
  { label: '429 with Retry-After seconds carries the wait in ms', script: { status: 429, raw: 'Too Many Requests', headers: { 'retry-after': '4' } }, kind: 'rate-limited', status: 429, retryAfterMs: 4000, detail: /^Too Many Requests$/ },
  { label: '429 with no header names no wait', script: { status: 429, body: { error: { message: 'Too Many Requests' } } }, kind: 'rate-limited', status: 429, retryAfterMs: 'absent' },
  { label: '529 is the provider down', script: { status: 529, body: { error: { type: 'overloaded_error', message: 'Overloaded' } } }, kind: 'provider-down', status: 529, detail: /^Overloaded$/ },
  { label: '500 is the provider down', script: { status: 500, raw: 'Internal Server Error' }, kind: 'provider-down', status: 500, detail: /^Internal Server Error$/ },
  { label: '402 with a credit body is a refusal quoting the body', script: { status: 402, body: { error: { message: 'Insufficient credits: top up at console.typesafe.ai' } } }, kind: 'provider-refused', status: 402, detail: /^Insufficient credits/ },
]
for (const c of cases) {
  standin.reset()
  standin.next({ ...c.script, headers: { ...(c.script.headers ?? {}), 'x-typesafe-request-id': `req-${c.status}` } })
  const outcome = await jevSystemOne(request, PROOF_KEY)
  const failure = failureOf(outcome)
  check(c.label, failure?.kind === c.kind && failure.status === c.status, JSON.stringify(failure))
  if (c.detail) check(`  the detail is the body's words verbatim`, failure !== undefined && c.detail.test(failure.detail), failure?.detail)
  if (c.retryAfterMs === 'absent') check('  retryAfterMs is undefined, never fabricated', failure !== undefined && failure.retryAfterMs === undefined)
  else if (typeof c.retryAfterMs === 'number') check(`  retryAfterMs is ${c.retryAfterMs}`, failure?.retryAfterMs === c.retryAfterMs, String(failure?.retryAfterMs))
  check('  the request id rides along', failure?.requestId === `req-${c.status}`)
  check('  exactly one request reached the stand-in — no retry', standin.received.length === 1, String(standin.received.length))
  check('  the key never enters the failure', !JSON.stringify(failure).includes(PROOF_KEY))
}

standin.reset()
standin.next({ status: 401, body: { error: { message: `Invalid API key ${PROOF_KEY} for this account` } } })
const echoed = failureOf(await jevSystemOne(request, PROOF_KEY))
check('a body that echoes the key is scrubbed before it can ride a failure', echoed?.detail === 'Invalid API key <key> for this account' && !JSON.stringify(echoed).includes(PROOF_KEY), echoed?.detail)

section('§4 a 200 Mercury cannot read is parse-failed naming the path, never an answer')
const malformed: Array<{ label: string; script: Parameters<typeof standin.next>[0]; path: RegExp }> = [
  { label: 'not JSON', script: { status: 200, raw: '{not json' }, path: /the body is not JSON/ },
  { label: 'no answers', script: { status: 200, body: { model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 0 } } }, path: /^answers: / },
  { label: 'a missing answer', script: { status: 200, body: { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } } }, path: /^answers\.skew: / },
  { label: 'a noul out of range', script: { status: 200, body: { model: 'jev-1.13.0', answers: { skew: { type: 'noul', noul: 1.5 } }, usage: { input_tokens: 1, output_tokens: 0 } } }, path: /^answers\.skew\.noul: / },
  { label: 'a choice without confidence', script: { status: 200, body: { model: 'jev-1.13.0', answers: { skew: { type: 'noul', noul: 0.5 }, next_test: { type: 'choice', choice: 'pin_clock', probabilities: { pin_clock: 0.5, serialise: 0.3, none: 0.2 } } }, usage: { input_tokens: 1, output_tokens: 0 } } }, path: /^answers\.next_test\.confidence: / },
  { label: 'a choice whose probabilities miss an option', script: { status: 200, body: { model: 'jev-1.13.0', answers: { skew: { type: 'noul', noul: 0.5 }, next_test: { type: 'choice', choice: 'pin_clock', probabilities: { pin_clock: 0.7, serialise: 0.3 }, confidence: 0.4 } }, usage: { input_tokens: 1, output_tokens: 0 } } }, path: /^answers\.next_test\.probabilities\.none: missing/ },
  { label: 'a score with the wrong legend size', script: { status: 200, body: { model: 'jev-1.13.0', answers: { skew: { type: 'noul', noul: 0.5 }, next_test: { type: 'choice', choice: 'pin_clock', probabilities: { pin_clock: 0.5, serialise: 0.3, none: 0.2 }, confidence: 0.4 }, blast: { type: 'score', score: 1, legend: { '0': 'a', '1': 'b' }, probabilities: { '0': 0.5, '1': 0.5 }, confidence: 0.1 } }, usage: { input_tokens: 1, output_tokens: 0 } } }, path: /^answers\.blast\.legend/ },
  { label: 'a type that does not match the question', script: { status: 200, body: { model: 'jev-1.13.0', answers: { skew: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } } }, path: /^answers\.skew\.type: expected "noul"/ },
  { label: 'usage missing', script: { status: 200, body: { model: 'jev-1.13.0', answers: { skew: { type: 'noul', noul: 0.5 }, next_test: { type: 'choice', choice: 'pin_clock', probabilities: { pin_clock: 0.5, serialise: 0.3, none: 0.2 }, confidence: 0.4 }, blast: { type: 'score', score: 1, legend: { '0': 'a', '1': 'b', '2': 'c' }, probabilities: { '0': 0.5, '1': 0.3, '2': 0.2 }, confidence: 0.1 } } } }, path: /^usage: / },
  { label: 'model missing', script: { status: 200, body: { answers: {}, usage: { input_tokens: 1, output_tokens: 0 } } }, path: /^model: / },
]
for (const m of malformed) {
  standin.reset()
  standin.next(m.script)
  const outcome = await jevSystemOne(request, PROOF_KEY)
  const failure = failureOf(outcome)
  check(`${m.label} ⇒ parse-failed`, failure?.kind === 'parse-failed' && failure.status === 200 && m.path.test(failure.detail), JSON.stringify(failure))
  check('  one request, no retry', standin.received.length === 1)
}
check('the decoder is total over a non-object body', !decodeJevResponse(null, request.questions).ok && !decodeJevResponse([], request.questions).ok && !decodeJevResponse('x', request.questions).ok)

section('§5 slow, cancelled and dead: provider down, aborted, provider down — one request each, never a retry')
standin.reset()
standin.next({ status: 200, body: {}, delayMs: 1500 })
const slow = await jevSystemOne(request, PROOF_KEY, { timeoutMs: 200 })
const slowFailure = failureOf(slow)
check('a response slower than the deadline is the provider down, in operator words', slowFailure?.kind === 'provider-down' && /timed out after 0\.2s — TypeSafe did not answer/.test(slowFailure.detail), JSON.stringify(slowFailure))
check('  one request reached the stand-in', standin.received.length === 1)
standin.reset()
standin.next({ status: 200, body: {}, delayMs: 1500 })
const controller = new AbortController()
const inFlight = jevSystemOne(request, PROOF_KEY, { signal: controller.signal })
setTimeout(() => controller.abort(), 50)
const cancelled = await inFlight
const cancelledFailure = failureOf(cancelled)
check('an abort mid-flight is aborted, never a timeout', cancelledFailure?.kind === 'aborted' && /cancelled/.test(cancelledFailure.detail), JSON.stringify(cancelledFailure))
check('  the request had been sent (one on the wire)', standin.received.length === 1)
const alreadyAborted = new AbortController()
alreadyAborted.abort()
standin.reset()
const never = await jevSystemOne(request, PROOF_KEY, { signal: alreadyAborted.signal })
check('a signal already aborted sends nothing and reads aborted', failureOf(never)?.kind === 'aborted' && standin.received.length === 0)
standin.reset()
process.env.MERCURY_JEV_BASE = DEAD_BASE
const dead = await jevSystemOne(request, PROOF_KEY)
const deadFailure = failureOf(dead)
check('the dead base is the provider down with the connection words', deadFailure?.kind === 'provider-down' && /^no connection — /.test(deadFailure.detail), JSON.stringify(deadFailure))
check('  nothing reached the stand-in', standin.received.length === 0)
check('  the key never enters the failure', !JSON.stringify(deadFailure).includes(PROOF_KEY))
process.env.MERCURY_JEV_BASE = standin.base

section('§6 the header readers and the detail clip')
check('retry-after-ms wins over Retry-After', jevRetryAfterMs(new Headers({ 'retry-after-ms': '250', 'retry-after': '9' })) === 250)
check('Retry-After seconds when no ms header', jevRetryAfterMs(new Headers({ 'retry-after': '3' })) === 3000)
check('an HTTP-date Retry-After reads as the wait from now', (() => {
  const now = Date.UTC(2020, 0, 1)
  const ms = jevRetryAfterMs(new Headers({ 'retry-after': new Date(now + 7000).toUTCString() }), now)
  return ms === 7000
})())
check('junk, zero and absent read as no wait', jevRetryAfterMs(new Headers({ 'retry-after-ms': 'soon' })) === undefined && jevRetryAfterMs(new Headers({ 'retry-after': '0' })) === undefined && jevRetryAfterMs(new Headers()) === undefined)
check('a JSON envelope yields its message; plain text rides verbatim; blanks collapse', jevFailureDetail('{"error":{"message":"Invalid  API\\nkey"}}') === 'Invalid API key' && jevFailureDetail('  Service\n Unavailable ') === 'Service Unavailable' && jevFailureDetail('') === '(empty body)')
check('a long body is clipped', jevFailureDetail('x'.repeat(1000)).length === 400)

await standin.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
