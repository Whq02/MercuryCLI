import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'model-refusals-'))
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = '2.1.280'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_CUSTOM_OAUTH_URL = 'http://127.0.0.1:1'
for (const key of ['NODE_ENV', 'CI', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', 'MERCURY_API_KEY_FILE_DESCRIPTOR']) delete process.env[key]
writeFileSync(join(home, '.mercury.json'), JSON.stringify({ customApiKeyResponses: { approved: ['proof-key-ci-gate-not-a-real-key'.slice(-20)], rejected: [] } }))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const refusals = await import('../../src/services/providers/anthropic/modelRefusal.js')
const { APIError } = await import('@anthropic-ai/sdk')
const MODEL = 'claude-opus-5-5'
const DOOR = 'Claude subscription (max)'
const WIRE = '2.1.280 does not support this model; version 2.1.290 or newer is required. Run claude update.'
const facts = {
  status: 400, errorType: 'invalid_request_error', wireText: WIRE,
  model: MODEL, door: DOOR, subscriber: true, presented: '2.1.280', seenAtMs: 1000,
}
let checks = 0
function check(label: string, value: unknown): void {
  assert(value, label)
  checks++
  console.log(`PASS ${label}`)
}

const { getAssistantMessageFromError, clientContractGateLine, API_ERROR_MESSAGE_PREFIX } = await import('../../src/services/api/errors.js')
const { setIsInteractive } = await import('../../src/bootstrap/state.js')
setIsInteractive(true)
const errorFor = (status: number, type: string, message: string) =>
  new APIError(status, { type: 'error', error: { type, message } }, undefined, undefined as never)
const textOf = (message: ReturnType<typeof getAssistantMessageFromError>): string =>
  message.message.content.map(block => block.type === 'text' ? block.text : '').join('')
const gate = errorFor(400, 'invalid_request_error', WIRE)
const paintedFloor = textOf(getAssistantMessageFromError(gate, MODEL))
check('the contract refusal paints one sentence, not separate cause and remedy sentences', (paintedFloor.match(/[.!?](?=\s|$)/g) ?? []).length === 1)
check('the row keeps the API error prefix and names the display name, current door and required version', paintedFloor.startsWith(`${API_ERROR_MESSAGE_PREFIX} (400): Opus 5.5 is refused on Anthropic API key:`) && paintedFloor.includes('needs client version 2.1.290 and Mercury presents 2.1.280'))
check('the exported contract line uses the same words', clientContractGateLine(WIRE, MODEL) === paintedFloor)
check('the row names the override and restart, never the wire updater', paintedFloor.includes('MERCURY_ANTHROPIC_CLIENT_CONTRACT=2.1.290 and restart Mercury') && !paintedFloor.includes('claude update'))
check('model refusals have one classifier rather than separate message branches', typeof refusals.classifyModelRefusal === 'function')
const floor = refusals.classifyModelRefusal(facts)
check('the contract gate records the floor, the wire read and the presented version separately', floor?.kind === 'contract-floor' && floor.floor === '2.1.290' && floor.read === '2.1.280' && floor.presented === '2.1.280')
check('the refusal keeps the id, credential label and observation time', floor?.id === MODEL && floor.door === DOOR && floor.seenAtMs === 1000)
check('an error code alone classifies without guessing a floor', refusals.classifyModelRefusal({ ...facts, wireText: 'claude_code_version_too_old' })?.floor === undefined)
check('a subscriber invalid model name on Opus is a tier refusal', refusals.classifyModelRefusal({ ...facts, wireText: 'invalid model name' })?.kind === 'tier')
check('an API key invalid model name is not called a subscription tier', refusals.classifyModelRefusal({ ...facts, wireText: 'invalid model name', subscriber: false }) === null)
check('a 404 naming the exact model is not served', refusals.classifyModelRefusal({ ...facts, status: 404, errorType: 'not_found_error', wireText: `model: ${MODEL}` })?.kind === 'not-served')
check('a model-scoped organisation 403 is not served', refusals.classifyModelRefusal({ ...facts, status: 403, errorType: 'permission_error', wireText: `Your organisation is not enabled for ${MODEL}` })?.kind === 'not-served')
for (const [status, errorType, wireText] of [
  [401, 'authentication_error', `OAuth token revoked for ${MODEL}`],
  [403, 'permission_error', `OAuth token revoked for ${MODEL}`],
  [403, 'authentication_error', `OAuth token expired for ${MODEL}`],
  [403, 'permission_error', `API key limit reached for ${MODEL}`],
  [429, 'rate_limit_error', `usage window reached for ${MODEL}`],
  [400, 'invalid_request_error', '`tool_use` ids were found without `tool_result` blocks immediately after'],
  [400, 'invalid_request_error', 'prompt is too long'],
  [400, 'invalid_request_error', 'image exceeds maximum size'],
  [404, 'not_found_error', '/v1/messages was not found'],
  [404, 'not_found_error', `model: ${MODEL}-other`],
  [404, 'invalid_request_error', `model: ${MODEL}`],
  [403, 'permission_error', 'Your organisation is disabled'],
] as const) {
  check(`${status} ${wireText} stays with its existing owner`, refusals.classifyModelRefusal({ ...facts, status, errorType, wireText }) === null)
}
for (const body of [
  { type: 'error', error: { type: 'not_found_error', message: `model: ${MODEL}` } },
  { type: 'not_found_error', message: `model: ${MODEL}` },
]) {
  const error = new APIError(404, body, undefined, undefined as never)
  check('SDK outer and inner error bodies keep their error type', refusals.modelRefusalErrorType(error) === 'not_found_error')
}
const tier = refusals.classifyModelRefusal({ ...facts, wireText: 'invalid model name' })!
const missing = refusals.classifyModelRefusal({ ...facts, status: 404, errorType: 'not_found_error', wireText: `model: ${MODEL}.` })!
for (const refusal of [floor!, tier, missing]) {
  check(`${refusal.kind} names the display model and the unchanged credential label`, refusal.words.includes('Opus 5.5') && refusal.words.includes(DOOR))
  check(`${refusal.kind} has only one sentence terminator outside version numbers`, (refusal.words.match(/[.!?](?=\s|$)/g) ?? []).length === 1 && refusal.words.endsWith('.'))
  check(`${refusal.kind} offers /model and no wire updater`, refusal.words.includes('/model') && !refusal.words.includes('claude update'))
}
check('an unknown id keeps its raw tag', refusals.classifyModelRefusal({ ...facts, status: 404, model: 'claude-opus-5-7', errorType: 'not_found_error', wireText: 'model: claude-opus-5-7' })?.words.startsWith('claude-opus-5-7 is not served'))
const notServed = getAssistantMessageFromError(errorFor(404, 'not_found_error', `model: ${MODEL}`), MODEL)
check('the 404 paints the not-served sentence', textOf(notServed).includes('Opus 5.5 is not served on Anthropic API key (the endpoint answered 404)') && notServed.error === 'invalid_request')
check('the 404 retains status, model and request id evidence outside the sentence', notServed.errorDetails === `HTTP 404 · model: ${MODEL} · request_id: unknown`)
const withRequestId = errorFor(404, 'not_found_error', `model: ${MODEL}`)
Object.assign(withRequestId, { request_id: 'req_model' })
check('a provider request id survives the new sentence', getAssistantMessageFromError(withRequestId, MODEL).errorDetails?.endsWith('request_id: req_model'))
const unrelated404 = textOf(getAssistantMessageFromError(errorFor(404, 'not_found_error', '/v1/messages was not found'), MODEL))
check('an unrelated 404 keeps its original row byte for byte', unrelated404 === `There is an issue with the selected model (${MODEL}) — it may not exist or may be inaccessible (HTTP 404, request_id: unknown). Run \`/model\` to pick a different model.`)
check('a model-specific 403 is not called a sign-in failure', getAssistantMessageFromError(errorFor(403, 'permission_error', `Your organisation is not enabled for ${MODEL}`), MODEL).error === 'invalid_request')
check('revoked credentials keep their exact row', textOf(getAssistantMessageFromError(errorFor(401, 'authentication_error', 'OAuth access token has been revoked'), MODEL)) === `${API_ERROR_MESSAGE_PREFIX}: Anthropic sign-in expired — switch providers (/model) or reconnect (/logins anthropic)`)
check('tool pairing keeps its exact row', textOf(getAssistantMessageFromError(errorFor(400, 'invalid_request_error', '`tool_use` ids were found without `tool_result` blocks immediately after'), MODEL)) === `${API_ERROR_MESSAGE_PREFIX} (400): a tool-use concurrency problem left a tool use without its result. Run /rewind to recover from an earlier point.`)
const auth = await import('../../src/utils/auth.js')
delete process.env.ANTHROPIC_API_KEY
writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: null } }))
auth.clearOAuthTokenCache()
check('a subscriber tier refusal paints the display model and its own door', textOf(getAssistantMessageFromError(errorFor(400, 'invalid_request_error', 'invalid model name'), MODEL)) === `${API_ERROR_MESSAGE_PREFIX} (400): ${tier.words}`)
check('a subscription window keeps its exact row', textOf(getAssistantMessageFromError(errorFor(429, 'rate_limit_error', 'usage window reached'), MODEL)) === `${API_ERROR_MESSAGE_PREFIX} (429, request rejected): Anthropic says: usage window reached`)
for (const refusal of refusals.standingModelRefusals()) refusals.clearModelRefusal(refusal.id, refusal.door)
refusals.noteModelRefusal(tier)
check('a noted refusal is standing and the picker receives its exact words', refusals.standingModelRefusals().length === 1 && refusals.modelRefusalWords(MODEL) === tier.words)
check('case, spacing and context annotations share the same refused id', refusals.modelRefusalWords(' CLAUDE-OPUS-5-5[1M] ') === tier.words)
const newer = { ...tier, words: `${tier.words} newer`, seenAtMs: tier.seenAtMs + 1 }
refusals.noteModelRefusal(newer)
refusals.noteModelRefusal(tier)
check('the newest observation wins, not the last-arriving older observation', refusals.modelRefusalWords(MODEL) === newer.words && refusals.standingModelRefusals().length === 1)
refusals.clearModelRefusal(MODEL, 'Anthropic API key')
check('success on another door cannot clear this refusal', refusals.modelRefusalWords(MODEL) === newer.words)
refusals.clearModelRefusal(MODEL, DOOR)
check('success on the same id and door clears the observation and words', refusals.standingModelRefusals().length === 0 && refusals.modelRefusalWords(MODEL) === undefined)
refusals.noteModelRefusal({ ...missing, door: 'Anthropic API key' })
check('a refusal on another door is recorded without gating the current one', refusals.standingModelRefusals().length === 1 && refusals.modelRefusalWords(MODEL) === undefined)
refusals.clearModelRefusal(MODEL, 'Anthropic API key')
refusals.noteModelRefusal(floor!)
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = '2.1.290'
check('raising the presented contract removes the standing floor from both readers', refusals.standingModelRefusals().length === 0 && refusals.modelRefusalWords(MODEL) === undefined)
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = '2.1.280'
refusals.clearModelRefusal(MODEL, DOOR)
const requestDoor = refusals.captureModelRefusalRequest(MODEL)
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
const capturedRow = getAssistantMessageFromError(gate, MODEL, { modelRefusalRequest: requestDoor })
check('a changed door after dispatch cannot rewrite the refusal attribution', textOf(capturedRow).includes(`on ${DOOR}:`) && refusals.modelRefusalWords(MODEL) === undefined)
delete process.env.ANTHROPIC_API_KEY
check('returning to the refused door restores its words', refusals.modelRefusalWords(MODEL) === textOf(capturedRow).replace(`${API_ERROR_MESSAGE_PREFIX} (400): `, ''))
refusals.clearModelRefusal(MODEL, DOOR)
refusals.noteModelRefusal(tier)
const storedDirectory = join(home, 'model-refusals')
const storedPath = join(storedDirectory, readdirSync(storedDirectory).find(name => name.endsWith('.json'))!)
const stored = JSON.parse(readFileSync(storedPath, 'utf8'))
check('the refusal is persisted beneath the auth home with its contract', stored.version === 1 && stored.refusal.presented === '2.1.280' && !readFileSync(storedPath, 'utf8').includes('fixture-access'))
const externalWrite = (text: string): void => {
  const temporary = join(storedDirectory, 'fixture.tmp')
  writeFileSync(temporary, text)
  renameSync(temporary, storedPath)
  utimesSync(storedDirectory, new Date(), new Date(Date.now() + 1000))
}
externalWrite(JSON.stringify({ version: 1, refusal: { ...floor, seenAtMs: 3000 } }))
check('another writer publishing a record replaces the directory memo immediately', refusals.modelRefusalWords(MODEL) === floor!.words)
const sibling = refusals.classifyModelRefusal({ ...facts, model: 'claude-sonnet-5', status: 404, errorType: 'not_found_error', wireText: 'model: claude-sonnet-5' })!
refusals.noteModelRefusal(sibling)
check('two back-to-back refusals keep two independent records', refusals.standingModelRefusals().length === 2 && readdirSync(storedDirectory).filter(name => name.endsWith('.json')).length === 2)
externalWrite('{')
check('an unreadable record is skipped while the other refusal stays visible', refusals.standingModelRefusals().length === 1 && refusals.modelRefusalWords(MODEL) === undefined && refusals.modelRefusalWords(sibling.id) === sibling.words)
refusals.noteModelRefusal({ ...tier, seenAtMs: 3001 })
refusals.clearModelRefusal(MODEL, DOOR)
check('clearing one record leaves the other refusal intact', refusals.standingModelRefusals().length === 1 && refusals.modelRefusalWords(sibling.id) === sibling.words)
refusals.clearModelRefusal(sibling.id, DOOR)
for (let n = 0; n < 15; n++) refusals.noteModelRefusal({ ...tier, id: `claude-fixture-${n}`, seenAtMs: 4000 + n })
check('reads and writes bound the persisted set to its newest dozen records', refusals.standingModelRefusals().length === 12 && readdirSync(storedDirectory).filter(name => name.endsWith('.json')).length === 12)
check('a successful publish leaves no temporary record', readdirSync(storedDirectory).every(name => name.endsWith('.json')))
for (const refusal of refusals.standingModelRefusals()) refusals.clearModelRefusal(refusal.id, refusal.door)

