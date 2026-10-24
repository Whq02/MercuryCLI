import assert from 'node:assert/strict'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture } from './runpodFixture.mjs'
import { vastFixture } from './vastFixture.mjs'
import { hfEndpointsFixture } from './hfEndpointsFixture.mjs'
import type { LlmHostQuestion } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const rp = await runpodFixture()
const vast = await vastFixture()
const hf = await hfEndpointsFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { escaped.push(url.origin); throw new Error('Only loopback fixtures are allowed') }
  return nativeFetch(request)
}, nativeFetch)
try {
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const secrets = await import('../../src/services/providers/providerSecrets.ts')
  const { writeHostRecord } = await import('../../src/services/host/store.ts')
  const { runModelDoor } = await import('../../src/services/host/door.ts')
  secrets.writeStoredRunpodApiKey(rp.key)
  secrets.writeStoredVastApiKey(vast.key)
  const record = { name: 'Never created', recipe: 'gpt-oss-120b-h100', status: 'ERROR', price: 9, startedAt: new Date().toISOString(), vendor: 'vast' as const }
  writeHostRecord({ ...record, id: 'failed-create', jobKind: 'setup', jobState: 'failed', creating: 'never-confirmed' })
  writeHostRecord({ ...record, id: 'dead-watch', jobKind: 'watch', jobState: 'failed' })
  const road = createHostRoad({ vendorApiBaseUrls: { runpod: rp.baseUrl, vast: vast.baseUrl, huggingface: hf.baseUrl }, sessionId: 'paid-count' })
  const inspect = async (paid = false) => {
    const questions: LlmHostQuestion[] = []
    await road(async question => { questions.push(question); return paid && question.step === 'door-models' ? 'pods' : null }, () => {}, new AbortController().signal)
    return questions
  }
  const count = (questions: LlmHostQuestion[]) => questions.find(row => row.step === 'door-models')!.rows!.find(row => row.value === 'pods')!.label
  assert.equal(count(await inspect()), 'Machines I’m paying for · 0 · ~$0.00 so far + storage', 'two never-confirmed local records leave the live count and cost at zero')
  const paid = (await inspect(true)).find(row => row.step === 'paid-pods')!
  assert.ok(paid.found.includes('Vast.ai: no instances') && paid.found.includes('Runpod: none'), paid.found)
  assert.equal(paid.rows!.filter(row => !row.value.startsWith('vendor-error:')).length, 0)
  secrets.writeStoredHuggingfaceApiKey('fixture-rejected-count')
  assert.match(count(await inspect()), /paying for · 0\+\? · Hugging Face unread/, 'an unread vendor marks the count unknown')
  const unread = (await inspect(true)).find(row => row.step === 'paid-pods')!
  assert.ok(unread.found.includes('Vast.ai: no instances') && unread.found.includes('Runpod: none') && unread.found.includes('Hugging Face: unread'), unread.found)
  assert.ok(!count(await inspect()).includes('last known'))
  rp.state.pods.set('live-one', { id: 'live-one', name: 'Live machine', status: 'RUNNING', cost: 2, createdAt: record.startedAt, startedAt: record.startedAt })
  assert.match(count(await inspect()), /paying for · 1\+\? · Hugging Face unread/)
  const fallback: LlmHostQuestion[] = []
  await runModelDoor(async question => { fallback.push(question); return null }, () => {}, new AbortController().signal, { offers: async () => [], pods: async () => { throw new Error('offline') }, records: () => [{ ...record, id: 'old-record' }], road })
  assert.match(count(fallback), /paying for · 0\+\?/, 'a failed list never falls back to local records')
  assert.deepEqual(escaped, [])
  console.log('PAID MACHINE COUNT GREEN — only live lists count; rejected vendors stay unknown; empty lists name each connected vendor')
} finally { await rp.close(); await vast.close(); await hf.close(); f.close(); globalThis.fetch = nativeFetch }
