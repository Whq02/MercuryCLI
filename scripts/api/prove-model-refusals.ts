import { strict as assert } from 'node:assert'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
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
console.log(`Model refusals: ${checks} checks passed`)
