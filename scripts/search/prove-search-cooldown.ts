import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { SearchClock } from '../../src/services/search/searchPacing.js'
import type { SearchOutcome } from '../../src/services/search/searchContract.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'proof', PACKAGE_URL: 'https://example.invalid' }
const root = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'))
const { keylessSearch } = await import(pathToFileURL(resolve(root, 'src/services/search/duckduckgo.ts')).href)
const pacing = await import(pathToFileURL(resolve(root, 'src/services/search/searchPacing.ts')).href)
const { braveSearch } = await import(pathToFileURL(resolve(root, 'src/services/search/brave.ts')).href)
const { performWebSearch } = await import(pathToFileURL(resolve(root, 'src/services/search/searchDoor.ts')).href)
const { DUCKDUCKGO_TERMS, DUCKDUCKGO_OFF_DOORS } = await import(pathToFileURL(resolve(root, 'src/services/search/searchSetting.ts')).href)
let checks = 0, failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  checks++
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${!condition && detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`)
}
const page = '<div id="links"><div class="result results_links"><a class="result__a" href="https://example.invalid/result">Fixture result</a><div class="result__snippet">Fixture excerpt</div></div></div>'
const message = (answer: SearchOutcome): string => answer.ok ? '' : answer.message
const cancelled = (answer: SearchOutcome): boolean => !answer.ok && answer.kind === 'aborted' && answer.message === 'cancelled'
function fixture(random = 0.5) {
  pacing.resetSearchPacing()
  let now = 0
  let status = 429
  let body = ''
  let headers: Record<string, string> = {}
  let hold = false
  let entered!: (ms: number) => void
  let release: (() => void) | undefined
  const sleeping = new Promise<number>(resolve => { entered = resolve })
  const sleeps: number[] = []
  const seen: Array<{ query: string; url: string; at: number; method?: string; body: string }> = []
  const clock: SearchClock = {
    now: () => now,
    random: () => random,
    sleep: async (ms, signal) => {
      if (!ms || signal?.aborted) return
      sleeps.push(ms)
      if (!hold) { now += ms; return }
      await new Promise<void>(resolve => {
        const done = (): void => { signal?.removeEventListener('abort', done); release = undefined; resolve() }
        release = () => { now += ms; hold = false; done() }
        signal?.addEventListener('abort', done, { once: true })
        entered(ms)
      })
    },
  }
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ query: new URLSearchParams(String(init?.body)).get('q') ?? '', url: String(url), at: now, method: init?.method, body: String(init?.body) })
    return new Response(body, { status, headers })
  }) as typeof fetch
  return {
    clock, fetchImpl, seen, sleeps, sleeping,
    advance(ms: number) { now += ms },
    answer(code = 200, text = page, values: Record<string, string> = {}) { status = code; body = text; headers = values },
    hold() { hold = true },
    release() { release?.() },
    search(query: string, signal?: AbortSignal, enabled = true): Promise<SearchOutcome> { return keylessSearch({ query, signal }, { clock, fetchImpl, enabled }) },
  }
}

{
  const f = fixture()
  const refused = await f.search('first refusal')
  check('a refusal is one request with the existing words and terms', f.seen.length === 1 && message(refused) === `${DUCKDUCKGO_TERMS} the site refused automated access; cooling down 30s; no retry or host swap`, refused)
  f.advance(3000)
  f.answer()
  const answers = await Promise.all(['first', 'second', 'third'].map(query => f.search(query)))
  check('three callers arriving with 27 seconds left all receive results', answers.every(answer => answer.ok && answer.hits[0]?.title === 'Fixture result'), answers)
  check('the three requests keep arrival order', JSON.stringify(f.seen.slice(1).map(hit => hit.query)) === JSON.stringify(['first', 'second', 'third']), f.seen)
  check('the first request waits out all 27 seconds', f.seen[1]?.at === 30_000, f.seen)
  check('followers make their requests three seconds apart', f.seen[2]?.at === 33_000 && f.seen[3]?.at === 36_000, f.seen)
  check('there are no extra requests or host swaps', f.seen.length === 4 && f.seen.every(hit => hit.url === f.seen[0]?.url), f.seen)
  check('successful followers do not repeat the terms notice', answers.every(answer => answer.ok && answer.notes?.length === 0), answers)
  check('an answer clears the refusal streak', pacing.coolDownRemainingMs('duckduckgo', f.clock.now()) === 0)
}

for (const [label, random, repeats, header, duration, waits] of [
  ['first-refusal jitter maximum', 1, 1, '', 37_500, true],
  ['second-refusal jitter minimum', 0, 2, '', 45_000, false],
  ['bound inclusive', 0.5, 1, '40', 40_000, true],
  ['one millisecond past the bound', 0.5, 1, '40.001', 40_001, false],
  ['server header over a minute', 0.5, 1, '120', 120_000, false],
] as const) {
  const f = fixture(random)
  f.answer(429, '', header ? { 'retry-after': header } : {})
  for (let i = 0; i < repeats; i++) {
    if (i) f.advance(pacing.coolDownRemainingMs('duckduckgo', f.clock.now()))
    await f.search(`refusal ${i}`)
  }
  check(`${label}: the refusal schedules ${duration}ms`, pacing.coolDownRemainingMs('duckduckgo', f.clock.now()) === duration)
  const start = f.clock.now(), before = f.seen.length, sleeps = f.sleeps.length
  f.answer()
  const answer = await f.search('next caller')
  check(`${label}: ${waits ? 'waits then asks once' : 'answers at once without a request'}`, waits
    ? answer.ok && f.clock.now() === start + duration && f.seen.length === before + 1
    : !answer.ok && answer.kind === 'rate-limited' && f.clock.now() === start && f.sleeps.length === sleeps && f.seen.length === before, answer)
  check(`${label}: existing answer words`, waits
    ? answer.ok && answer.hits[0]?.snippet === 'Fixture excerpt'
    : message(answer) === `cooling down ${pacing.secondsLeftLabel(duration)}; no request was made`, answer)
}

for (const [status, body, why] of [
  [202, '', 'the site'], [403, '', 'the site'], [429, '', 'the site'], [503, '', 'the site'],
  [200, '<form id="challenge-form">bots use DuckDuckGo too</form>', 'the bot challenge page'],
] as const) {
  const f = fixture()
  f.answer(status, body)
  await f.search('refused')
  f.advance(3000)
  const answer = await f.search('refused after waiting')
  check(`${status} ${why}: one request after the wait is not retried or swapped`, f.seen.length === 2 && f.seen[1]?.at === 30_000 && f.seen[1]?.url === f.seen[0]?.url, f.seen)
  check(`${status} ${why}: the second refusal keeps its words and longer schedule`, message(answer) === `${why} refused automated access; cooling down 1m; no retry or host swap` && pacing.coolDownRemainingMs('duckduckgo', f.clock.now()) === 60_000, answer)
  const next = await f.search('later caller')
  check(`${status} ${why}: the next call does not wait or request during that longer cool-down`, f.seen.length === 2 && f.clock.now() === 30_000 && message(next) === 'cooling down 1m; no request was made', next)
}

{
  const f = fixture()
  await f.search('refused')
  f.advance(3000)
  f.answer()
  f.hold()
  const controller = new AbortController()
  const waiting = f.search('cancel me', controller.signal)
  const entered = await Promise.race([f.sleeping, waiting.then(() => 0)])
  check('a short cool-down really stays pending', entered === 27_000, entered)
  controller.abort()
  const answer = await waiting
  check('cancellation ends the wait before the fake clock advances and makes no request', cancelled(answer) && f.clock.now() === 3000 && f.seen.length === 1, answer)
  check('cancellation leaves the remaining cool-down intact', pacing.coolDownRemainingMs('duckduckgo', f.clock.now()) === 27_000)
}

{
  const f = fixture()
  await f.search('refused')
  f.advance(3000)
  f.answer()
  f.hold()
  const first = f.search('first waiting')
  await Promise.race([f.sleeping, first.then(() => 0)])
  const controller = new AbortController()
  const second = f.search('cancelled in queue', controller.signal)
  const third = f.search('third waiting')
  controller.abort()
  check('a queued cancellation settles without releasing its predecessor', cancelled(await second) && f.seen.length === 1, f.seen)
  f.release()
  const answers = await Promise.all([first, third])
  check('the caller behind a cancelled seat stays behind the waiting one', answers.every(answer => answer.ok) && JSON.stringify(f.seen.slice(1).map(hit => [hit.query, hit.at])) === JSON.stringify([['first waiting', 30_000], ['third waiting', 33_000]]), f.seen)
}

{
  const f = fixture()
  await f.search('refused')
  const off = await f.search('off', undefined, false)
  check('the off switch still answers immediately with its existing words', message(off) === `DuckDuckGo page scraping is off (${DUCKDUCKGO_OFF_DOORS})` && f.seen.length === 1 && f.sleeps.length === 0, off)
  const controller = new AbortController()
  controller.abort()
  check('an already cancelled call never enters the wait', cancelled(await f.search('already cancelled', controller.signal)) && f.seen.length === 1 && f.sleeps.length === 0)
}

{
  const f = fixture()
  await f.search('refused')
  let calls = 0
  const native = { ok: true as const, via: 'openai-native' as const, tier: 'native' as const, hits: [{ title: 'Native result', url: 'https://example.invalid/native', snippet: 'Native excerpt', source_type: 'provider' as const }] }
  const answer = await performWebSearch({ query: 'native question' }, {
    context: { options: { engineModel: 'gpt-6-astra' }, abortController: new AbortController() },
    reads: { keylessAllowed: true }, clock: f.clock,
    backends: { native: async () => { calls++; return native }, keyless: () => f.search('must not run') },
  })
  check('a native provider answer neither reaches DuckDuckGo nor waits on its cool-down', calls === 1 && f.seen.length === 1 && f.sleeps.length === 0 && f.clock.now() === 0)
  check('a native provider answer keeps its hits and notes unchanged', answer.via === native.via && JSON.stringify(answer.hits) === JSON.stringify(native.hits) && answer.notes.length === 0, answer)
}

for (const door of ['brave', 'tavily', 'npm', 'searxng:https://example.invalid', 'jina-reader'] as const) {
  const f = fixture()
  pacing.noteRateLimited(door, f.clock)
  const wait = await pacing.withSearchTurn(door, { intervalMs: 1000, why: 'fixture' }, f.clock, undefined, async (ms: number) => ms)
  check(`${door}: a policy without the new wait stays immediate`, wait === 30_000 && f.clock.now() === 0 && f.sleeps.length === 0, wait)
}

{
  const f = fixture()
  const io = { clock: f.clock, fetchImpl: f.fetchImpl, env: { BRAVE_API_KEY: 'fixture-key' } }
  await braveSearch({ query: 'refused' }, io)
  const next = await braveSearch({ query: 'next caller' }, io)
  check('the actual Brave policy still returns a short cool-down immediately', message(next) === 'wait 30s; no request made' && f.clock.now() === 0 && f.sleeps.length === 0 && f.seen.length === 1, next)
}

{
  const f = fixture()
  f.answer()
  const answers = await Promise.all(['one', 'two', 'three'].map(query => f.search(query)))
  f.advance(10_000)
  answers.push(await f.search('four'))
  const expected = ['one', 'two', 'three', 'four'].map((query, i) => ({ query, url: 'https://html.duckduckgo.com/html/', at: [0, 3000, 6000, 16_000][i], method: 'POST', body: `q=${query}&kl=us-en&b=` }))
  check('a never-refused session keeps the same requests and clock times', answers.every(answer => answer.ok) && JSON.stringify(f.seen) === JSON.stringify(expected) && JSON.stringify(f.sleeps) === '[3000,3000]', f.seen)
  console.log(`Never-refused requests: ${JSON.stringify(f.seen)}`)
}

pacing.resetSearchPacing()
console.log(`${checks} checks, ${failures} failures`)
process.exitCode = failures ? 1 : 0
