#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

function runScenario(
  body: string,
  options: { extraEnv?: Record<string, string | undefined>; fakeSecurityScript?: string } = {},
): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w05-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const bin = join(scratch, 'bin')
  if (options.fakeSecurityScript !== undefined) {
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'security'), options.fakeSecurityScript)
    chmodSync(join(bin, 'security'), 0o755)
  }
  const useKeychain = options.fakeSecurityScript !== undefined
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    ${useKeychain ? 'delete process.env.MERCURY_CREDENTIAL_STORE' : "process.env.MERCURY_CREDENTIAL_STORE = 'file'"}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SCRATCH = ${JSON.stringify(scratch)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  const env: Record<string, string | undefined> = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_HOME: '',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ...(useKeychain ? { MERCURY_CREDENTIAL_STORE: undefined, PATH: `${bin}:${process.env.PATH ?? ''}` } : { MERCURY_CREDENTIAL_STORE: 'file' }),
    ...(options.extraEnv ?? {}),
  }
  if (env.MERCURY_CREDENTIAL_STORE === undefined) delete env.MERCURY_CREDENTIAL_STORE
  try {
    const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env, timeout: 30_000 })
    if (res.status !== 0) throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1500)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nw05-1 — keychain and credentialStoreUnread distinguish absent from failed reads')
if (process.platform !== 'darwin') {
  skip('w05-1 keychain scenarios', 'macOS keychain backend only runs on darwin')
} else {
  const securityScript = `#!/bin/sh
STATE="$MERCURY_CONFIG_DIR/sec-mode"
MODE="absent"
if [ -f "$STATE" ]; then MODE=$(cat "$STATE"); fi
case "$MODE" in
  locked) echo "security: SecKeychainSearchCopyNext: User interaction is not allowed." >&2; exit 36 ;;
  corrupt) echo '{ "claudeAiOauth": "fake-secret-value-not-json'; exit 0 ;;
  ok) echo '{"claudeAiOauth":{"accessToken":"fake-at-1","refreshToken":"fake-rt-1","expiresAt":4102444800000,"scopes":["user:inference"]}}'; exit 0 ;;
  *) exit 44 ;;
esac
`
  const r = runScenario(
    `
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const debugLogs = []
    mock.module(path.join(SRC, 'utils/debug.js'), () => ({
      logForDebugging: (msg) => { debugLogs.push(String(msg)) },
      isDebugMode: () => false,
      getDebugLogPath: () => '',
    }))
    const ss = await import(path.join(SRC, 'utils/secureStorage/index.ts'))
    const auth = await import(path.join(SRC, 'utils/auth.ts'))
    const modeFile = path.join(HOME, 'sec-mode')

    fs.writeFileSync(modeFile, 'absent')
    ss.clearKeychainCache()
    out.absentRead = ss.macOsKeychainStorage.read()
    out.absentUnread = ss.credentialStoreUnread()

    fs.writeFileSync(modeFile, 'locked')
    ss.clearKeychainCache()
    out.lockedRead1 = ss.macOsKeychainStorage.read()
    out.lockedUnread1 = ss.credentialStoreUnread()
    const logsAfter1 = debugLogs.filter(l => l.includes('keychain could not be read')).length
    ss.clearKeychainCache()
    out.lockedRead2 = ss.macOsKeychainStorage.read()
    const logsAfter2 = debugLogs.filter(l => l.includes('keychain could not be read')).length
    out.lockedLogDelta = logsAfter2 - logsAfter1
    out.lockedLogsCount = logsAfter1

    fs.writeFileSync(modeFile, 'corrupt')
    ss.clearKeychainCache()
    out.corruptRead = ss.macOsKeychainStorage.read()
    out.corruptUnread = ss.credentialStoreUnread()
    out.corruptLeaked = JSON.stringify({ u: out.corruptUnread, l: debugLogs }).includes('fake-secret-value-not-json')

    fs.writeFileSync(modeFile, 'ok')
    ss.clearKeychainCache()
    out.recoveredRead = ss.macOsKeychainStorage.read()?.claudeAiOauth?.accessToken ?? null
    out.recoveredUnread = ss.credentialStoreUnread()

    fs.writeFileSync(modeFile, 'locked')
    ss.clearKeychainCache()
    out.asyncLockedRead = await ss.macOsKeychainStorage.readAsync()
    out.asyncLockedUnread = ss.credentialStoreUnread()

    fs.writeFileSync(modeFile, 'ok')
    ss.clearKeychainCache()
    out.asyncRecoveredRead = (await ss.macOsKeychainStorage.readAsync())?.claudeAiOauth?.accessToken ?? null
    out.asyncRecoveredUnread = ss.credentialStoreUnread()

    fs.writeFileSync(modeFile, 'locked')
    auth.clearOAuthTokenCache()
    out.authTokens = auth.getClaudeAIOAuthTokens()
    out.authTokensAsync = await auth.getClaudeAIOAuthTokensAsync()
    out.authHas = auth.hasStoredOAuthToken()
    out.authUnread = ss.credentialStoreUnread()
    `,
    { fakeSecurityScript: securityScript },
  )
  check('w05-1: exit 44 (absent) returns null and credentialStoreUnread is null', r.absentRead === null && r.absentUnread === null, JSON.stringify({ r: r.absentRead, u: r.absentUnread }))
  const lu = r.lockedUnread1 as { code?: string; warning?: string } | null
  check('w05-1: locked keychain (exit 36) returns null and sets credentialStoreUnread', r.lockedRead1 === null && lu !== null && lu.code === 'KEYCHAIN_LOCKED', JSON.stringify(lu))
  check('w05-1: repeated identical keychain failure logs once, not on every read', r.lockedLogsCount === 1 && r.lockedLogDelta === 0, JSON.stringify({ count: r.lockedLogsCount, delta: r.lockedLogDelta }))
  const cu = r.corruptUnread as { code?: string; warning?: string } | null
  check('w05-1: non-JSON keychain content sets credentialStoreUnread without leaking raw secret', r.corruptRead === null && cu !== null && cu.code === 'KEYCHAIN_CORRUPT' && r.corruptLeaked === false, JSON.stringify({ cu, leaked: r.corruptLeaked }))
  check('w05-1: next successful read clears credentialStoreUnread', r.recoveredRead === 'fake-at-1' && r.recoveredUnread === null, JSON.stringify({ read: r.recoveredRead, u: r.recoveredUnread }))
  const alu = r.asyncLockedUnread as { code?: string } | null
  check('w05-1: readAsync locked sets credentialStoreUnread and async recovery clears it', r.asyncLockedRead === null && alu !== null && alu.code === 'KEYCHAIN_LOCKED' && r.asyncRecoveredRead === 'fake-at-1' && r.asyncRecoveredUnread === null, JSON.stringify({ alu, rec: r.asyncRecoveredRead, recU: r.asyncRecoveredUnread }))
  const au = r.authUnread as { code?: string } | null
  check('w05-1: auth OAuth readers keep null/false on locked keychain while credentialStoreUnread stays set', r.authTokens === null && r.authTokensAsync === null && r.authHas === false && au !== null && au.code === 'KEYCHAIN_LOCKED', JSON.stringify({ t: r.authTokens, ta: r.authTokensAsync, h: r.authHas, au }))
}

