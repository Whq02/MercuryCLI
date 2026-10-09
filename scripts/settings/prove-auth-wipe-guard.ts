import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'auth-wipe-guard-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`)
}

const config = await import(join(SRC, 'utils/config/globalConfig.ts'))
const wouldLose = config._wouldLoseAuthStateForTesting as (fresh: { oauthAccount?: unknown; hasCompletedOnboarding?: boolean }) => boolean
const setCache = config._setGlobalConfigCacheForTesting as (c: Record<string, unknown> | null) => void
const account = { accountUuid: 'acct-1', emailAddress: 'op@example.test', organizationUuid: 'org-1' }

try {
  setCache(null)
  check('with nothing cached no view loses anything', wouldLose({}) === false)

  setCache({ oauthAccount: account, hasCompletedOnboarding: true })
  check('a view that keeps both facts is safe', wouldLose({ oauthAccount: account, hasCompletedOnboarding: true }) === false)
  check('a view without the cached account is a loss', wouldLose({ hasCompletedOnboarding: true }) === true)
  check('a view that forgets completed onboarding is a loss', wouldLose({ oauthAccount: account, hasCompletedOnboarding: false }) === true)
  check('a view silent on onboarding is a loss too', wouldLose({ oauthAccount: account }) === true)
  check('an empty view loses both', wouldLose({}) === true)

  setCache({ hasCompletedOnboarding: false })
  check('a cache without an account and without completed onboarding guards nothing', wouldLose({}) === false)

  setCache({ oauthAccount: account })
  check('a cache with an account but no onboarding guards the account alone', wouldLose({ oauthAccount: account }) === false && wouldLose({ hasCompletedOnboarding: true }) === true)
} finally {
  setCache(null)
  rmSync(HOME, { recursive: true, force: true })
}
console.log(failures ? `FAIL auth-wipe guard: ${failures} failures` : 'PASS auth-wipe guard')
process.exit(failures ? 1 : 0)
