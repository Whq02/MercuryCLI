import assert from 'node:assert/strict'
import { createServer } from 'node:http'
;(globalThis as any).MACRO = { VERSION: 'proof', PACKAGE_URL: 'https://example.invalid' }
const { officialSearch, officialSearchUrl, wikipediaPhrase, wikipediaLegNote } = await import('../../src/services/search/officialSearch.js')
const { performWebSearch } = await import('../../src/services/search/searchDoor.js')
const { officialSearchIntent } = await import('../../src/services/search/searchSources.js')
const pacing = await import('../../src/services/search/searchPacing.js')
const { mapSearchResult } = await import('../../src/tools/WebSearchTool/searchOutput.js')
const { searchTokenEstimate, SEARCH_PAYLOAD_TOKEN_CEILING } = await import('../../src/services/search/searchPayload.js')
let now = 1_000_000
const clock = { now: () => now, random: () => 0.5, sleep: async (ms: number) => { now += ms } }
const page = (title: string, snippet: string) => ({ ns: 0, title, pageid: 1, snippet })
const phraseHits = [page('Reciprocal rank fusion', 'a <span class="searchmatch">rank aggregation</span> method')]
const wordHits = [page('Rank', 'noise'), page('Fusion', 'more noise'), page('Reciprocal', 'word matches')]
let phraseAnswer: unknown[] = phraseHits, wordAnswer: unknown[] = wordHits, status = 200
const seen: Array<{ srsearch: string | null; at: number }> = []
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1')
  seen.push({ srsearch: url.searchParams.get('srsearch'), at: now })
  assert.equal(url.pathname, '/w/api.php'); assert.equal(url.searchParams.get('list'), 'search'); assert.equal(url.searchParams.get('maxlag'), '5')
  const quoted = (url.searchParams.get('srsearch') ?? '').startsWith('"')
  res.writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '120' } : {}) })
  res.end(JSON.stringify({ batchcomplete: '', query: { searchinfo: { totalhits: quoted ? phraseAnswer.length : wordAnswer.length }, search: quoted ? phraseAnswer : wordAnswer } }))
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const fetchImpl = (async (url: string | URL, init: RequestInit) => {
  const u = new URL(String(url))
  assert.equal(u.host, 'en.wikipedia.org')
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init)
}) as typeof fetch
const io = { clock, fetchImpl }
const words = 'reciprocal rank fusion'
try {
  assert.equal(wikipediaPhrase('say "hi"  there'), '"say hi there"')
  assert.equal(officialSearchUrl('wikipedia', words).searchParams.get('srsearch'), '"reciprocal rank fusion"')
  assert.equal(officialSearchUrl('wikipedia', words, 10, 'words').searchParams.get('srsearch'), words)
  assert.equal(officialSearchIntent('what is reciprocal rank fusion?')?.words, words)
  pacing.resetSearchPacing()
  const exact = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(exact.ok, true)
  if (exact.ok) {
    assert.deepEqual(exact.hits.map(h => h.title), ['Reciprocal rank fusion'])
    assert.ok(exact.notes?.includes(wikipediaLegNote('phrase', words)))
    assert.ok(exact.notes?.some(n => n.includes('exact phrase "reciprocal rank fusion"')))
  }
  assert.deepEqual(seen.map(s => s.srsearch), ['"reciprocal rank fusion"'])
  const again = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(again.ok, true); assert.equal(seen.length, 1)
  if (again.ok) assert.ok(again.notes?.some(n => n.includes('search cache')))
  pacing.resetSearchPacing(); seen.length = 0; phraseAnswer = []
  const fell = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(fell.ok, true)
  if (fell.ok) {
    assert.deepEqual(fell.hits.map(h => h.title), ['Rank', 'Fusion', 'Reciprocal'])
    assert.ok(fell.notes?.includes(wikipediaLegNote('words', words)))
    assert.ok(fell.notes?.some(n => n.includes('no page carries the exact phrase "reciprocal rank fusion"')))
    assert.ok(!fell.notes?.includes(wikipediaLegNote('phrase', words)))
  }
  assert.deepEqual(seen.map(s => s.srsearch), ['"reciprocal rank fusion"', words])
  assert.ok(seen[1]!.at - seen[0]!.at >= 1000)
  const cachedFall = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(cachedFall.ok, true); assert.equal(seen.length, 2)
  if (cachedFall.ok) assert.deepEqual(cachedFall.hits.map(h => h.title), ['Rank', 'Fusion', 'Reciprocal'])
  pacing.resetSearchPacing(); seen.length = 0; wordAnswer = []
  const nothing = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(nothing.ok, true)
  if (nothing.ok) { assert.equal(nothing.hits.length, 0); assert.ok(nothing.notes?.includes(wikipediaLegNote('words', words))) }
  assert.deepEqual(seen.map(s => s.srsearch), ['"reciprocal rank fusion"', words])
  const nothingAgain = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(nothingAgain.ok, true); assert.equal(seen.length, 2)
  pacing.resetSearchPacing(); seen.length = 0; phraseAnswer = []; wordAnswer = wordHits; status = 429
  const refused = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.kind, 'rate-limited')
  assert.deepEqual(seen.map(s => s.srsearch), ['"reciprocal rank fusion"'])
  status = 200
  pacing.resetSearchPacing(); seen.length = 0; phraseAnswer = []
  const context = { options: { engineModel: 'glm-5.2' }, abortController: new AbortController() } as any
  const run = await performWebSearch({ query: 'what is reciprocal rank fusion?' }, { context, reads: { keylessAllowed: false }, clock, backends: { official: (s: any, w: string, request: any) => officialSearch(s, w, request, io) } })
  assert.equal(run.via, 'wikipedia')
  assert.ok(run.notes.includes(wikipediaLegNote('words', words)))
  assert.deepEqual(seen.map(s => s.srsearch), ['"reciprocal rank fusion"', words])
  const payload = mapSearchResult({ query: 'what is reciprocal rank fusion?', results: [{ tool_use_id: 'g', content: run.hits }], notes: run.notes, via: run.via, tier: run.tier, durationSeconds: 0 }, 't').content
  assert.ok(payload.includes('no page carries the exact phrase')); assert.ok(searchTokenEstimate(payload) < SEARCH_PAYLOAD_TOKEN_CEILING)
  pacing.resetSearchPacing(); seen.length = 0; phraseAnswer = phraseHits
  const exactRun = await performWebSearch({ query: 'what is reciprocal rank fusion?' }, { context, reads: { keylessAllowed: false }, clock, backends: { official: (s: any, w: string, request: any) => officialSearch(s, w, request, io) } })
  assert.ok(exactRun.notes.includes(wikipediaLegNote('phrase', words)))
  assert.equal(seen.length, 1)
  console.log('PASS wikipedia: the exact phrase is asked first (quoted srsearch), the word query only when the phrase finds nothing, each answer says which leg, both legs paced one second apart, the final answer alone is cached, a refusal stops the walk')
} finally { await new Promise<void>(r => server.close(() => r())) }
