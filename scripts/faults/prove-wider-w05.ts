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

const SCRUBBED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_OAUTH_BASE',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_OAUTH_REFRESH_TOKEN',
  'MERCURY_OAUTH_TOKEN_FD',
  'MERCURY_API_KEY_FD',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_HOME',
  'MERCURY_CLIENT_CERT',
  'MERCURY_CLIENT_KEY',
  'MERCURY_CLIENT_KEY_PASSPHRASE',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
] as const

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
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of SCRUBBED_ENV_KEYS) delete env[key]
  env.MERCURY_CONFIG_DIR = home
  env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  if (useKeychain) {
    delete env.MERCURY_CREDENTIAL_STORE
    env.PATH = `${bin}:${process.env.PATH ?? ''}`
  } else {
    env.MERCURY_CREDENTIAL_STORE = 'file'
  }
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
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
    mock.module(path.join(SRC, 'platform/logs/debugLog.js'), () => ({
      logForDebugging: (msg) => { debugLogs.push(String(msg)) },
      isDebugMode: () => false,
      getDebugLogPath: () => '',
    }))
    const ss = await import(path.join(SRC, 'platform/secure-storage/index.ts'))
    const auth = { ...(await import(path.join(SRC, 'models/sign-in/credentials/auth.ts'))), ...(await import(path.join(SRC, 'models/sign-in/lifecycle/oauthLifecycle.ts'))) }
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
    const real = await import(path.join(SRC, 'platform/secure-storage/index.ts'))
    let shouldThrow = true
    mock.module(path.join(SRC, 'platform/secure-storage/index.js'), () => ({
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
    const auth = { ...(await import(path.join(SRC, 'models/sign-in/credentials/auth.ts'))), ...(await import(path.join(SRC, 'models/sign-in/lifecycle/oauthLifecycle.ts'))) }
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
    const ss = await import(path.join(SRC, 'platform/secure-storage/index.ts'))
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
    const ss = await import(path.join(SRC, 'platform/secure-storage/index.ts'))
    const { scanAccountScopes } = await import(path.join(SRC, 'models/sign-in/account-ledger/scopeScan.ts'))
    const { resolveLiveScopeIdentity, _resetIdentityCacheForTesting } = await import(path.join(SRC, 'models/sign-in/account-ledger/accountIdentity.ts'))
    const { anthropicSlots } = await import(path.join(SRC, 'models/roads/account-slots/anthropic.ts'))
    const { walletEntries, activeWalletEntry, resetWalletEntriesMemo } = await import(path.join(SRC, 'models/wallet/wallet.ts'))
    const { deriveScheduleAccountForModel } = await import(path.join(SRC, 'daemon/saturn/saturnAccount.ts'))

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
    const po = await import(path.join(SRC, 'platform/errors/passedOver.ts'))
    mock.module(path.join(SRC, 'models/roads/accountSlots.js'), () => ({
      deriveFamilySlotGroups: () => { throw new Error('slots-boom') },
    }))
    const { providerIdentityLine } = await import(path.join(SRC, 'models/roads/providerIdentityLine.ts'))
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
    const po = await import(path.join(SRC, 'platform/errors/passedOver.ts'))
    const realAuth = await import(path.join(SRC, 'models/sign-in/credentials/auth.ts'))
    mock.module(path.join(SRC, 'models/sign-in/credentials/auth.js'), () => ({
      ...realAuth,
      getAuthTokenSource: () => { throw new Error('bearer-boom') },
    }))
    const { anthropicCredentialPresence } = await import(path.join(SRC, 'models/roads/providerUsage.ts'))
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
    const po = await import(path.join(SRC, 'platform/errors/passedOver.ts'))
    mock.module('react', () => ({ useMemo: (fn) => fn() }))
    mock.module(path.join(SRC, 'models/sign-in/account-ledger/useSignInEpoch.js'), () => ({ useSignInEpoch: () => 0 }))
    mock.module(path.join(SRC, 'screen/model-picker/useCatalogueEpoch.js'), () => ({ useCatalogueEpoch: () => 0 }))
    mock.module(path.join(SRC, 'models/sign-in/accounts/sessionSignIn.js'), () => ({
      sessionSignInGate: () => { throw new Error('gate-boom') },
    }))
    const { useSessionSignInGate } = await import(path.join(SRC, 'screen/focused-session/useSessionSignInGate.ts'))
    const before = po.passedOverSoFar().count
    out.gate = useSessionSignInGate('claude-sonnet-4-6')
    const after = po.passedOverSoFar()
    out.passed = after.count > before && String(after.last).includes('gate-boom')
  `)
  check('w05-6: throwing sessionSignInGate returns ok and calls passedOver(error)', (r.gate as { state?: string }).state === 'ok' && r.passed === true, JSON.stringify(r))
}

console.log('\nw05-3 — removeApiKey treats exit 44 as done and surfaces keychain refusal in logout and slot removal')
if (process.platform !== 'darwin') {
  skip('w05-3 keychain delete scenarios', 'macOS keychain backend only runs on darwin')
} else {
  const securityScript = `#!/bin/sh
STATE="$MERCURY_CONFIG_DIR/del-mode"
MODE="absent"
if [ -f "$STATE" ]; then MODE=$(cat "$STATE"); fi
if [ "$1" = "delete-generic-password" ]; then
  case "$MODE" in
    refuse) echo "User interaction is not allowed." >&2; exit 36 ;;
    absent) exit 44 ;;
    ok) exit 0 ;;
  esac
