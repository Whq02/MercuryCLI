import assert from 'node:assert/strict'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { validateEngineRequest } from './fixtures/engineRules.mjs'

const f = await llmhostFixture()
const fetchBefore = globalThis.fetch
try {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    assert.equal(url.hostname, '127.0.0.1')
    return fetchBefore(input, init)
  }) as typeof fetch
  f.state.dialect = 'ollama'
  f.state.thinkingValues = ['low', 'medium', 'high', 'max']
  const { updateSettingsForSource } = await import(`${f.root}/src/utils/settings/settings.ts`)
  const { cachedCompatCatalogue } = await import(`${f.root}/src/services/providers/openaicompat/compatCatalogue.ts`)
  const { compatModelEndpoint } = await import(`${f.root}/src/services/providers/openaicompat/compatAccounts.ts`)
  const model = `compat/cold-ollama/${f.model}`
  assert.equal(updateSettingsForSource('userSettings', { compatProvider: { 'cold-ollama': { baseUrl: f.baseUrl, dialect: 'ollama', models: [f.model] } } }).error, null)
  const endpoint = compatModelEndpoint(model)!.endpoint
  assert.equal(cachedCompatCatalogue(endpoint), undefined, 'no picker, recheck or previous request warmed the catalogue')
  const before = f.state.requests
  const first = await f.run(model, undefined, AbortSignal.timeout(10000), 'max')
  assert.equal(f.captures.length, 1)
  assert.equal(f.captures[0]!.body.reasoning_effort, 'max', 'the first request carries the selected max, not a server default')
  assert.ok(first.every(row => !row.isApiErrorMessage))
  assert.equal(first.at(-1).effort.applied, 'max')
  assert.equal(validateEngineRequest('ollama', f.captures[0]!.body), undefined)
  assert.ok(f.state.requests > before + 1, 'cold request reads the served metadata')
  const warmBefore = f.state.requests
  const second = await f.run(model, undefined, AbortSignal.timeout(10000), 'max')
  assert.equal(f.state.requests - warmBefore, 1, 'warm catalogue does not re-probe per turn')
  assert.equal(f.captures.at(-1)!.body.reasoning_effort, 'max')
  assert.deepEqual(f.captures.at(-1)!.body.tools, f.captures[0]!.body.tools)
  assert.ok(second.every(row => !row.isApiErrorMessage))
  const controller = new AbortController()
  controller.abort()
  const cancelBefore = f.state.requests
  await f.run(model, undefined, controller.signal, 'max')
  assert.equal(f.state.requests, cancelBefore, 'pre-cancel does not probe or generate')
  console.log('PASS cold Ollama max is sent on request one; warm catalogue is reused; cancellation stays quiet')
} finally { globalThis.fetch = fetchBefore; f.close() }
