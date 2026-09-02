#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-keychain-never-touched.ts — a proof never touches
//  the operator's OS keychain, reads or writes.
//
//  MERCURY_CREDENTIAL_STORE=file is the ONE rule every `security` spawn
//  honours (secureStorage/macOsKeychainHelpers.keychainReachable): the store
//  factory, the boot prefetch, the backend's own reads/writes/deletes, the
//  legacy API-key read/write/delete and the lock probe. With the real tool
//  SHIMMED on PATH — a script that logs its argv and fails loudly — every
//  credential road runs in a scratch home and the shim is never reached.
//
//    §1 the rule: the file store under the seam; keychainReachable false
//    §2 in-process roads under the seam — the prefetch, the store's read /
//       update / async read / field removal, the backend held directly, the
//       legacy managed-key read / save / remove, the lock probe: the shim
//       stays untouched, and the saved key lands in the scratch home's
//       config, never in a keychain
//    §3 the built artifact boots under the seam (doctor --json): untouched
//    §4 CONTROL (darwin): the prefetch WITHOUT the seam reaches the shim —
//       the shim intercepts, the rule discriminates; off darwin the rule is
//       false regardless and the control is a named skip
//    §5 structure: every `security` spawn site in src names the rule
//
//  Run: ~/.bun/bin/bun run scripts/accounts/prove-keychain-never-touched.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'keychain-never-touched-'))
const BIN = join(SCRATCH, 'bin')
const HOME = join(SCRATCH, 'home')
const LOG = join(SCRATCH, 'security-invocations.log')
mkdirSync(BIN, { recursive: true })
mkdirSync(HOME, { recursive: true })

// The shim: first on PATH, so every bare `security` spawn lands here. It
// records its argv and fails loudly — a reached keychain tool is a red line
// in the log, never a silent miss.
const SHIM = join(BIN, 'security')
writeFileSync(
  SHIM,
  `#!/bin/sh\nprintf '%s\\n' "$*" >> '${LOG}'\necho "prove-keychain-never-touched: the keychain tool was reached: $*" >&2\nexit 1\n`,
)
chmodSync(SHIM, 0o755)
process.env.PATH = `${BIN}:${process.env.PATH ?? ''}`

