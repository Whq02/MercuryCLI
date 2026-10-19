#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APIError } from '../../src/services/api/sdkErrors.js'

const ROOT = join(import.meta.dir, '..', '..')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-env-key-not-real'
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const { getAssistantMessageFromError, API_ERROR_MESSAGE_PREFIX } = await import('../../src/services/api/errors.ts')
const { mapOpenaiHttpFailure } = await import('../../src/services/providers/openai/openaiWire.ts')
const { mapCompatHttpFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { compatTerminalFaultText } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { classifyCredentialWall } = await import('../../src/services/providers/credentialWall.ts')

const textOf = (row: { message: { content: unknown } }): string =>
  (row.message.content as Array<{ type?: string; text?: string }>).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
const anthropicRow = (status: number, body: unknown, message?: string): { text: string; kind: string | undefined } => {
  const wire = message ?? `${status} ${JSON.stringify(body)}`
  const row = getAssistantMessageFromError(new APIError(status, body, wire, new Headers({ 'request-id': 'req_fixture_4xx' })), 'claude-opus-5')
  return { text: textOf(row as never), kind: (row as { error?: string }).error }
}
const envelope = (type: string, message: string): unknown => ({ type: 'error', error: { type, message } })

section('§1 the first-party Anthropic road: an unrecognised 4xx paints the status and the provider\'s own sentence, never the envelope')
const shapes: Array<[number, string, string]> = [
  [400, 'invalid_request_error', 'messages: text content blocks must be non-empty'],
  [409, 'conflict_error', 'the request conflicts with another in flight'],
  [428, 'invalid_request_error', 'a precondition header is required'],
  [422, 'invalid_request_error', 'tools: an unknown field was supplied'],
]
for (const [status, type, sentence] of shapes) {
  const row = anthropicRow(status, envelope(type, sentence))
  console.log(`      ${status}: ${row.text}`)
  check(`${status}: the row reads "${API_ERROR_MESSAGE_PREFIX} (${status}): Anthropic says: ${sentence}"`, row.text === `${API_ERROR_MESSAGE_PREFIX} (${status}): Anthropic says: ${sentence}`, row.text)
  check(`${status}: no brace on the transcript row`, !row.text.includes('{') && !row.text.includes('}'), row.text)
  check(`${status}: the kind stays outside the login flow`, row.kind !== 'authentication_failed', String(row.kind))
}
section('§1b the provider\'s sentence rides WHOLE: a quote, a brace or a line break inside it is unescaped, never a cut at the first escaped quote')
const ROLES = 'messages: roles must alternate between "user" and "assistant", but found multiple "user" roles in a row'
const quoted = anthropicRow(400, envelope('invalid_request_error', ROLES))
console.log(`      quoted: ${quoted.text}`)
check('the real alternating-roles 400 paints its whole sentence, the quoted words included', quoted.text === `${API_ERROR_MESSAGE_PREFIX} (400): Anthropic says: ${ROLES}`, quoted.text)
check('no stray backslash and no envelope byte on the row', !quoted.text.includes('\\') && !quoted.text.includes('{') && !quoted.text.includes('"type"'), quoted.text)
const BRACED = 'unexpected token {"foo": 1} at position 4'
const braced = anthropicRow(400, envelope('invalid_request_error', BRACED))
check('a brace inside the provider\'s own sentence rides as its words (the envelope\'s braces never do)', braced.text === `${API_ERROR_MESSAGE_PREFIX} (400): Anthropic says: ${BRACED}` && !braced.text.includes('"type"') && !braced.text.includes('\\'), braced.text)
const BROKEN = 'the first line of the sentence\nthe second line of the sentence'
const broken = anthropicRow(400, envelope('invalid_request_error', BROKEN))
check('a line break inside the sentence arrives as a line break, not as the two characters of its escape', broken.text === `${API_ERROR_MESSAGE_PREFIX} (400): Anthropic says: ${BROKEN}` && !broken.text.includes('\\n'), JSON.stringify(broken.text))
const rateRow = anthropicRow(429, envelope('rate_limit_error', 'This request would exceed the rate limit for your organization ("org_123") of 50 requests per minute'))
check('the 429 road, served by the same reader, carries its quoted sentence whole', rateRow.text.includes('("org_123") of 50 requests per minute') && !rateRow.text.includes('\\'), rateRow.text)
const plain = anthropicRow(400, undefined, 'the gateway refused the request body')
check('a non-JSON tail rides verbatim under the status', plain.text === `${API_ERROR_MESSAGE_PREFIX} (400): the gateway refused the request body`, plain.text)
const bare = anthropicRow(400, undefined, '')
check('a body-less refusal rides the SDK\'s own words under the status', bare.text === `${API_ERROR_MESSAGE_PREFIX} (400): status code (no body)` && !bare.text.includes('{'), bare.text)
const serverRow = anthropicRow(500, envelope('api_error', 'Internal server error'))
check('a 5xx keeps its standing tail (only the unrecognised 4xx moved)', serverRow.text.startsWith(`${API_ERROR_MESSAGE_PREFIX}: 500 `), serverRow.text)

section('§2 the first-party OpenAI road: the fault carries the sentence the body stated, never the body')
{
  const fault = mapOpenaiHttpFailure(400, { error: { type: 'invalid_request_error', message: 'Invalid value: the input exceeds the context window.' } })
  check('the message is the provider\'s sentence', fault.message === 'Invalid value: the input exceeds the context window.' && !fault.message.includes('{'), fault.message)
  const detail = mapOpenaiHttpFailure(422, { detail: 'Unprocessable: the tool schema is malformed' })
  check('a detail-shaped body rides as its sentence', detail.message === 'Unprocessable: the tool schema is malformed', detail.message)
  const none = mapOpenaiHttpFailure(400, 'not json at all')
  check('a non-JSON body names the status only', none.message === 'HTTP 400' && none.code === 'http-400', `${none.code}: ${none.message}`)
  const road = readFileSync(join(ROOT, 'src/services/providers/openai/openaiCallModel.ts'), 'utf8')
  check('the OpenAI painter spells the status and the sentence', road.includes('OpenAI stream failed (${outcome.fault.code}) — ${outcome.fault.message}'))
}

section('§3 a compat lane: the sentence painter and the credential kind the seam hands the wall classifier')
{
  const body = { error: { message: 'max_tokens is above the model limit' } }
  const fault = mapCompatHttpFailure(400, body)
  const profile = { providerLabel: 'DeepSeek', credentialHint: 'no DeepSeek key', authRemedy: 'set DEEPSEEK_API_KEY', billingRemedy: 'top up' }
  const line = compatTerminalFaultText(profile, fault, 'invalid_request')
  console.log(`      compat 400: ${line}`)
  check('the compat row reads the label, the status and the sentence, no brace', line === `${API_ERROR_MESSAGE_PREFIX}: DeepSeek stream failed (http-400) — max_tokens is above the model limit` && !line.includes('{'), line)
  check('a refused sign-in on a compat lane is the sign-in wall whatever the sentence says', classifyCredentialWall(401, 'Unauthorized', 'sign-in') === 'sign-in' && classifyCredentialWall(403, 'forbidden', 'sign-in') === 'sign-in')
  check('a refused key names no wall unless its words name a reached cap', classifyCredentialWall(401, 'Unauthorized') === undefined && classifyCredentialWall(401, 'Unauthorized', 'key') === undefined && classifyCredentialWall(403, 'Key limit exceeded', 'key') === 'key-limit')
  const seam = readFileSync(join(ROOT, 'src/services/providers/openaicompat/compatChatCallModel.ts'), 'utf8')
  check('the compat seam hands the classifier its lane\'s credential kind: a sign-in whose refresh route was tried', seam.includes("classifyCredentialWall(outcome.fault.status, outcome.fault.message, recovery !== undefined ? 'sign-in' : undefined)"))
}

section('§4 one law for the three roads: a transcript row never carries a brace')
{
  const rows = [
    anthropicRow(400, envelope('invalid_request_error', 'messages: text content blocks must be non-empty')).text,
    `${API_ERROR_MESSAGE_PREFIX}: OpenAI stream failed (http-400) — ${mapOpenaiHttpFailure(400, { error: { message: 'bad request' } }).message}`,
    compatTerminalFaultText({ providerLabel: 'Moonshot', credentialHint: '' }, mapCompatHttpFailure(400, { error: { message: 'bad request' } }), 'invalid_request'),
  ]
  check('none of the three rows carries a brace', rows.every(row => !row.includes('{') && !row.includes('}')), JSON.stringify(rows))
  check('every row opens with the shared prefix', rows.every(row => row.startsWith(API_ERROR_MESSAGE_PREFIX)))
}

console.log(`\n${checks} checks, ${failures} failed`)
console.log(failures === 0 ? '✅ prove-unrecognised-4xx-sentence: the sentence, never the envelope' : `❌ prove-unrecognised-4xx-sentence: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