fi
exit 44
`
  const r = runScenario(
    `
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cfg = await import(path.join(SRC, 'platform/config/globalConfig.ts'))
    cfg.enableConfigs()
    const auth = { ...(await import(path.join(SRC, 'models/sign-in/credentials/auth.ts'))), ...(await import(path.join(SRC, 'models/sign-in/lifecycle/oauthLifecycle.ts'))) }
    const portable = await import(path.join(SRC, 'models/sign-in/credentials/authPortable.ts'))
    const logout = await import(path.join(SRC, 'commands/logout/logout.tsx'))
    const removal = await import(path.join(SRC, 'models/roads/account-slots/removal.ts'))
    const ps = await import(path.join(SRC, 'models/sign-in/account-ledger/providerSecrets.ts'))
    const modeFile = path.join(HOME, 'del-mode')

    fs.writeFileSync(modeFile, 'absent')
    out.exit44Threw = await portable.maybeRemoveApiKeyFromMacOSKeychainThrows().then(() => null, e => String(e?.message ?? e))

    cfg.saveGlobalConfig(c => ({ ...c, primaryApiKey: 'sk-ant-fake-key-1234567890' }))
    ps.writeStoredOpenaiApiKey('sk-openai-fake-other-1234')
    fs.writeFileSync(modeFile, 'refuse')

    out.removeErr = await auth.removeApiKey().then(() => null, e => String(e?.message ?? e))
    out.configKeptAfterRemoveErr = cfg.getGlobalConfig().primaryApiKey === 'sk-ant-fake-key-1234567890'

    out.slotRemoval = removal.executeSlotRemoval({
      family: 'anthropic',
      id: 'anthropic:api-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: 'managed',
      active: true,
      envPinned: false,
      signedIn: true,
      removal: { route: 'anthropic-managed-key' },
    })
    out.configKeptAfterSlotRefusal = cfg.getGlobalConfig().primaryApiKey === 'sk-ant-fake-key-1234567890'

    out.logoutRefused = await logout.performLogout()
    out.otherProviderCleared = ps.readStoredOpenaiApiKey() === undefined
    out.leakedKey = JSON.stringify({ r: out.removeErr, s: out.slotRemoval, l: out.logoutRefused }).includes('sk-ant-fake-key-1234567890')

    fs.writeFileSync(modeFile, 'absent')
    out.removeOn44 = await auth.removeApiKey().then(() => null, e => String(e?.message ?? e))
    out.configClearedOn44 = cfg.getGlobalConfig().primaryApiKey === undefined
    `,
    { fakeSecurityScript: securityScript },
  )
  check('w05-3: exit 44 from security delete-generic-password is treated as done', r.exit44Threw === null && r.removeOn44 === null && r.configClearedOn44 === true, JSON.stringify({ e44: r.exit44Threw, r44: r.removeOn44, cleared: r.configClearedOn44 }))
  check(
    'w05-3: removeApiKey rejects on keychain refusal with exact sentence and leaves config untouched',
    typeof r.removeErr === 'string' &&
      r.removeErr.startsWith('the API key could not be removed from the keychain (') &&
      r.removeErr.endsWith(') — it is still stored; unlock the keychain and remove it again') &&
      r.configKeptAfterRemoveErr === true,
    JSON.stringify({ err: r.removeErr, kept: r.configKeptAfterRemoveErr }),
  )
  const slotR = r.slotRemoval as { note?: string; mutated?: boolean; refused?: boolean }
  check(
    'w05-3: executeSlotRemoval refuses synchronously with mutated:false and leaves config untouched',
    slotR.refused === true &&
      slotR.mutated === false &&
      typeof slotR.note === 'string' &&
      slotR.note.includes('the API key could not be removed from the keychain (') &&
      r.configKeptAfterSlotRefusal === true,
    JSON.stringify({ slotR, kept: r.configKeptAfterSlotRefusal }),
  )
  const logR = r.logoutRefused as string[]
  check(
    'w05-3: performLogout finishes signing out other providers and reports the keychain refusal without leaking key',
    Array.isArray(logR) &&
      logR.some(line => line.includes('the API key could not be removed from the keychain (')) &&
      r.otherProviderCleared === true &&
      r.leakedKey === false,
    JSON.stringify({ logR, otherCleared: r.otherProviderCleared, leaked: r.leakedKey }),
  )
}

console.log('\nw05-4 — storeOAuthAccountInfo keeps daemon restart failure for auth CLI and login screen')
{
  const r = runScenario(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const cfg = await import(path.join(SRC, 'platform/config/globalConfig.ts'))
    cfg.enableConfigs()
    let failRestart = true
    mock.module(path.join(SRC, 'daemon/control/ownedDaemon.js'), () => ({
      restartOwnedDaemonForFreshSignin: async () => {
        if (failRestart) throw new Error('daemon-socket-gone')
        return 'asked'
      },
    }))
    const refresh = await import(path.join(SRC, 'models/sign-in/oauth/refresh.ts'))
    const authCli = await import(path.join(SRC, 'commands/verbs/auth.ts'))
    const { createAnthropicLoginMachine } = await import(path.join(SRC, 'screen/widgets/faces/anthropicLoginModel.ts'))

    out.hasAwaitExport = typeof refresh.awaitStoredOAuthDaemonRestart === 'function'
    const ret = refresh.storeOAuthAccountInfo({ accountUuid: 'u-1', emailAddress: 'fake1@example.com' })
    out.syncReturn = ret === undefined
    out.firstRestartErr = out.hasAwaitExport ? await refresh.awaitStoredOAuthDaemonRestart() : null

    const installed = await authCli.installOAuthTokens({
      accessToken: 'fake-at-4',
      refreshToken: 'fake-rt-4',
      expiresAt: 4102444800000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: null,
      tokenAccount: { uuid: 'u-2', emailAddress: 'fake2@example.com' },
    })
    out.installed = installed ?? null

    let snapshot = null
    const ctrl = createAnthropicLoginMachine(
      { onDone: () => {} },
      next => { snapshot = next },
      {
        createService: () => ({
          startOAuthFlow: async () => ({
            accessToken: 'fake-at-5',
            refreshToken: 'fake-rt-5',
            expiresAt: 4102444800000,
            scopes: ['user:inference'],
            subscriptionType: 'pro',
            rateLimitTier: null,
            tokenAccount: { uuid: 'u-3', emailAddress: 'fake3@example.com' },
          }),
          handleManualAuthCodeInput: () => {},
          cleanup: () => {},
        }),
        saveTokens: () => ({ success: true }),
        usesClaudeAiAuth: () => true,
        mintApiKey: async () => null,
        validateOrg: async () => ({ valid: true }),
        storeAccount: account => refresh.storeOAuthAccountInfo(account),
        shadowWarning: () => null,
        recordSignIn: () => {},
        settings: () => ({}),
        clipboard: async () => ({ sequence: '', answer: 'copied' as const }),
        writeStdout: () => {},
        log: () => {},
        setTimer: (fn) => { queueMicrotask(fn); return 1 },
        clearTimer: () => {},
      },
    )
    ctrl.start(true)
    for (let i = 0; i < 40 && snapshot?.flow?.name !== 'success'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    out.loginFlow = snapshot?.flow ?? null

    failRestart = false
    refresh.storeOAuthAccountInfo({ accountUuid: 'u-4', emailAddress: 'fake4@example.com' })
    out.okRestartErr = out.hasAwaitExport ? await refresh.awaitStoredOAuthDaemonRestart() : 'missing'
  `)
  check('w05-4: storeOAuthAccountInfo stays synchronous and exposes failed daemon restart error', r.hasAwaitExport === true && r.syncReturn === true && r.firstRestartErr === 'daemon-socket-gone' && r.okRestartErr === null, JSON.stringify({ has: r.hasAwaitExport, sync: r.syncReturn, first: r.firstRestartErr, ok: r.okRestartErr }))
  const inst = r.installed as { daemonRestartError?: string } | null
  check('w05-4: installOAuthTokens returns daemonRestartError when daemon restart fails', inst !== null && inst.daemonRestartError === 'daemon-socket-gone', JSON.stringify(inst))
  const lf = r.loginFlow as { name?: string; warning?: string } | null
  check(
    'w05-4: anthropicLoginModel success receipt carries the daemon restart warning sentence',
    lf !== null &&
      lf.name === 'success' &&
      lf.warning === 'signed in, but the background daemon could not be restarted (daemon-socket-gone) — run `mercury daemon restart` so it uses this sign-in',
    JSON.stringify(lf),
  )
}

