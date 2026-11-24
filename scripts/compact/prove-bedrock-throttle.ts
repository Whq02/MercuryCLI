import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const { classifyOverflowFault } = await import('../../src/engine/requests/overflowSignal.js')
const { mapCompatHttpFailure } = await import('../../src/models/roads/openaicompat/compatChatClient.js')
const { compatFaultToTypedError } = await import('../../src/models/roads/openaicompat/compatChatCallModel.js')
const { getAssistantMessageFromError } = await import('../../src/engine/requests/apiErrorRows.js')
const { isRetryableError } = await import('../../src/engine/requests/withRetry.js')
const { APIError } = await import('../../src/engine/request-parts/sdkErrors.js')
const failures: string[] = []
for (const row of [
  { body: { message: 'Too many tokens, please wait before trying again. The input cannot exceed 5000 tokens.' } },
  { body: { message: 'Too many tokens per day, please wait.' } },
  { body: { __type: 'com.amazonaws.bedrock#ThrottlingException', message: 'prompt is too long' } },
  { body: { code: 'ThrottlingException:aws', message: 'prompt is too long' } },
  { body: { message: 'prompt is too long' }, headers: { 'x-amzn-errortype': 'ThrottlingException:aws' } },
]) {
  const headers = new Headers({ ...row.headers, 'retry-after': '2' })
  const fault = mapCompatHttpFailure(400, row.body, headers)
  if (!fault.retryable || compatFaultToTypedError(fault) !== 'rate_limit' || !/throttl|rate.limit/i.test(fault.code)) failures.push(`compat: ${JSON.stringify(row)}`)
  if (fault.retryAfterMs !== 2000) failures.push('Retry-After was lost')
  if (classifyOverflowFault({ family: 'openai-compat', ...fault }) !== null) failures.push(`overflow: ${JSON.stringify(row)}`)
  const error = new APIError(400, row.body as never, row.body.message, headers)
  if (!isRetryableError(error)) failures.push(`home retry: ${JSON.stringify(row)}`)
  if (getAssistantMessageFromError(error, 'stranger/gateway').error !== 'rate_limit') failures.push(`home result: ${JSON.stringify(row)}`)
}
assert.deepEqual(failures, [])
assert.ok(classifyOverflowFault({ family: 'openai-compat', status: 400, message: 'too many tokens: cannot exceed 4096; received 5000' }), 'classifyOverflowFault returned null for genuine 400 token-limit overflow; check overflow classification')
assert.equal(mapCompatHttpFailure(403, { message: 'ThrottlingException' }).retryable, false)
console.log('Bedrock throttling is retryable, never overflow: PASS')