{
  const r = runScenario(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const real = await import(path.join(SRC, 'utils/secureStorage/index.ts'))
    let shouldThrow = true
    mock.module(path.join(SRC, 'utils/secureStorage/index.js'), () => ({
      ...real,
      getSecureStorage: () => ({
        name: 'throwing-mock',
        read() {
          if (shouldThrow) throw new Error('store boom sync')
          return { claudeAiOauth: { accessToken: 'fake-at-ok', refreshToken: null, expiresAt: null, scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null } }
        },
        async readAsync() {
          if (shouldThrow) throw new Error('store boom async')
          return { claudeAiOauth: { accessToken: 'fake-at-ok', refreshToken: null, expiresAt: null, scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null } }
        },
        update() { return { success: false } },
        delete() { return false },
      }),
    }))
    const auth = await import(path.join(SRC, 'utils/auth.ts'))
    out.syncNull = auth.getClaudeAIOAuthTokens()
    out.unreadAfterSyncThrow = real.credentialStoreUnread()
    auth.clearOAuthTokenCache()
    out.asyncNull = await auth.getClaudeAIOAuthTokensAsync()
    out.unreadAfterAsyncThrow = real.credentialStoreUnread()
    out.hasFalse = auth.hasStoredOAuthToken()
    out.unreadAfterHasThrow = real.credentialStoreUnread()
    shouldThrow = false
    auth.clearOAuthTokenCache()
    out.recovered = auth.getClaudeAIOAuthTokens()?.accessToken ?? null
    out.unreadAfterRecover = real.credentialStoreUnread()
  `)
  const uSync = r.unreadAfterSyncThrow as { warning?: string } | null
  const uAsync = r.unreadAfterAsyncThrow as { warning?: string } | null
  const uHas = r.unreadAfterHasThrow as { warning?: string } | null
  check(
    'w05-1: auth OAuth catch sites record unread error without throwing and clear on recovery',
    r.syncNull === null &&
      r.asyncNull === null &&
      r.hasFalse === false &&
      uSync !== null &&
      String(uSync.warning).includes('store boom sync') &&
      uAsync !== null &&
      String(uAsync.warning).includes('store boom async') &&
      uHas !== null &&
      String(uHas.warning).includes('store boom sync') &&
      r.recovered === 'fake-at-ok' &&
      r.unreadAfterRecover === null,
    JSON.stringify(r),
  )
}

if (!POSIX_MODES) {
  skip('w05-1 file store unread', 'mode 0200 needs non-root POSIX')
} else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const ss = await import(path.join(SRC, 'utils/secureStorage/index.ts'))
    const file = ss.credentialsPath()
    fs.writeFileSync(file, JSON.stringify({ trustedDeviceToken: 'fake-dev' }), { mode: 0o600 })
    fs.chmodSync(file, 0o200)
    out.unread = ss.credentialStoreUnread()
    fs.chmodSync(file, 0o600)
    out.recovered = ss.credentialStoreUnread()
  `)
  const u = r.unread as { code?: string; warning?: string } | null
  check('w05-1: file store credentialStoreUnread still reports EACCES with path and clears when readable', u !== null && u.code === 'EACCES' && String(u.warning).includes('.credentials.json') && r.recovered === null, JSON.stringify(r))
}

