import assert from 'node:assert/strict'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { validateEngineRequest } from './fixtures/engineRules.mjs'

const f = await llmhostFixture()
const fetchBefore = globalThis.fetch
let checks = 0
try {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    assert.equal(url.hostname, '127.0.0.1', 'the proof never leaves loopback')
    return fetchBefore(input, init)
  }) as typeof fetch
  const { updateSettingsForSource } = await import(`${f.root}/src/utils/settings/settings.ts`)
  const { resolveEffortTruth } = await import(`${f.root}/src/utils/effort.ts`)
  for (const dialect of ['llamacpp', 'vllm', 'sglang', 'ollama', 'chat-completions']) {
    f.state.dialect = dialect
    const id = `compat/refusal-${dialect}/${f.model}`
    assert.equal(updateSettingsForSource('userSettings', {
      compatProvider: { [`refusal-${dialect}`]: { baseUrl: f.baseUrl, dialect, models: [f.model] } },
      models: { [id]: { efforts: ['low', 'high', 'max'], maxOutputTokens: 65536, contextWindow: 1048576 } },
    }).error, null)
    for (const mode of ['reject-effort', ...(dialect === 'llamacpp' ? ['reject-template'] : []), 'reject-persistent', 'reject-other']) {
      f.state.mode = mode
      const before = f.captures.length
      const replies = await f.run(id, undefined, AbortSignal.timeout(10000), 'max')
      assert.equal(f.captures.length - before, 1, `${dialect}/${mode}: refusal must not retry with less effort`)
      assert.equal(replies.length, 1, `${dialect}/${mode}: one terminal refusal, not a successful fallback`)
      assert.equal(replies[0].isApiErrorMessage, true)
      assert.equal(replies[0].error, 'invalid_request')
      assert.equal(replies[0].effort.asked, 'max')
      assert.equal(replies[0].effort.applied, 'max')
      assert.equal(replies[0].effortAdjusted, undefined)
      if (mode !== 'reject-other') assert.match(JSON.stringify(replies[0].message.content), /selected effort and thinking are unchanged/)
      const sent = f.captures.at(-1)!.body
      assert.equal(sent.reasoning_effort ?? sent.chat_template_kwargs?.reasoning_effort, 'max')
      assert.equal(sent.max_tokens, 65536)
      assert.ok(sent.tools.some((tool: any) => tool.function.name === 'FixtureEcho'))
      if (dialect === 'sglang') assert.equal(sent.chat_template_kwargs.clear_thinking, false)
      if (dialect !== 'chat-completions') assert.equal(validateEngineRequest(dialect, sent), undefined)
      checks++
    }
    f.state.mode = 'retry'
    const before = f.captures.length
    const retried = await f.run(id, undefined, AbortSignal.timeout(10000), 'max')
    assert.equal(f.captures.length - before, 2, `${dialect}: a transient 408 still retries`)
    assert.deepEqual(f.captures[before]!.body, f.captures[before + 1]!.body, `${dialect}: retry keeps the entire request`)
    assert.ok(retried.every(row => !row.isApiErrorMessage))
    assert.equal(retried.at(-1).effort.applied, 'max')
    const resumed = await f.run(id, undefined, AbortSignal.timeout(10000), 'max')
    assert.ok(resumed.every(row => !row.isApiErrorMessage))
    assert.equal(resumed.at(-1).effort.applied, 'max')
    assert.equal(resolveEffortTruth(id, 'max').requested, 'max')
    checks += 2
  }
  const id = `compat/no-dial/${f.model}`
  assert.equal(updateSettingsForSource('userSettings', {
    compatProvider: { 'no-dial': { baseUrl: f.baseUrl, dialect: 'chat-completions', models: [f.model] } },
  }).error, null)
  const truth = resolveEffortTruth(id, 'max')
  assert.equal(truth.requested, 'max')
  assert.equal(truth.label, 'no effort control')
  assert.equal(truth.supportsEffort, false)
  const noDial = await f.run(id, undefined, AbortSignal.timeout(10000), 'max')
  assert.equal(f.captures.at(-1)!.body.reasoning_effort, undefined)
  assert.equal(noDial.at(-1).effort.asked, 'max')
  assert.equal(noDial.at(-1).effort.applied, 'not supported by this model')
  console.log(`PASS ${checks + 1} effort refusal, unchanged retry/resume and no-dial legs; loopback only`)
} finally {
  globalThis.fetch = fetchBefore
  f.close()
}
