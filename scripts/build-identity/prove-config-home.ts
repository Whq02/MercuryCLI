#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', fixHint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond && fixHint) console.log(`      to fix: ${fixHint}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const envUtils = await import('../../src/platform/environment/envUtils.js')
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
check('explicit env wins (version stamp)', probe(true, '/tmp/explicit-a', '/tmp/mh') === '/tmp/explicit-a', '', 'getMercuryHome in src/platform/environment/envUtils.ts must return MERCURY_CONFIG_DIR before MERCURY_HOME')
check('explicit env wins (bare stamp — same behavior)', probe(false, '/tmp/explicit-b', undefined) === '/tmp/explicit-b', '', 'getMercuryHome in src/platform/environment/envUtils.ts must not depend on the MACRO version stamp')
check('unset + MERCURY_HOME → MERCURY_HOME', probe(true, undefined, '/tmp/mercury-home') === '/tmp/mercury-home', '', 'getMercuryHome in src/platform/environment/envUtils.ts must fall back to MERCURY_HOME when MERCURY_CONFIG_DIR is unset')
const envlessDefault = probe(true, undefined, undefined)
check('unset → ~/.mercury (the one default, whatever else exists beside it)', envlessDefault === mercuryDefault, envlessDefault, 'defaultMercuryHome in src/platform/environment/envUtils.ts must be the only default, ~/.mercury')
check("unset → never the default's ~/.claude", envlessDefault !== join(home, '.claude').normalize('NFC'), envlessDefault, 'getMercuryHome in src/platform/environment/envUtils.ts must never resolve to ~/.claude')
check('bare stamp + unset → the same default (stamp-independence)', probe(false, undefined, undefined) === envlessDefault, '', 'getMercuryHome in src/platform/environment/envUtils.ts must give the same default with and without the version stamp')
check('memoize keys on BOTH env inputs (flip MERCURY_HOME re-resolves)', probe(true, undefined, '/tmp/mh2') === '/tmp/mh2', '', 'the memoize key of getMercuryHome in src/platform/environment/envUtils.ts must include both MERCURY_CONFIG_DIR and MERCURY_HOME')

console.log('\nkeychain identity follows the RESOLVED home (fork)')
const kc = await import('../../src/platform/secure-storage/macOsKeychainHelpers.js')
const svc = (fork: boolean, ccd: string | undefined, mh: string | undefined): string => {
  probe(fork, ccd, mh)
  return kc.getMacOsKeychainStorageServiceName()
}
const launcherSvc = svc(true, envlessDefault, undefined)
const envlessSvc = svc(true, undefined, undefined)
check('launcher (env=resolved default) and env-less fork share ONE service', launcherSvc === envlessSvc, `${launcherSvc} vs ${envlessSvc}`, 'getMacOsKeychainStorageServiceName in src/platform/secure-storage/macOsKeychainHelpers.ts must derive the service from the resolved home')
check('the Mercury service is suffixed (never the foreign bare entry)', /-[0-9a-f]{8}$/.test(envlessSvc), envlessSvc, 'getMacOsKeychainStorageServiceName in src/platform/secure-storage/macOsKeychainHelpers.ts must append the 8-hex home suffix')
check('an explicit foreign-named home is hashed like every other home (no bare service anywhere)', /-[0-9a-f]{8}$/.test(svc(true, join(home, '.claude'), undefined)), '', 'getMacOsKeychainStorageServiceName in src/platform/secure-storage/macOsKeychainHelpers.ts must hash every home, including a ~/.claude one')
check('bare stamp env-less service is Mercury\'s (suffixed, stamp-independence)', svc(false, undefined, undefined) === envlessSvc, '', 'getMacOsKeychainStorageServiceName in src/platform/secure-storage/macOsKeychainHelpers.ts must not depend on the MACRO version stamp')
check('bare stamp + an explicit foreign-named home is hashed too (resolved-home keying)', /-[0-9a-f]{8}$/.test(svc(false, join(home, '.claude'), undefined)), '', 'getMacOsKeychainStorageServiceName in src/platform/secure-storage/macOsKeychainHelpers.ts must hash a foreign-named home with or without the stamp')

