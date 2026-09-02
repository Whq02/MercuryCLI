#!/usr/bin/env bun
import { createServer, type Server } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
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
  console.log('\nTIMEOUT — provider-deadline prover exceeded 120s')
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

const deadline = await import(join(REPO, 'src/services/providers/fetchDeadline.ts'))

section('§1 the two sentences: timed out ≠ cancelled')
{
  t('§1 the breach line names provider + seconds', deadline.deadlineBreachLine('openrouter', 15_000) === 'timed out after 15s — openrouter did not answer')
  t('§1 fractional seconds keep one decimal', deadline.deadlineBreachLine('openai', 1_500) === 'timed out after 1.5s — openai did not answer')
  const timeoutErr = Object.assign(new Error('operation timed out'), { name: 'TimeoutError' })
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
  t('§1 the classifier reads TimeoutError and AbortError', deadline.isDeadlineBreach(timeoutErr) && deadline.isDeadlineBreach(abortErr))
  t('§1 an ordinary failure is not a breach', !deadline.isDeadlineBreach(new Error('ECONNREFUSED')))
  const loginSrc = readFileSync(join(REPO, 'src/commands/login/login.tsx'), 'utf8')
  t("§1 the operator's own close keeps its own sentence at /login", loginSrc.includes('Login closed — no credential changed'))
  t('§1 the two sentences share no words that could blur them', !deadline.deadlineBreachLine('x', 1000).includes('closed') && !'Login closed — no credential changed'.includes('timed out'))
  const openaiAccountsSrc = readFileSync(join(REPO, 'src/services/providers/openai/openaiAccounts.ts'), 'utf8')
  t('§1 the OpenAI device wait says EXPIRED for a code the operator never approved', openaiAccountsSrc.includes('OpenAI sign-in expired before the code was approved — retry from /logins openai'))
  t('§1 …and no longer wears the timeout word for it', !openaiAccountsSrc.includes('device authorization timed out'))
  const moonshotLoginSrc = readFileSync(join(REPO, 'src/services/providers/moonshot/moonshotLogin.ts'), 'utf8')
  t('§1 the Kimi wait speaks the same three facts (cancelled · expired)', moonshotLoginSrc.includes('Kimi sign-in cancelled — nothing stored.') && moonshotLoginSrc.includes('Kimi sign-in expired before the code was entered'))
  const oauth = await import(join(REPO, 'src/services/oauth/client.ts'))
  const { AxiosError } = await import('axios')
  const timeout = new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED')
  const mapped = oauth.honestDeadlineBreach(timeout, 15_000)
  t('§1 an axios timeout on the Anthropic OAuth legs reads the honest line', mapped instanceof Error && mapped.message === 'timed out after 15s — anthropic did not answer', String((mapped as Error)?.message))
  const refused = new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST')
  t('§1 every other axios failure passes through untouched', oauth.honestDeadlineBreach(refused, 15_000) === refused)
  const plain = new Error('ECONNREFUSED')
  t('§1 a non-axios failure passes through untouched', oauth.honestDeadlineBreach(plain, 15_000) === plain)
  const oauthSrc = readFileSync(join(REPO, 'src/services/oauth/client.ts'), 'utf8')
  t('§1 both the exchange and the refresh legs throw through the mapper', (oauthSrc.match(/throw honestDeadlineBreach\(error, EXCHANGE_TIMEOUT_MS\)/g) ?? []).length >= 2)
}

section('§2 the door ends a black-holed request within the bound')
{
  const { getApiFetch } = await import(join(REPO, 'src/utils/proxy.ts'))
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
  t('§2 the request ended within the bound', wall < 6_000, `${wall}ms`)
  t('§2 the honest line, not the runtime spelling', line === 'timed out after 1.5s — openrouter did not answer', line)
}

section('§2b caller cancel stays a cancel; a breach beside a quiet caller signal stays a timeout')
{
  const { getApiFetch } = await import(join(REPO, 'src/utils/proxy.ts'))
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
    t('§2b the caller abort ends the request promptly', wall < 2_000, `${wall}ms`)
    t('§2b the cancel is NOT reported as a timeout', !line.includes('timed out after'), line)
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
    t('§2b a quiet caller signal still breaches honestly', line === 'timed out after 1.5s — probe did not answer', line)
  }
}

section('§3 the openrouter catalogue against the black hole (15s bound)')
{
  const { server, port } = await listenBlackHole()
  const { fetchOpenrouterLiveModels } = await import(join(REPO, 'src/services/providers/openrouter/openrouterCatalogue.ts'))
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
  t('§3 the catalogue request SETTLES (base hangs forever)', outcome !== 'pending', `still pending after ${wall}ms`)
  t('§3 the failure carries the honest line', typeof outcome === 'string' && outcome.includes('timed out after 15s — openrouter did not answer'), String(outcome))
}

