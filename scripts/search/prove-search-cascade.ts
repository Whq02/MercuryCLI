import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
;(globalThis as any).MACRO = { VERSION: 'proof', PACKAGE_URL: 'https://example.invalid' }
const door = process.argv[2] ? await import(pathToFileURL(process.argv[2]).href) : await import('../../src/services/search/searchDoor.js')
assert.deepEqual(door.resolveSearchDoorPlan({ keylessAllowed: false, mainModel: 'gpt-6-astra', braveKey: 'env', tavilyKey: 'stored', metasearchInstances: 1 }, 'npm typescript').doors.map((d: any) => d.kind), ['native', 'keyed', 'keyed', 'official', 'metasearch'])
assert.deepEqual(door.resolveSearchDoorPlan({ keylessAllowed: false, mainModel: 'gpt-6-astra', braveKey: 'env', tavilyKey: 'stored' }, 'npm typescript').doors.map((d: any) => d.kind), ['native', 'keyed', 'keyed', 'official'])
const { officialSearch, officialSearchUrl, decodeOfficialSearch } = await import('../../src/services/search/officialSearch.js')
const { OFFICIAL_SEARCH_SOURCES, officialSearchIntent } = await import('../../src/services/search/searchSources.js')
const pacing = await import('../../src/services/search/searchPacing.js')
const { searchFailure } = await import('../../src/services/search/searchContract.js')
const { mapSearchResult } = await import('../../src/tools/WebSearchTool/searchOutput.js')
let now = 1_000_000
const clock = { now: () => now, random: () => 0.5, sleep: async (ms: number) => { now += ms } }
const bodies = {
  stackexchange: { items: [{ title: 'TypeError &amp; fix', link: 'https://stackoverflow.com/questions/42', tags: ['typescript'] }], quota_remaining: 200 },
  npm: { objects: [{ package: { name: 'typescript', links: { npm: 'https://www.npmjs.com/package/typescript' }, description: 'Typed JS' } }] },
  pypi: { info: { name: 'requests', package_url: 'https://pypi.org/project/requests/', summary: 'HTTP client' } },
  crates: { crates: [{ id: 'serde', description: 'Serialization' }] },
  github: { items: [{ repository: { private: false }, name: 'read.ts', path: 'src/read.ts', html_url: 'https://github.com/example/repo/blob/main/src/read.ts' }] },
  hackernews: { hits: [{ title: 'New compiler', objectID: '42', url: 'https://example.com/compiler' }] },
  wikipedia: { query: { search: [{ title: 'Compiler', snippet: 'A <span>compiler</span> translates code' }] } },
}
const queries = { stackexchange: 'TypeError: not callable', npm: 'npm install typescript', pypi: 'pip install requests', crates: 'cargo add serde', github: 'github repo:example/repo read', hackernews: 'compiler news', wikipedia: 'what is a compiler' }
const servers: ReturnType<typeof createServer>[] = []
const contexts = (engineModel = 'glm-5.2') => ({ options: { engineModel }, abortController: new AbortController() }) as any
try {
  for (const source of OFFICIAL_SEARCH_SOURCES) {
    pacing.resetSearchPacing()
    const seen: { url: string; ua: string; at: number; auth?: string }[] = []
    let status = 200, body: unknown = bodies[source], extraHeaders: Record<string, string> = {}
    const server = createServer((req, res) => {
      seen.push({ url: req.url!, ua: String(req.headers['user-agent']), at: now, auth: req.headers.authorization })
      res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const address = server.address() as { port: number }
    const host = officialSearchUrl(source, 'proof').host
    const fetchImpl = (async (url: string | URL, init: RequestInit) => {
      const u = new URL(String(url))
      assert.equal(u.host, host)
      return fetch(`http://127.0.0.1:${address.port}${u.pathname}${u.search}`, init)
    }) as typeof fetch
    const env = source === 'github' ? { GH_TOKEN: 'fixture-only-token' } : {}
    const intent = officialSearchIntent(queries[source])!
    assert.equal(intent.source, source)
    const io = { clock, fetchImpl, env }
    const run = await door.performWebSearch({ query: queries[source] }, { context: contexts(), reads: { keylessAllowed: false }, clock, backends: { official: (s: any, words: string, request: any) => officialSearch(s, words, request, io) } })
    assert.equal(run.via, source)
    assert.equal(run.tier, source === 'github' ? 'keyed' : 'keyless')
    const perSearch = source === 'stackexchange' || source === 'hackernews' ? 2 : 1
    assert.equal(seen.length, perSearch)
    if (perSearch === 2) {
      assert.match(seen[1]!.url, source === 'stackexchange' ? /^\/2\.3\/questions\/42\?.*filter=withbody/ : /^\/api\/v1\/search\?tags=comment%2C%28story_42%29/)
      assert.ok(seen[1]!.at - seen[0]!.at >= 1000)
      assert.ok(run.notes.includes('excerpts fetched for 0 hits'), JSON.stringify(run.notes))
    }
    assert.match(seen[0]!.ua, /^Mercury\/proof \(\+https:\/\/mercury-cli.ai;/)
    assert.equal(seen[0]!.auth, source === 'github' ? 'Bearer fixture-only-token' : undefined)
    assert.deepEqual(Object.keys(run.hits[0]).sort(), ['snippet', 'source_type', 'title', 'url'])
    assert.equal(run.hits[0].source_type, source)
    const mapped = mapSearchResult({ query: queries[source], durationSeconds: 0, via: run.via, tier: run.tier, results: [{ tool_use_id: 'g', content: run.hits }], notes: run.notes }, 't')
    assert.ok(Buffer.byteLength(mapped.content) < 2000)
    assert.ok(!mapped.content.includes('fixture-only-token'))
    assert.equal(decodeOfficialSearch(source, { wrong: [] }), undefined)
    if (source !== 'github') {
      const again = await officialSearch(source, intent.words, { query: queries[source] }, io)
      assert.equal(again.ok, true); assert.equal(seen.length, perSearch)
    }
    const second = await officialSearch(source, `${intent.words}-other`, { query: `${queries[source]}-other` }, io)
    assert.equal(second.ok, true)
    assert.equal(seen.length, perSearch * 2)
    assert.ok(seen[perSearch]!.at - seen[perSearch - 1]!.at >= (source === 'github' ? 6000 : 1000))
    pacing.resetSearchPacing(); body = { unexpected: true }
    const malformed = await officialSearch(source, intent.words, { query: queries[source] }, io)
    assert.equal(malformed.ok, false)
    if (!malformed.ok) assert.equal(malformed.kind, 'parse-failed')
    pacing.resetSearchPacing(); body = bodies[source]
    const filtered = await officialSearch(source, intent.words, { query: queries[source], allowedDomains: ['not-the-source.invalid'] }, io)
    assert.equal(filtered.ok, true)
    if (filtered.ok) assert.equal(filtered.hits.length, 0)
    if (source === 'github') {
      assert.deepEqual(decodeOfficialSearch('github', { items: [{ ...bodies.github.items[0], repository: { private: true } }] }), [])
      assert.deepEqual(decodeOfficialSearch('github', { items: [{ ...bodies.github.items[0], repository: {} }] }), [])
      pacing.resetSearchPacing(); status = 403; extraHeaders = { 'retry-after': '90' }
      const before = seen.length
      const refusal = await officialSearch(source, intent.words, { query: queries[source] }, io)
      assert.equal(refusal.ok, false)
      assert.ok(pacing.coolDownRemainingMs(source, now) >= 90_000)
      await officialSearch(source, intent.words, { query: queries[source] }, io)
      assert.equal(seen.length, before + 1)
      const missing = await officialSearch(source, intent.words, { query: queries[source] }, { ...io, env: {} })
      assert.equal(missing.ok, false)
      if (!missing.ok) assert.match(missing.message, /requires a token/)
      assert.equal(seen.length, before + 1)
      now += 90_000; status = 200; extraHeaders = {}; body = bodies.github
      assert.equal((await officialSearch(source, intent.words, { query: queries[source] }, io)).ok, true)
    }
    if (source === 'stackexchange') {
      pacing.resetSearchPacing(); body = { ...bodies.stackexchange, backoff: 75 }
      assert.equal((await officialSearch(source, 'backoff', { query: 'backoff' }, io)).ok, true)
      assert.ok(pacing.coolDownRemainingMs(source, now) >= 75_000)
    }
    console.log(`PASS ${source}: fixture API, route, exact fields, UA, pacing, domains and malformed response`)
  }
  pacing.resetSearchPacing()
  const order: string[] = []
  const answer = { ok: true as const, via: 'npm' as const, tier: 'keyless' as const, hits: [{ title: 'typescript', url: 'https://www.npmjs.com/package/typescript', snippet: '', source_type: 'npm' as const }] }
  const backends = {
    native: async (family: string) => { order.push(family); return searchFailure('provider-refused', 'openai-native', 'fixture refusal') },
    brave: async () => { order.push('brave'); return searchFailure('key-refused', 'brave', 'fixture refusal') },
    tavily: async () => { order.push('tavily'); return { ok: true as const, via: 'tavily' as const, tier: 'keyed' as const, hits: [] } },
    official: async () => { order.push('npm'); return answer },
    keyless: async () => { throw new Error('DuckDuckGo must not be called') },
  }
  await door.performWebSearch({ query: 'npm typescript' }, { context: contexts('gpt-6-astra'), reads: { braveKey: 'env', tavilyKey: 'env', keylessAllowed: false }, backends, clock })
  assert.deepEqual(order, ['openai', 'brave', 'tavily', 'npm'])
  pacing.resetSearchPacing(); order.length = 0
  await door.performWebSearch({ query: 'npm typescript' }, { context: contexts('glm-5.2'), reads: { mainModel: 'gpt-6-astra', keylessAllowed: false }, backends, clock })
  assert.deepEqual(order, ['npm'])
  const cancelled = contexts(); cancelled.abortController.abort()
  await assert.rejects(door.performWebSearch({ query: 'npm typescript' }, { context: cancelled, reads: { keylessAllowed: false }, backends, clock }), /abort|cancel/i)
  assert.equal(pacing.serverSearchWaitMs(new Headers({ 'retry-after': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 240_000) / 1000) }), now), 240_000)
  assert.equal(pacing.serverSearchWaitMs(new Headers({ 'retry-after': new Date(now + 90_000).toUTCString() }), now), 90_000)
  assert.equal(officialSearchIntent('mercury'), undefined)
  console.log('PASS cascade: native → keys → official; same account only, empty falls through, cancellation, server waits')
} finally {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
}
