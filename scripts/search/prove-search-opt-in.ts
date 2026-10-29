import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as any).MACRO = { VERSION: 'proof' }
const home = mkdtempSync(join(tmpdir(), 'search-opt-in-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const setting = await import('../../src/services/search/searchSetting.js')
const { keylessSearch } = process.argv[2] ? await import(process.argv[2]) : await import('../../src/services/search/duckduckgo.js')
const { performWebSearch, liveSearchDoorReads, resolveSearchDoorPlan } = await import('../../src/services/search/searchDoor.js')
const { resetSearchPacing } = await import('../../src/services/search/searchPacing.js')
const { mapSearchResult } = await import('../../src/tools/WebSearchTool/searchOutput.js')
const { searchTokenEstimate, SEARCH_PAYLOAD_TOKEN_CEILING } = await import('../../src/services/search/searchPayload.js')
const { getFlagSpec, flagEnabled } = await import('../../src/substrate/flagRegistry.js')
const { getGlobalConfig } = await import('../../src/utils/config/globalConfig.js')
delete process.env.MERCURY_SEARCH_KEYLESS
assert.equal(getGlobalConfig()[setting.DUCKDUCKGO_SETTING_KEY], undefined)
assert.equal(setting.duckduckgoScrapingEnabled(), true)
assert.equal(liveSearchDoorReads({}).keylessAllowed, true)
assert.equal(getFlagSpec('MERCURY_SEARCH_KEYLESS').kind, 'default-on')
assert.equal(flagEnabled('MERCURY_SEARCH_KEYLESS'), true)
const freshPlan = resolveSearchDoorPlan(liveSearchDoorReads({}), 'what is a compiler')
assert.deepEqual(freshPlan.doors.map(d => d.kind), ['official', 'keyless'])
assert.ok(!freshPlan.closed.some(line => line.includes('DuckDuckGo')))
for (const spelling of ['0', 'false', 'off', 'no', '"0"', ' Off ']) { process.env.MERCURY_SEARCH_KEYLESS = spelling; assert.equal(setting.duckduckgoScrapingEnabled(), false, spelling) }
process.env.MERCURY_SEARCH_KEYLESS = '0'
assert.equal(liveSearchDoorReads({}).keylessAllowed, false)
assert.deepEqual(resolveSearchDoorPlan(liveSearchDoorReads({}), 'what is a compiler').doors.map(d => d.kind), ['official'])
assert.ok(resolveSearchDoorPlan(liveSearchDoorReads({}), 'what is a compiler').closed.some(line => line.includes('DuckDuckGo page scraping is off') && line.includes('MERCURY_SEARCH_KEYLESS=0')))
delete process.env.MERCURY_SEARCH_KEYLESS
let requests = 0, status = 200, paths: string[] = []
const html = readFileSync(join(import.meta.dir, 'fixtures/ddg-html-results.html'), 'utf8')
const server = createServer((req, res) => { requests++; paths.push(req.url!); res.writeHead(status, { 'content-type': 'text/html', ...(status === 429 ? { 'retry-after': '90' } : {}) }); res.end(html) })
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
let now = 1_000_000
const clock = { now: () => now, random: () => 0.5, sleep: async (ms: number) => { now += ms } }
const fetchImpl = (async (url: string | URL, init: RequestInit) => fetch(`http://127.0.0.1:${(server.address() as any).port}${new URL(String(url)).pathname}`, init)) as typeof fetch
const context = () => ({ options: { engineModel: 'glm-5.2' }, abortController: new AbortController() }) as any
const wikipedia = { title: 'Compiler', url: 'https://en.wikipedia.org/wiki/Compiler', snippet: 'translates code', source_type: 'wikipedia' as const }
const official = (hits: typeof wikipedia[]) => async (source: any) => ({ ok: true as const, via: source, tier: 'keyless' as const, hits })
try {
  resetSearchPacing()
  const freshHome = { context: context(), clock, reads: liveSearchDoorReads({}), backends: { official: official([wikipedia]), keyless: (req: any) => keylessSearch(req, { fetchImpl, clock }) } }
  const answered = await performWebSearch({ query: 'what is a compiler' }, freshHome)
  assert.equal(answered.via, 'wikipedia'); assert.equal(requests, 0)
  resetSearchPacing()
  const fell = await performWebSearch({ query: 'what is a compiler' }, { ...freshHome, backends: { ...freshHome.backends, official: official([]) } })
  assert.equal(fell.via, 'duckduckgo'); assert.equal(requests, 1)
  assert.equal(fell.notes.filter(n => n === setting.DUCKDUCKGO_TERMS).length, 1)
  assert.ok(fell.notes.some(n => n.includes('Wikipedia found no matching links')))
  resetSearchPacing()
  process.env.MERCURY_SEARCH_KEYLESS = '0'
  const pinnedOff = { ...freshHome, reads: liveSearchDoorReads({}), backends: { ...freshHome.backends, official: official([]) } }
  await assert.rejects(performWebSearch({ query: 'what is a compiler' }, pinnedOff), error => error instanceof Error && error.message.includes('MERCURY_SEARCH_KEYLESS=0') && !error.message.includes(setting.DUCKDUCKGO_TERMS))
  assert.equal((await keylessSearch({ query: 'pinned off' }, { fetchImpl, clock })).ok, false)
  assert.equal(requests, 1)
  delete process.env.MERCURY_SEARCH_KEYLESS
  setting.setDuckduckgoScraping(false)
  assert.equal(setting.duckduckgoScrapingEnabled(), false)
  assert.equal(liveSearchDoorReads({}).keylessAllowed, false)
  assert.equal((await keylessSearch({ query: 'saved off' }, { fetchImpl, clock })).ok, false)
  assert.equal(requests, 1)
  process.env.MERCURY_SEARCH_KEYLESS = '1'; assert.equal(setting.duckduckgoScrapingEnabled(), true)
  delete process.env.MERCURY_SEARCH_KEYLESS
  setting.setDuckduckgoScraping(true)
  assert.equal(setting.duckduckgoScrapingEnabled(), true)
  resetSearchPacing()
  const io = { context: context(), clock, reads: { keylessAllowed: true, backendOverride: 'duckduckgo' }, backends: { keyless: (req: any) => keylessSearch(req, { fetchImpl, clock }) } }
  const first = await performWebSearch({ query: 'test' }, io)
  assert.equal(first.notes.filter(n => n === setting.DUCKDUCKGO_TERMS).length, 1)
  const payload = mapSearchResult({ query: 'test', results: [{ tool_use_id: 'g', content: first.hits }], notes: first.notes, via: first.via, tier: first.tier, durationSeconds: 0 }, 't').content
  assert.ok(payload.includes(setting.DUCKDUCKGO_TERMS)); assert.ok(searchTokenEstimate(payload) < SEARCH_PAYLOAD_TOKEN_CEILING)
  const cached = await performWebSearch({ query: 'test' }, io)
  assert.equal(cached.cached, true); assert.ok(!cached.notes.includes(setting.DUCKDUCKGO_TERMS)); assert.equal(requests, 2)
  const second = await performWebSearch({ query: 'other' }, io)
  assert.ok(!second.notes.includes(setting.DUCKDUCKGO_TERMS)); assert.equal(requests, 3)
  resetSearchPacing(); status = 429; paths = []
  const before = requests
  const refusal = await keylessSearch({ query: 'refused' }, { fetchImpl, clock })
  assert.equal(refusal.ok, false)
  if (!refusal.ok) { assert.match(refusal.message, /no retry or host swap/); assert.ok(refusal.message.includes(setting.DUCKDUCKGO_TERMS)) }
  await keylessSearch({ query: 'different query' }, { fetchImpl, clock })
  assert.equal(requests, before + 1); assert.deepEqual(paths, ['/html/'])
  now += 90_000; status = 200
  assert.equal((await keylessSearch({ query: 'after wait' }, { fetchImpl, clock })).ok, true)
  resetSearchPacing()
  await assert.rejects(performWebSearch({ query: 'empty', allowedDomains: ['no-match.invalid'] }, io), error => error instanceof Error && error.message.includes(setting.DUCKDUCKGO_TERMS))
  resetSearchPacing()
  const controller = new AbortController()
  const aborted = await keylessSearch({ query: 'cancel', signal: controller.signal }, { clock, fetchImpl: (async () => { controller.abort(); throw new Error('fixture cancel') }) as typeof fetch })
  assert.equal(aborted.ok, false)
  if (!aborted.ok) assert.equal(aborted.kind, 'aborted')
  const afterCancel = await keylessSearch({ query: 'after cancel' }, { clock, fetchImpl })
  assert.equal(afterCancel.ok, true)
  if (afterCancel.ok) assert.ok(afterCancel.notes?.includes(setting.DUCKDUCKGO_TERMS))
  setting.setDuckduckgoScraping(false)
  assert.equal(setting.duckduckgoScrapingEnabled(), false)
  const finalCount = requests
  const off = await keylessSearch({ query: 'off' }, { fetchImpl, clock })
  assert.equal(off.ok, false)
  if (!off.ok) assert.ok(off.message.includes('turned off in /config'))
  assert.equal(requests, finalCount)
  console.log('PASS scraping default: on for a fresh home and knocked only after the official doors found nothing, =0 and the saved off make no request, =1 overrides a saved off, terms once including failure, no host evasion')
} finally { setting.setDuckduckgoScraping(false); await new Promise<void>(r => server.close(() => r())); rmSync(home, { recursive: true, force: true }) }
