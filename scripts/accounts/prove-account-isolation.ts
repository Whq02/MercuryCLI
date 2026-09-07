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
  delete process.env.MERCURY_CONFIG_DIR
  delete process.env.MERCURY_HOME
  if (dir === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = dir
  return helpers.getMacOsKeychainStorageServiceName()
}

const svcA = svcFor('/tmp/acct-iso-homeA')
const svcB = svcFor('/tmp/acct-iso-homeB')
check(svcA !== svcB, `two homes ⇒ two keychain services (${svcA.slice(-10)} vs ${svcB.slice(-10)})`)
check(/-[0-9a-f]{8}$/.test(svcA) && /-[0-9a-f]{8}$/.test(svcB), 'non-default homes carry the 8-hex dir-hash suffix')

check(svcFor('/tmp/acct-iso-homeA') === svcA, 'same home ⇒ same service (stable)')

const svcUnset = svcFor(undefined)
check(/-[0-9a-f]{8}$/.test(svcUnset), 'env-less run carries Mercury\'s suffixed service (stamp-independent)')

const composed = '/tmp/acct-iso-café'
const decomposed = '/tmp/acct-iso-café'
check(svcFor(composed) === svcFor(decomposed), 'NFC: composed/decomposed path spellings hash to one service')

;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = { VERSION: '1.0.0' }
const envUtils = (await import('../../src/utils/envUtils.js')) as typeof import('../../src/utils/envUtils.js')
const prevMercuryHome = process.env.MERCURY_HOME
const prevMercuryConfigDir = process.env.MERCURY_CONFIG_DIR
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CONFIG_DIR
;(envUtils.getMercuryHome as unknown as { cache: { clear?: () => void } }).cache.clear?.()
const resolvedDefaultHome = envUtils.getMercuryHome()
const svcForkEnvless = svcFor(undefined)
const svcForkExplicit = svcFor(resolvedDefaultHome)
check(svcForkEnvless === svcForkExplicit,
  `fork: env-less and explicit MERCURY_CONFIG_DIR=${resolvedDefaultHome} (the resolver's own answer) share ONE service (${svcForkEnvless.slice(-10)}) — no re-login between launcher and env-less runs`)
check(/-[0-9a-f]{8}$/.test(svcForkEnvless), 'a non-default home is suffix-keyed (credential identity split impossible)')
const svcForkStock = svcFor(join(homedir(), '.claude'))
check(/-[0-9a-f]{8}$/.test(svcForkStock), 'a run pinned to a foreign-named home is hashed like any other (one law, no bare entry)')

if (prevEnv === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = prevEnv
if (prevMercuryHome !== undefined) process.env.MERCURY_HOME = prevMercuryHome
if (prevMercuryConfigDir !== undefined) process.env.MERCURY_CONFIG_DIR = prevMercuryConfigDir

console.log(failures === 0 ? '✅ account isolation GREEN' : `❌ account isolation RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
