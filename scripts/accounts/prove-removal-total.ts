#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-removal-total.ts — removing an account leaves no
//  trace anywhere, and "no account" is a real state (the operator's law).
//
//  THE SIGHTING: /accounts showed, under "Anthropic accounts · 1/2 signed
//  in", a family header saying no Anthropic credential existed AND a slot
//  row wearing "<email> · verified live"; ⌫ twice changed nothing — the row
//  could not be removed.
//
//  ROOT CAUSES (adjudicated from the source):
//    · the per-slot sign-out cleared the GLOBAL config's account row while
//      the scan read the scope's OWN dir-scoped snapshot (written by the
//      board's verification heal, cleared by nothing) as the sign-in —
//      "signed in" by a file that outlived the login;
//    · the live identity cache served a verification for five minutes past
//      the removal, and the derivation trusted it over the credential;
//    · the removal refused a slot the scan called signed out ("nothing to
//      sign out"), so the snapshot that fed the row was never cleared;
//    · the sign-out awaited the server-side revoke BEFORE the local
//      teardown, so every surface stayed signed in for the round trip.
//
//  THE LAWS:
//    R1  two families signed in on a fixture home read on every surface —
//        the scan, the board, the presence owner, the wallet, the computed
//        default's order, the session-account words;
//    R2  removing the ChatGPT sign-in through the real owner leaves the
//        Anthropic one whole and the OpenAI family absent everywhere;
//    R3  removing the Anthropic login through the REAL owner (the revoke
//        stubbed) lands the KEYLESS state everywhere, synchronously: the
//        store field (its siblings kept), both snapshots, the resolved
//        identity, the credential memos, the ledger's epoch — the scan, the
//        board's row and header (a stale identity read notwithstanding),
//        the presence owner, the wallet, the computed default (no provider;
//        the Default row is the logins door), the failover candidates
//        (none), the session-account words (none);
//    R4  the revoke ran AFTER the local teardown, on the refresh token
//        captured first;
//    R5  a stale row cannot exist: a snapshot with no login behind it reads
//        signed out with its identity labelled, a cached verification never
//        outranks the credential's absence (the cache follows the sign-in
//        epoch), and ⌫ clears the snapshot; only a slot with nothing behind
//        it is the no-op;
//    R6  the sign-in ledger keeps its history, the resolver skips the
//        departed credentials, and a re-login round trip restores every
//        surface with the NEW identity; /logout clears the scope snapshot
//        (structural).
//
//  Hermetic: a scratch home pinned before any owner loads; the file
//  credential plane; every provider base dead; ambient credentials cleared.
//
//  Run: ~/.bun/bin/bun run scripts/accounts/prove-removal-total.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

