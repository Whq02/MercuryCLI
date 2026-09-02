#!/usr/bin/env bun
// ============================================================================
//  prove-api-key-helper-failure — a failed apiKeyHelper is a null key with a
//  named reason, never a one-space credential (release-hardening audit
//  rank 48).
//
//  The lie: a helper that exited non-zero, printed nothing, or was killed by
//  its budget cached a single-space sentinel so the execution ladder would
//  stop — and the public readers handed that sentinel out as the resolved
//  key. The verification row sent a probe request carrying one space and
//  painted "invalid API key"; the turn path sent an empty bearer, the 401
//  was classified retryable, the cache was cleared and every retry lap
//  re-ran the helper under its ten-minute budget before a generic 401 line
//  that never named the helper. The only mention of the real cause was a raw
//  ANSI-red stderr write that landed in the middle of a live cockpit repaint.
//
//    §1 a failed helper answers null to every reader, records its reason,
//       and the ladder still stops (one execution per TTL);
//    §2 a 401 with a failed helper fails fast, and the presenter names the
//       helper and its reason instead of "invalid API key";
//    §3 a healed helper serves its key, clears the record, and the 401
//       recovery lap stands again;
//    §4 the raw stderr line rides the headless road only;
//    §5 the verification row carries the recorded reason (source pin).
//
//  Hermetic: scratch config home, the helpers are node scripts in scratch.
//  PROVE_SRC names another checkout's src (the A/B control: §1, §2 and §4
//  read red at the pre-fix tree).
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'api-key-helper-'))
const HOME = join(SCRATCH, 'home')
process.env.MERCURY_CONFIG_DIR = HOME
mkdirSync(HOME, { recursive: true })
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
delete process.env.CI
delete process.env.NODE_ENV
// A long TTL: the ladder must stop on its own, not through expiry.
process.env.MERCURY_API_KEY_HELPER_TTL_MS = '600000'
const COUNT = join(SCRATCH, 'count')
process.env.HELPER_COUNT_FILE = COUNT

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// The helpers: one that fails the way a locked vault fails, one that serves.
const FAIL = join(SCRATCH, 'fail.mjs')
writeFileSync(
  FAIL,
  "import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.HELPER_COUNT_FILE, 'x')\nprocess.stderr.write('vault locked\\n')\nprocess.exit(3)\n",
)
const OK = join(SCRATCH, 'ok.mjs')
writeFileSync(OK, "import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.HELPER_COUNT_FILE, 'x')\nconsole.log('sk-ant-ok')\n")
const executions = (): number => (existsSync(COUNT) ? readFileSync(COUNT, 'utf8').length : 0)
const helperLine = (script: string): string => `"${process.execPath}" "${script}"`

// The SDK the product under proof resolves (the tree's own copy, under bun's
// own conditions) — the 401 must be ITS APIError for the classifier's
// instanceof to hold on the control tree too.
const bunApi = (globalThis as { Bun?: { resolveSync: (specifier: string, from: string) => string } }).Bun
const sdkEntry = bunApi ? bunApi.resolveSync('@anthropic-ai/sdk', join(SRC, 'services', 'api')) : '@anthropic-ai/sdk'

// Config reads are boot-gated; the prover is its own boot.
const { enableConfigs } = await import(join(SRC, 'utils/config/globalConfig.ts'))
enableConfigs()
const settings = await import(join(SRC, 'utils/settings/settings.ts'))
const { resetSettingsCache } = await import(join(SRC, 'utils/settings/settingsCache.ts'))
const auth = await import(join(SRC, 'utils/auth.ts'))
const retry = await import(join(SRC, 'services/api/withRetry.ts'))
const errors = await import(join(SRC, 'services/api/errors.ts'))
const state = await import(join(SRC, 'bootstrap/state.ts'))
const sdk = (await import(sdkEntry)) as { APIError: new (status: number, body: unknown, message: string, headers: unknown) => unknown }

function configureHelper(script: string): void {
  const path = settings.getSettingsFilePathForSource('userSettings') as string
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ apiKeyHelper: helperLine(script) }))
  resetSettingsCache()
  auth.clearApiKeyHelperCache()
}
const err401 = (): unknown =>
  new sdk.APIError(
    401,
    { type: 'error', error: { type: 'authentication_error', message: 'x-api-key header is required' } },
    'x-api-key header is required',
    undefined,
  )
