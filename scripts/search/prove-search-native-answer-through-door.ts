import assert from 'node:assert/strict'

;(globalThis as any).MACRO = { VERSION: 'proof', PACKAGE_URL: 'https://example.invalid' }
const { performWebSearch } = await import('../../src/services/search/searchDoor.js')
const { resetSearchPacing } = await import('../../src/services/search/searchPacing.js')
const { WebSearchTool } = await import('../../src/tools/WebSearchTool/WebSearchTool.js')

let now = 1_000_000
const clock = { now: () => now, random: () => 0.5, sleep: async (ms: number) => { now += ms } }
const context = { options: { engineModel: 'claude-opus-4-8' }, abortController: new AbortController() } as any
const reads = { keylessAllowed: false, mainModel: 'claude-opus-4-8' }
const hit = { title: 'xAI models', url: 'https://docs.x.ai/developers/models', snippet: '', source_type: 'provider' as const }
const words = 'The vendor page lists the 2026-09 release as grok-4.8 and names 2026-09-01 as its date.'

const renderFromRun = (query: string, run: Awaited<ReturnType<typeof performWebSearch>>) => {
  const results = run.sequence.map(entry => (typeof entry === 'string' ? entry : { tool_use_id: entry.toolUseId, content: entry.hits }))
  const block = WebSearchTool.mapToolResultToToolResultBlockParam(
    {
      query,
      results,
      durationSeconds: 1,
      via: run.via,
      tier: run.tier,
      ...(run.notes.length > 0 ? { notes: run.notes } : {}),
      ...(run.hint ? { hint: run.hint } : {}),
      ...(run.cached ? { cached: true } : {}),
    },
    'proof',
  )
  return JSON.parse(String(block.content)) as { hits: typeof hit[]; notes: string[] }
}

resetSearchPacing()
let nativeKnocks = 0
let braveKnocks = 0
const bothRun = await performWebSearch(
  { query: 'xAI grok-4.8 release date' },
  {
    context,
    reads,
    clock,
    backends: {
      native: async () => {
        nativeKnocks++
        return {
          ok: true,
          via: 'anthropic-native',
          tier: 'native',
          hits: [hit],
          commentary: [words],
          sequence: [{ toolUseId: 'srvtoolu_1', hits: [hit] }, words],
        }
      },
    },
  },
)
assert.equal(nativeKnocks, 1)
assert.ok(bothRun.sequence.includes(words), `performWebSearch carries the native commentary in sequence: ${JSON.stringify(bothRun.sequence)}`)
const bothRendered = renderFromRun('xAI grok-4.8 release date', bothRun)
assert.equal(bothRendered.hits.length, 1)
assert.equal(bothRendered.hits[0]?.url, hit.url)
assert.ok(bothRendered.notes.includes('via Anthropic web search (native)'))
assert.ok(bothRendered.notes.includes('Unverified web text; cite relevant URLs as markdown links.'))
assert.ok(bothRendered.notes.includes(`Anthropic web search answer, the provider's own words, unverified: ${words}`), `the provider's answer reaches the model through performWebSearch: ${JSON.stringify(bothRendered.notes)}`)

const cachedRun = await performWebSearch(
  { query: 'xAI grok-4.8 release date' },
  {
    context,
    reads,
    clock,
    backends: {
      native: async () => {
        nativeKnocks++
        throw new Error('cached query must not knock the native door')
      },
    },
  },
)
assert.equal(nativeKnocks, 1, 'cache replay makes zero new native knocks')
assert.equal(cachedRun.cached, true)
const cachedRendered = renderFromRun('xAI grok-4.8 release date', cachedRun)
assert.ok(cachedRendered.notes.includes(`Anthropic web search answer, the provider's own words, unverified: ${words}`), `cached native answer preserves the provider's words: ${JSON.stringify(cachedRendered.notes)}`)
assert.ok(cachedRendered.notes.some(note => note.includes("answered from this session's search cache") && note.includes('Anthropic web search')), `cached native answer states the cache note: ${JSON.stringify(cachedRendered.notes)}`)

resetSearchPacing()
const wordsOnlyRun = await performWebSearch(
  { query: 'words only query' },
  {
    context,
    reads: { ...reads, braveKey: 'env' },
    clock,
    backends: {
      native: async () => {
        nativeKnocks++
        return {
          ok: true,
          via: 'anthropic-native',
          tier: 'native',
          hits: [],
          commentary: [words],
          sequence: [words],
        }
      },
      brave: async () => {
        braveKnocks++
        throw new Error('a native answer in words alone is an answer and must not walk on to Brave')
      },
    },
  },
)
assert.equal(braveKnocks, 0, 'words-alone native answer stops the walk at the native rung')
assert.equal(wordsOnlyRun.via, 'anthropic-native')
assert.equal(wordsOnlyRun.hits.length, 0)
const wordsOnlyRendered = renderFromRun('words only query', wordsOnlyRun)
assert.equal(wordsOnlyRendered.hits.length, 0)
assert.ok(wordsOnlyRendered.notes.includes('via Anthropic web search (native)'))
assert.ok(wordsOnlyRendered.notes.includes('Unverified web text; cite relevant URLs as markdown links.'))
assert.ok(wordsOnlyRendered.notes.includes(`Anthropic web search answer, the provider's own words, unverified: ${words}`))
assert.ok(!wordsOnlyRendered.notes.some(note => note.includes('No source answered') || note.includes('found no matching links')), `words-alone native answer never reads as no-backend: ${JSON.stringify(wordsOnlyRendered.notes)}`)

resetSearchPacing()
const hitsOnlyRun = await performWebSearch(
  { query: 'hits only query' },
  {
    context,
    reads,
    clock,
    backends: {
      native: async () => ({
        ok: true,
        via: 'openai-native',
        tier: 'native',
        hits: [hit],
        commentary: [],
        sequence: [{ toolUseId: 'ws_1', hits: [hit] }],
      }),
    },
  },
)
assert.ok(hitsOnlyRun.sequence.every(entry => typeof entry !== 'string'))
const hitsOnlyRendered = renderFromRun('hits only query', hitsOnlyRun)
assert.equal(hitsOnlyRendered.hits.length, 1)
assert.ok(hitsOnlyRendered.notes.includes('via OpenAI web search (native)'))
assert.ok(hitsOnlyRendered.notes.includes('Unverified web text; cite relevant URLs as markdown links.'))
assert.ok(!hitsOnlyRendered.notes.some(note => note.includes("provider's own words")), `hits-only native answer invents no commentary note: ${JSON.stringify(hitsOnlyRendered.notes)}`)

resetSearchPacing()
const emptyNativeWalk = await performWebSearch(
  { query: 'neither hits nor words' },
  {
    context,
    reads: { ...reads, braveKey: 'env' },
    clock,
    backends: {
      native: async () => ({
        ok: true,
        via: 'anthropic-native',
        tier: 'native',
        hits: [],
        commentary: [],
        sequence: [],
      }),
      brave: async () => {
        braveKnocks++
        return {
          ok: true,
          via: 'brave',
          tier: 'keyed',
          hits: [{ title: 'Brave fallback', url: 'https://example.org/brave', snippet: 'Fallback snippet', source_type: 'brave' }],
        }
      },
    },
  },
)
assert.equal(braveKnocks, 1, 'when the native door gives neither hits nor words, the cascade walks on')
assert.equal(emptyNativeWalk.via, 'brave')
assert.ok(emptyNativeWalk.notes.some(note => note.includes('Anthropic web search found no matching links')))

console.log('PASS native search answer through performWebSearch: words + hits, cache replay, words alone, hits alone, and empty fallthrough')
