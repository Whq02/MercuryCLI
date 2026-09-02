#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-accounts-honesty.ts — the /accounts board's two
//  derivations are ONE truth each (the operator's finding:
//  "Anthropic accounts · 1/2 signed in" over a row reading "not signed in",
//  and a "main loop" line naming the Anthropic snapshot while the session
//  ran on the OpenAI subscription).
//
//  §1 slotSigninState — one answer per slot: a scope counts ONLY through its
//     live identity verification (verified ⇒ signed in; expired / signed-out
//     / unverified-offline / in-flight ⇒ not); a stored key or token counts
//     by presence, labelled so; a foreign Claude-family scope is excluded.
//  §2 the family header reads the SAME derivation the row paints: the
//     operator's shape (an Anthropic credential that fails live, an OpenAI
//     subscription present) reads 0/2 and 1/2; an in-flight probe and an
//     offline fallback are named beside the count, never counted.
//  §3 mainLoopIdentity — the route decides the family, the family's owning
//     resolver decides the credential: OpenAI ⇒ the subscription label;
//     Anthropic ⇒ the live-verified identity or 'not signed in'; a snapshot
//     only ever appears labelled as one; a key or env bearer names itself.
//  §4 the REAL owners on a scratch home: a file-backed Anthropic credential
//     the profile endpoint refuses (401, injected fetch — the OAuth base is
//     allowlisted, so no loopback can stand in), a fixture ChatGPT
//     subscription, and a snapshot email — the slot derivation still reads
//     the credential's EXISTENCE, the header count reads ZERO, and the main
//     loop row on a GPT model names the OpenAI subscription.
//  §5 the presence owner counts an env bearer token (ANTHROPIC_AUTH_TOKEN)
//     — the credential the API client sends — so every presence consumer
//     agrees with the health AUTH row.
//  §6 the board's wiring: header, row and main-loop row read the seam; no
//     snapshot is dressed as the billing identity.
//
//  Hermetic: a scratch config home pinned BEFORE any owner loads; the file
//  credential plane; every provider base dead; ambient credentials cleared.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'accounts-honesty-'))
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

