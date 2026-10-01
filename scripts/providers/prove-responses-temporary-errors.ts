import { ResponsesStreamFold } from '../../src/services/providers/openai/openaiWire.ts'
import { nextBusyRetry, openBusyRetryLadder, takesBusyLadder } from '../../src/services/providers/busyRetry.ts'
const classifier = await import(new URL('../../src/services/providers/temporaryStreamError.ts', import.meta.url).href).catch(() => undefined)

let failures = 0
function check(label: string, value: boolean): void {
  console.log(`[${value ? 'PASS' : 'FAIL'}] ${label}`)
  if (!value) failures++
}
const probe = [
  { type: 'error', code: 'server_error', message: 'The server had an error.' },
  { type: 'error', code: 'rate_limit_exceeded', message: 'Rate limit reached.' },
  { type: 'error', code: 'capacity_exceeded', message: 'The model is temporarily at capacity, try again later.' },
  { type: 'error', code: 'temporarily_unavailable', message: 'Service temporarily unavailable.' },
  { type: 'error', code: 'network_error', message: 'network error' },
  { type: 'error', message: 'The model is currently at capacity. Try again later.' },
  { type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } },
  { type: 'response.failed', response: { error: { code: 'capacity_exceeded', message: 'temporarily at capacity, try again later' } } },
  { type: 'response.failed', response: { error: { message: 'Service is temporarily at capacity. Please try again later.' } } },
  { type: 'response.failed', response: { error: { code: 'internal_error', message: 'Internal error' } } },
]
for (const [index, event] of probe.entries()) {
  const faults = new ResponsesStreamFold().fold(event).filter(row => row.type === 'stream-fault')
  check(`probe ${index + 1} retries its temporary failure`, faults.length === 1 && faults[0]!.fault.retryable)
  check(`probe ${index + 1} takes the existing six-step ladder`, faults.length === 1 && takesBusyLadder(faults[0]!.fault, 'server_error'))
}
for (const type of ['error', 'response.error', 'response.failed']) {
  for (const error of [
    { code: 'authentication', message: 'try again later' },
    { code: 'invalid_api_key', message: 'at capacity' },
    { code: 'permission_denied', message: 'overloaded' },
    { code: 'payment_required', message: 'try again later' },
    { code: 'insufficient_quota', message: 'temporarily unavailable' },
    { code: 'invalid_request_error', message: 'try again later' },
    { code: 'content_policy_violation', message: 'overloaded' },
    { code: 'server_error', type: 'authentication_error', message: 'try again later' },
    { code: 'server_error', message: 'Insufficient credits. Try again later.' },
    { message: 'Billing limit exceeded. Try again later.' },
    { message: 'Invalid API key. Temporarily unavailable.' },
    { message: 'Invalid request: try again later' },
    { message: 'Content policy violation. Try again later.' },
    { message: 'Something else failed.' },
  ]) {
    const event = type === 'response.failed' ? { type, response: { error } } : { ...error, type, error }
    const faults = new ResponsesStreamFold().fold(event).filter(row => row.type === 'stream-fault')
    check(`${type} keeps ${JSON.stringify(error)} final`, faults.length === 1 && !faults[0]!.fault.retryable)
  }
}
for (const type of ['response.failed', 'response.error', 'error']) {
  for (const errorType of ['authentication', 'payment_required', 'invalid_request', 'content_policy_violation']) {
    const error = { code: 'server_error', message: 'Internal server error. Try again later.' }
    const payload = { error, error_type: errorType }
    const event = type === 'response.failed' ? { type, response: payload } : { type, ...payload }
    const faults = new ResponsesStreamFold().fold(event).filter(row => row.type === 'stream-fault')
    check(`${type} canonical ${errorType} outranks collapsed server_error`, faults.length === 1 && !faults[0]!.fault.retryable)
  }
}
for (const error of [{ type: 'authentication_error' }, { type: 'billing_error' }, { code: 'image_content_policy_violation', message: 'try again later' }, { code: 'invalid_authentication_error', message: 'at capacity' }]) {
  const faults = new ResponsesStreamFold().fold({ type: 'error', error }).filter(row => row.type === 'stream-fault')
  check(`type-only or namespaced permanent error stays final: ${JSON.stringify(error)}`, faults.length === 1 && !faults[0]!.fault.retryable)
}
for (const error of [
  { code: 503, message: 'Provider is overloaded', metadata: { error_type: 'provider_overloaded' } },
  { code: 'timeout', message: 'No response in time.' },
  { code: 'provider_unavailable', message: 'Provider returned an empty response.' },
]) {
  const faults = new ResponsesStreamFold().fold({ type: 'error', error }).filter(row => row.type === 'stream-fault')
  check(`nested error ${error.code} retries`, faults.length === 1 && faults[0]!.fault.retryable)
}
check('the exported classifier keeps unknown errors final', classifier?.isTemporaryStreamError({ code: 'future_error', message: 'unexpected failure' }) === false)
check('the exported classifier lets a permanent type veto temporary words', classifier?.isTemporaryStreamError({ type: 'authentication_error', message: 'try again later' }) === false)
check('the exported classifier accepts documented provider_overloaded', classifier?.isTemporaryStreamError({ code: 'provider_overloaded' }) === true)
const ladder = openBusyRetryLadder(0, 1)
let steps = 0
while (nextBusyRetry(ladder, undefined, 0) !== null) steps++
check('temporary faults use six retries, never a fresh ladder per failure', steps === 6 && nextBusyRetry(ladder, undefined, 0) === null)
console.log(`${failures ? 'FAIL' : 'PASS'} responses temporary errors: ${failures} failures`)
process.exitCode = failures ? 1 : 0
