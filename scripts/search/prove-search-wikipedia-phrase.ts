import assert from 'node:assert/strict'
import { createServer } from 'node:http'
;(globalThis as any).MACRO = { VERSION: 'proof', PACKAGE_URL: 'https://example.invalid' }
const { officialSearch, officialSearchUrl, wikipediaPhrase, wikipediaLegNote, wikipediaNothingNote, wikipediaTitleCarries } = await import('../../src/services/search/officialSearch.js')
const { performWebSearch } = await import('../../src/services/search/searchDoor.js')
const { officialSearchIntent } = await import('../../src/services/search/searchSources.js')
const pacing = await import('../../src/services/search/searchPacing.js')
const { mapSearchResult } = await import('../../src/tools/WebSearchTool/searchOutput.js')
const { searchTokenEstimate, SEARCH_PAYLOAD_TOKEN_CEILING } = await import('../../src/services/search/searchPayload.js')
let now = 1_000_000
const clock = { now: () => now, random: () => 0.5, sleep: async (ms: number) => { now += ms } }
const page = (title: string, snippet: string) => ({ ns: 0, title, pageid: 1, snippet })
const phraseHits = [page('Reciprocal rank fusion', 'a <span class="searchmatch">rank aggregation</span> method')]
const wordHits = [page('Identity fusion', 'a form of alignment'), page('Greek letters used in mathematics, science, and engineering', 'rank of a matrix'), page('Dry as a Bone', 'a 1990 EP')]
const titledHits = [page('Identity fusion', 'a form of alignment'), page('Fusions of reciprocal ranks', 'carries every word of the query, inflected'), page('Dry as a Bone', 'a 1990 EP')]
const duck = { title: 'Reciprocal Rank Fusion explained', url: 'https://docs.example.org/rrf', snippet: 'RRF combines ranked lists', source_type: 'duckduckgo' as const }
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
  assert.equal(wikipediaTitleCarries(words, 'Fusions of reciprocal ranks'), true)
  assert.equal(wikipediaTitleCarries(words, 'Identity fusion'), false)
  assert.equal(wikipediaTitleCarries(words, 'Dry as a Bone'), false)
  assert.equal(wikipediaTitleCarries('the rank', 'Rank'), true)
  assert.equal(wikipediaTitleCarries('what is it', 'It'), false)
  pacing.resetSearchPacing(); seen.length = 0; phraseAnswer = []
  const fell = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(fell.ok, true)
  if (fell.ok) {
    assert.deepEqual(fell.hits, [])
    assert.ok(fell.notes?.includes(wikipediaNothingNote(words)))
    assert.ok(fell.notes?.some(n => n.includes('no page carries the phrase "reciprocal rank fusion"')))
    assert.ok(!fell.notes?.includes(wikipediaLegNote('phrase', words)) && !fell.notes?.includes(wikipediaLegNote('words', words)))
  }
  assert.deepEqual(seen.map(s => s.srsearch), ['"reciprocal rank fusion"', words])
  assert.ok(seen[1]!.at - seen[0]!.at >= 1000)
  const cachedFall = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(cachedFall.ok, true); assert.equal(seen.length, 2)
  if (cachedFall.ok) assert.deepEqual(cachedFall.hits, [])
  pacing.resetSearchPacing(); seen.length = 0; wordAnswer = titledHits
  const titled = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(titled.ok, true)
  if (titled.ok) {
    assert.deepEqual(titled.hits.map(h => h.title), ['Fusions of reciprocal ranks'])
    assert.ok(titled.notes?.includes(wikipediaLegNote('words', words)))
    assert.ok(titled.notes?.some(n => n.includes('no page carries the exact phrase "reciprocal rank fusion"') && n.includes('titles')))
  }
  assert.deepEqual(seen.map(s => s.srsearch), ['"reciprocal rank fusion"', words])
  pacing.resetSearchPacing(); seen.length = 0; wordAnswer = []
  const nothing = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(nothing.ok, true)
  if (nothing.ok) { assert.equal(nothing.hits.length, 0); assert.ok(nothing.notes?.includes(wikipediaNothingNote(words))) }
  assert.deepEqual(seen.map(s => s.srsearch), ['"reciprocal rank fusion"', words])
  const nothingAgain = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(nothingAgain.ok, true); assert.equal(seen.length, 2)
  wordAnswer = wordHits
  pacing.resetSearchPacing(); seen.length = 0; phraseAnswer = []; wordAnswer = wordHits; status = 429
  const refused = await officialSearch('wikipedia', words, { query: words }, io)
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.kind, 'rate-limited')
  assert.deepEqual(seen.map(s => s.srsearch), ['"reciprocal rank fusion"'])
  status = 200
  pacing.resetSearchPacing(); seen.length = 0; phraseAnswer = []
  const context = { options: { engineModel: 'glm-5.2' }, abortController: new AbortController() } as any
  const official = (s: any, w: string, request: any) => officialSearch(s, w, request, io)
  const run = await performWebSearch({ query: 'what is reciprocal rank fusion?' }, { context, reads: { keylessAllowed: true }, clock, backends: { official, keyless: async () => ({ ok: true as const, via: 'duckduckgo' as const, tier: 'keyless' as const, hits: [duck] }) } })
  assert.equal(run.via, 'duckduckgo')
  assert.deepEqual(run.hits.map(h => h.title), [duck.title])
  assert.ok(run.notes.includes(`${wikipediaNothingNote(words)}; the next source answered`), JSON.stringify(run.notes))
  assert.ok(!run.notes.some(n => n.includes('Identity fusion') || n.includes('found no matching links') || n.includes('no open door')), JSON.stringify(run.notes))
  assert.deepEqual(seen.map(s => s.srsearch), ['"reciprocal rank fusion"', words])
  const payload = mapSearchResult({ query: 'what is reciprocal rank fusion?', results: [{ tool_use_id: 'g', content: run.hits }], notes: run.notes, via: run.via, tier: run.tier, durationSeconds: 0 }, 't').content
  assert.ok((JSON.parse(payload) as { notes: string[] }).notes.includes(`${wikipediaNothingNote(words)}; the next source answered`)); assert.ok(searchTokenEstimate(payload) < SEARCH_PAYLOAD_TOKEN_CEILING)
  pacing.resetSearchPacing(); seen.length = 0
  await assert.rejects(performWebSearch({ query: 'what is reciprocal rank fusion?' }, { context, reads: { keylessAllowed: false }, clock, backends: { official } }), (error: unknown) => error instanceof Error && error.message.includes(`${wikipediaNothingNote(words)}; no later source answered`))
  assert.deepEqual(seen.map(s => s.srsearch), ['"reciprocal rank fusion"', words])
  pacing.resetSearchPacing(); seen.length = 0; phraseAnswer = phraseHits
  const exactRun = await performWebSearch({ query: 'what is reciprocal rank fusion?' }, { context, reads: { keylessAllowed: false }, clock, backends: { official: (s: any, w: string, request: any) => officialSearch(s, w, request, io) } })
  assert.ok(exactRun.notes.includes(wikipediaLegNote('phrase', words)))
  assert.equal(seen.length, 1)
  console.log('PASS wikipedia: the exact phrase is asked first (quoted srsearch), the word query only when the phrase finds nothing and answers only titles carrying every content word, otherwise Wikipedia answers nothing and the next door answers with the via note, each answer says which leg, both legs paced one second apart, the final answer alone is cached, a refusal stops the walk')
} finally { await new Promise<void>(r => server.close(() => r())) }