// The fixture home: an Anthropic OAuth credential (file plane) whose profile
// check will be refused, the snapshot that credential once wrote, and a
// ChatGPT subscription — the operator's own shape.
writeFileSync(
  join(home, '.credentials.json'),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-access-token-000000000001',
      refreshToken: 'fixture-refresh-token-00000000001',
      expiresAt: 4102444800000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: null,
    },
  }),
)
writeFileSync(
  join(home, '.claude.json'),
  JSON.stringify({ oauthAccount: { accountUuid: 'uuid-fixture', emailAddress: 'stale@fixture.example' } }),
)
writeFileSync(
  join(home, '.openai-auth.json'),
  JSON.stringify({
    version: 1,
    tokens: { idToken: '', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus' },
  }),
)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const slots = await import('../../src/services/providers/accountSlots.ts')
const {
  deriveFamilySlotGroups,
  familySigninCount,
  familySigninHeaderNote,
  familySigninSummary,
  mainLoopIdentity,
  scopeSlotTail,
  slotSigninState,
} = slots
type AccountSlot = import('../../src/services/providers/accountSlots.ts').AccountSlot
type Presence = import('../../src/services/providers/providerUsage.ts').ProviderFamilyPresence

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(2, 66 - t.length))}`)
}

console.log('============================================================')
console.log(' /accounts honesty — one derivation per claim')
console.log('============================================================')

// ── fixture slots in the seam's own shape ───────────────────────────────────
const SCOPE_DIR = '/fixture/home'
const scopeSlot = (authed: boolean, claudeFamily = false): AccountSlot => ({
  family: 'anthropic',
  id: SCOPE_DIR,
  name: 'primary',
  kind: 'oauth',
  kindLabel: 'OAuth',
  identity: authed ? 'stale@fixture.example' : 'not signed in',
  active: true,
  envPinned: false,
  signedIn: authed,
  scope: { name: 'primary', dir: SCOPE_DIR, isCurrent: true, hasConfig: true, authed, claudeFamily, ...(authed ? { email: 'stale@fixture.example', uuid: 'uuid-fixture' } : {}) },
  removal: claudeFamily ? { route: 'excluded', note: 'x' } : { route: 'anthropic-oauth', dir: SCOPE_DIR },
})
const keySlot = (family: string, envPinned: boolean): AccountSlot => ({
  family,
  id: `${family}:${envPinned ? 'env-key' : 'stored-key'}`,
  name: 'api-key',
  kind: 'api-key',
  kindLabel: envPinned ? 'API key · env' : 'API key',
  identity: envPinned ? 'X_API_KEY (env) …abcd' : 'stored key (auth-scoped) …abcd',
  active: true,
  envPinned,
  signedIn: true,
  removal: envPinned ? { route: 'env', envVar: 'X_API_KEY' } : { route: 'zai-stored-key' },
})
const subscriptionSlot: AccountSlot = {
  family: 'openai',
  id: 'openai:subscription',
  name: 'chatgpt',
  kind: 'subscription',
  kindLabel: 'subscription',
  identity: 'ChatGPT plus subscription',
  active: true,
  envPinned: false,
  signedIn: true,
  removal: { route: 'openai-subscription' },
}

section('§1 slotSigninState — one answer per slot')
{
  const authed = scopeSlot(true)
  const verified = slotSigninState(authed, { [SCOPE_DIR]: { state: 'verified', email: 'live@fixture.example' } })
  check('verified live ⇒ signed in, basis verified-live', verified.signedIn && verified.basis === 'verified-live', JSON.stringify(verified))
  const expired = slotSigninState(authed, { [SCOPE_DIR]: { state: 'expired', snapshotEmail: 'stale@fixture.example' } })
  check('expired ⇒ NOT signed in (the credential exists; the row calls it expired)', !expired.signedIn && expired.basis === 'expired', JSON.stringify(expired))
  const signedOut = slotSigninState(authed, { [SCOPE_DIR]: { state: 'signed-out' } })
  check('signed-out ⇒ NOT signed in', !signedOut.signedIn && signedOut.basis === 'signed-out')
  const offline = slotSigninState(authed, { [SCOPE_DIR]: { state: 'unverified', email: 'stale@fixture.example', note: 'offline (TypeError)' } })
  check('the labelled offline snapshot is NEVER a sign-in', !offline.signedIn && offline.basis === 'unverified', JSON.stringify(offline))
  const checking = slotSigninState(authed, { [SCOPE_DIR]: { state: 'checking' } })
  check('an in-flight probe is not a sign-in yet (checking)', !checking.signedIn && checking.basis === 'checking')
  const unstarted = slotSigninState(authed, {})
  check('a probe that has not started reads checking, never the scan’s existence bit', !unstarted.signedIn && unstarted.basis === 'checking', JSON.stringify(unstarted))
  // PRESENCE OUTRANKS THE CACHE: a scope whose store holds no login is
  // signed out whatever the identity read says — a verification cached
  // before the removal, a probe in flight, a snapshot that outlived the
  // login (the stale-row class: "verified live" under a family header
  // that said no credential existed).
  const outlived = scopeSlot(false)
  const cachedVerified = slotSigninState(outlived, { [SCOPE_DIR]: { state: 'verified', email: 'stale@fixture.example' } })
  check('no stored login + a cached VERIFIED read ⇒ signed out (the presence owner outranks the cache)', !cachedVerified.signedIn && cachedVerified.basis === 'signed-out', JSON.stringify(cachedVerified))
  const pending = slotSigninState(outlived, {})
  check("no stored login + no probe yet ⇒ signed out, never 'checking'", !pending.signedIn && pending.basis === 'signed-out')
  // The row words over the derivation — ONE composer, snapshot-first,
  // never dressed as verified.
  const staleSnapshot: AccountSlot = {
    ...outlived,
    identity: 'stale@fixture.example',
    scope: { ...outlived.scope!, email: 'stale@fixture.example', uuid: 'uuid-fixture' },
  }
  const staleState = slotSigninState(staleSnapshot, { [SCOPE_DIR]: { state: 'verified', email: 'stale@fixture.example' } })
  check("a snapshot that outlived its login says so and names re-login and ⌫ — never 'verified live'",
    staleState.basis === 'signed-out' &&
      scopeSlotTail(staleState, { state: 'verified', email: 'stale@fixture.example' }, staleSnapshot) ===
        'snapshot stale@fixture.example — signed out · ↵ opens Logins to re-login · ⌫ clears the snapshot',
    scopeSlotTail(staleState, { state: 'verified', email: 'stale@fixture.example' }, staleSnapshot))
  check("no login, no snapshot ⇒ the family's absent words (the one template)", scopeSlotTail(pending, undefined, outlived) === 'not signed in · ↵ names the route — /logins anthropic or ANTHROPIC_API_KEY', scopeSlotTail(pending, undefined, outlived))
  // THE ONE ROW GRAMMAR: every absent family paints the same template —
  // "<state> · ↵ names the route — <route>" — the route spelled once from
  // the /logins command and the family's first env spelling.
  const template = /^(not signed in|no server discovered) · ↵ names the route — .+$/
  const expected: Record<string, string> = {
    anthropic: 'not signed in · ↵ names the route — /logins anthropic or ANTHROPIC_API_KEY',
    openai: 'not signed in · ↵ names the route — /logins openai or OPENAI_API_KEY',
    zai: 'not signed in · ↵ names the route — /logins zai or ZAI_API_KEY',
    openrouter: 'not signed in · ↵ names the route — /logins openrouter or OPENROUTER_API_KEY',
    gemini: 'not signed in · ↵ names the route — /logins gemini or GEMINI_API_KEY',
    moonshot: 'not signed in · ↵ names the route — /logins moonshot or MOONSHOT_API_KEY',
    deepseek: 'not signed in · ↵ names the route — /logins deepseek or DEEPSEEK_API_KEY',
    huggingface: 'not signed in · ↵ names the route — /logins huggingface or HF_TOKEN',
    'openai-compat': 'not signed in · ↵ names the route — MERCURY_COMPAT_BASE_URL configures the endpoint (key optional — /router key compat)',
    local: 'no server discovered · ↵ names the route — Ollama · LM Studio · vLLM · llama.cpp, or MERCURY_LOCAL_BASE_URL',
  }
  for (const [family, words] of Object.entries(expected)) {
    check(`the absent row template holds for ${family}`, slots.familyAbsentWords(family) === words && template.test(words), slots.familyAbsentWords(family))
  }
  check('an unknown family is never silent — the generic /logins route in the same template', slots.familyAbsentWords('acme') === 'not signed in · ↵ names the route — /logins')
  check("Anthropic's route words are the same composer's (no family keeps its own)", slots.familyRouteWords('anthropic') === '/logins anthropic or ANTHROPIC_API_KEY')
  check('a probe in flight paints the snapshot LABELLED as one (snapshot-first), then verifies', scopeSlotTail(unstarted, undefined, authed) === 'snapshot stale@fixture.example · verifying identity…', scopeSlotTail(unstarted, undefined, authed))
  check('a verified probe paints the LIVE email as verified', scopeSlotTail(verified, { state: 'verified', email: 'live@fixture.example' }, authed) === 'live@fixture.example · verified live · ↵ opens Logins to re-login · ⌫ signs out')
  check('an expired probe labels the snapshot and never counts', scopeSlotTail(expired, { state: 'expired', snapshotEmail: 'stale@fixture.example' }, authed) === 'expired (snapshot stale@fixture.example) · not signed in · ↵ opens Logins to reauth')
  const excluded = slotSigninState(scopeSlot(true, true), { [SCOPE_DIR]: { state: 'verified', email: 'x@y' } })
  check("a foreign Claude-family scope is excluded even when its credential verifies", !excluded.signedIn && excluded.basis === 'excluded')
  const stored = slotSigninState(keySlot('zai', false), {})
  check('a stored key counts by presence, labelled credential-present', stored.signedIn && stored.basis === 'credential-present')
  const sub = slotSigninState(subscriptionSlot, {})
  check('the ChatGPT subscription counts by presence (no live probe on this board)', sub.signedIn && sub.basis === 'credential-present')
  const absent = slotSigninState({ ...keySlot('zai', false), signedIn: false }, {})
  check('a non-scope slot without a credential is absent', !absent.signedIn && absent.basis === 'absent')
}

section("§2 the family header counts the SAME derivation the row paints (the operator's shape)")
{
  const expiredRead = { [SCOPE_DIR]: { state: 'expired' as const, snapshotEmail: 'stale@fixture.example' } }
  const anthropic = [scopeSlot(true)]
  const before = anthropic.filter(slot => slot.signedIn).length
  check('BEFORE (existence): the scan’s authed bit counted 1 sign-in', before === 1, String(before))
  const after = familySigninCount(anthropic, expiredRead)
  check('AFTER (one derivation): the expired credential counts ZERO sign-ins', after === 0, String(after))
  const header = familySigninHeaderNote('anthropic', anthropic, expiredRead)
  check("the Anthropic header reads ' · 0/2 signed in'", header === ' · 0/2 signed in', header)
  const openaiHeader = familySigninHeaderNote('openai', [subscriptionSlot], {})
  check("the OpenAI header reads ' · 1/2 signed in' (the subscription is present)", openaiHeader === ' · 1/2 signed in', openaiHeader)
  const verifiedHeader = familySigninHeaderNote('anthropic', anthropic, { [SCOPE_DIR]: { state: 'verified', email: 'live@fixture.example' } })
  check("a verified scope reads ' · 1/2 signed in'", verifiedHeader === ' · 1/2 signed in', verifiedHeader)
  const checkingHeader = familySigninHeaderNote('anthropic', anthropic, {})
  check('an in-flight probe is NAMED beside the count, never counted', checkingHeader === ' · 0/2 signed in · verifying…', checkingHeader)
  const offlineHeader = familySigninHeaderNote('anthropic', anthropic, { [SCOPE_DIR]: { state: 'unverified', email: 'stale@fixture.example', note: 'offline' } })
  check('an offline fallback is NAMED beside the count, never counted', offlineHeader === ' · 0/2 signed in · 1 unverified (offline)', offlineHeader)
  const withKey = familySigninSummary([scopeSlot(true), keySlot('anthropic', false)], expiredRead)
  check('a Mercury-held key still counts beside an expired scope (held 1, signedIn 1)', withKey.held === 1 && withKey.signedIn === 1, JSON.stringify(withKey))
  const envPinned = familySigninSummary([keySlot('zai', true), keySlot('zai', false)], {})
  check('env pins are signed in but never Mercury-HELD (signedIn 2, held 1)', envPinned.signedIn === 2 && envPinned.held === 1, JSON.stringify(envPinned))
  check('no ceiling ⇒ no header note (the plain count chip paints)', familySigninHeaderNote('zai', [keySlot('zai', false)], {}) === '')
}

section('§3 mainLoopIdentity — the route decides the family, the owner decides the credential')
{
  const presences = (overrides: Partial<Record<string, Partial<Presence>>> = {}): Presence[] =>
    (
      [
        { id: 'anthropic', available: true, credentialed: true, credentialLabel: 'Claude subscription (max)' },
        { id: 'openai', available: true, credentialed: true, credentialLabel: 'ChatGPT plus subscription' },
        { id: 'zai', available: true, credentialed: false },
        { id: 'local', available: true, credentialed: true, credentialLabel: 'Ollama :11434 (keyless)' },
      ] as Presence[]
    ).map(presence => ({ ...presence, ...(overrides[presence.id as string] ?? {}) }) as Presence)
  const anthropicExpired = { state: 'expired' as const, snapshotEmail: 'stale@fixture.example' }

  const onGpt = mainLoopIdentity({ model: 'gpt-5.6-sol', presences: presences(), currentScopeIdentity: anthropicExpired })
  check('route OpenAI ⇒ the OpenAI family', onGpt.route === 'openai' && onGpt.family === 'OpenAI')
  check('…names the subscription, labelled by presence', onGpt.text === 'ChatGPT plus subscription · credential present' && onGpt.basis === 'credential-present', onGpt.text)
  check('…and the Anthropic snapshot email appears NOWHERE on it', !onGpt.text.includes('fixture.example'))

  const verified = mainLoopIdentity({ model: 'claude-opus-5', presences: presences(), currentScopeIdentity: { state: 'verified', email: 'live@fixture.example' } })
  check('route Anthropic + verified ⇒ the live identity', verified.text === 'live@fixture.example · verified live' && verified.basis === 'verified-live', verified.text)

  const expired = mainLoopIdentity({ model: 'claude-opus-5', presences: presences(), currentScopeIdentity: anthropicExpired })
  check("route Anthropic + expired ⇒ 'not signed in', the snapshot labelled as a snapshot", expired.basis === 'expired' && expired.text.startsWith('not signed in') && expired.text.includes('(snapshot stale@fixture.example)'), expired.text)

  const signedOut = mainLoopIdentity({ model: 'claude-opus-5', presences: presences(), currentScopeIdentity: { state: 'signed-out' } })
  check("route Anthropic + signed-out ⇒ 'not signed in — /logins anthropic'", signedOut.text === 'not signed in — /logins anthropic' && signedOut.basis === 'not-signed-in', signedOut.text)

  const absent = mainLoopIdentity({ model: 'claude-opus-5', presences: presences({ anthropic: { credentialed: false, credentialLabel: undefined } }), currentScopeIdentity: undefined })
  check("no Anthropic credential ⇒ 'not signed in — /logins anthropic' (no probe consulted)", absent.text === 'not signed in — /logins anthropic', absent.text)

  const offline = mainLoopIdentity({ model: 'claude-opus-5', presences: presences(), currentScopeIdentity: { state: 'unverified', email: 'stale@fixture.example', note: 'offline (TypeError)' } })
  check('offline ⇒ unverified, the snapshot labelled, never dressed as verified', offline.basis === 'unverified' && offline.text.includes('unverified — offline') && offline.text.includes('snapshot stale@fixture.example') && !offline.text.includes('verified live'), offline.text)

  const checking = mainLoopIdentity({ model: 'claude-opus-5', presences: presences(), currentScopeIdentity: { state: 'checking' } })
  check('in flight ⇒ verifying; no identity claimed when the store recorded none', checking.basis === 'checking' && checking.text.endsWith('verifying identity…') && !checking.text.includes('fixture.example'), checking.text)
  const checkingSnapshot = mainLoopIdentity({ model: 'claude-opus-5', presences: presences({ anthropic: { identity: 'snap@fixture.example' } }), currentScopeIdentity: { state: 'checking' } })
  check('in flight with a stored identity ⇒ the snapshot paints first, LABELLED, then verifies (never dressed as verified)', checkingSnapshot.basis === 'checking' && checkingSnapshot.text === 'Claude subscription (max) · snapshot snap@fixture.example · verifying identity…', checkingSnapshot.text)

  const key = mainLoopIdentity({ model: 'claude-opus-5', presences: presences({ anthropic: { credentialLabel: 'Anthropic API key' } }), currentScopeIdentity: anthropicExpired })
  check('an Anthropic API key bills itself — presence-labelled, the scope probe not consulted', key.text === 'Anthropic API key · credential present' && key.basis === 'credential-present', key.text)

  const bearer = mainLoopIdentity({ model: 'claude-opus-5', presences: presences({ anthropic: { credentialLabel: 'Anthropic bearer token (ANTHROPIC_AUTH_TOKEN)' } }), currentScopeIdentity: undefined })
  check('an env bearer token names itself', bearer.text === 'Anthropic bearer token (ANTHROPIC_AUTH_TOKEN) · credential present', bearer.text)

  const cc = mainLoopIdentity({ model: 'claude-opus-5', presences: presences(), currentScopeIdentity: { state: 'verified', email: 'x@y' }, currentScopeClaudeFamily: true })
  check('a foreign Claude-family scope is excluded on the main-loop row too', cc.basis === 'excluded' && !cc.text.includes('x@y'))

  const zai = mainLoopIdentity({ model: 'glm-5.3', presences: presences() })
  check("route Z.AI without a key ⇒ 'not signed in — /logins zai' (the picker's attach home)", zai.text === 'not signed in — /logins zai' && zai.family === 'Z.AI', zai.text)

  const local = mainLoopIdentity({ model: 'local/qwen3:8b', presences: presences() })
  check('a discovered local server is a live fact (discovered live)', local.basis === 'discovered-live' && local.text.endsWith('· discovered live'), local.text)
}

section('§4 the REAL owners on the fixture home (credential refused live, subscription present)')
{
  const { resolveLiveScopeIdentity, _resetIdentityCacheForTesting } = await import('../../src/utils/accounts/accountIdentity.ts')
  const { providerFamilyPresences } = await import('../../src/services/providers/providerUsage.ts')
  const { isClaudeAISubscriber } = await import('../../src/utils/auth.ts')
  check('the fixture credential reads as a Claude subscriber (existence, through the real owner)', isClaudeAISubscriber() === true)

  const groups = deriveFamilySlotGroups()
  const anthropic = groups.find(group => group.family.id === 'anthropic')
  const openai = groups.find(group => group.family.id === 'openai')
  const scope = anthropic?.slots.find(slot => slot.scope !== undefined)
  check('the Anthropic scope slot derives with signedIn=true (a credential EXISTS)', scope?.signedIn === true && scope.scope?.dir === home, JSON.stringify(scope?.scope))
  check('the OpenAI subscription slot derives from the fixture file', openai?.slots.some(slot => slot.kind === 'subscription') === true, JSON.stringify(openai?.slots.map(slot => slot.id)))

  _resetIdentityCacheForTesting()
  const refused = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
  const identity = await resolveLiveScopeIdentity(home, { fetchImpl: refused })
  check('the live verification of the REAL credential file reads expired (401)', identity.state === 'expired' && identity.snapshotEmail === 'stale@fixture.example', JSON.stringify(identity))
  const identities = { [home]: identity }

  const beforeCount = anthropic!.slots.filter(slot => slot.signedIn && !slot.envPinned).length
  const afterNote = familySigninHeaderNote('anthropic', anthropic!.slots, identities)
  console.log(`    before: Anthropic accounts · ${beforeCount}/2 signed in   (existence)`)
  console.log(`    after : Anthropic accounts${afterNote}   (the row: expired (snapshot stale@fixture.example) · not signed in)`)
  check('BEFORE: existence counted 1/2', beforeCount === 1)
  check("AFTER: the header reads ' · 0/2 signed in' over the expired row", afterNote === ' · 0/2 signed in', afterNote)
  const openaiNote = familySigninHeaderNote('openai', openai!.slots, identities)
  check("the OpenAI header reads ' · 1/2 signed in'", openaiNote === ' · 1/2 signed in', openaiNote)

  const presences = providerFamilyPresences()
  const anthropicPresence = presences.find(presence => (presence.id as string) === 'anthropic')
  const openaiPresence = presences.find(presence => (presence.id as string) === 'openai')
  check('the presence owner reads the Anthropic credential as PRESENT (existence by contract)', anthropicPresence?.credentialed === true && anthropicPresence.credentialLabel === 'Claude subscription (max)', JSON.stringify(anthropicPresence))
  check('the presence owner reads the OpenAI subscription as present', openaiPresence?.credentialed === true, JSON.stringify(openaiPresence))

  const snapshot = (JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as { oauthAccount: { emailAddress: string } }).oauthAccount.emailAddress
  console.log(`    before: main loop · ${snapshot} (snapshot)`)
  const onGpt = mainLoopIdentity({ model: 'gpt-5.6-sol', presences, currentScopeIdentity: identity })
  console.log(`    after : main loop · ${onGpt.family} · ${onGpt.text}`)
  check('the main loop on a GPT model names the OpenAI subscription', onGpt.route === 'openai' && onGpt.basis === 'credential-present' && /ChatGPT|subscription/i.test(onGpt.text), onGpt.text)
  check('…and never the Anthropic snapshot', !onGpt.text.includes(snapshot))
  const onClaude = mainLoopIdentity({ model: 'claude-opus-5', presences, currentScopeIdentity: identity })
  console.log(`    after (Anthropic route): main loop · ${onClaude.family} · ${onClaude.text}`)
  check("the main loop on an Anthropic model reads 'not signed in — credential expired (snapshot …)'", onClaude.basis === 'expired' && onClaude.text.includes(`(snapshot ${snapshot})`) && onClaude.text.startsWith('not signed in'), onClaude.text)
}

section('§5 the presence owner counts what the wire would send')
{
  const { anthropicCredentialPresence } = await import('../../src/services/providers/providerUsage.ts')
  const bearer = anthropicCredentialPresence({
    claudeSubscriber: () => false,
    anthropicApiKeyPresent: () => false,
    bearerTokenSource: () => ({ source: 'ANTHROPIC_AUTH_TOKEN', hasToken: true }),
  })
  check('ANTHROPIC_AUTH_TOKEN alone is a credential (the API client sends it)', bearer.credentialed && bearer.credentialLabel === 'Anthropic bearer token (ANTHROPIC_AUTH_TOKEN)', JSON.stringify(bearer))
  const none = anthropicCredentialPresence({
    claudeSubscriber: () => false,
    anthropicApiKeyPresent: () => false,
    bearerTokenSource: () => ({ source: 'none', hasToken: false }),
  })
  check('nothing anywhere ⇒ not credentialed', !none.credentialed && none.credentialLabel === undefined)
  const subscriber = anthropicCredentialPresence({
    claudeSubscriber: () => true,
    subscriptionType: () => 'max',
    anthropicApiKeyPresent: () => false,
    bearerTokenSource: () => ({ source: 'claude.ai', hasToken: true }),
  })
  check('the subscription keeps its own label (the bearer read names the same login)', subscriber.credentialLabel === 'Claude subscription (max)')
  const helperOnly = anthropicCredentialPresence({
    claudeSubscriber: () => false,
    anthropicApiKeyPresent: () => false,
    bearerTokenSource: () => ({ source: 'apiKeyHelper', hasToken: true }),
  })
  check('a configured helper with no key yet is the key ladder’s to report, never a bearer', !helperOnly.credentialed)
}

section('§6 the board wires the seam (structural)')
{
  const board = readFileSync(join(import.meta.dir, '../../src/components/mercury-ui/parity/AccountView.tsx'), 'utf8')
  check('the header counts through familySigninSummary / familySigninHeaderNote', board.includes('familySigninSummary(group.slots, identities).signedIn') && board.includes('familySigninHeaderNote(group.family.id, group.slots, identities)'))
  check("the scope row paints from slotSigninState through the seam's ONE row composer", board.includes('const state = slotSigninState(slot, identities)') && board.includes('scopeSlotTail(state, id, slot)') && !board.includes('function identityTail('))
  check('the main-loop row derives from mainLoopIdentity over the main model', board.includes('mainLoopIdentity({') && board.includes('model: mainLoopModel,'))
  check("no snapshot is dressed as the billing identity (the old '(snapshot)' fallback is gone)", !board.includes("`${acct.emailAddress} (snapshot)`"))
  check('the org fact is labelled a snapshot and rides only a verified Anthropic main loop', board.includes("mainLoop.basis === 'verified-live' && acct?.organizationName"))
  const seam = readFileSync(join(import.meta.dir, '../../src/services/providers/accountSlots.ts'), 'utf8')
  check('the seam states the existence/validity split on the slot field', seam.includes('existence, never validity') && seam.includes('export function slotSigninState('))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('ACCOUNTS HONESTY: ALL GREEN')
else console.log(`❌ ${failures} ACCOUNTS-HONESTY LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
