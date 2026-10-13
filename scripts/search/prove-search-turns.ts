import assert from 'node:assert/strict'
const { withSearchTurn, resetSearchPacing, noteRateLimited, coolDownRemainingMs } = await import('../../src/services/search/searchPacing.js')
resetSearchPacing()
let now = 0
const starts: number[] = []
const clock = { now: () => now, random: () => 0.5, sleep: async (ms: number) => { now += ms } }
const policy = { intervalMs: 1000, windowMs: 10_000, maxRequests: 2, why: 'fixture' }
let release!: () => void, started!: () => void
const entered = new Promise<void>(r => { started = r })
const gate = new Promise<void>(r => { release = r })
const first = withSearchTurn('npm', policy, clock, undefined, async wait => { assert.equal(wait, 0); starts.push(now); started(); await gate; return 'first' })
await entered
const abort = new AbortController()
const second = withSearchTurn('npm', policy, clock, abort.signal, async () => { assert.ok(abort.signal.aborted); return 'cancelled' })
const third = withSearchTurn('npm', policy, clock, undefined, async wait => { assert.equal(wait, 0); starts.push(now); return 'third' })
abort.abort()
assert.equal(await second, 'cancelled')
assert.equal(starts.length, 1)
release(); assert.equal(await first, 'first'); assert.equal(await third, 'third')
assert.deepEqual(starts, [0, 1000])
let quotaWait = 0
await withSearchTurn('npm', policy, clock, undefined, async wait => { quotaWait = wait })
assert.equal(quotaWait, 8000)
now = 10_000
await withSearchTurn('npm', policy, clock, undefined, async wait => assert.equal(wait, 0))
const min = noteRateLimited('npm', clock, 86_400_000)
assert.equal(min, 86_400_000)
noteRateLimited('npm', clock)
assert.equal(coolDownRemainingMs('npm', now), 86_400_000)
console.log('PASS serial pacing: cancelled queued caller leaves predecessor lock intact, starts spaced, rolling quota and server minimum preserved')

;(globalThis as any).MACRO = { VERSION: 'proof' }
const { braveSearch } = await import('../../src/services/search/brave.js')
const { tavilySearch } = await import('../../src/services/search/tavily.js')
for (const source of ['brave', 'tavily'] as const) {
  resetSearchPacing(); now = 0
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    return new Response('{}', { status: 429, headers: source === 'brave'
      ? { 'x-ratelimit-remaining': '1, 0', 'x-ratelimit-reset': '1, 3600', 'retry-after': '60' }
      : { 'retry-after': '120' } })
  }) as typeof fetch
  const search = source === 'brave' ? braveSearch : tavilySearch
  const io = { fetchImpl, clock, env: { BRAVE_API_KEY: 'fixture-key', TAVILY_API_KEY: 'fixture-key' } }
  const answer = await search({ query: 'test' }, io)
  assert.equal(answer.ok, false)
  assert.equal(coolDownRemainingMs(source, now), source === 'brave' ? 3_600_000 : 120_000)
  await search({ query: 'different' }, io)
  assert.equal(calls, 1)
}
console.log('PASS keyed search: Brave exhausted-window relative reset and Tavily Retry-After preserved without a second call')