console.log('\nw05-5 — unreadable MERCURY_CLIENT_CERT / MERCURY_CLIENT_KEY warned once at start and shown in /status')
{
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const mtls = await import(path.join(SRC, 'platform/network/mtls.ts'))
    const status = await import(path.join(SRC, 'commands/verbs/status.tsx'))

    const missingCert = path.join(SCRATCH, 'missing-cert.pem')
    const missingKey = path.join(SCRATCH, 'missing-key.pem')
    process.env.MERCURY_CLIENT_CERT = missingCert
    process.env.MERCURY_CLIENT_KEY = missingKey
    mtls.clearMTLSCache()

    const stderrChunks = []
    const origWrite = process.stderr.write
    process.stderr.write = (chunk => { stderrChunks.push(String(chunk)); return true })
    try {
      out.configMissing = mtls.getMTLSConfig() ?? null
      mtls.configureGlobalMTLS()
      const afterFirst = stderrChunks.join('')
      mtls.configureGlobalMTLS()
      const afterSecond = stderrChunks.join('')
      out.stderrFirst = afterFirst
      out.stderrRepeatSame = afterSecond === afterFirst
    } finally {
      process.stderr.write = origWrite
    }

    const propsMissing = status.buildAPIProviderProperties().map(p => ({ label: p.label, text: status.propertyValueToText(p.value) }))
    out.propsMissing = propsMissing
    out.missingCert = missingCert
    out.missingKey = missingKey

    const okCert = path.join(SCRATCH, 'ok-cert.pem')
    const okKey = path.join(SCRATCH, 'ok-key.pem')
    fs.writeFileSync(okCert, 'FAKE-CERT-MATERIAL-NEVER-LEAK')
    fs.writeFileSync(okKey, 'FAKE-KEY-MATERIAL-NEVER-LEAK')
    process.env.MERCURY_CLIENT_CERT = okCert
    process.env.MERCURY_CLIENT_KEY = okKey
    mtls.clearMTLSCache()
    const okChunks = []
    process.stderr.write = (chunk => { okChunks.push(String(chunk)); return true })
    try {
      out.configOk = Boolean(mtls.getMTLSConfig()?.cert && mtls.getMTLSConfig()?.key)
      mtls.configureGlobalMTLS()
      out.stderrOk = okChunks.join('')
    } finally {
      process.stderr.write = origWrite
    }
    const propsOk = status.buildAPIProviderProperties().map(p => ({ label: p.label, text: status.propertyValueToText(p.value) }))
    out.propsOk = propsOk
    out.okCert = okCert
    out.okKey = okKey
    out.leakedMaterial = JSON.stringify({ propsOk, okChunks }).includes('FAKE-KEY-MATERIAL-NEVER-LEAK')
  `)
  const stderrFirst = String(r.stderrFirst ?? '')
  const missingCert = String(r.missingCert ?? '')
  const missingKey = String(r.missingKey ?? '')
  check(
    'w05-5: unreadable mTLS files keep getMTLSConfig non-throwing and warn once on stderr at startup',
    r.configMissing === null &&
      stderrFirst.includes(`MERCURY_CLIENT_CERT is set to ${missingCert}, which could not be read (`) &&
      stderrFirst.includes('so requests go out without the client certificate — fix the path or unset it.') &&
      stderrFirst.includes(`MERCURY_CLIENT_KEY is set to ${missingKey}, which could not be read (`) &&
      r.stderrRepeatSame === true,
    JSON.stringify({ cfg: r.configMissing, stderrFirst, repeatSame: r.stderrRepeatSame }),
  )
  const propsM = r.propsMissing as Array<{ label?: string; text: string }>
  const certRow = propsM.find(p => p.label === 'mTLS client cert')
  const keyRow = propsM.find(p => p.label === 'mTLS client key')
  check(
    'w05-5: /status buildAPIProviderProperties shows unread sentences for MERCURY_CLIENT_CERT and MERCURY_CLIENT_KEY',
    certRow !== undefined &&
      certRow.text.startsWith(`MERCURY_CLIENT_CERT is set to ${missingCert}, which could not be read (`) &&
      certRow.text.endsWith(') , so requests go out without the client certificate — fix the path or unset it.'.replace(') ,', '),')) &&
      keyRow !== undefined &&
      keyRow.text.startsWith(`MERCURY_CLIENT_KEY is set to ${missingKey}, which could not be read (`) &&
      keyRow.text.endsWith('), so requests go out without the client certificate — fix the path or unset it.'),
    JSON.stringify(propsM),
  )
  const propsOk = r.propsOk as Array<{ label?: string; text: string }>
  check(
    'w05-5: readable mTLS files control prints nothing to stderr, shows paths in /status, and leaks no material',
    r.configOk === true &&
      r.stderrOk === '' &&
      propsOk.some(p => p.label === 'mTLS client cert' && p.text === r.okCert) &&
      propsOk.some(p => p.label === 'mTLS client key' && p.text === r.okKey) &&
      r.leakedMaterial === false,
    JSON.stringify({ configOk: r.configOk, stderrOk: r.stderrOk, propsOk, leaked: r.leakedMaterial }),
  )
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