const helperFailure = (): { message: string; at: number } | null =>
  (auth.getApiKeyHelperFailure as (() => { message: string; at: number } | null) | undefined)?.() ?? null
const failedLast = (): boolean | undefined => (auth.apiKeyHelperFailedLast as (() => boolean) | undefined)?.()

section('§1 A FAILED HELPER IS A NULL KEY WITH A NAMED REASON')
{
  configureHelper(FAIL)
  check('precondition: the helper is configured', auth.getConfiguredApiKeyHelper() === helperLine(FAIL), String(auth.getConfiguredApiKeyHelper()))
  const key = await auth.getApiKeyFromApiKeyHelper(false)
  check('the async reader answers null, never the one-space sentinel', key === null, JSON.stringify(key))
  check('the cached reader answers null too', auth.getApiKeyFromApiKeyHelperCached() === null, JSON.stringify(auth.getApiKeyFromApiKeyHelperCached()))
  const resolved = auth.getAnthropicApiKeyWithSource() as { key: string | null; source: string }
  check('the key ladder reports no key from the helper source', resolved.key === null && resolved.source === 'apiKeyHelper', JSON.stringify(resolved))
  const failure = helperFailure()
  check('the failure is recorded with the exit code and the stderr', failure !== null && /exited with code 3/.test(failure.message) && /vault locked/.test(failure.message), failure?.message)
  check('the failed-last predicate reads it', failedLast() === true)
  const again = await auth.getApiKeyFromApiKeyHelper(false)
  check('the ladder still stops: a second read within the TTL runs nothing', again === null && executions() === 1, `executions=${executions()}`)
}

section('§2 A 401 WITH A FAILED HELPER FAILS FAST AND NAMES THE HELPER')
{
  check('the 401 is NOT retryable — no ten-lap helper re-run', retry.isRetryableError(err401()) === false)
  check('the lap still cleared the cache (the next turn re-runs the helper) and kept the record', auth.getApiKeyFromApiKeyHelperCached() === null && helperFailure() !== null)
  const painted = JSON.stringify(errors.getAssistantMessageFromError(err401(), 'claude-fable-5-1'))
  check('the presenter names the helper and its reason', painted.includes('apiKeyHelper failed') && painted.includes('vault locked'), painted.slice(0, 240))
  check('and never "invalid API key"', !/invalid api key/i.test(painted))
}

section('§3 A HEALED HELPER SERVES ITS KEY')
{
  configureHelper(OK)
  const healed = await auth.getApiKeyFromApiKeyHelper(false)
  check('the key is served', healed === 'sk-ant-ok', JSON.stringify(healed))
  check('the cached reader agrees', auth.getApiKeyFromApiKeyHelperCached() === 'sk-ant-ok')
  check('the failure record clears on success', helperFailure() === null && failedLast() === false)
  check('a 401 is retryable again — the one recovery lap stands', retry.isRetryableError(err401()) === true)
}

section('§4 THE RAW STDERR LINE RIDES THE HEADLESS ROAD ONLY')
{
  const writes: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  }) as never
  try {
    state.setIsInteractive(true)
    configureHelper(FAIL)
    await auth.getApiKeyFromApiKeyHelper(false)
    check('interactive: no ANSI line lands on stderr (the typed message is the paint)', !writes.some(w => w.includes('apiKeyHelper failed')), writes.join('|').slice(0, 200))
    state.setIsInteractive(false)
    configureHelper(FAIL)
    await auth.getApiKeyFromApiKeyHelper(false)
    check('headless: the stderr line still names the failure', writes.some(w => w.includes('apiKeyHelper failed') && w.includes('vault locked')), writes.join('|').slice(0, 200))
  } finally {
    process.stderr.write = original as never
  }
}

section('§5 THE VERIFICATION ROW CARRIES THE REASON (source pin)')
{
  const hook = readFileSync(join(SRC, 'hooks/useApiKeyVerification.ts'), 'utf8')
  check('the row reads the recorded failure beside its typed message', hook.includes('getApiKeyHelperFailure()') && hook.includes('returned no valid key'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-api-key-helper-failure: ALL PASS' : `\nprove-api-key-helper-failure: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
