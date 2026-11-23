#!/usr/bin/env bun
import { createServer, type Server } from 'node:net'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'provider-deadline-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — provider-deadline prover exceeded 120s; a request in the sections above never settled, check src/models/roads/fetchDeadline.ts and the section printed last')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

async function listenBlackHole(): Promise<{ server: Server; port: number }> {
  const server = createServer(socket => {
    socket.on('error', () => {})
  })
  for (let port = 37060; port < 37100; port++) {
    const landed = await new Promise<boolean>(resolve => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (landed) return { server, port }
  }
  throw new Error('no free fixture port in 37000–37099')
}

console.log('============================================================')
console.log(' provider deadlines — every call bounded, honest words')
console.log('============================================================')

const deadline = await import(join(REPO, 'src/models/roads/fetchDeadline.ts'))

section('§1 the two sentences: timed out ≠ cancelled')
{
  t('§1 the breach line names provider + seconds', deadline.deadlineBreachLine('openrouter', 15_000) === 'timed out after 15s — openrouter did not answer', `got ${JSON.stringify(deadline.deadlineBreachLine('openrouter', 15_000))}; fix deadlineBreachLine in src/models/roads/fetchDeadline.ts`)
  t('§1 fractional seconds keep one decimal', deadline.deadlineBreachLine('openai', 1_500) === 'timed out after 1.5s — openai did not answer', `got ${JSON.stringify(deadline.deadlineBreachLine('openai', 1_500))}; fix the seconds formatting in deadlineBreachLine in src/models/roads/fetchDeadline.ts`)
  const timeoutErr = Object.assign(new Error('operation timed out'), { name: 'TimeoutError' })
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
  t('§1 the classifier reads TimeoutError and AbortError', deadline.isDeadlineBreach(timeoutErr) && deadline.isDeadlineBreach(abortErr), 'isDeadlineBreach in src/models/roads/fetchDeadline.ts must return true for errors named TimeoutError and AbortError')
  t('§1 an ordinary failure is not a breach', !deadline.isDeadlineBreach(new Error('ECONNREFUSED')), 'isDeadlineBreach in src/models/roads/fetchDeadline.ts must return false for an error that is not named TimeoutError or AbortError')
  t('§1 the two sentences share no words that could blur them', !deadline.deadlineBreachLine('x', 1000).includes('closed') && !'/logins closed — no credential changed'.includes('timed out'), 'the breach line from deadlineBreachLine in src/models/roads/fetchDeadline.ts must not contain the word closed')
  const oauth = await import(join(REPO, 'src/models/sign-in/oauth/client.ts'))
  const { AxiosError } = await import('axios')
  const timeout = new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED')
  const mapped = oauth.honestDeadlineBreach(timeout, 15_000)
  t('§1 an axios timeout on the Anthropic OAuth legs reads the honest line', mapped instanceof Error && mapped.message === 'timed out after 15s — anthropic did not answer', `${String((mapped as Error)?.message)}; fix honestDeadlineBreach in src/models/sign-in/oauth/refresh.ts`)
  const refused = new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST')
  t('§1 every other axios failure passes through untouched', oauth.honestDeadlineBreach(refused, 15_000) === refused, 'honestDeadlineBreach in src/models/sign-in/oauth/refresh.ts must return an AxiosError that is not a timeout as the same object')
  const plain = new Error('ECONNREFUSED')
  t('§1 a non-axios failure passes through untouched', oauth.honestDeadlineBreach(plain, 15_000) === plain, 'honestDeadlineBreach in src/models/sign-in/oauth/refresh.ts must return a non-axios error as the same object')
}

section('§2 the door ends a black-holed request within the bound')
{
  const { getApiFetch } = await import(join(REPO, 'src/platform/network/proxy.ts'))
  const { server, port } = await listenBlackHole()
  const started = Date.now()
  let line = ''
  try {
    await deadline.fetchWithProviderDeadline(getApiFetch(), 'openrouter', 1_500, `http://127.0.0.1:${port}/api/v1/models`, { method: 'GET' })
  } catch (error) {
    line = error instanceof Error ? error.message : String(error)
  }
  const wall = Date.now() - started
  server.close()
  t('§2 the request ended within the bound', wall < 6_000, `${wall}ms; fetchWithProviderDeadline in src/models/roads/fetchDeadline.ts must abort at the bound it is given`)
  t('§2 the honest line, not the runtime spelling', line === 'timed out after 1.5s — openrouter did not answer', `${line}; fetchWithProviderDeadline in src/models/roads/fetchDeadline.ts must throw the deadlineBreachLine text`)
}

section('§2b caller cancel stays a cancel; a breach beside a quiet caller signal stays a timeout')
{
  const { getApiFetch } = await import(join(REPO, 'src/platform/network/proxy.ts'))
  {
    const { server, port } = await listenBlackHole()
    const caller = new AbortController()
    const cancelTimer = setTimeout(() => caller.abort(), 300)
    const started = Date.now()
    let failure: unknown = null
    try {
      await deadline.fetchWithProviderDeadline(getApiFetch(), 'probe', 5_000, `http://127.0.0.1:${port}/api/v1/models`, {
        method: 'GET',
        signal: caller.signal,
      })
    } catch (error) {
      failure = error
    }
    const wall = Date.now() - started
    clearTimeout(cancelTimer)
    server.close()
    const line = failure instanceof Error ? failure.message : String(failure)
    t('§2b the caller abort ends the request promptly', wall < 2_000, `${wall}ms; fetchWithProviderDeadline in src/models/roads/fetchDeadline.ts must pass the caller signal through to the request`)
    t('§2b the cancel is NOT reported as a timeout', !line.includes('timed out after'), `${line}; fetchWithProviderDeadline in src/models/roads/fetchDeadline.ts must rethrow a caller abort unchanged`)
  }
  {
    const { server, port } = await listenBlackHole()
    const caller = new AbortController()
    let line = ''
    try {
      await deadline.fetchWithProviderDeadline(getApiFetch(), 'probe', 1_500, `http://127.0.0.1:${port}/api/v1/models`, {
        method: 'GET',
        signal: caller.signal,
      })
    } catch (error) {
      line = error instanceof Error ? error.message : String(error)
    }
    server.close()
    t('§2b a quiet caller signal still breaches honestly', line === 'timed out after 1.5s — probe did not answer', `${line}; fetchWithProviderDeadline in src/models/roads/fetchDeadline.ts must still apply its own bound when the caller signal never fires`)
  }
}

section('§3 the openrouter catalogue against the black hole (15s bound)')
{
  const { server, port } = await listenBlackHole()
  const { fetchOpenrouterLiveModels } = await import(join(REPO, 'src/models/roads/openrouter/openrouterCatalogue.ts'))
  const started = Date.now()
  const outcome = await Promise.race([
    fetchOpenrouterLiveModels({ baseUrl: `http://127.0.0.1:${port}/api/v1`, headers: {} }).then(
      () => 'resolved' as const,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
    new Promise<'pending'>(r => {
      const bound = setTimeout(() => r('pending'), 25_000)
      bound.unref?.()
    }),
  ])
  const wall = Date.now() - started
  server.close()
  t('§3 the catalogue request SETTLES (base hangs forever)', outcome !== 'pending', `still pending after ${wall}ms; fetchOpenrouterLiveModels in src/models/roads/openrouter/openrouterCatalogue.ts must fetch through fetchWithProviderDeadline`)
  t('§3 the failure carries the honest line', typeof outcome === 'string' && outcome.includes('timed out after 15s — openrouter did not answer'), `${String(outcome)}; fetchOpenrouterLiveModels in src/models/roads/openrouter/openrouterCatalogue.ts must surface the deadlineBreachLine text with a 15s bound`)
}

section('§3b the OpenAI catalogue against the black hole (15s bound)')
{
  const { server, port } = await listenBlackHole()
  const { fetchOpenaiLiveModels } = await import(join(REPO, 'src/models/roads/openai/openaiClient.ts'))
  const started = Date.now()
  const outcome = await Promise.race([
    fetchOpenaiLiveModels({ baseUrl: `http://127.0.0.1:${port}/v1`, headers: {} }).then(
      () => 'resolved' as const,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
    new Promise<'pending'>(r => {
      const bound = setTimeout(() => r('pending'), 25_000)
      bound.unref?.()
    }),
  ])
  const wall = Date.now() - started
  server.close()
  t('§3b the OpenAI catalogue request SETTLES (base hangs forever)', outcome !== 'pending', `still pending after ${wall}ms; fetchOpenaiLiveModels in src/models/roads/openai/openaiClient.ts must fetch through fetchWithProviderDeadline`)
  t('§3b the failure carries the honest line', typeof outcome === 'string' && outcome.includes('timed out after 15s — openai did not answer'), `${String(outcome)}; fetchOpenaiLiveModels in src/models/roads/openai/openaiClient.ts must surface the deadlineBreachLine text with a 15s bound`)
}

section('§3c the OpenRouter /key probe against the black hole (10s bound)')
{
  const { server, port } = await listenBlackHole()
  const usage = await import(join(REPO, 'src/models/roads/openrouter/openrouterUsageState.ts'))
  usage.__resetOpenrouterUsageStateForTest()
  process.env.OPENROUTER_API_KEY = 'sk-or-fixture-probe'
  process.env.MERCURY_OPENROUTER_API_BASE = `http://127.0.0.1:${port}/api/v1`
  const started = Date.now()
  const outcome = await Promise.race([
    usage.refreshOpenrouterKeyUsage({ force: true }).then(() => 'settled' as const),
    new Promise<'pending'>(r => {
      const bound = setTimeout(() => r('pending'), 25_000)
      bound.unref?.()
    }),
  ])
  const wall = Date.now() - started
  server.close()
  const observed = usage.openrouterObservedKeyUsage()
  delete process.env.OPENROUTER_API_KEY
  delete process.env.MERCURY_OPENROUTER_API_BASE
  usage.__resetOpenrouterUsageStateForTest()
  t('§3c the key probe SETTLES (base hung the /usage mount forever)', outcome === 'settled', `still pending after ${wall}ms; refreshOpenrouterKeyUsage in src/models/roads/openrouter/openrouterUsageState.ts must fetch through fetchWithProviderDeadline`)
  t('§3c the honest line lands in the stale-but-labelled channel', typeof observed.lastError === 'string' && observed.lastError.includes('timed out after 10s — openrouter did not answer'), `${String(observed.lastError)}; refreshOpenrouterKeyUsage in src/models/roads/openrouter/openrouterUsageState.ts must store the deadlineBreachLine text (10s bound) in lastError`)
  t('§3c nothing was fabricated for the key', observed.usage === null, 'refreshOpenrouterKeyUsage in src/models/roads/openrouter/openrouterUsageState.ts must leave usage null when the probe times out')
}


console.log(failures === 0 ? '\nPASS prove-provider-deadlines' : `\nFAIL prove-provider-deadlines (${failures})`)
process.exit(failures === 0 ? 0 : 1)
