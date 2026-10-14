import assert from 'node:assert/strict'
import { createServer } from 'node:http'
;(globalThis as any).MACRO = { VERSION: 'proof', PACKAGE_URL: 'https://example.invalid' }
const { officialSearch, excerptUrl, excerptIdOf, excerptOf, decodeExcerpts, EXCERPT_HITS, HN_COMMENT_LABEL } = await import('../../src/services/search/officialSearch.js')
const { performWebSearch } = await import('../../src/services/search/searchDoor.js')
const { MAX_SNIPPET_CHARS } = await import('../../src/services/search/searchContract.js')
const pacing = await import('../../src/services/search/searchPacing.js')
const { mapSearchResult } = await import('../../src/tools/WebSearchTool/searchOutput.js')
const { searchTokenEstimate, SEARCH_PAYLOAD_TOKEN_CEILING } = await import('../../src/services/search/searchPayload.js')
let now = 1_000_000
const clock = { now: () => now, random: () => 0.5, sleep: async (ms: number) => { now += ms } }
const long = `<p>${'The body of the accepted question goes on and on. '.repeat(20)}</p>`
const seBodies: Record<string, unknown> = {
  '/2.3/search/advanced': { items: [42, 43, 44, 45].map(id => ({ question_id: id, title: `Question ${id} &amp; its TypeError`, link: `https://stackoverflow.com/questions/${id}/slug-${id}` })), quota_remaining: 200 },
  '/2.3/questions/42;43;44': { items: [
    { question_id: 42, body: '<p>Call <code>fn()</code> after it is defined &mdash; the hoisting rule.</p>' },
    { question_id: 43, body: long },
    { question_id: 44, body: '   <p></p>  ' },
  ], quota_remaining: 199 },
}
const hnBodies: Record<string, unknown> = {
  '/api/v1/search?query': { hits: [
    { title: 'Ask HN: compilers?', objectID: '1', story_text: 'I am writing a <b>compiler</b> &amp; need advice.' },
    { title: 'A new compiler', objectID: '2', url: 'https://example.com/compiler' },
    { title: 'Another compiler', objectID: '3', url: 'https://example.com/another' },
    { title: 'Fourth story', objectID: '4', url: 'https://example.com/fourth' },
  ] },
  '/api/v1/search?tags': { hits: [
    { objectID: '20', story_id: 2, comment_text: '<p>The <i>first</i> comment on story two &mdash; best one.</p>' },
    { objectID: '21', story_id: 2, comment_text: 'A later comment on story two.' },
    { objectID: '30', story_id: 3, comment_text: 'The only comment on story three.' },
    { objectID: '99', story_id: 9, comment_text: 'A comment on a story nobody asked about.' },
  ] },
}
const seen: Array<{ path: string; search: string; at: number }> = []
let status = 200, extra: Record<string, string> = {}, override: unknown
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1')
  seen.push({ path: url.pathname, search: url.search, at: now })
  const key = url.pathname.startsWith('/api/v1/search') ? `/api/v1/search?${url.searchParams.has('query') ? 'query' : 'tags'}` : url.pathname
  const body = override ?? seBodies[key] ?? hnBodies[key] ?? { items: [] }
  res.writeHead(status, { 'content-type': 'application/json', ...extra })
  res.end(JSON.stringify(body))
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const fetchImpl = (async (url: string | URL, init: RequestInit) => {
  const u = new URL(String(url))
  assert.ok(['api.stackexchange.com', 'hn.algolia.com'].includes(u.host), u.host)
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init)
}) as typeof fetch
const io = { clock, fetchImpl }
const reset = (): void => { pacing.resetSearchPacing(); seen.length = 0; status = 200; extra = {}; override = undefined }
try {
  assert.equal(EXCERPT_HITS, 3)
  assert.equal(excerptIdOf('stackexchange', 'https://stackoverflow.com/questions/42/slug'), '42')
  assert.equal(excerptIdOf('hackernews', 'https://news.ycombinator.com/item?id=7'), '7')
  assert.equal(excerptIdOf('stackexchange', 'https://stackoverflow.com/tags'), undefined)
  const se = excerptUrl('stackexchange', ['42', '43', '44'])
  assert.equal(se.origin + se.pathname, 'https://api.stackexchange.com/2.3/questions/42;43;44')
  assert.equal(se.searchParams.get('site'), 'stackoverflow'); assert.equal(se.searchParams.get('filter'), 'withbody')
  const hn = excerptUrl('hackernews', ['2', '3'])
  assert.equal(hn.origin + hn.pathname, 'https://hn.algolia.com/api/v1/search'); assert.equal(hn.searchParams.get('tags'), 'comment,(story_2,story_3)')
  assert.ok(excerptOf(long).endsWith('…')); assert.ok(excerptOf(long).length <= MAX_SNIPPET_CHARS); assert.ok(!excerptOf(long).includes('<'))
  assert.equal(decodeExcerpts('stackexchange', { wrong: [] }), undefined)
  assert.equal(decodeExcerpts('hackernews', { items: [] }), undefined)
  reset()
  const first = await officialSearch('stackexchange', 'TypeError: fn is not a function', { query: 'TypeError: fn is not a function' }, io)
  assert.equal(first.ok, true)
  if (first.ok) {
    assert.equal(first.hits.length, 4)
    assert.equal(first.hits[0]!.snippet, 'Call fn() after it is defined — the hoisting rule.')
    assert.ok(first.hits[1]!.snippet.endsWith('…') && first.hits[1]!.snippet.length <= MAX_SNIPPET_CHARS && !first.hits[1]!.snippet.includes('<p>'))
    assert.equal(first.hits[2]!.snippet, '')
    assert.equal(first.hits[3]!.snippet, '')
    assert.equal(first.hits[0]!.title, 'Question 42 & its TypeError')
    assert.ok(first.notes?.includes('excerpts fetched for 2 hits'), JSON.stringify(first.notes))
  }
  assert.deepEqual(seen.map(s => s.path), ['/2.3/search/advanced', '/2.3/questions/42;43;44'])
  assert.ok(seen[1]!.search.includes('filter=withbody') && seen[1]!.search.includes('site=stackoverflow'))
  assert.ok(seen[1]!.at - seen[0]!.at >= 1000)
  const cached = await officialSearch('stackexchange', 'TypeError: fn is not a function', { query: 'TypeError: fn is not a function' }, io)
  assert.equal(cached.ok, true); assert.equal(seen.length, 2)
  if (cached.ok) { assert.equal(cached.hits[0]!.snippet, 'Call fn() after it is defined — the hoisting rule.'); assert.ok(cached.notes?.some(n => n.includes('search cache'))) }
  const payload = mapSearchResult({ query: 'TypeError', results: [{ tool_use_id: 'g', content: cached.ok ? cached.hits : [] }], notes: first.ok ? first.notes : [], via: 'stackexchange', tier: 'keyless', durationSeconds: 0 }, 't').content
  assert.ok(payload.includes('excerpts fetched for 2 hits')); assert.ok(searchTokenEstimate(payload) < SEARCH_PAYLOAD_TOKEN_CEILING)
  reset()
  let calls = 0
  const refusingFetch = (async (url: string | URL, init: RequestInit) => {
    calls++
    const u = new URL(String(url))
    if (u.pathname.startsWith('/2.3/questions/')) return new Response(JSON.stringify({ error_id: 502, error_message: 'throttle' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '90' } })
    return fetchImpl(url, init)
  }) as typeof fetch
  const refused = await officialSearch('stackexchange', 'TypeError: other', { query: 'TypeError: other' }, { clock, fetchImpl: refusingFetch })
  assert.equal(refused.ok, true)
  if (refused.ok) {
    assert.equal(refused.hits.length, 4); assert.ok(refused.hits.every(h => h.snippet === ''))
    assert.ok(refused.notes?.some(n => n.startsWith('excerpts not fetched for 3 hits:') && /wait \d+/.test(n)), JSON.stringify(refused.notes))
  }
  assert.equal(calls, 2)
  assert.ok(pacing.coolDownRemainingMs('stackexchange', now) >= 90_000)
  reset()
  const hnRun = await officialSearch('hackernews', 'compiler', { query: 'compiler news' }, io)
  assert.equal(hnRun.ok, true)
  if (hnRun.ok) {
    assert.equal(hnRun.hits.length, 4)
    assert.equal(hnRun.hits[0]!.snippet, 'I am writing a compiler & need advice.')
    assert.equal(hnRun.hits[1]!.snippet, `${HN_COMMENT_LABEL}The first comment on story two — best one.`)
    assert.equal(hnRun.hits[2]!.snippet, `${HN_COMMENT_LABEL}The only comment on story three.`)
    assert.equal(hnRun.hits[3]!.snippet, '')
    assert.ok(hnRun.notes?.includes('excerpts fetched for 2 hits'), JSON.stringify(hnRun.notes))
  }
  assert.deepEqual(seen.map(s => s.path), ['/api/v1/search', '/api/v1/search'])
  assert.ok(seen[0]!.search.includes('tags=story') && seen[0]!.search.includes('query=compiler'))
  assert.equal(new URL(`http://x${seen[1]!.search}`).searchParams.get('tags'), 'comment,(story_2,story_3)')
  assert.ok(seen[1]!.at - seen[0]!.at >= 1000)
  reset()
  override = { hits: [{ title: 'Ask HN: one', objectID: '1', story_text: 'text one' }, { title: 'Ask HN: two', objectID: '2', story_text: 'text two' }, { title: 'Ask HN: three', objectID: '3', story_text: 'text three' }, { title: 'Link', objectID: '4', url: 'https://example.com/' }] }
  const allText = await officialSearch('hackernews', 'ask', { query: 'ask news' }, io)
  assert.equal(allText.ok, true)
  if (allText.ok) { assert.deepEqual(allText.hits.map(h => h.snippet), ['text one', 'text two', 'text three', '']); assert.ok(!allText.notes?.some(n => n.includes('excerpts'))) }
  assert.equal(seen.length, 1)
  reset()
  const context = { options: { engineModel: 'glm-5.2' }, abortController: new AbortController() } as any
  const run = await performWebSearch({ query: 'TypeError: fn is not a function' }, { context, reads: { keylessAllowed: false }, clock, backends: { official: (s: any, w: string, request: any) => officialSearch(s, w, request, io) } })
  assert.equal(run.via, 'stackexchange'); assert.equal(run.tier, 'keyless')
  assert.equal(run.hits[0]!.snippet, 'Call fn() after it is defined — the hoisting rule.')
  assert.ok(run.notes.includes('excerpts fetched for 2 hits'))
  const mapped = mapSearchResult({ query: run.queries[0]!, results: [{ tool_use_id: 'g', content: run.hits }], notes: run.notes, via: run.via, tier: run.tier, durationSeconds: 0 }, 't').content
  assert.ok(searchTokenEstimate(mapped) < SEARCH_PAYLOAD_TOKEN_CEILING)
  assert.ok(mapped.includes('via Stack Exchange (keyless)') && mapped.includes('excerpts fetched for 2 hits'))
  console.log('PASS excerpts: Stack Exchange bodies for the top three in one /questions/{ids} call with the body filter, Hacker News story_text kept and the top comment fetched in one search?tags=comment,(story_…) call, plain text cut with an ellipsis, the via note counts the fetched excerpts, a refusal keeps the hits and names the wait, the cache carries the excerpts, the payload stays under the ceiling')
} finally { await new Promise<void>(r => server.close(() => r())) }
