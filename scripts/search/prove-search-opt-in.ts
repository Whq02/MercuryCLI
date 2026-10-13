import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
;(globalThis as any).MACRO = { VERSION: 'proof' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const setting = await import('../../src/services/search/searchSetting.js')
const { keylessSearch } = process.argv[2] ? await import(process.argv[2]) : await import('../../src/services/search/duckduckgo.js')
const { performWebSearch, liveSearchDoorReads } = await import('../../src/services/search/searchDoor.js')
const { resetSearchPacing } = await import('../../src/services/search/searchPacing.js')
const { mapSearchResult } = await import('../../src/tools/WebSearchTool/searchOutput.js')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')
delete process.env.MERCURY_SEARCH_KEYLESS
assert.equal(setting.duckduckgoScrapingEnabled(), false)
assert.equal(liveSearchDoorReads({}).keylessAllowed, false)
assert.equal(getFlagSpec('MERCURY_SEARCH_KEYLESS').kind, 'opt-in')
let requests = 0, status = 200, paths: string[] = []
const html = readFileSync(join(import.meta.dir, 'fixtures/ddg-html-results.html'), 'utf8')
const server = createServer((req, res) => { requests++; paths.push(req.url!); res.writeHead(status, { 'content-type': 'text/html', ...(status === 429 ? { 'retry-after': '90' } : {}) }); res.end(html) })
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
let now = 1_000_000
const clock = { now: () => now, random: () => 0.5, sleep: async (ms: number) => { now += ms } }
const fetchImpl = (async (url: string | URL, init: RequestInit) => fetch(`http://127.0.0.1:${(server.address() as any).port}${new URL(String(url)).pathname}`, init)) as typeof fetch
try {
  resetSearchPacing()
  assert.equal((await keylessSearch({ query: 'test' }, { fetchImpl, clock })).ok, false)
  assert.equal(requests, 0)
  setting.setDuckduckgoScraping(true)
  assert.equal(setting.duckduckgoScrapingEnabled(), true)
  process.env.MERCURY_SEARCH_KEYLESS = '0'; assert.equal(setting.duckduckgoScrapingEnabled(), false)
  delete process.env.MERCURY_SEARCH_KEYLESS
  const io = { context: { options: { engineModel: 'glm-5.2' }, abortController: new AbortController() } as any, clock, reads: { keylessAllowed: true, backendOverride: 'duckduckgo' }, backends: { keyless: (req: any) => keylessSearch(req, { fetchImpl, clock }) } }
  const first = await performWebSearch({ query: 'test' }, io)
  assert.equal(first.notes.filter(n => n === setting.DUCKDUCKGO_TERMS).length, 1)
  const payload = mapSearchResult({ query: 'test', results: [{ tool_use_id: 'g', content: first.hits }], notes: first.notes, via: first.via, tier: first.tier, durationSeconds: 0 }, 't').content
  assert.ok(payload.includes(setting.DUCKDUCKGO_TERMS)); assert.ok(Buffer.byteLength(payload) < 2000)
  const cached = await performWebSearch({ query: 'test' }, io)
  assert.equal(cached.cached, true); assert.ok(!cached.notes.includes(setting.DUCKDUCKGO_TERMS)); assert.equal(requests, 1)
  const second = await performWebSearch({ query: 'other' }, io)
  assert.ok(!second.notes.includes(setting.DUCKDUCKGO_TERMS)); assert.equal(requests, 2)
  resetSearchPacing(); status = 429; paths = []
  const before = requests
  const refusal = await keylessSearch({ query: 'refused' }, { fetchImpl, clock })
  assert.equal(refusal.ok, false)
  if (!refusal.ok) { assert.match(refusal.message, /no retry or host swap/); assert.ok(refusal.message.includes(setting.DUCKDUCKGO_TERMS)) }
  await keylessSearch({ query: 'different query' }, { fetchImpl, clock })
  assert.equal(requests, before + 1); assert.deepEqual(paths, ['/html/'])
  now += 90_000; status = 200
  assert.equal((await keylessSearch({ query: 'after wait' }, { fetchImpl, clock })).ok, true)
  setting.setDuckduckgoScraping(false)
  assert.equal(setting.duckduckgoScrapingEnabled(), false)
  const finalCount = requests
  assert.equal((await keylessSearch({ query: 'off' }, { fetchImpl, clock })).ok, false)
  assert.equal(requests, finalCount)
  console.log('PASS scraping opt-in: default off, saved choice, env precedence, terms once including failure, no host evasion')
} finally { setting.setDuckduckgoScraping(false); await new Promise<void>(r => server.close(() => r())) }