console.log('\nw05-2 — scopeScan, accountIdentity, anthropicSlots, wallet, saturnAccount surface unread credentials instead of signed-out')
if (!POSIX_MODES) {
  skip('w05-2 unreadable file store', 'mode 0200 needs non-root POSIX')
} else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const ss = await import(path.join(SRC, 'utils/secureStorage/index.ts'))
    const { scanAccountScopes } = await import(path.join(SRC, 'utils/accounts/scopeScan.ts'))
    const { resolveLiveScopeIdentity, _resetIdentityCacheForTesting } = await import(path.join(SRC, 'utils/accounts/accountIdentity.ts'))
    const { anthropicSlots } = await import(path.join(SRC, 'services/providers/accountSlots/anthropic.ts'))
    const { walletEntries, activeWalletEntry, resetWalletEntriesMemo } = await import(path.join(SRC, 'services/wallet/wallet.ts'))
    const { deriveScheduleAccountForModel } = await import(path.join(SRC, 'daemon/saturnAccount.ts'))

    const file = ss.credentialsPath()
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'fake-at-2', refreshToken: 'fake-rt-2', expiresAt: 4102444800000, scopes: ['user:inference'] } }), { mode: 0o600 })
    fs.chmodSync(file, 0o200)

    _resetIdentityCacheForTesting()
    resetWalletEntriesMemo()
    out.scopeUnread = scanAccountScopes()[0]
    out.liveIdentityUnread = await resolveLiveScopeIdentity(HOME)
    out.slotsUnread = anthropicSlots({})
    out.walletUnread = walletEntries().filter(e => e.provider === 'anthropic')
    out.activeUnread = activeWalletEntry('anthropic') ?? null
    out.saturnUnread = deriveScheduleAccountForModel('claude-sonnet-4-6')

    fs.chmodSync(file, 0o600)
    fs.unlinkSync(file)
    _resetIdentityCacheForTesting()
    resetWalletEntriesMemo()
    out.scopeAbsent = scanAccountScopes()[0]
    out.liveIdentityAbsent = await resolveLiveScopeIdentity(HOME)
    out.slotsAbsent = anthropicSlots({})
    out.walletAbsent = walletEntries().filter(e => e.provider === 'anthropic')
    out.saturnAbsent = deriveScheduleAccountForModel('claude-sonnet-4-6')
  `)
  const scopeU = r.scopeUnread as { authed?: boolean; unreadError?: string }
  check('w05-2: scanAccountScopes carries unreadError when store cannot be read', scopeU.authed === false && typeof scopeU.unreadError === 'string' && scopeU.unreadError.includes('EACCES'), JSON.stringify(scopeU))
  const liveU = r.liveIdentityUnread as { state?: string; note?: string }
  check('w05-2: resolveLiveScopeIdentity returns unverified with credentials could not be read (<error>)', liveU.state === 'unverified' && typeof liveU.note === 'string' && liveU.note.startsWith('credentials could not be read ('), JSON.stringify(liveU))
  const slotsU = r.slotsUnread as Array<{ signedIn: boolean; stateNote?: string }>
  check('w05-2: anthropicSlots keeps scope with unverified stateNote instead of dropping it', slotsU.length === 1 && slotsU[0]!.signedIn === false && typeof slotsU[0]!.stateNote === 'string' && slotsU[0]!.stateNote.startsWith('credentials could not be read ('), JSON.stringify(slotsU))
  const walletU = r.walletUnread as Array<{ state?: string; stateNote?: string; label?: string }>
  const activeU = r.activeUnread as { state?: string; stateNote?: string } | null
  check('w05-2: walletEntries and activeWalletEntry carry unverified entry with credentials could not be read (<error>)', walletU.length === 1 && walletU[0]!.state === 'unverified' && String(walletU[0]!.stateNote).startsWith('credentials could not be read (') && activeU?.state === 'unverified', JSON.stringify({ walletU, activeU }))
  const saturnU = r.saturnUnread as { ok: boolean; reason?: string }
  check('w05-2: saturnAccount returns unread:anthropic — the sign-in could not be read (<error>)', saturnU.ok === false && typeof saturnU.reason === 'string' && saturnU.reason.startsWith('unread:anthropic — the sign-in could not be read ('), JSON.stringify(saturnU))
  const scopeA = r.scopeAbsent as { authed?: boolean; unreadError?: string }
  const liveA = r.liveIdentityAbsent as { state?: string }
  const saturnA = r.saturnAbsent as { ok: boolean; reason?: string }
  check('w05-2: absent store control stays signed-out without unread error', scopeA.authed === false && scopeA.unreadError === undefined && liveA.state === 'signed-out' && (r.slotsAbsent as unknown[]).length === 0 && (r.walletAbsent as unknown[]).length === 0 && saturnA.ok === false && String(saturnA.reason).startsWith('no-credential:anthropic'), JSON.stringify({ scopeA, liveA, saturnA }))
}

{
  const r = runScenario(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const po = await import(path.join(SRC, 'utils/passedOver.ts'))
    mock.module(path.join(SRC, 'services/providers/accountSlots.js'), () => ({
      deriveFamilySlotGroups: () => { throw new Error('slots-boom') },
    }))
    const { providerIdentityLine } = await import(path.join(SRC, 'services/providers/providerIdentityLine.ts'))
    const before1 = po.passedOverSoFar().count
    out.idLine = providerIdentityLine('anthropic')
    const after1 = po.passedOverSoFar()
    out.idPassed = after1.count > before1 && String(after1.last).includes('slots-boom')
  `)
  check('w05-2: providerIdentityLine catch records error via passedOver', r.idPassed === true && (r.idLine as { kind?: string }).kind === 'none', JSON.stringify(r))
}

