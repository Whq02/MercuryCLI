import assert from 'node:assert/strict'
import { createServer } from 'node:http'
;(globalThis as any).MACRO = { VERSION: 'proof' }
const { searxngSearch, resetSearxngSession } = await import('../../src/services/search/searxng.js')
const { resetSearchPacing } = await import('../../src/services/search/searchPacing.js')
const { SEARXNG_INSTANCES } = await import('../../src/services/search/searxngInstances.js')
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
  assert.ok(SEARXNG_INSTANCES.every(i => i.url.startsWith('https://') && i.checked === '2026-10-13' && i.terms))
  const abort = new AbortController(); abort.abort()
  const cancelled = await searxngSearch({ query: 'cancel', signal: abort.signal }, io)
  assert.equal(cancelled.ok, false)
  if (!cancelled.ok) assert.equal(cancelled.kind, 'aborted')
  console.log('PASS metasearch: failed instance remembered, serial rotation, no limit evasion, terms and cancellation')
} finally { await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r())))) }
