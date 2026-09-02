// ============================================================================
//  prove-account-isolation — credential identity is PER-HOME and can never
//  bleed across accounts.
//
//  What this pins:
//   1. getMacOsKeychainStorageServiceName() derives a DISTINCT service per
//      config home (sha256(dir) 8-hex suffix) — scope A's keychain entry is
//      structurally unreachable from scope B (no cross-account token bleed).
//   2. Foreign-home runs keep the un-suffixed service (backwards compat).
//   3. Fork builds (MACRO sim): the env-less run and an explicit
//      MERCURY_CONFIG_DIR pin of the resolver's OWN answer resolve the SAME
//      home ⇒ SAME service — the no-re-login invariant. The pin comes from
//      the resolver, never a hardcoded home.
//   4. NFC normalization: composed and decomposed spellings of one path hash
//      to one identity (a moved/retyped home never forks the credential).
// ============================================================================
import { join } from 'node:path'
import { homedir } from 'node:os'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

const prevEnv = process.env.MERCURY_CONFIG_DIR
const helpers = (await import('../../src/utils/secureStorage/macOsKeychainHelpers.js')) as typeof import('../../src/utils/secureStorage/macOsKeychainHelpers.js')

const svcFor = (dir: string | undefined): string => {
  // scrub the CANONICAL spellings per call — the pooled gate exports
  // MERCURY_CONFIG_DIR, which outranks the MERCURY_CONFIG_DIR this helper
  // drives (the second-eyes adjudication class)
  delete process.env.MERCURY_CONFIG_DIR
  delete process.env.MERCURY_HOME
  if (dir === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = dir
  return helpers.getMacOsKeychainStorageServiceName()
}

// ── 1: distinct per-home identities ─────────────────────────────────────────
const svcA = svcFor('/tmp/acct-iso-homeA')
const svcB = svcFor('/tmp/acct-iso-homeB')
check(svcA !== svcB, `two homes ⇒ two keychain services (${svcA.slice(-10)} vs ${svcB.slice(-10)})`)
check(/-[0-9a-f]{8}$/.test(svcA) && /-[0-9a-f]{8}$/.test(svcB), 'non-default homes carry the 8-hex dir-hash suffix')

// Same home twice ⇒ same service (stable identity).
check(svcFor('/tmp/acct-iso-homeA') === svcA, 'same home ⇒ same service (stable)')

// ── 2: an env-less run resolves Mercury's own home and its SUFFIXED service under any stamp.
const svcUnset = svcFor(undefined)
check(/-[0-9a-f]{8}$/.test(svcUnset), 'env-less run carries Mercury\'s suffixed service (stamp-independent)')

// ── 4: NFC — decomposed and composed spellings are ONE identity ─────────────
const composed = '/tmp/acct-iso-café'      // é composed
const decomposed = '/tmp/acct-iso-café'   // e + combining acute
check(svcFor(composed) === svcFor(decomposed), 'NFC: composed/decomposed path spellings hash to one service')

// ── 3: stamp sim — resolved-home keying (the resolved-home invariant) ───────────
// Set the MACRO fork seam LAST (it persists for the remainder of the process).
// The resolver memoizes on its ENV inputs only — correct in production where
// the fork bit folds at build and never flips mid-process; the sim flip here
// must clear that cache (and pin MERCURY_HOME) or leg 2's cached foreign home
// would leak into the fork legs.
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = { VERSION: '1.0.0' }
const envUtils = (await import('../../src/utils/envUtils.js')) as typeof import('../../src/utils/envUtils.js')
const prevMercuryHome = process.env.MERCURY_HOME
const prevMercuryConfigDir = process.env.MERCURY_CONFIG_DIR
// the pooled gate exports the home spellings — they outrank the legs this
// prover drives (the second-eyes adjudication class)
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CONFIG_DIR
;(envUtils.getMercuryHome as unknown as { cache: { clear?: () => void } }).cache.clear?.()
// The launcher exports MERCURY_CONFIG_DIR=<its own resolution>. Pin the
// explicit leg to the resolver's OWN env-less answer, never a hardcoded home.
const resolvedDefaultHome = envUtils.getMercuryHome()
const svcForkEnvless = svcFor(undefined)
const svcForkExplicit = svcFor(resolvedDefaultHome)
check(svcForkEnvless === svcForkExplicit,
  `fork: env-less and explicit MERCURY_CONFIG_DIR=${resolvedDefaultHome} (the resolver's own answer) share ONE service (${svcForkEnvless.slice(-10)}) — no re-login between launcher and env-less runs`)
check(/-[0-9a-f]{8}$/.test(svcForkEnvless), 'a non-default home is suffix-keyed (credential identity split impossible)')
// The literal default path is this law's INPUT (the un-suffixed entry is keyed
// on exactly that spelling) — a string-only derivation; nothing under that
// directory is read or written.
const svcForkStock = svcFor(join(homedir(), '.claude'))
check(!/-[0-9a-f]{8}$/.test(svcForkStock), 'fork run explicitly on ~/.claude keeps the un-suffixed service (deliberate foreign-home runs keep working)')

if (prevEnv === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = prevEnv
if (prevMercuryHome !== undefined) process.env.MERCURY_HOME = prevMercuryHome
if (prevMercuryConfigDir !== undefined) process.env.MERCURY_CONFIG_DIR = prevMercuryConfigDir

console.log(failures === 0 ? '✅ account isolation GREEN' : `❌ account isolation RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