console.log('\nhealth coherence keys on the AUTH home (a foreign slot is not a split)')
{
  probe(true, undefined, undefined)
  envUtils.setAuthScope(join(home, '.claude'))
  try {
    const slottedSvc = kc.getMacOsKeychainStorageServiceName()
    check('a foreign-named auth slot is hashed too — one law, every home', /-[0-9a-f]{8}$/.test(slottedSvc), slottedSvc, 'getMacOsKeychainStorageServiceName in src/platform/secure-storage/macOsKeychainHelpers.ts must hash the auth-scope home too')
    const flagged = !/-[0-9a-f]{8}$/.test(slottedSvc)
    check('the auth-home-keyed predicate flags nothing for a hashed slot', !flagged)
    check('…while the session home stays ~/.mercury (never ~/.claude)', envUtils.getMercuryHome() === mercuryDefault, envUtils.getMercuryHome(), 'setAuthScope in src/platform/environment/envUtils.ts must not change what getMercuryHome returns')
  } finally {
    envUtils.clearAuthScope()
  }
  const restAuthHome = envUtils.getAuthConfigHomeDir()
  check('at rest the auth home is the resolved session home', restAuthHome === envUtils.getMercuryHome(), '', 'getAuthConfigHomeDir in src/platform/environment/envUtils.ts must return the session home when no auth scope is set; check clearAuthScope')
  check('at rest the env-less service is suffixed (the split test still bites on a bare one)', /-[0-9a-f]{8}$/.test(kc.getMacOsKeychainStorageServiceName()), '', 'getMacOsKeychainStorageServiceName in src/platform/secure-storage/macOsKeychainHelpers.ts must append the home suffix once the auth scope is cleared')
  const rowHome = probe(true, saved.mcd ?? (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'config-home-row-')), undefined)
  const { crewChecks } = await import('../../src/platform/health/sections/crew.js')
  const configHomeRow = crewChecks().find(row => row.id === 'config-home')
  const atRest = await configHomeRow?.run()
  check('health config-home keys the keychain test on getAuthConfigHomeDir()', atRest?.status === 'ok' && atRest.evidence.startsWith(`${rowHome} via explicit MERCURY_CONFIG_DIR · keychain …${kc.getMacOsKeychainStorageServiceName().slice(-12)}`) && !atRest.evidence.includes('auth scope slotted'), atRest?.evidence, 'the config-home row in src/platform/health/sections/crew/home.ts must report the ok evidence in the form shown above')
  envUtils.setAuthScope(join(home, '.claude'))
  let slotted: { status: string; evidence: string } | undefined
  let slotHome = ''
  try {
    slotHome = envUtils.getAuthConfigHomeDir()
    slotted = await configHomeRow?.run()
  } finally {
    envUtils.clearAuthScope()
  }
  check('/health carries no foreign-home arm', slotted?.status === 'ok', slotted?.evidence, 'the config-home row in src/platform/health/sections/crew/home.ts must stay ok under a live auth scope')
  check('a live slot is NAMED in the ok evidence, never flagged', slotted?.status === 'ok' && slotted.evidence.includes(`auth scope slotted → ${slotHome}`), slotted?.evidence, 'the config-home row in src/platform/health/sections/crew/home.ts must name the slotted auth home in its ok evidence')
  const { mock } = await import('bun:test')
  const keychainPath = join(ROOT, 'src', 'platform', 'secure-storage', 'macOsKeychainHelpers.ts')
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
    'the config-home row in src/platform/health/sections/crew/home.ts must fail with the un-suffixed evidence and fix text shown in the condition',
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
  check('fresh home created 0700', (st(freshHome).mode & 0o777) === 0o700, '', 'ensurePrivateConfigHome in src/platform/environment/envUtils.ts must create a missing home with mode 0700')
  const looseHome = join(scratchRoot, 'loose-home')
  mkd(looseHome)
  chm(looseHome, 0o755)
  probe(true, looseHome, undefined)
  envUtils.ensurePrivateConfigHome()
  check('existing 0755 home tightened to 0700', (st(looseHome).mode & 0o777) === 0o700, '', 'ensurePrivateConfigHome in src/platform/environment/envUtils.ts must chmod an existing home to 0700')
  const { builtCli } = await import('../lib/builtProduct.ts')
  const bootHome = join(scratchRoot, 'boot-home')
  mkd(bootHome)
  chm(bootHome, 0o755)
  const booted = builtCli(['--no-commands', 'version'], { env: { MERCURY_CONFIG_DIR: bootHome } })
  check('main() calls ensurePrivateConfigHome at boot', booted.status === 0 && (st(bootHome).mode & 0o777) === 0o700, '', 'main in src/boot/main.tsx must call ensurePrivateConfigHome at boot; the built CLI also must exit 0 for --no-commands version')
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
