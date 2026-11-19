#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const envUtils = await import('../../src/utils/envUtils.js')
const home = homedir()
type Memoized = { cache: { clear?: () => void } }
const reset = (): void => {
  ;(envUtils.getMercuryHome as unknown as Memoized).cache.clear?.()
}
const setStamp = (on: boolean): void => {
  if (on) (globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>).MACRO
}
const probe = (fork: boolean, ccd: string | undefined, mh: string | undefined): string => {
  setStamp(fork)
  if (ccd === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = ccd
  if (mh === undefined) delete process.env.MERCURY_HOME
  else process.env.MERCURY_HOME = mh
  reset()
  return envUtils.getMercuryHome()
}

const saved = { mcd: process.env.MERCURY_CONFIG_DIR, mh: process.env.MERCURY_HOME }
const mercuryDefault = join(home, '.mercury').normalize('NFC')

console.log('\nsovereign config home — truth table (stamp-independent)')
check('explicit env wins (version stamp)', probe(true, '/tmp/explicit-a', '/tmp/mh') === '/tmp/explicit-a')
check('explicit env wins (bare stamp — same behavior)', probe(false, '/tmp/explicit-b', undefined) === '/tmp/explicit-b')
check('unset + MERCURY_HOME → MERCURY_HOME', probe(true, undefined, '/tmp/mercury-home') === '/tmp/mercury-home')
const envlessDefault = probe(true, undefined, undefined)
check('unset → ~/.mercury (the one default, whatever else exists beside it)', envlessDefault === mercuryDefault, envlessDefault)
check("unset → never the default's ~/.claude", envlessDefault !== join(home, '.claude').normalize('NFC'), envlessDefault)
check('bare stamp + unset → the same default (stamp-independence)', probe(false, undefined, undefined) === envlessDefault)
check('memoize keys on BOTH env inputs (flip MERCURY_HOME re-resolves)', probe(true, undefined, '/tmp/mh2') === '/tmp/mh2')

console.log('\nkeychain identity follows the RESOLVED home (fork)')
const kc = await import('../../src/utils/secureStorage/macOsKeychainHelpers.js')
const svc = (fork: boolean, ccd: string | undefined, mh: string | undefined): string => {
  probe(fork, ccd, mh)
  return kc.getMacOsKeychainStorageServiceName()
}
const launcherSvc = svc(true, envlessDefault, undefined)
const envlessSvc = svc(true, undefined, undefined)
check('launcher (env=resolved default) and env-less fork share ONE service', launcherSvc === envlessSvc, `${launcherSvc} vs ${envlessSvc}`)
check('the Mercury service is suffixed (never the foreign bare entry)', /-[0-9a-f]{8}$/.test(envlessSvc), envlessSvc)
check('an explicit foreign-named home is hashed like every other home (no bare service anywhere)', /-[0-9a-f]{8}$/.test(svc(true, join(home, '.claude'), undefined)))
check('bare stamp env-less service is Mercury\'s (suffixed, stamp-independence)', svc(false, undefined, undefined) === envlessSvc)
check('bare stamp + an explicit foreign-named home is hashed too (resolved-home keying)', /-[0-9a-f]{8}$/.test(svc(false, join(home, '.claude'), undefined)))

console.log('\nhealth coherence keys on the AUTH home (a foreign slot is not a split)')
{
  probe(true, undefined, undefined)
  envUtils.setAuthScope(join(home, '.claude'))
  try {
    const slottedSvc = kc.getMacOsKeychainStorageServiceName()
    check('a foreign-named auth slot is hashed too — one law, every home', /-[0-9a-f]{8}$/.test(slottedSvc), slottedSvc)
    const flagged = !/-[0-9a-f]{8}$/.test(slottedSvc)
    check('the auth-home-keyed predicate flags nothing for a hashed slot', !flagged)
    check('…while the session home stays ~/.mercury (never ~/.claude)', envUtils.getMercuryHome() === mercuryDefault, envUtils.getMercuryHome())
  } finally {
    envUtils.clearAuthScope()
  }
  const restAuthHome = envUtils.getAuthConfigHomeDir()
  check('at rest the auth home is the resolved session home', restAuthHome === envUtils.getMercuryHome())
  check('at rest the env-less service is suffixed (the split test still bites on a bare one)', /-[0-9a-f]{8}$/.test(kc.getMacOsKeychainStorageServiceName()))
  const rowHome = probe(true, saved.mcd ?? (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'config-home-row-')), undefined)
  const { crewChecks } = await import('../../src/utils/health/sections/crew.js')
  const configHomeRow = crewChecks().find(row => row.id === 'config-home')
  const atRest = await configHomeRow?.run()
  check('health config-home keys the keychain test on getAuthConfigHomeDir()', atRest?.status === 'ok' && atRest.evidence.startsWith(`${rowHome} via explicit MERCURY_CONFIG_DIR · keychain …${kc.getMacOsKeychainStorageServiceName().slice(-12)}`) && !atRest.evidence.includes('auth scope slotted'), atRest?.evidence)
  envUtils.setAuthScope(join(home, '.claude'))
  let slotted: { status: string; evidence: string } | undefined
  let slotHome = ''
  try {
    slotHome = envUtils.getAuthConfigHomeDir()
    slotted = await configHomeRow?.run()
  } finally {
    envUtils.clearAuthScope()
  }
  check('/health carries no foreign-home arm', slotted?.status === 'ok', slotted?.evidence)
  check('a live slot is NAMED in the ok evidence, never flagged', slotted?.status === 'ok' && slotted.evidence.includes(`auth scope slotted → ${slotHome}`), slotted?.evidence)
  const { mock } = await import('bun:test')
  const keychainPath = join(ROOT, 'src', 'utils', 'secureStorage', 'macOsKeychainHelpers.ts')
  const keychain = { ...(await import(keychainPath)) }
  mock.module(keychainPath, () => ({ ...keychain, getMacOsKeychainStorageServiceName: () => 'Mercury' }))
  envUtils.setAuthScope(join(home, '.claude'))
  let split: { status: string; evidence: string; fix?: string } | undefined
  let splitHome = ''
  try {
    splitHome = envUtils.getAuthConfigHomeDir()
    split = await configHomeRow?.run()
  } finally {
    envUtils.clearAuthScope()
    mock.module(keychainPath, () => keychain)
  }
  check(
    'a keychain service that carries no home suffix (the owner stubbed to answer a bare name) fails the row: it names the auth home the service is un-suffixed for, not the session home, and says where to report it',
    split?.status === 'fail' && splitHome !== envUtils.getMercuryHome() && split.evidence === `keychain service 'Mercury' is UN-suffixed for the auth home ${splitHome} — credential identity split` && split.fix === 'The config home resolved two ways — report this with `mercury health --json`.',
    `${split?.status}: ${split?.evidence}`,
  )
  probe(true, undefined, undefined)
}