const scratch = mkdtempSync(join(tmpdir(), 'removal-total-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const dead = 'http://127.0.0.1:1'
for (const base of [
  'ANTHROPIC_BASE_URL',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_MOONSHOT_API_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
]) {
  process.env[base] = dead
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(2, 68 - t.length))}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

console.log('============================================================')
console.log(' removal is total — no account is a real state')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const slots = await import('../../src/services/providers/accountSlots.ts')
const usage = await import('../../src/services/providers/providerUsage.ts')
const identity = await import('../../src/utils/accounts/accountIdentity.ts')
const scan = await import('../../src/utils/accounts/scopeScan.ts')
const ledger = await import('../../src/utils/accounts/signInLedger.ts')
const computed = await import('../../src/utils/model/computedDefault.ts')
const wallet = await import('../../src/services/wallet/wallet.ts')
const cap = await import('../../src/services/capFailover.ts')
const auth = await import('../../src/utils/auth.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const session = await import('../../src/utils/accounts/sessionAccount.ts')
const openai = await import('../../src/services/providers/openai/openaiAccounts.ts')
type AccountSlot = import('../../src/services/providers/accountSlots.ts').AccountSlot

// ── the fixture roads (the stores' own shapes; the sign-in roads' memo drops) ─
const CREDENTIALS = join(home, '.credentials.json')
const SNAPSHOT = join(home, '.claude.json')
const SIBLINGS = { mcpOAuth: { 'fixture-server': { accessToken: 'mcp-fixture-token' } }, trustedDeviceToken: 'device-fixture' }
const ANTHROPIC_EMAIL = 'claude-operator@fixture.example'
const OPENAI_EMAIL = 'gpt-operator@fixture.example'
const REFRESH_TOKEN = 'fixture-refresh-token-00000000001'

function seedAnthropic(email: string, uuid: string): void {
  writeFileSync(
    CREDENTIALS,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token-000000000001',
        refreshToken: REFRESH_TOKEN,
        expiresAt: 4102444800000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: null,
      },
      ...SIBLINGS,
    }),
  )
  // The board's verification heal writes this file; a login's other keys
  // ride beside the account (the clear must keep them).
  writeFileSync(SNAPSHOT, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email }, fixtureKey: 'kept' }))
  config.saveGlobalConfig(current => ({
    ...current,
    oauthAccount: { accountUuid: uuid, emailAddress: email, organizationUuid: 'org-fixture', organizationName: 'Fixture Org' },
  }))
  auth.dropCredentialMemos()
  ledger.recordSignIn('anthropic', 'oauth')
}
function seedOpenai(): void {
  writeFileSync(
    join(home, '.openai-auth.json'),
    JSON.stringify({
      version: 1,
      tokens: { idToken: '', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus', email: OPENAI_EMAIL },
    }),
  )
  ledger.recordSignIn('openai', 'subscription')
}
const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
const profileOk = (email: string): typeof fetch =>
  (async () => new Response(JSON.stringify({ account: { email_address: email, uuid: 'uuid-live' } }), { status: 200 })) as unknown as typeof fetch
const noNetwork: typeof fetch = (async () => {
  throw new Error('the network must not be reached')
}) as unknown as typeof fetch
const anthropicScopeSlot = (): AccountSlot | undefined =>
  slots.deriveFamilySlotGroups().find(group => group.family.id === 'anthropic')?.slots.find(slot => slot.scope !== undefined)
const presenceOf = (family: string) => usage.providerFamilyPresences().find(presence => (presence.id as string) === family)
const families = (facts: readonly { family: string }[]): string => facts.map(fact => fact.family).join(',')

seedAnthropic(ANTHROPIC_EMAIL, 'uuid-fixture')
await sleep(5)
seedOpenai()

section('R1 two families signed in — every surface reads both')
{
  const scope = scan.scanAccountScopes()[0]!
  check('the scan: the resolved home is signed in (the STORE holds the login) and names the snapshot identity', scope.authed && scope.email === ANTHROPIC_EMAIL && scope.uuid === 'uuid-fixture', JSON.stringify(scope))
  const anthropicSlot = anthropicScopeSlot()
  check('the board: the Anthropic scope slot is signed in with the identity', anthropicSlot?.signedIn === true && anthropicSlot.identity === ANTHROPIC_EMAIL, JSON.stringify(anthropicSlot))
  const openaiGroup = slots.deriveFamilySlotGroups().find(group => group.family.id === 'openai')
  check('the board: the ChatGPT slot is signed in with the recorded email', openaiGroup?.slots.some(slot => slot.kind === 'subscription' && slot.signedIn && slot.identity === OPENAI_EMAIL) === true, JSON.stringify(openaiGroup?.slots))
  const verified = { [home]: { state: 'verified' as const, email: ANTHROPIC_EMAIL } }
  check("the header: ' · 1/2 signed in' over a verified probe", slots.familySigninHeaderNote('anthropic', [anthropicSlot!], verified) === ' · 1/2 signed in', slots.familySigninHeaderNote('anthropic', [anthropicSlot!], verified))
  check('the presence owner: both families credentialed, each with its identity', presenceOf('anthropic')?.credentialed === true && usage.presenceIdentityWords(presenceOf('anthropic')!) === ANTHROPIC_EMAIL && presenceOf('openai')?.credentialed === true && usage.presenceIdentityWords(presenceOf('openai')!) === OPENAI_EMAIL, JSON.stringify([presenceOf('anthropic'), presenceOf('openai')]))
  const entries = wallet.walletEntries()
  check('the wallet: an Anthropic OAuth entry naming the account and an OpenAI entry', entries.some(entry => entry.id === 'anthropic:oauth:primary' && entry.label.includes(ANTHROPIC_EMAIL)) && entries.some(entry => entry.provider === 'openai'), JSON.stringify(entries.map(entry => entry.id)))
  check('the sign-in ledger orders the credentials by recency (openai landed last)', families(computed.recentSignIns()) === 'openai,anthropic', families(computed.recentSignIns()))
  const decision = computed.computedDefault()
  check('the computed default considers both, most recent first, and lands on a provider', families(decision.considered) === 'openai,anthropic' && decision.provider !== null && decision.source !== 'keyless', JSON.stringify({ provider: decision.provider, source: decision.source, why: decision.why }))
  check('the session-account words on a GPT session name the ChatGPT sign-in', session.sessionAccountWords('gpt-5.5', { modelSetting: () => 'gpt-5.5' }).state === 'email' && (session.sessionAccountWords('gpt-5.5', { modelSetting: () => 'gpt-5.5' }) as { text?: string }).text === OPENAI_EMAIL)
  check('…and on a Claude session the Claude sign-in', (session.sessionAccountWords('claude-opus-5', { modelSetting: () => 'claude-opus-5' }) as { text?: string }).text === ANTHROPIC_EMAIL)
  check('the live identity read verifies the fixture credential (the profile stubbed)', (await identity.resolveLiveScopeIdentity(home, { fetchImpl: profileOk(ANTHROPIC_EMAIL) })).state === 'verified')
}

section('R2 removing the ChatGPT sign-in leaves the Claude login whole')
{
  const openaiSlot = slots.deriveFamilySlotGroups().find(group => group.family.id === 'openai')!.slots.find(slot => slot.kind === 'subscription')!
  const epochBefore = ledger.signInLedgerEpoch()
  const out = slots.executeSlotRemoval(openaiSlot)
  check('the real owner disconnects and announces', out.mutated && out.note.includes('ChatGPT subscription disconnected') && ledger.signInLedgerEpoch() === epochBefore + 1, out.note)
  check('the OpenAI store holds no sign-in', openai.openaiSubscriptionPresence().state === 'absent' && openai.resolveOpenaiAccount() === undefined)
  check('the presence owner: OpenAI absent, Anthropic whole', presenceOf('openai')?.credentialed === false && presenceOf('anthropic')?.credentialed === true && usage.presenceIdentityWords(presenceOf('anthropic')!) === ANTHROPIC_EMAIL)
  check('the board: the OpenAI group is absent (no slots), the Anthropic scope slot stands', slots.deriveFamilySlotGroups().find(group => group.family.id === 'openai')?.slots.length === 0 && anthropicScopeSlot()?.signedIn === true)
  check('the wallet: no OpenAI entry, the Anthropic entry stands', !wallet.walletEntries().some(entry => entry.provider === 'openai') && wallet.walletEntries().some(entry => entry.id === 'anthropic:oauth:primary'))
  check('the resolver skips the departed credential; the ledger keeps its history', families(computed.recentSignIns()) === 'anthropic' && ledger.readSignInLedger().openai?.kind === 'subscription')
  const decision = computed.computedDefault()
  check('the computed default lands on the Claude sign-in alone', decision.provider === 'anthropic' && families(decision.considered) === 'anthropic', JSON.stringify({ provider: decision.provider, considered: families(decision.considered) }))
  check('the session-account words on a GPT session name no account now', session.sessionAccountWords('gpt-5.5', { modelSetting: () => 'gpt-5.5' }).state === 'none')
}

section('R3 removing the Claude login through the REAL owner lands the keyless state everywhere, at once')
{
  const before = ledger.signInLedgerEpoch()
  const revoked: Array<{ token: string; storeEmptyAtRevoke: boolean; snapshotGoneAtRevoke: boolean }> = []
  const slot = anthropicScopeSlot()!
  const staleRead = { [home]: { state: 'verified' as const, email: ANTHROPIC_EMAIL } }
  const out = slots.executeSlotRemoval(slot, {
    revokeAnthropicToken: async token => {
      revoked.push({ token, storeEmptyAtRevoke: !auth.hasStoredOAuthToken(), snapshotGoneAtRevoke: readJson(SNAPSHOT)?.oauthAccount === undefined })
    },
  })
  check('the owner signs out and announces (the epoch moved once, synchronously)', out.mutated && out.note.includes('tokens revoked and dropped') && ledger.signInLedgerEpoch() === before + 1, out.note)
  const store = readJson(CREDENTIALS)
  check('the token-store field left; its sibling fields survived (the per-slot law)', store !== null && store.claudeAiOauth === undefined && store.mcpOAuth !== undefined && store.trustedDeviceToken === 'device-fixture', JSON.stringify(store))
  check('the stored-login read says none (no memo served the departed token)', auth.hasStoredOAuthToken() === false && auth.isClaudeAISubscriber() === false && auth.getClaudeAIOAuthTokens() === null)
  check("the global config's account row is gone", config.getGlobalConfig().oauthAccount === undefined && auth.getOauthAccountInfo() === undefined)
  const snapshot = readJson(SNAPSHOT)
  check("the scope's own snapshot lost its account and kept its other keys", snapshot !== null && snapshot.oauthAccount === undefined && snapshot.fixtureKey === 'kept', JSON.stringify(snapshot))
  const scope = scan.scanAccountScopes()[0]!
  check('the scan: signed out, no identity', scope.authed === false && scope.email === undefined && scope.uuid === undefined, JSON.stringify(scope))
  const gone = anthropicScopeSlot()!
  const state = slots.slotSigninState(gone, staleRead)
  check("the board's row: signed out even against a stale VERIFIED read (presence outranks the cache)", gone.signedIn === false && state.basis === 'signed-out' && slots.scopeSlotTail(state, staleRead[home], gone) === 'not signed in · ↵ opens Logins to sign in', slots.scopeSlotTail(state, staleRead[home], gone))
  check("the header: ' · 0/2 signed in' against the same stale read", slots.familySigninHeaderNote('anthropic', [gone], staleRead) === ' · 0/2 signed in', slots.familySigninHeaderNote('anthropic', [gone], staleRead))
  check('the live identity read answers signed-out from the store without touching the network (nothing cached survived)', (await identity.resolveLiveScopeIdentity(home, { fetchImpl: noNetwork })).state === 'signed-out')
  check('the presence owner: no family credentialed', usage.providerFamilyPresences().every(presence => !presence.credentialed && usage.presenceIdentityWords(presence) === undefined))
  check('the wallet: empty', wallet.walletEntries().length === 0, JSON.stringify(wallet.walletEntries().map(entry => entry.id)))
  const decision = computed.computedDefault()
  check('the computed default: keyless — no provider, nothing considered', decision.source === 'keyless' && decision.provider === null && decision.considered.length === 0, JSON.stringify({ source: decision.source, provider: decision.provider }))
  check('the /model Default row is the logins door', computed.describeComputedDefaultRow(decision) === `Default (${computed.NO_SIGN_IN_REASON})`, computed.describeComputedDefaultRow(decision))
  check('the resolver: no recent sign-in; the ledger still holds both records (history, never truth)', computed.recentSignIns().length === 0 && computed.mostRecentSignInFamily() === undefined && ledger.readSignInLedger().anthropic?.kind === 'oauth' && ledger.readSignInLedger().openai?.kind === 'subscription')
  const candidates = cap.liveCapFailoverCandidates(null)
  check('the failover candidate set: empty, every family excluded with its blocker (no card)', candidates.candidates.length === 0 && candidates.excluded.length > 0 && candidates.excluded.every(exclusion => exclusion.why.length > 0), JSON.stringify(candidates))
  check('the session-account words on the default: no account (the keyless placeholder names nobody)', session.sessionAccountWords(decision.setting, { modelSetting: () => null }).state === 'none')

  section('R4 the revoke ran after the local teardown, on the refresh token captured first')
  await sleep(10)
  check('exactly one revoke, with the stored refresh token', revoked.length === 1 && revoked[0]!.token === REFRESH_TOKEN, JSON.stringify(revoked))
  check('…and the store and the snapshot were already gone when it ran', revoked[0]?.storeEmptyAtRevoke === true && revoked[0]?.snapshotGoneAtRevoke === true)
  const again = slots.executeSlotRemoval(anthropicScopeSlot()!)
  check('a second ⌫ on the empty slot is the honest no-op', again.mutated === false && again.note.includes('nothing to sign out'), again.note)
}

section('R5 a stale row cannot exist — a snapshot with no login behind it')
{
  // Another tool removed the login and left the snapshot (the operator's
  // shape): the store holds no claude.ai field, the snapshot names an account.
  writeFileSync(SNAPSHOT, JSON.stringify({ oauthAccount: { accountUuid: 'uuid-stale', emailAddress: 'stale@fixture.example' } }))
  identity.forgetScopeIdentity()
  const scope = scan.scanAccountScopes()[0]!
  check('the scan: signed OUT with the identity labelled (never a login)', scope.authed === false && scope.email === 'stale@fixture.example', JSON.stringify(scope))
  const slot = anthropicScopeSlot()!
  const cachedVerified = { [home]: { state: 'verified' as const, email: 'stale@fixture.example' } }
  const state = slots.slotSigninState(slot, cachedVerified)
  check("the row: 'snapshot … — signed out', re-login and ⌫ named — never 'verified live'", state.basis === 'signed-out' && slots.scopeSlotTail(state, cachedVerified[home], slot) === 'snapshot stale@fixture.example — signed out · ↵ opens Logins to re-login · ⌫ clears the snapshot', slots.scopeSlotTail(state, cachedVerified[home], slot))
  check("the header: ' · 0/2 signed in'", slots.familySigninHeaderNote('anthropic', [slot], cachedVerified) === ' · 0/2 signed in')
  const cleared = slots.executeSlotRemoval(slot)
  check('⌫ clears the snapshot (mutated, the receipt says what left)', cleared.mutated && cleared.note.includes('stale identity snapshot cleared') && readJson(SNAPSHOT)?.oauthAccount === undefined, cleared.note)
  check('…and the row is now the plain absent one', anthropicScopeSlot()?.identity === 'not signed in' && anthropicScopeSlot()?.signedIn === false)

  // The identity cache follows the sign-in epoch: a verification cached
  // under one epoch is never served under the next.
  identity.forgetScopeIdentity()
  const creds = () => ({ accessToken: 'fixture-access-token-000000000001', refreshToken: null, expiresAt: null })
  const primed = await identity.resolveLiveScopeIdentity(home, { readCreds: creds, fetchImpl: profileOk('cached@fixture.example') })
  const served = await identity.resolveLiveScopeIdentity(home, { readCreds: () => undefined, fetchImpl: noNetwork })
  check('inside one epoch the cached verification is served (no network, no store read)', primed.state === 'verified' && served.state === 'verified')
  ledger.noteCredentialRemoval()
  const afterMove = await identity.resolveLiveScopeIdentity(home, { readCreds: () => undefined, fetchImpl: noNetwork })
  check('after the epoch moves the cache is dead: the store answers signed-out', afterMove.state === 'signed-out', JSON.stringify(afterMove))
  identity.forgetScopeIdentity()
}

section('R6 the ledger is history; a re-login restores every surface with the NEW identity')
{
  const RETURNED = 'returned@fixture.example'
  seedAnthropic(RETURNED, 'uuid-returned')
  const scope = scan.scanAccountScopes()[0]!
  check('the scan: signed in again, the new identity', scope.authed && scope.email === RETURNED, JSON.stringify(scope))
  check('the presence owner names the new identity', usage.presenceIdentityWords(presenceOf('anthropic')!) === RETURNED)
  check('the live identity read verifies the NEW login (no stale entry survived the sign-in)', (await identity.resolveLiveScopeIdentity(home, { fetchImpl: profileOk(RETURNED) })).state === 'verified')
  check('the wallet names the returned account', wallet.walletEntries().some(entry => entry.id === 'anthropic:oauth:primary' && entry.label.includes(RETURNED)))
  const decision = computed.computedDefault()
  check('the computed default lands on the returned sign-in', decision.provider === 'anthropic' && families(decision.considered) === 'anthropic')
  check('the session-account words on the default name the returned account', (session.sessionAccountWords(decision.setting, { modelSetting: () => null }) as { text?: string }).text === RETURNED)
  const logout = readFileSync(join(ROOT, 'src/commands/logout/logout.tsx'), 'utf8')
  check('/logout clears the scope snapshot and the resolved identities (structural)', logout.includes('clearScopeIdentitySnapshot(getMercuryHome())') && logout.includes('forgetScopeIdentity()'))
  const board = readFileSync(join(ROOT, 'src/components/mercury-ui/parity/AccountView.tsx'), 'utf8')
  check('the board re-probes on every mutation and drops the departed read (structural)', board.includes('}, [scopeDirsKey, version])') && board.includes('delete next[row.slot.id]') && board.includes('forgetScopeIdentity()'))
}

await sleep(20)
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('REMOVAL TOTAL: ALL GREEN')
else console.log(`❌ ${failures} REMOVAL LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
