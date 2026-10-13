import assert from 'node:assert/strict'
import { createServer } from 'node:http'
;(globalThis as any).MACRO = { VERSION: 'proof' }
const { searxngSearch, resetSearxngSession } = await import('../../src/services/search/searxng.js')
const { resetSearchPacing } = await import('../../src/services/search/searchPacing.js')
const { SEARXNG_INSTANCES, configuredSearxngInstances } = await import('../../src/services/search/searxngInstances.js')
const { performWebSearch, searchDoorFact } = await import('../../src/services/search/searchDoor.js')
const originalInstances = process.env.MERCURY_SEARCH_SEARXNG_INSTANCES
delete process.env.MERCURY_SEARCH_SEARXNG_INSTANCES
let now = 100_000
const clock = { now: () => now, random: () => 0.5, sleep: async (ms: number) => { now += ms } }
const servers: ReturnType<typeof createServer>[] = []
let firstCount = 0, secondCount = 0, status = 500
try {
  const instances = []
  for (const first of [true, false]) {
    const server = createServer((req, res) => {
      if (first) firstCount++; else secondCount++
      assert.equal(new URL(req.url!, 'http://fixture').searchParams.get('format'), 'json')
      assert.match(String(req.headers['user-agent']), /^Mercury\/proof/)
      res.writeHead(first ? status : 200, { 'content-type': 'application/json', ...(first && status === 429 ? { 'retry-after': '120' } : {}) })
      res.end(JSON.stringify({ results: first ? [] : [{ title: 'Test', url: 'https://example.com/page', content: '<b>test</b>' }] }))
    })
    servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    instances.push({ url: `http://127.0.0.1:${(server.address() as any).port}/`, terms: 'https://example.invalid/terms', checked: 'fixture', apiAllowed: true, why: 'fixture allows its JSON API' })
  }
  const io = { instances, clock, fetchImpl: fetch }
  resetSearchPacing(); resetSearxngSession()
  const first = await searxngSearch({ query: 'test' }, io)
  assert.equal(first.ok, true)
  if (first.ok) { assert.equal(first.hits[0]!.source_type, 'searxng'); assert.match(first.notes!.join(' '), /terms/); assert.equal(first.hits[0]!.snippet, 'test') }
  assert.deepEqual([firstCount, secondCount], [1, 1])
  await searxngSearch({ query: 'test again' }, io)
  assert.deepEqual([firstCount, secondCount], [1, 2])
  await searxngSearch({ query: 'test third' }, io)
  assert.deepEqual([firstCount, secondCount], [1, 3])
  resetSearchPacing(); resetSearxngSession(); status = 429
  const before = [firstCount, secondCount]
  const refused = await searxngSearch({ query: 'rate limit' }, io)
  assert.equal(refused.ok, false)
  if (!refused.ok) { assert.equal(refused.kind, 'rate-limited'); assert.match(refused.message, /no other instance/) }
  await searxngSearch({ query: 'do not rotate' }, io)
  assert.deepEqual([firstCount, secondCount], [before[0]! + 1, before[1]])
  now += 120_000
  assert.equal((await searxngSearch({ query: 'after wait' }, io)).ok, true)
  assert.deepEqual([firstCount, secondCount], [before[0]! + 1, before[1]! + 1])
  resetSearchPacing(); resetSearxngSession()
  const unverified = await searxngSearch({ query: 'policy' }, { ...io, instances: instances.map(i => ({ ...i, apiAllowed: false })) })
  assert.equal(unverified.ok, false)
  if (!unverified.ok) assert.match(unverified.message, /policy not verified; not contacted/)
  assert.deepEqual(SEARXNG_INSTANCES, [])
  const noConfigured = await searxngSearch({ query: 'unset' }, { clock, fetchImpl: (async () => { throw new Error('must not fetch without configuration') }) as typeof fetch })
  assert.equal(noConfigured.ok, false)
  if (!noConfigured.ok) assert.match(noConfigured.message, /no metasearch instance configured/)
  assert.match(searchDoorFact('glm-5.2', {}), /no metasearch instance configured/)
  const entry = { url: instances[1]!.url, terms: 'https://example.invalid/terms', apiAllowed: true, checked: '2026-10-13' }
  for (const raw of ['not-json', '{}', JSON.stringify([{ ...entry, apiAllowed: false }]), JSON.stringify([{ ...entry, url: 'http://example.invalid/' }]), JSON.stringify([{ ...entry, url: 'https://user:secret@example.invalid/' }]), JSON.stringify([{ ...entry, url: 'https://example.invalid/?q=query' }]), JSON.stringify([{ ...entry, checked: '' }])]) {
    assert.equal(configuredSearxngInstances(raw).instances.length, 0)
    assert.ok(configuredSearxngInstances(raw).error)
  }
  assert.equal(configuredSearxngInstances(JSON.stringify([entry, entry])).instances.length, 1)
  resetSearchPacing(); resetSearxngSession()
  process.env.MERCURY_SEARCH_SEARXNG_INSTANCES = JSON.stringify([entry])
  const context = { options: { engineModel: 'glm-5.2' }, abortController: new AbortController() } as any
  const runIo = { context, clock, reads: { keylessAllowed: false } }
  const configuredAnswer = await performWebSearch({ query: 'metasearch fixture' }, runIo)
  assert.equal(configuredAnswer.via, 'searxng')
  assert.equal(configuredAnswer.hits[0]!.source_type, 'searxng')
  const afterConfigured = secondCount
  assert.equal((await performWebSearch({ query: 'metasearch fixture' }, runIo)).cached, true)
  assert.equal(secondCount, afterConfigured)
  delete process.env.MERCURY_SEARCH_SEARXNG_INSTANCES
  await assert.rejects(performWebSearch({ query: 'metasearch fixture' }, runIo), /no metasearch instance configured/)
  assert.equal(secondCount, afterConfigured)
  const abort = new AbortController(); abort.abort()
  const cancelled = await searxngSearch({ query: 'cancel', signal: abort.signal }, io)
  assert.equal(cancelled.ok, false)
  if (!cancelled.ok) assert.equal(cancelled.kind, 'aborted')
  console.log('PASS metasearch: failed instance remembered, serial rotation, no limit evasion, terms and cancellation')
} finally {
  if (originalInstances === undefined) delete process.env.MERCURY_SEARCH_SEARXNG_INSTANCES
  else process.env.MERCURY_SEARCH_SEARXNG_INSTANCES = originalInstances
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))))
}