// The proof's own environment, pinned BEFORE any src import: a scratch home,
// the file-backed store, no env credential shadowing the stores under proof,
// and the bun-side NODE_ENV/CI rule the sibling provers keep.
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const name of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_API_KEY_FILE_DESCRIPTOR',
  'MERCURY_SIMPLE',
  'CI',
  'NODE_ENV',
]) {
  delete process.env[name]
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const invocations = (): string[] =>
  existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []
const untouched = (label: string): void =>
  check(`${label}: the keychain tool was never reached`, invocations().length === 0, invocations().join(' | '))

// ── §1 the rule ─────────────────────────────────────────────────────────────
section('§1 — under the seam the store is the file store and the keychain is unreachable')
const store = await import('../../src/utils/secureStorage/index.ts')
check('keychainReachable() is false under MERCURY_CREDENTIAL_STORE=file', store.keychainReachable() === false)
check('getSecureStorage() is the file store itself', store.getSecureStorage() === store.plainTextStorage)

// ── §2 in-process roads ─────────────────────────────────────────────────────
section('§2 — every in-process credential road under the seam, reads and writes')
store.startKeychainPrefetch()
await store.ensureKeychainPrefetchCompleted()
untouched('the boot prefetch')

const s = store.getSecureStorage()
s.read()
check('the store accepts a write into the scratch home', s.update({ trustedDeviceToken: 'fixture-device-token' }).success === true)
await s.readAsync()
store.removeSecureStorageField('trustedDeviceToken')
untouched('the store read / update / async read / field removal')

check('the backend held DIRECTLY reads a miss under the seam', store.macOsKeychainStorage.read() === null)
check('…its async read too', (await store.macOsKeychainStorage.readAsync()) === null)
check('…its write is refused, never spawned', store.macOsKeychainStorage.update({ trustedDeviceToken: 'x' }).success === false)
check('…its delete reports failure, never spawned', store.macOsKeychainStorage.delete() === false)
check('the lock probe answers unlocked without a spawn', store.isMacOsKeychainLocked() === false)
untouched('the backend held directly + the lock probe')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const auth = await import('../../src/utils/auth.ts')
check('the managed-key read answers none in a fresh scratch home', auth.getApiKeyFromConfigOrMacOSKeychain() === null)
const KEY = 'fixture-key-never-touched'
await auth.saveApiKey(KEY)
auth.getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
check('the saved managed key answers from the scratch home config — off the keychain', auth.getApiKeyFromConfigOrMacOSKeychain() === KEY)
const configFiles = spawnSync('grep', ['-rl', KEY, HOME], { encoding: 'utf8' })
check('the key is on disk under the scratch home (the file estate, not a keychain entry)', (configFiles.stdout ?? '').trim() !== '')
await auth.removeApiKey()
auth.getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
check('the removed key answers none again', auth.getApiKeyFromConfigOrMacOSKeychain() === null)
untouched('the legacy managed-key read / save / remove')

// ── §3 the built artifact ───────────────────────────────────────────────────
section('§3 — the built artifact boots under the seam and never reaches the keychain tool')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (existsSync(DIST) && nodeBin) {
  const bootHome = mkdtempSync(join(SCRATCH, 'boot-home-'))
  const r = spawnSync(nodeBin, [DIST, 'doctor', '--json'], {
    cwd: SCRATCH,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${BIN}:/usr/bin:/bin:${dirname(nodeBin)}`,
      MERCURY_CONFIG_DIR: bootHome,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_DAEMON_DIR: join(bootHome, 'daemon'),
      MERCURY_TEAMS_DIR: join(bootHome, 'teams'),
    },
  })
  check('the artifact booted to a certificate (doctor --json emitted JSON)', (r.stdout ?? '').trimStart().startsWith('{'), (r.stderr ?? '').slice(0, 200))
  untouched('the artifact boot (module-evaluation prefetch included)')
} else {
  console.log('  – [SKIP] dist/mercury.mjs or node absent — the artifact leg needs the prebuilt dist (the pooled gate prebuilds it)')
}

// ── §4 the control ──────────────────────────────────────────────────────────
section('§4 — CONTROL: without the seam the prefetch reaches the shim (darwin); off darwin the rule is false regardless')
const DRIVER = join(SCRATCH, 'control.ts')
writeFileSync(
  DRIVER,
  [
    ";(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }",
    `const m = await import(${JSON.stringify(join(ROOT, 'src/utils/secureStorage/index.ts'))})`,
    'm.startKeychainPrefetch()',
    'await m.ensureKeychainPrefetchCompleted()',
    "console.log(JSON.stringify({ reachable: m.keychainReachable(), platform: process.platform }))",
    '',
  ].join('\n'),
)
{
  const controlHome = mkdtempSync(join(SCRATCH, 'control-home-'))
  const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: controlHome }
  delete env.MERCURY_CREDENTIAL_STORE
  const before = invocations().length
  const r = spawnSync(process.execPath, ['run', DRIVER], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env })
  let parsed: { reachable?: boolean; platform?: string } = {}
  try {
    parsed = JSON.parse((r.stdout ?? '').trim().split('\n').pop() ?? '{}') as typeof parsed
  } catch {
    /* asserted below */
  }
  check('the control child ran', r.status === 0 && typeof parsed.reachable === 'boolean', (r.stderr ?? '').slice(0, 300))
  if (parsed.platform === 'darwin') {
    check('without the seam the rule says reachable', parsed.reachable === true)
    const reached = invocations().slice(before)
    check(
      'the prefetch reached the shim — the shim intercepts and the rule discriminates',
      reached.some(line => line.includes('find-generic-password')),
      reached.join(' | ') || '(no invocation logged)',
    )
  } else {
    check('off darwin the rule is false regardless of the seam', parsed.reachable === false)
    console.log('  – [SKIP] the darwin control leg — the shim is reached only where a keychain exists')
  }
}

// ── §5 structure ────────────────────────────────────────────────────────────
section('§5 — every `security` spawn site in src names the rule')
{
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'src'], { cwd: ROOT, encoding: 'utf8' })
  const files = (listed.stdout ?? '').split('\0').filter(f => /\.(ts|tsx)$/.test(f))
  const SPAWN = /(?:spawnSync|spawn|execFileSync|execFile|execFileNoThrow)\(\s*['"]security['"]/
  const spawners = files.filter(f => SPAWN.test(readFileSync(join(ROOT, f), 'utf8'))).sort()
  const EXPECTED = [
    'src/utils/auth.ts',
    'src/utils/authPortable.ts',
    'src/utils/secureStorage/keychainPrefetch.ts',
    'src/utils/secureStorage/macOsKeychainStorage.ts',
  ]
  check(
    'the keychain tool is spawned from exactly the four known roads',
    JSON.stringify(spawners) === JSON.stringify(EXPECTED),
    spawners.join(', '),
  )
  for (const f of spawners) {
    check(`${f} consults keychainReachable()`, readFileSync(join(ROOT, f), 'utf8').includes('keychainReachable('))
  }
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ the keychain was never touched')
  process.exit(0)
}
console.log(` ❌ ${failures} FAILED`)
process.exit(1)