const { queryModelWithStreaming, queryModelWithoutStreaming } = await import('../../src/services/providers/anthropic/streamCore.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')
const successFetch = (async () => {
  const event = (type: string, body: unknown): string => `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`
  return new Response([
    event('message_start', { type: 'message_start', message: { id: 'msg_model_success', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answered' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } })
}) as typeof fetch
const input = () => ({
  messages: [createUserMessage({ content: 'Reply with one word.' })], systemPrompt: asSystemPrompt(['Reply briefly.']),
  thinkingConfig: { type: 'disabled' as const }, tools: [], signal: new AbortController().signal,
  options: { model: MODEL, fetchOverride: successFetch, querySource: 'agent:refusal-fixture', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64 } as never,
})
for (const road of ['streamed', 'collected'] as const) {
  getAssistantMessageFromError(gate, MODEL)
  check(`${road}: the error seam itself records a standing refusal`, refusals.modelRefusalWords(MODEL) !== undefined)
  if (road === 'collected') {
    const answer = await queryModelWithoutStreaming(input())
    check('the collected request actually succeeds', !answer.isApiErrorMessage && textOf(answer) === 'answered')
  } else {
    let answered = false
    for await (const item of queryModelWithStreaming(input())) {
      if (item.type === 'assistant' && !item.isApiErrorMessage && textOf(item) === 'answered') answered = true
    }
    check('the streamed request actually succeeds', answered)
  }
  check(`${road}: the completed request clears the same id and door`, refusals.standingModelRefusals().length === 0 && refusals.modelRefusalWords(MODEL) === undefined)
}
console.log(`Model refusals: ${checks} checks passed`)