{
  const r = runScenario(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const po = await import(path.join(SRC, 'utils/passedOver.ts'))
    const realAuth = await import(path.join(SRC, 'utils/auth.ts'))
    mock.module(path.join(SRC, 'utils/auth.js'), () => ({
      ...realAuth,
      getAuthTokenSource: () => { throw new Error('bearer-boom') },
    }))
    const { anthropicCredentialPresence } = await import(path.join(SRC, 'services/providers/providerUsage.ts'))
    const before = po.passedOverSoFar().count
    out.presence = anthropicCredentialPresence()
    const after = po.passedOverSoFar()
    out.bearerPassed = after.count > before && String(after.last).includes('bearer-boom')
  `)
  check('w05-2: providerUsage readBearerTokenSource catch records error via passedOver', r.bearerPassed === true, JSON.stringify(r))
}

console.log('\nw05-6 — useSessionSignInGate stays open on throw and records error via passedOver')
{
  const r = runScenario(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const po = await import(path.join(SRC, 'utils/passedOver.ts'))
    mock.module('react', () => ({ useMemo: (fn) => fn() }))
    mock.module(path.join(SRC, 'utils/accounts/useSignInEpoch.js'), () => ({ useSignInEpoch: () => 0 }))
    mock.module(path.join(SRC, 'hooks/useCatalogueEpoch.js'), () => ({ useCatalogueEpoch: () => 0 }))
    mock.module(path.join(SRC, 'utils/accounts/sessionSignIn.js'), () => ({
      sessionSignInGate: () => { throw new Error('gate-boom') },
    }))
    const { useSessionSignInGate } = await import(path.join(SRC, 'hooks/useSessionSignInGate.ts'))
    const before = po.passedOverSoFar().count
    out.gate = useSessionSignInGate('claude-sonnet-4-6')
    const after = po.passedOverSoFar()
    out.passed = after.count > before && String(after.last).includes('gate-boom')
  `)
  check('w05-6: throwing sessionSignInGate returns ok and calls passedOver(error)', (r.gate as { state?: string }).state === 'ok' && r.passed === true, JSON.stringify(r))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