if (process.platform !== 'win32') {
  const { mkdtempSync, rmSync, statSync: st, mkdirSync: mkd, chmodSync: chm } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const scratchRoot = mkdtempSync(join(tmpdir(), 'cfg-home-priv-'))
  const freshHome = join(scratchRoot, 'fresh-home')
  probe(true, freshHome, undefined)
  envUtils.ensurePrivateConfigHome()
  check('fresh home created 0700', (st(freshHome).mode & 0o777) === 0o700)
  const looseHome = join(scratchRoot, 'loose-home')
  mkd(looseHome)
  chm(looseHome, 0o755)
  probe(true, looseHome, undefined)
  envUtils.ensurePrivateConfigHome()
  check('existing 0755 home tightened to 0700', (st(looseHome).mode & 0o777) === 0o700)
  const { builtCli } = await import('../lib/builtProduct.ts')
  const bootHome = join(scratchRoot, 'boot-home')
  mkd(bootHome)
  chm(bootHome, 0o755)
  const booted = builtCli(['--no-commands', 'version'], { env: { MERCURY_CONFIG_DIR: bootHome } })
  check('main() calls ensurePrivateConfigHome at boot', booted.status === 0 && (st(bootHome).mode & 0o777) === 0o700)
  rmSync(scratchRoot, { recursive: true, force: true })
}

if (saved.mcd === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = saved.mcd
if (saved.mh === undefined) delete process.env.MERCURY_HOME
else process.env.MERCURY_HOME = saved.mh
reset()

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('✅ config home — ALL CHECKS PASS')