section('§3b the OpenAI catalogue against the black hole (15s bound)')
{
  const { server, port } = await listenBlackHole()
  const { fetchOpenaiLiveModels } = await import(join(REPO, 'src/services/providers/openai/openaiClient.ts'))
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
  t('§3b the OpenAI catalogue request SETTLES (base hangs forever)', outcome !== 'pending', `still pending after ${wall}ms`)
  t('§3b the failure carries the honest line', typeof outcome === 'string' && outcome.includes('timed out after 15s — openai did not answer'), String(outcome))
}

section('§3c the OpenRouter /key probe against the black hole (10s bound)')
{
  const { server, port } = await listenBlackHole()
  const usage = await import(join(REPO, 'src/services/providers/openrouter/openrouterUsageState.ts'))
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
  t('§3c the key probe SETTLES (base hung the /usage mount forever)', outcome === 'settled', `still pending after ${wall}ms`)
  t('§3c the honest line lands in the stale-but-labelled channel', typeof observed.lastError === 'string' && observed.lastError.includes('timed out after 10s — openrouter did not answer'), String(observed.lastError))
  t('§3c nothing was fabricated for the key', observed.usage === null)
}

section('§4 source census — the deadline at every login/catalogue site')
{
  const sites: Array<[string, string, number]> = [
    ['openrouter catalogue', 'src/services/providers/openrouter/openrouterCatalogue.ts', 1],
    ['openrouter key exchange', 'src/services/providers/openrouter/openrouterAccounts.ts', 1],
    ['huggingface oauth + registration + whoami', 'src/services/providers/huggingface/huggingfaceAccounts.ts', 3],
    ['huggingface catalogue', 'src/services/providers/huggingface/huggingfaceCatalogue.ts', 1],
    ['gemini token exchange', 'src/services/providers/gemini/geminiAccounts.ts', 1],
    ['gemini catalogue', 'src/services/providers/gemini/geminiCatalogue.ts', 1],
    ['moonshot oauth', 'src/services/providers/moonshot/moonshotAccounts.ts', 1],
    ['moonshot balance + usages probes', 'src/services/providers/moonshot/moonshotUsageState.ts', 2],
    ['deepseek balance probe', 'src/services/providers/deepseek/deepseekUsageState.ts', 1],
    ['local discovery probe', 'src/services/providers/local/localDiscovery.ts', 1],
    ['openai token + device auth', 'src/services/providers/openai/openaiAccounts.ts', 3],
    ['openai catalogue', 'src/services/providers/openai/openaiClient.ts', 1],
    ['openrouter key probe', 'src/services/providers/openrouter/openrouterUsageState.ts', 1],
  ]
  for (const [label, file, minUses] of sites) {
    const src = readFileSync(join(REPO, file), 'utf8')
    const uses = (src.match(/fetchWithProviderDeadline\(/g) ?? []).length
    t(`§4 ${label} rides the door (${minUses}+ site(s))`, uses >= minUses, `${uses} uses`)
  }
  {
    const { readdirSync } = await import('node:fs')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name)
        if (entry.isDirectory()) walk(child)
        else if (/\.tsx?$/.test(entry.name) && !child.endsWith('fetchDeadline.ts')) {
          if (readFileSync(child, 'utf8').includes('AbortSignal.timeout(')) offenders.push(child)
        }
      }
    }
    walk(join(REPO, 'src/services/providers'))
    t('§4 no provider site carries a bare AbortSignal.timeout', offenders.length === 0, offenders.join(', '))
  }
  {
    const accounts = readFileSync(join(REPO, 'src/services/providers/gemini/geminiAccounts.ts'), 'utf8')
    const catalogue = readFileSync(join(REPO, 'src/services/providers/gemini/geminiCatalogue.ts'), 'utf8')
    const labelOf = (src: string): string[] => [...src.matchAll(/fetchWithProviderDeadline\(\s*\w+,\s*'([^']+)'/g)].map(m => m[1]!)
    const labels = new Set([...labelOf(accounts), ...labelOf(catalogue)])
    t('§4 the gemini family speaks ONE name in the breach line', labels.size === 1 && labels.has('gemini'), [...labels].join(', '))
  }
}

section('§5 deadlineSecondsLabel has one home')
{
  const clientSrc = readFileSync(join(REPO, 'src/services/mcp/client.ts'), 'utf8')
  t('§5 the MCP client imports the one label', clientSrc.includes("import { deadlineSecondsLabel } from '../providers/fetchDeadline.js'"))
  t('§5 the MCP client declares no private copy', !clientSrc.includes('function deadlineSecondsLabel'))
}

console.log(failures === 0 ? '\nPASS prove-provider-deadlines' : `\nFAIL prove-provider-deadlines (${failures})`)
process.exit(failures === 0 ? 0 : 1)
