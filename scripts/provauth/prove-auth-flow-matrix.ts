#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' PROVAUTH — the auth flow matrix: ten families × six arms')
console.log('============================================================')

for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_API_KEY',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_USAGE_SEED',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
const home = mkdtempSync(join(tmpdir(), 'authhard-matrix-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_AUTH_SCOPE_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.js')
type UsabilityReads = NonNullable<Parameters<typeof resolveProviderUsability>[0]>
const { activeSourceUsage, anthropicCredentialPresence } = await import(
  '../../src/services/providers/providerUsage.js'
)
const accountSlots = await import('../../src/services/providers/accountSlots.js')
const {
  slotSigninState,
  mainLoopIdentity,
  executeSlotRemoval,
  signinCeilingRefusal,
  familySigninCeiling,
} = accountSlots
type AccountSlotT = import('../../src/services/providers/accountSlots.js').AccountSlot
const { classifyCredentialWall, credentialWallLine, reconnectDoorFor, isRevokedSignInText } =
  await import('../../src/services/providers/credentialWall.js')
const { compatFaultToTypedError } = await import(
  '../../src/services/providers/openaicompat/compatChatCallModel.js'
)
const { loginFamilyRows, loginFamilyFocusFor } = await import(
  '../../src/components/loginFamilyRows.js'
)
const { isAnthropicOAuthSignInExpired, clearOAuthTokenCache } = await import(
  '../../src/utils/auth.js'
)
const gemini = await import('../../src/services/providers/gemini/geminiAccounts.js')
const openaiAcc = await import('../../src/services/providers/openai/openaiAccounts.js')
const moonshot = await import('../../src/services/providers/moonshot/moonshotAccounts.js')
const huggingface = await import(
  '../../src/services/providers/huggingface/huggingfaceAccounts.js'
)
const { writeStoredZaiApiKey, readStoredZaiApiKey } = await import(
  '../../src/utils/router/providerSecrets.js'
)

const SEAT_ABSENT_REASON = 'no OpenAI account — /logins openai connects one'
const absentReads: UsabilityReads = {
  anthropicApiKey: () => null,
  anthropicSubscriber: () => false,
  anthropicBearerToken: () => false,
  anthropicLimitStatus: () => 'allowed',
  gptSeat: () => ({ state: 'disabled', reason: SEAT_ABSENT_REASON, why: 'no-account' }),
  zaiKeyPresent: () => false,
  moonshotAccount: () => undefined,
  deepseekKeyPresent: () => false,
  compatConfigured: () => false,
  huggingfaceAccount: () => undefined,
  localServerPresent: () => false,
  openrouterKeyPresent: () => false,
  geminiAccount: () => undefined,
}

section('§0 the grid: families × arms, every cell accounted')

const ARMS = [
  'sign-in',
  'refresh',
  'expiry-at-rest',
  'expiry-mid-flight',
  'revocation',
  're-login',
] as const
type Arm = (typeof ARMS)[number]

const families = Object.keys(resolveProviderUsability(absentReads)).sort()

const DRIVEN: Record<Arm, readonly string[]> = {
  'sign-in': families,
  refresh: ['anthropic', 'openai', 'gemini', 'moonshot', 'huggingface'],
  'expiry-at-rest': ['anthropic', 'openai', 'moonshot', 'huggingface'],
  'expiry-mid-flight': families,
  revocation: families,
  're-login': families,
}

const ABSENT: Partial<Record<string, Partial<Record<Arm, string>>>> = {
  openrouter: {
    refresh:
      'the OAuth connect mints a KEY, not a refreshable token pair — no refresh protocol exists; a spent key surfaces as the key-limit wall (mid-flight arm)',
    'expiry-at-rest':
      'a key states no expiry and the no-probe law forbids asking at rest — the wire speaks at the send; the observed key-cap latch is the mid-flight arm',
  },
  zai: {
    refresh: 'a stored API key has no refresh protocol — honest absence',
    'expiry-at-rest':
      'a key states no expiry; validity is unknowable at rest (no probe by law) — the wire speaks at the send',
  },
  deepseek: {
    refresh: 'a stored API key has no refresh protocol — honest absence',
    'expiry-at-rest':
      'a key states no expiry; validity is unknowable at rest (no probe by law) — the wire speaks at the send',
  },
  'openai-compat': {
    refresh: 'a configured endpoint key has no refresh protocol — honest absence',
    'expiry-at-rest':
      'a key states no expiry; validity is unknowable at rest (no probe by law) — the wire speaks at the send',
  },
  local: {
    refresh: 'discovery is the credential — a server answers or its row leaves; nothing refreshes',
    'expiry-at-rest':
      'a discovered server has no expiry; the next probe is the truth (the row leaves when it stops answering)',
  },
  gemini: {
    'expiry-at-rest':
      'Google sign-ins always carry a refresh token — a clock-expired set refreshes at use (the refreshable-expiry law, §2); no stranded at-rest state exists to paint',
  },
}

check('the family set is the resolver’s ten (or the grid grew and the cells below must follow)', families.length === 10, families.join(', '))
{
  let driven = 0
  let absent = 0
  let holes = 0
  for (const family of families) {
    for (const arm of ARMS) {
      const isDriven = DRIVEN[arm].includes(family)
      const absentReason = ABSENT[family]?.[arm]
      if (isDriven && absentReason !== undefined) {
        holes++
        check(`${family} × ${arm}: cell is BOTH driven and absent`, false)
      } else if (isDriven) {
        driven++
      } else if (absentReason !== undefined) {
        absent++
        console.log(`  [ABSENT] ${family} × ${arm} — ${absentReason}`)
      } else {
        holes++
        check(`${family} × ${arm}: cell unaccounted (no drive, no typed absence)`, false)
      }
    }
  }
  check(
    `every cell accounted: ${driven} driven + ${absent} typed-absent = ${families.length * ARMS.length}`,
    holes === 0 && driven + absent === families.length * ARMS.length,
  )
}

const RECONNECT_DOORS: Record<string, string> = {
  anthropic: '/logins anthropic',
  openai: '/logins openai',
  zai: '/logins zai',
  moonshot: '/logins moonshot',
  deepseek: '/logins deepseek',
  openrouter: '/logins openrouter',
  gemini: '/logins gemini',
  huggingface: '/logins huggingface',
  'openai-compat': '/router key compat',
  local: '/router key local',
}

section('§1 sign-in: the signed-out answers name the right door, every family')

{
  const map = resolveProviderUsability(absentReads)
  const expectedBlocker: Record<string, string> = {
    anthropic: 'no Anthropic credential — /logins (or ANTHROPIC_API_KEY)',
    openai: SEAT_ABSENT_REASON,
    zai: 'no Z.AI API key — /logins zai (or ZAI_API_KEY)',
    moonshot: 'no Kimi sign-in or Moonshot API key — /logins moonshot (or MOONSHOT_API_KEY)',
    deepseek: 'no DeepSeek API key — /logins deepseek (or DEEPSEEK_API_KEY)',
    'openai-compat': 'no endpoint configured — MERCURY_COMPAT_BASE_URL',
    openrouter: 'no OpenRouter credential — /logins (or OPENROUTER_API_KEY)',
    gemini: 'no Gemini credential — /logins (or GOOGLE_API_KEY / GEMINI_API_KEY)',
    huggingface: 'no Hugging Face credential — /logins (or HF_TOKEN)',
    local:
      'no local server discovered — start Ollama/LM Studio/vLLM/llama.cpp-server or set MERCURY_LOCAL_BASE_URL',
  }
  for (const family of families) {
    const lane = map[family as keyof typeof map]
    check(
      `${family}: signed-out ⇒ not usable, credential 'none', typed blocker`,
      lane.usable === false && lane.credential === 'none' && lane.blockers[0] === expectedBlocker[family],
      JSON.stringify(lane.blockers),
    )
  }

  const zeroSpend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
  const expectedWhyNot: Record<string, string> = {
    anthropic: 'not connected — /logins connects Anthropic',
    openai: 'not connected — /logins connects OpenAI',
    zai: 'not connected — /logins zai adds a key',
    moonshot: 'not connected — /logins moonshot adds Kimi or a key',
    deepseek: 'not connected — /logins deepseek adds a key',
    'openai-compat': 'not configured — set MERCURY_COMPAT_BASE_URL',
    openrouter: 'not connected — /logins adds OpenRouter',
    gemini: 'not connected — /logins adds Gemini',
    huggingface: 'not connected — /logins adds Hugging Face',
    local: 'no local server — start one, or set MERCURY_LOCAL_BASE_URL',
  }
  for (const family of families) {
    const view = activeSourceUsage({
      model: 'matrix-fixture-model',
      reads: {
        route: () => family as never,
        activeEntry: () => undefined,
        spend: () => zeroSpend,
        zaiKeyPresent: () => false,
        openrouterKeyPresent: () => false,
        geminiAccount: () => undefined,
        huggingfaceAccount: () => undefined,
        localAccount: () => undefined,
        moonshotAccount: () => undefined,
        laneCredentialed: () => false,
      },
    })
    check(
      `${family}: usage card signed-out whyNot names the door`,
      view.sourceKind === 'none' && view.whyNot === expectedWhyNot[family],
      `whyNot=${JSON.stringify(view.whyNot)}`,
    )
  }

  for (const family of families) {
    check(
      `${family}: reconnectDoorFor = '${RECONNECT_DOORS[family]}'`,
      reconnectDoorFor(family) === RECONNECT_DOORS[family],
      reconnectDoorFor(family),
    )
  }

  const rows = loginFamilyRows({ engineLegs: true }).map(row => row.value)
  check(
    'the /logins catalogue carries the eight sign-in families (anthropic as claudeai+console)',
    rows.join('|') ===
      ['claudeai', 'openai', 'console', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek'].join('|'),
    rows.join('|'),
  )
  check(
    "compat and local parse NO /logins focus (their door is /router key — never a dead /logins row)",
    loginFamilyFocusFor('openai-compat') === undefined && loginFamilyFocusFor('local') === undefined,
  )
  check(
    "the eight sign-in families parse a /logins focus (anthropic → 'claudeai')",
    loginFamilyFocusFor('anthropic') === 'claudeai' &&
      (['openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek'] as const).every(
        family => loginFamilyFocusFor(family) === family,
      ),
  )
}

section('§2 refresh: rotate-on-200 stores · dead grant drops · refreshable ≠ stranded')

const PAST_MS = Date.now() - 60_000
const FUTURE_MS = Date.now() + 3_600_000
const NOW_MS = Date.now()

{
  const credentialsPath = join(home, '.credentials.json')
  const seed = (refreshToken: string | null): void => {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fixture-access-token-000000000001',
          refreshToken,
          expiresAt: PAST_MS,
          scopes: ['user:inference', 'user:profile'],
          subscriptionType: 'max',
          rateLimitTier: null,
        },
      }),
    )
    clearOAuthTokenCache()
  }
  seed('fixture-refresh-token-00000000001')
  check(
    'anthropic: expired WITH a refresh token is NOT stranded (refresh happens at use)',
    isAnthropicOAuthSignInExpired() === false,
  )
  seed(null)
  check(
    'anthropic: expired with NO refresh token IS the stranded sign-in',
    isAnthropicOAuthSignInExpired() === true,
  )
  seed('fixture-refresh-token-00000000001')
}

{
  const jwt = (expMs: number): string =>
    `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')}.s`
  const seed = (): void => {
    writeFileSync(
      openaiAcc.openaiAuthPathForDisplay(),
      JSON.stringify({
        version: 1,
        tokens: {
          idToken: 'h.e30.s',
          accessToken: jwt(PAST_MS),
          refreshToken: 'RT-OPENAI-1',
          accessTokenExpiresAtMs: PAST_MS,
        },
      }),
      { mode: 0o600 },
    )
  }
  seed()
  const rotated: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        id_token: 'h.e30.s',
        access_token: jwt(FUTURE_MS),
        refresh_token: 'RT-OPENAI-2',
        expires_in: 3600,
      }),
      { status: 200 },
    )) as unknown as typeof fetch
  const fresh = await openaiAcc.currentSubscriptionTokens({ fetchImpl: rotated })
  check(
    'openai: refresh-on-expiry rotates and PERSISTS the new set',
    fresh?.refreshToken === 'RT-OPENAI-2' &&
      openaiAcc.currentSubscriptionTokens !== undefined &&
      JSON.parse(
        (await import('node:fs')).readFileSync(openaiAcc.openaiAuthPathForDisplay(), 'utf8'),
      ).tokens.refreshToken === 'RT-OPENAI-2',
  )
  seed()
  const invalidGrant: typeof fetch = (async () =>
    new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as unknown as typeof fetch
  const refused = await openaiAcc.currentSubscriptionTokens({ fetchImpl: invalidGrant })
  const onDisk = JSON.parse(
    (await import('node:fs')).readFileSync(openaiAcc.openaiAuthPathForDisplay(), 'utf8'),
  ).tokens
  check(
    'openai: a terminal invalid_grant answers undefined and BLANKS the dead refresh token on disk',
    refused === undefined && !onDisk.refreshToken,
    JSON.stringify(onDisk.refreshToken),
  )
}

{
  const geminiEnv = { ...process.env, MERCURY_GEMINI_OAUTH_CLIENT_ID: 'client-fixture' }
  gemini.__resetGeminiAccountsForTest()
  const seed = (): void => {
    writeFileSync(
      gemini.geminiAuthPathForDisplay(),
      JSON.stringify({
        version: 1,
        tokens: { accessToken: 'OLD', refreshToken: 'RT-GEM-1', accessTokenExpiresAtMs: PAST_MS },
      }),
      { mode: 0o600 },
    )
  }
  seed()
  const rotated: typeof fetch = (async () =>
    new Response(JSON.stringify({ access_token: 'NEW', expires_in: 3600 }), {
      status: 200,
    })) as unknown as typeof fetch
  const fresh = await gemini.currentGeminiTokens({ fetchImpl: rotated, env: geminiEnv })
  check('gemini: refresh-on-expiry rotates (refresh token carried forward)', fresh?.accessToken === 'NEW' && fresh?.refreshToken === 'RT-GEM-1')
  gemini.__resetGeminiAccountsForTest()
  seed()
  const invalidGrant: typeof fetch = (async () =>
    new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'revoked' }), {
      status: 400,
    })) as unknown as typeof fetch
  await gemini.currentGeminiTokens({ fetchImpl: invalidGrant, env: geminiEnv })
  check(
    'gemini: a terminal invalid_grant DROPS the stored sign-in (never re-presented)',
    gemini.geminiOauthConnected() === false,
  )
}

{
  moonshot.writeMoonshotTokens(
    { accessToken: 'OLD', refreshToken: 'RT-KIMI-1', accessTokenExpiresAtMs: PAST_MS },
    'global',
  )
  const rotated: typeof fetch = (async () =>
    new Response(
      JSON.stringify({ access_token: 'NEW', refresh_token: 'RT-KIMI-2', expires_in: 3600 }),
      { status: 200 },
    )) as unknown as typeof fetch
  const fresh = await moonshot.refreshMoonshotTokens({ fetchImpl: rotated })
  check(
    'moonshot: refresh rotates and stores the new pair',
    fresh?.accessToken === 'NEW' && moonshot.moonshotStoredTokens()?.refreshToken === 'RT-KIMI-2',
  )
  const refused: typeof fetch = (async () =>
    new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 })) as unknown as typeof fetch
  const dropped = await moonshot.refreshMoonshotTokens({ fetchImpl: refused })
  check(
    'moonshot: a refused refresh grant (401) DROPS the store (no zombie sign-in)',
    dropped === undefined && moonshot.moonshotStoredTokens() === undefined,
  )
}

{
  const hfEnv = { ...process.env, MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'client-fixture' }
  huggingface.writeHuggingfaceTokens({
    accessToken: 'OLD',
    refreshToken: 'RT-HF-1',
    accessTokenExpiresAtMs: PAST_MS,
  })
  const rotated: typeof fetch = (async () =>
    new Response(
      JSON.stringify({ access_token: 'NEW', refresh_token: 'RT-HF-2', expires_in: 3600 }),
      { status: 200 },
    )) as unknown as typeof fetch
  const fresh = await huggingface.refreshHuggingfaceTokens({ fetchImpl: rotated, env: hfEnv })
  check(
    'huggingface: refresh rotates and stores the new pair',
    fresh?.accessToken === 'NEW' && huggingface.huggingfaceStoredTokens()?.refreshToken === 'RT-HF-2',
  )
  const refused: typeof fetch = (async () =>
    new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as unknown as typeof fetch
  const dropped = await huggingface.refreshHuggingfaceTokens({ fetchImpl: refused, env: hfEnv })
  check(
    'huggingface: a refused refresh grant (400) DROPS the store (no zombie sign-in)',
    dropped === undefined && huggingface.huggingfaceStoredTokens() === undefined,
  )
}

section('§3 expiry-at-rest: the stranded states paint loud, with the right door')

{
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token-000000000001',
        refreshToken: null,
        expiresAt: PAST_MS,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: null,
      },
    }),
  )
  clearOAuthTokenCache()
  const presence = anthropicCredentialPresence({
    claudeSubscriber: () => true,
    subscriptionType: () => 'max',
    anthropicApiKeyPresent: () => false,
    bearerTokenSource: () => ({ source: 'none', hasToken: false }),
  })
  check(
    'anthropic: presence stays credentialed AND carries expired:true (present-but-dead honesty)',
    presence.credentialed === true && presence.expired === true,
    JSON.stringify(presence),
  )

  const scopeSlot = {
    family: 'anthropic',
    id: 'scope-dir-1',
    name: 'primary',
    kind: 'oauth',
    kindLabel: 'OAuth',
    identity: 'op@example.dev',
    active: true,
    envPinned: false,
    signedIn: true,
    scope: {
      name: 'primary',
      dir: 'scope-dir-1',
      isCurrent: true,
      hasConfig: true,
      authed: true,
      email: 'op@example.dev',
      claudeFamily: false,
    },
    removal: { route: 'anthropic-oauth', dir: 'scope-dir-1' },
  } as unknown as AccountSlotT
  const state = slotSigninState(scopeSlot, {
    'scope-dir-1': { state: 'expired', snapshotEmail: 'op@example.dev' } as never,
  })
  check(
    "anthropic: the slot's live-identity 'expired' answers signedIn:false, basis 'expired' (never a counted sign-in)",
    state.signedIn === false && state.basis === 'expired',
  )

  const identity = mainLoopIdentity({
    model: 'claude-fable-5',
    presences: [
      {
        id: 'anthropic' as never,
        available: true,
        credentialed: true,
        credentialLabel: 'Claude subscription (max)',
      },
    ],
    currentScopeIdentity: { state: 'expired', snapshotEmail: 'op@example.dev' } as never,
  })
  check(
    'anthropic: the main-loop identity row paints the expiry with the reauth door',
    identity.basis === 'expired' &&
      identity.text ===
        'not signed in — credential expired (snapshot op@example.dev) · ↵ on the Anthropic slot reauths',
    identity.text,
  )
}

{
  const map = resolveProviderUsability({
    ...absentReads,
    gptSeat: () => ({
      state: 'disabled',
      reason: 'OpenAI sign-in expired — /logins openai reconnects',
      why: 'auth-expired',
    }),
  })
  check(
    "openai: seat 'auth-expired' ⇒ credential 'none' + the blocker names the door",
    map.openai.credential === 'none' &&
      map.openai.usable === false &&
      map.openai.blockers[0] === 'OpenAI sign-in expired — /logins openai reconnects',
    JSON.stringify(map.openai),
  )
}

{
  const fakeProviders = families.map(id => ({
    id,
    available: true,
    description: { account: { kind: 'none' as const, label: '' } },
  })) as never
  const groups = accountSlots.deriveFamilySlotGroups(fakeProviders, {
    familyReads: {
      claudeSubscriber: () => false,
      anthropicApiKeyPresent: () => false,
      bearerTokenSource: () => ({ source: 'none', hasToken: false }),
    },
    scanScopes: () => [],
    anthropicApiKey: () => ({ key: null, source: 'none' as never }),
    openaiSubscription: () => undefined,
    openaiApiKey: () => undefined,
    openaiActiveAccount: () => undefined,
    zaiEnvKey: () => undefined,
    zaiStoredKey: () => undefined,
    zaiStoredKeyPlan: () => undefined,
    openrouterEnvKey: () => undefined,
    openrouterMintedKey: () => undefined,
    openrouterStoredKey: () => undefined,
    geminiOauthConnected: () => false,
    geminiActiveAccount: () => undefined,
    geminiEnvGoogleKey: () => undefined,
    geminiEnvGeminiKey: () => undefined,
    geminiStoredKey: () => undefined,
    moonshotEnvKey: () => undefined,
    moonshotStoredKey: () => undefined,
    moonshotOauth: () => ({
      accessToken: 'kimi-access-token-0000000001',
      accessTokenExpiresAtMs: PAST_MS,
    }),
    moonshotOauthRegion: () => 'global' as const,
    deepseekEnvKey: () => undefined,
    deepseekStoredKey: () => undefined,
    compatEnvKey: () => undefined,
    compatStoredKey: () => undefined,
    huggingfaceEnvKey: () => undefined,
    huggingfaceOauth: () => ({
      accessToken: 'hf-access-token-000000000001',
      accessTokenExpiresAtMs: PAST_MS,
    }),
    huggingfaceOauthIdentity: () => undefined,
    huggingfaceStoredKey: () => undefined,
    huggingfaceStoredKeyIdentity: () => undefined,
    localEnvKey: () => undefined,
    localStoredKey: () => undefined,
    localAccount: () => undefined,
  })
  const kimi = groups.find(g => (g.family.id as string) === 'moonshot')?.slots.find(s => s.kind === 'oauth')
  check(
    'moonshot: an expired unrefreshable Kimi sign-in reads signed-out, inactive, with the door in its note',
    kimi !== undefined &&
      kimi.signedIn === false &&
      kimi.active === false &&
      kimi.stateNote === 'access token expired with no refresh route — /logins moonshot signs in again',
    JSON.stringify(kimi?.stateNote),
  )
  const hf = groups.find(g => (g.family.id as string) === 'huggingface')?.slots.find(s => s.kind === 'oauth')
  check(
    'huggingface: an expired unrefreshable sign-in reads signed-out, inactive, with the door in its note',
    hf !== undefined &&
      hf.signedIn === false &&
      hf.active === false &&
      hf.stateNote === 'access token expired with no refresh route — /logins reconnects Hugging Face',
    JSON.stringify(hf?.stateNote),
  )
}

{
  const geminiEnv = { ...process.env, MERCURY_GEMINI_OAUTH_CLIENT_ID: 'client-fixture' }
  const geminiUsability = (): ReturnType<typeof resolveProviderUsability>['gemini'] =>
    resolveProviderUsability({
      ...absentReads,
      geminiAccount: () => (gemini.geminiOauthRef() !== undefined ? { kind: 'oauth' as const } : undefined),
    }).gemini
  gemini.__resetGeminiAccountsForTest()
  writeFileSync(
    gemini.geminiAuthPathForDisplay(),
    JSON.stringify({
      version: 1,
      tokens: { accessToken: 'DEAD', refreshToken: '', accessTokenExpiresAtMs: PAST_MS },
    }),
    { mode: 0o600 },
  )
  const corrupted = geminiUsability()
  check(
    'gemini hostile store (no refresh token, expired access): honest signed-out — connected=false, no ref, the /logins blocker',
    gemini.geminiOauthConnected() === false &&
      gemini.geminiOauthRef() === undefined &&
      corrupted.usable === false &&
      corrupted.blockers.join(' ').includes('/logins'),
    `connected=${gemini.geminiOauthConnected()} blockers=${JSON.stringify(corrupted.blockers)}`,
  )
  gemini.__resetGeminiAccountsForTest()
  writeFileSync(
    gemini.geminiAuthPathForDisplay(),
    JSON.stringify({
      version: 1,
      tokens: { accessToken: 'OLD', refreshToken: 'RT-REVOKED', accessTokenExpiresAtMs: PAST_MS },
    }),
    { mode: 0o600 },
  )
  const atRest = geminiUsability()
  check(
    'gemini revoked-but-present at rest: refreshable presence (usable, oauth credential) — never a stranded at-rest claim',
    gemini.geminiOauthConnected() === true && atRest.usable === true && atRest.credential === 'oauth',
    `connected=${gemini.geminiOauthConnected()} usable=${atRest.usable} credential=${String(atRest.credential)}`,
  )
  const invalidGrant: typeof fetch = (async () =>
    new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'revoked' }), {
      status: 400,
    })) as unknown as typeof fetch
  await gemini.currentGeminiTokens({ fetchImpl: invalidGrant, env: geminiEnv })
  const afterUse = geminiUsability()
  check(
    'gemini revoked-but-present after first use: the drop law flips every surface to honest signed-out with the /logins door',
    gemini.geminiOauthConnected() === false &&
      afterUse.usable === false &&
      afterUse.blockers.join(' ').includes('/logins'),
    `connected=${gemini.geminiOauthConnected()} blockers=${JSON.stringify(afterUse.blockers)}`,
  )
  gemini.__resetGeminiAccountsForTest()
}

section('§4 expiry-mid-flight: the wall classifies, the line names the family and the door')

{
  check(
    "revoked sign-in, 401 spelling ('OAuth access token has been revoked') → 'sign-in'",
    classifyCredentialWall(401, '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}') === 'sign-in',
  )
  check(
    "revoked sign-in, 403 spelling ('OAuth token has been revoked') → 'sign-in'",
    classifyCredentialWall(403, 'OAuth token has been revoked') === 'sign-in',
  )
  check(
    "OpenRouter key limit, 403 'Key limit exceeded' → 'key-limit'",
    classifyCredentialWall(403, '{"error":{"message":"Key limit exceeded","code":403}}') === 'key-limit',
  )
  check('a 429 is never a wall (rate limits keep their own presenter)', classifyCredentialWall(429, 'Key limit exceeded') === undefined)
  check('an expired-token word is never the revoked wall (the refresh lap owns it)', isRevokedSignInText('access token expired') === false)

  for (const family of families) {
    const line = credentialWallLine(family, 'sign-in')
    check(
      `${family}: wall line names the door (${RECONNECT_DOORS[family]})`,
      line.includes(RECONNECT_DOORS[family]) && line.includes('switch providers (/model)'),
      line,
    )
  }
  const headless = credentialWallLine('anthropic', 'sign-in', { nonInteractive: true })
  check(
    'headless spelling names --model and the interactive door honestly',
    headless.includes('--model') && headless.includes('in an interactive session'),
    headless,
  )
  const keyLimitLine = credentialWallLine('openrouter', 'key-limit')
  check(
    "the key-limit line offers 'connect another key' with the family door",
    keyLimitLine.includes('key limit reached') && keyLimitLine.includes('/logins openrouter'),
    keyLimitLine,
  )

  const fault = (status: number): Parameters<typeof compatFaultToTypedError>[0] =>
    ({ kind: 'http', code: `http-${status}`, status }) as never
  check("401 → 'authentication_failed'", compatFaultToTypedError(fault(401)) === 'authentication_failed')
  check("403 → 'authentication_failed'", compatFaultToTypedError(fault(403)) === 'authentication_failed')
  check("402 → 'billing_error'", compatFaultToTypedError(fault(402)) === 'billing_error')
  check("429 → 'rate_limit'", compatFaultToTypedError(fault(429)) === 'rate_limit')
}

section('§5 revocation: routed removals, honest notes, env pins refused as the shell’s')

{
  const fired: string[] = []
  const owner = (name: string) => () => void fired.push(name)
  const owners = {
    disconnectOpenaiSubscription: owner('openai-subscription'),
    clearStoredOpenaiKey: owner('openai-stored-key'),
    clearStoredZaiKey: owner('zai-stored-key'),
    disconnectOpenrouterOauthKey: owner('openrouter-oauth-key'),
    clearStoredOpenrouterKey: owner('openrouter-stored-key'),
    disconnectGeminiOauth: owner('gemini-oauth'),
    clearStoredGeminiKey: owner('gemini-stored-key'),
    clearStoredMoonshotKey: owner('moonshot-stored-key'),
    disconnectMoonshotOauth: owner('moonshot-oauth'),
    clearStoredDeepseekKey: owner('deepseek-stored-key'),
    clearStoredCompatKey: owner('compat-stored-key'),
    disconnectHuggingfaceOauth: owner('huggingface-oauth'),
    clearStoredHuggingfaceKey: owner('huggingface-stored-key'),
    clearStoredLocalKey: owner('local-stored-key'),
    clearManagedAnthropicKey: owner('anthropic-managed-key'),
    signOutAnthropicOauth: owner('anthropic-oauth'),
    openaiApiKeyAfter: () => undefined,
  }
  const slot = (family: string, removal: AccountSlotT['removal'], signedIn = true): AccountSlotT =>
    ({
      family,
      id: `${family}:fixture`,
      name: 'fixture',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: 'fixture',
      active: true,
      envPinned: removal.route === 'env',
      signedIn,
      removal,
    }) as AccountSlotT

  const routed: Array<{ family: string; removal: AccountSlotT['removal']; note: string }> = [
    { family: 'anthropic', removal: { route: 'anthropic-oauth', dir: 'scope-dir-1' }, note: 'tokens revoked and dropped' },
    { family: 'anthropic', removal: { route: 'anthropic-managed-key' }, note: 'config + keychain' },
    { family: 'openai', removal: { route: 'openai-subscription' }, note: 'tokens dropped' },
    { family: 'openai', removal: { route: 'openai-stored-key' }, note: 'auth-scoped store' },
    { family: 'zai', removal: { route: 'zai-stored-key' }, note: 'auth-scoped store' },
    { family: 'openrouter', removal: { route: 'openrouter-oauth-key' }, note: 'openrouter.ai → Settings → Keys' },
    { family: 'openrouter', removal: { route: 'openrouter-stored-key' }, note: 'auth-scoped store' },
    { family: 'gemini', removal: { route: 'gemini-oauth' }, note: 'myaccount.google.com → Security → Third-party access' },
    { family: 'gemini', removal: { route: 'gemini-stored-key' }, note: 'auth-scoped store' },
    { family: 'moonshot', removal: { route: 'moonshot-oauth' }, note: 'region choice stays remembered' },
    { family: 'moonshot', removal: { route: 'moonshot-stored-key' }, note: 'auth-scoped store' },
    { family: 'deepseek', removal: { route: 'deepseek-stored-key' }, note: 'auth-scoped store' },
    { family: 'openai-compat', removal: { route: 'compat-stored-key' }, note: 'auth-scoped store' },
    { family: 'huggingface', removal: { route: 'huggingface-oauth' }, note: 'Connected applications' },
    { family: 'huggingface', removal: { route: 'huggingface-stored-key' }, note: 'auth-scoped store' },
    { family: 'local', removal: { route: 'local-stored-key' }, note: 'auth-scoped store' },
  ]
  for (const row of routed) {
    fired.length = 0
    const result = executeSlotRemoval(slot(row.family, row.removal), owners)
    check(
      `${row.family}: ${row.removal.route} fires exactly its owner, mutates, note honest`,
      fired.length === 1 && fired[0] === row.removal.route && result.mutated === true && result.note.includes(row.note),
      `fired=${fired.join(',')} note=${result.note}`,
    )
  }

  fired.length = 0
  const envResult = executeSlotRemoval(slot('zai', { route: 'env', envVar: 'ZAI_API_KEY' }), owners)
  check(
    'an env pin refuses honestly: shell-owned, nothing fired, never edited',
    fired.length === 0 && envResult.mutated === false && envResult.note.includes('Mercury never edits your environment'),
    envResult.note,
  )
  fired.length = 0
  const signedOut = executeSlotRemoval(
    slot('anthropic', { route: 'anthropic-oauth', dir: 'scope-dir-1' }, false),
    owners,
  )
  check(
    'a signed-out oauth slot refuses the sign-out honestly (nothing to revoke)',
    fired.length === 0 && signedOut.mutated === false && signedOut.note.includes('nothing to sign out'),
    signedOut.note,
  )
  fired.length = 0
  const ownerRouted = executeSlotRemoval(
    slot('local', { route: 'owner', note: 'discovered live — stop the server and the row leaves on the next probe' }),
    owners,
  )
  check(
    'an owner-routed slot answers its own note and mutates nothing',
    fired.length === 0 && ownerRouted.mutated === false && ownerRouted.note.includes('discovered live'),
    ownerRouted.note,
  )
}

section('§6 re-login: always allowed for an existing slot; ADD refused at the ceiling; replace is the law')

{
  check('anthropic ceiling is 2; openai ceiling is 2; no other family has one', familySigninCeiling('anthropic') === 2 && familySigninCeiling('openai') === 2 && families.filter(f => familySigninCeiling(f) !== undefined).length === 2)
  check('under the ceiling, no refusal (an ADD may open)', signinCeilingRefusal('anthropic', 1) === undefined)
  const refusal = signinCeilingRefusal('anthropic', 2)
  check(
    'at the ceiling the ADD refuses typed — and says re-login of an existing slot is ALWAYS allowed',
    refusal !== undefined &&
      refusal.message.includes('2/2') &&
      refusal.message.includes('⌫ on /accounts') &&
      refusal.message.includes('re-login of an existing slot is always allowed'),
    refusal?.message,
  )
  for (const family of families) {
    if (family === 'anthropic' || family === 'openai') continue
    check(
      `${family}: no ceiling — a re-login structurally REPLACES (single-entry store)`,
      signinCeilingRefusal(family, 99) === undefined,
    )
  }
  writeStoredZaiApiKey('zai-fixture-key-000000000001')
  writeStoredZaiApiKey('zai-fixture-key-000000000002')
  check(
    'zai: a second sign-in replaced the stored key (one slot, never a second)',
    readStoredZaiApiKey() === 'zai-fixture-key-000000000002',
  )
  writeStoredZaiApiKey(null)
}

section('§7 the abandon arms: pre-fire cancel stores nothing; in-flight cancel stores, rejects, and DISCLOSES')

console.log(
  ' [NOTE] anthropic: the login machine keeps the pinned generation law — an abandoned flow\'s late settle writes NOTHING; the asymmetry with the handles/device families is deliberate and recorded.',
)

const sleepMs = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
function exchangeGate(): {
  started: Promise<void>
  signalStarted: () => void
  released: Promise<void>
  release: () => void
} {
  let signalStarted!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => (signalStarted = resolve))
  const released = new Promise<void>(resolve => (release = resolve))
  return { started, signalStarted, released, release }
}
const within = <T,>(p: Promise<T>, ms = 900): Promise<T | 'timed-out'> =>
  Promise.race([p, sleepMs(ms).then(() => 'timed-out' as const)])

{
  const openrouter = await import(
    '../../src/services/providers/openrouter/openrouterAccounts.js'
  )
  let notified = false
  const handles = openrouter.beginOpenrouterConnect({
    skipBrowserOpen: true,
    loopbackPort: 0,
    fetchImpl: (async () => {
      throw new Error('prover: the pre-fire arm must never reach the wire')
    }) as unknown as typeof fetch,
    onSettledAfterCancel: () => void (notified = true),
  } as never)
  handles.cancel('esc before any exchange')
  const verdict = await within(handles.result.then(() => 'resolved', () => 'rejected'))
  handles.completeWithRedirect('http://127.0.0.1:1456/auth/callback?code=LATE')
  await sleepMs(50)
  check(
    'openrouter: pre-fire cancel rejects; a later redirect stores NOTHING and notifies nothing',
    verdict === 'rejected' && openrouter.readMintedOpenrouterKey() === undefined && notified === false,
    `verdict=${verdict} minted=${JSON.stringify(openrouter.readMintedOpenrouterKey())}`,
  )
}

{
  const openrouter = await import(
    '../../src/services/providers/openrouter/openrouterAccounts.js'
  )
  const gate = exchangeGate()
  let disclosed: unknown = null
  const handles = openrouter.beginOpenrouterConnect({
    skipBrowserOpen: true,
    loopbackPort: 0,
    fetchImpl: (async (url: RequestInfo | URL) => {
      if (String(url).includes('/auth/keys')) {
        gate.signalStarted()
        await gate.released
        return new Response(JSON.stringify({ key: 'sk-or-fixture-minted-0000000001' }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch,
    onSettledAfterCancel: (ref: unknown) => void (disclosed = ref),
  } as never)
  handles.completeWithRedirect('http://127.0.0.1:1456/auth/callback?code=REAL')
  await within(gate.started)
  handles.cancel('esc mid-exchange')
  const verdict = await within(handles.result.then(() => 'resolved', () => 'rejected'))
  gate.release()
  await sleepMs(120)
  const minted = openrouter.readMintedOpenrouterKey()
  check(
    'openrouter: in-flight cancel REJECTS the flow, the mint still lands (never orphaned), and the disclosure fires',
    verdict === 'rejected' &&
      minted?.key === 'sk-or-fixture-minted-0000000001' &&
      disclosed !== null &&
      (disclosed as { kind?: string }).kind === 'oauth-key',
    `verdict=${verdict} minted=${minted !== undefined} disclosed=${JSON.stringify(disclosed)}`,
  )
  const removal = executeSlotRemoval({
    family: 'openrouter',
    id: 'openrouter:oauth-key',
    name: 'oauth',
    kind: 'oauth',
    kindLabel: 'OAuth-minted key',
    identity: 'minted fixture',
    active: true,
    envPinned: false,
    signedIn: true,
    removal: { route: 'openrouter-oauth-key' },
  } as AccountSlotT)
  check(
    'openrouter: E3 — the /accounts removal really clears the after-cancel mint (no dead-door remedy)',
    removal.mutated === true && openrouter.readMintedOpenrouterKey() === undefined,
    removal.note,
  )
}

{
  const openrouter = await import(
    '../../src/services/providers/openrouter/openrouterAccounts.js'
  )
  const gate = exchangeGate()
  const issues: string[] = []
  const handles = openrouter.beginOpenrouterConnect({
    skipBrowserOpen: true,
    loopbackPort: 0,
    fetchImpl: (async (url: RequestInfo | URL) => {
      if (String(url).includes('/auth/keys')) {
        gate.signalStarted()
        await gate.released
        return new Response('', { status: 403 })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch,
    onListenerIssue: (m: string) => void issues.push(m),
  } as never)
  await sleepMs(30)
  const port = handles.boundLoopbackPort()
  const tabP =
    port !== undefined ? fetch(`http://127.0.0.1:${port}/auth/callback?code=WILL-REFUSE`) : undefined
  await within(gate.started)
  handles.cancel('esc before the refusal answers')
  const flow = await within(handles.result.then(() => 'resolved', () => 'rejected'))
  gate.release()
  const tab = tabP !== undefined ? await within(tabP, 2000) : 'timed-out'
  const tabText = tab !== 'timed-out' && tab !== undefined ? await (tab as Response).text() : ''
  check(
    'openrouter listener refused-after-cancel: the flow stays rejected, the tab names the ENDED sign-in (never "still waiting"), no "still listening" note',
    flow === 'rejected' &&
      tab !== 'timed-out' &&
      (tab as Response).status === 409 &&
      /already ended in the terminal/.test(tabText) &&
      /\/logins/.test(tabText) &&
      !/still waiting/.test(tabText) &&
      !issues.some(m => m.includes('still listening')) &&
      openrouter.readMintedOpenrouterKey() === undefined,
    `flow=${String(flow)} status=${tab !== 'timed-out' ? (tab as Response).status : 'timeout'} tab=${JSON.stringify(tabText)} issues=${JSON.stringify(issues)}`,
  )
}

{
  const gate = exchangeGate()
  const handles = gemini.beginGeminiBrowserConnect({
    skipBrowserOpen: true,
    loopbackPort: 0,
    env: { ...process.env, MERCURY_GEMINI_OAUTH_CLIENT_ID: 'client-fixture' },
    fetchImpl: (async () => {
      gate.signalStarted()
      await gate.released
      return new Response('', { status: 400 })
    }) as unknown as typeof fetch,
  } as never)
  await sleepMs(30)
  const port = (handles as { boundLoopbackPort(): number | undefined }).boundLoopbackPort()
  const state = new URL(handles.authorizeUrl).searchParams.get('state') ?? ''
  const tabP =
    port !== undefined
      ? fetch(`http://127.0.0.1:${port}/oauth2/callback?code=X&state=${encodeURIComponent(state)}`)
      : undefined
  await within(gate.started)
  gate.release()
  const tab = tabP !== undefined ? await within(tabP, 2000) : 'timed-out'
  const tabText = tab !== 'timed-out' && tab !== undefined ? await (tab as Response).text() : ''
  const flow = await within(handles.result.then(() => 'resolved', () => 'rejected'))
  check(
    'gemini listener: a refused exchange never saw a premature connected tab — the answer names the terminal and /logins',
    flow === 'rejected' &&
      tab !== 'timed-out' &&
      (tab as Response).status === 400 &&
      /could not complete/.test(tabText) &&
      /\/logins/.test(tabText) &&
      !/connected/.test(tabText),
    `flow=${String(flow)} status=${tab !== 'timed-out' ? (tab as Response).status : 'timeout'} tab=${JSON.stringify(tabText)}`,
  )
}
{
  const gate = exchangeGate()
  const openaiMod = await import('../../src/services/providers/openai/openaiAccounts.js')
  const handles = openaiMod.beginOpenaiBrowserConnect({
    skipBrowserOpen: true,
    loopbackPort: 0,
    fetchImpl: (async () => {
      gate.signalStarted()
      await gate.released
      return new Response('', { status: 400 })
    }) as unknown as typeof fetch,
  } as never)
  await sleepMs(30)
  const port = (handles as { boundLoopbackPort(): number | undefined }).boundLoopbackPort()
  const state = new URL(handles.authorizeUrl).searchParams.get('state') ?? ''
  const tabP =
    port !== undefined
      ? fetch(`http://127.0.0.1:${port}/auth/callback?code=X&state=${encodeURIComponent(state)}`)
      : undefined
  await within(gate.started)
  gate.release()
  const tab = tabP !== undefined ? await within(tabP, 2000) : 'timed-out'
  const tabText = tab !== 'timed-out' && tab !== undefined ? await (tab as Response).text() : ''
  const flow = await within(handles.result.then(() => 'resolved', () => 'rejected'))
  check(
    'openai listener: a refused exchange never saw a premature connected tab — the answer names the terminal and /logins',
    flow === 'rejected' &&
      tab !== 'timed-out' &&
      (tab as Response).status === 400 &&
      /could not complete/.test(tabText) &&
      /\/logins/.test(tabText) &&
      !/connected/.test(tabText),
    `flow=${String(flow)} status=${tab !== 'timed-out' ? (tab as Response).status : 'timeout'} tab=${JSON.stringify(tabText)}`,
  )
}
{
  gemini.__resetGeminiAccountsForTest()
  writeFileSync(gemini.geminiAuthPathForDisplay(), JSON.stringify({ version: 1 }), { mode: 0o600 })
  const handles = gemini.beginGeminiBrowserConnect({
    skipBrowserOpen: true,
    loopbackPort: 0,
    env: { ...process.env, MERCURY_GEMINI_OAUTH_CLIENT_ID: 'client-fixture' },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ access_token: 'GA-2', refresh_token: 'GR-2', expires_in: 3600 }), {
        status: 200,
      })) as unknown as typeof fetch,
  } as never)
  await sleepMs(30)
  const port = (handles as { boundLoopbackPort(): number | undefined }).boundLoopbackPort()
  const state = new URL(handles.authorizeUrl).searchParams.get('state') ?? ''
  const tab =
    port !== undefined
      ? await within(
          fetch(`http://127.0.0.1:${port}/oauth2/callback?code=OK&state=${encodeURIComponent(state)}`),
          2500,
        )
      : 'timed-out'
  const tabText = tab !== 'timed-out' ? await (tab as Response).text() : ''
  const flow = await within(handles.result.then(() => 'resolved', () => 'rejected'))
  check(
    'gemini listener: the success arm answers connected AFTER the settle (flow resolved, grant stored)',
    flow === 'resolved' &&
      tab !== 'timed-out' &&
      (tab as Response).status === 200 &&
      /connected/.test(tabText) &&
      gemini.geminiOauthConnected() === true,
    `flow=${String(flow)} status=${tab !== 'timed-out' ? (tab as Response).status : 'timeout'} tab=${JSON.stringify(tabText)} connected=${gemini.geminiOauthConnected()}`,
  )
  gemini.disconnectGeminiOauth()
}

{
  gemini.__resetGeminiAccountsForTest()
  writeFileSync(gemini.geminiAuthPathForDisplay(), JSON.stringify({ version: 1 }), { mode: 0o600 })
  const geminiEnv = { ...process.env, MERCURY_GEMINI_OAUTH_CLIENT_ID: 'client-fixture' }
  const geminiTokenUrl = (geminiEnv['MERCURY_GEMINI_OAUTH_TOKEN_BASE']?.trim() || 'https://oauth2.googleapis.com/token')
  const gate = exchangeGate()
  let disclosed: unknown = null
  const handles = gemini.beginGeminiBrowserConnect({
    skipBrowserOpen: true,
    env: geminiEnv,
    fetchImpl: (async (url: RequestInfo | URL) => {
      if (String(url) === geminiTokenUrl || String(url).startsWith(geminiTokenUrl)) {
        gate.signalStarted()
        await gate.released
        return new Response(
          JSON.stringify({ access_token: 'GA-1', refresh_token: 'GR-1', expires_in: 3600 }),
          { status: 200 },
        )
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch,
    onSettledAfterCancel: (ref: unknown) => void (disclosed = ref),
  } as never)
  const state = new URL(handles.authorizeUrl).searchParams.get('state')!
  handles.completeWithRedirect(`http://127.0.0.1:1457/oauth2/callback?code=REAL&state=${state}`)
  await within(gate.started)
  handles.cancel('esc mid-exchange')
  const verdictEarly = await within(handles.result.then(() => 'resolved', () => 'rejected'))
  gate.release()
  await sleepMs(120)
  check(
    'gemini: in-flight cancel REJECTS the flow (never a resolved abandon), the store lands, the disclosure fires',
    verdictEarly === 'rejected' && gemini.geminiOauthConnected() === true && disclosed !== null,
    `verdict=${verdictEarly} connected=${gemini.geminiOauthConnected()} disclosed=${disclosed !== null}`,
  )
  gemini.disconnectGeminiOauth()
}

{
  const gate = exchangeGate()
  let disclosed: unknown = null
  const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(FUTURE_MS / 1000) })).toString('base64url')}.s`
  const handles = openaiAcc.beginOpenaiBrowserConnect({
    skipBrowserOpen: true,
    fetchImpl: (async (url: RequestInfo | URL) => {
      if (String(url).includes('/oauth/token')) {
        gate.signalStarted()
        await gate.released
        return new Response(
          JSON.stringify({
            id_token: 'h.e30.s',
            access_token: jwt,
            refresh_token: 'OR-CANCEL-1',
            expires_in: 3600,
          }),
          { status: 200 },
        )
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch,
    onSettledAfterCancel: (ref: unknown) => void (disclosed = ref),
  } as never)
  const state = new URL(handles.authorizeUrl).searchParams.get('state')!
  handles.completeWithRedirect(`http://localhost:1455/auth/callback?code=REAL&state=${state}`)
  await within(gate.started)
  handles.cancel('esc mid-exchange')
  const verdict = await within(handles.result.then(() => 'resolved', () => 'rejected'))
  gate.release()
  await sleepMs(120)
  check(
    'openai: in-flight cancel REJECTS the flow, the subscription store lands, the disclosure fires',
    verdict === 'rejected' && openaiAcc.subscriptionConnected() === true && disclosed !== null,
    `verdict=${verdict} connected=${openaiAcc.subscriptionConnected()} disclosed=${disclosed !== null}`,
  )
  openaiAcc.disconnectOpenaiSubscription()
}

{
  const { runKimiDeviceLogin } = await import(
    '../../src/services/providers/moonshot/moonshotLogin.js'
  )
  moonshot.writeMoonshotTokens(null)
  let cancelled = false
  const gate = exchangeGate()
  const outcomeP = runKimiDeviceLogin({
    region: 'global',
    cancelled: () => cancelled,
    sleep: () => Promise.resolve(),
    io: {
      fetchImpl: (async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes('device')) {
          return new Response(
            JSON.stringify({
              device_code: 'DC-1',
              user_code: 'USER-1',
              verification_uri: 'https://kimi.example/activate',
              interval: 0,
              expires_in: 300,
            }),
            { status: 200 },
          )
        }
        if (u.includes('token')) {
          gate.signalStarted()
          await gate.released
          return new Response(
            JSON.stringify({ access_token: 'kimi-A-1', refresh_token: 'kimi-R-1', expires_in: 3600 }),
            { status: 200 },
          )
        }
        return new Response('', { status: 404 })
      }) as unknown as typeof fetch,
    },
  })
  await within(gate.started)
  cancelled = true
  gate.release()
  const outcome = await within(outcomeP)
  check(
    'moonshot: authorized-after-cancel WRITES the grant and the outcome discloses settled-after-cancel with the removal door',
    outcome !== 'timed-out' &&
      (outcome as { ok: boolean }).ok === true &&
      (outcome as { settledAfterCancel?: boolean }).settledAfterCancel === true &&
      /completed after cancel/.test((outcome as { receipt: string }).receipt) &&
      /accounts/.test((outcome as { receipt: string }).receipt) &&
      moonshot.moonshotStoredTokens()?.accessToken === 'kimi-A-1',
    JSON.stringify(outcome),
  )
  moonshot.writeMoonshotTokens(null)
}

{
  const { runHuggingfaceDeviceLogin } = await import(
    '../../src/services/providers/huggingface/huggingfaceLogin.js'
  )
  huggingface.writeHuggingfaceTokens(null)
  const hfEnv = { ...process.env, MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'client-fixture' }
  let cancelled = false
  const gate = exchangeGate()
  const outcomeP = runHuggingfaceDeviceLogin({
    cancelled: () => cancelled,
    sleep: () => Promise.resolve(),
    refreshCatalogue: () => Promise.resolve(null),
    io: {
      env: hfEnv,
      fetchImpl: (async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes('device')) {
          return new Response(
            JSON.stringify({
              device_code: 'DC-2',
              user_code: 'USER-2',
              verification_uri: 'https://hf.example/activate',
              interval: 0,
              expires_in: 300,
            }),
            { status: 200 },
          )
        }
        if (u.includes('token')) {
          gate.signalStarted()
          await gate.released
          return new Response(
            JSON.stringify({ access_token: 'hf-A-1', refresh_token: 'hf-R-1', expires_in: 3600 }),
            { status: 200 },
          )
        }
        return new Response('', { status: 404 })
      }) as unknown as typeof fetch,
    },
  } as never)
  await within(gate.started)
  cancelled = true
  gate.release()
  const outcome = await within(outcomeP)
  check(
    'huggingface: authorized-after-cancel WRITES the grant and the outcome discloses settled-after-cancel with the removal door',
    outcome !== 'timed-out' &&
      (outcome as { ok: boolean }).ok === true &&
      (outcome as { settledAfterCancel?: boolean }).settledAfterCancel === true &&
      /completed after cancel/.test((outcome as { receipt: string }).receipt) &&
      /accounts/.test((outcome as { receipt: string }).receipt) &&
      huggingface.huggingfaceStoredTokens()?.accessToken === 'hf-A-1',
    JSON.stringify(outcome),
  )
  huggingface.writeHuggingfaceTokens(null)
}

{
  const { runKimiDeviceLogin, KIMI_SETTLED_AFTER_CANCEL_RECEIPT } = await import(
    '../../src/services/providers/moonshot/moonshotLogin.js'
  )
  moonshot.writeMoonshotTokens(null)
  let cancelled = false
  const gate = exchangeGate()
  const outcomeP = runKimiDeviceLogin({
    region: 'global',
    cancelled: () => cancelled,
    sleep: () => Promise.resolve(),
    io: {
      fetchImpl: (async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes('device_authorization')) {
          return new Response(
            JSON.stringify({
              device_code: 'DC-3',
              user_code: 'USER-3',
              verification_uri: 'https://kimi.example/activate',
              interval: 0,
              expires_in: 300,
            }),
            { status: 200 },
          )
        }
        if (u.includes('/api/oauth/token')) {
          return new Response(
            JSON.stringify({ access_token: 'kimi-A-2', refresh_token: 'kimi-R-2', expires_in: 3600 }),
            { status: 200 },
          )
        }
        gate.signalStarted()
        await gate.released
        return new Response('', { status: 500 })
      }) as unknown as typeof fetch,
    },
  })
  await within(gate.started)
  cancelled = true
  gate.release()
  const outcome = await within(outcomeP)
  check(
    'moonshot: a cancel during the POST-store usage probe still discloses settled-after-cancel (never a silent landing)',
    outcome !== 'timed-out' &&
      (outcome as { ok: boolean }).ok === true &&
      (outcome as { settledAfterCancel?: boolean }).settledAfterCancel === true &&
      (outcome as { receipt: string }).receipt === KIMI_SETTLED_AFTER_CANCEL_RECEIPT &&
      moonshot.moonshotStoredTokens()?.accessToken === 'kimi-A-2',
    JSON.stringify(outcome),
  )
  moonshot.writeMoonshotTokens(null)
}

{
  const { runHuggingfaceDeviceLogin, HUGGINGFACE_SETTLED_AFTER_CANCEL_RECEIPT } = await import(
    '../../src/services/providers/huggingface/huggingfaceLogin.js'
  )
  huggingface.writeHuggingfaceTokens(null)
  const hfEnv = { ...process.env, MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'client-fixture' }
  let cancelled = false
  const gate = exchangeGate()
  const outcomeP = runHuggingfaceDeviceLogin({
    cancelled: () => cancelled,
    sleep: () => Promise.resolve(),
    refreshCatalogue: () => Promise.resolve(null),
    io: {
      env: hfEnv,
      fetchImpl: (async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes('/oauth/device')) {
          return new Response(
            JSON.stringify({
              device_code: 'DC-4',
              user_code: 'USER-4',
              verification_uri: 'https://hf.example/activate',
              interval: 0,
              expires_in: 300,
            }),
            { status: 200 },
          )
        }
        if (u.includes('/oauth/token')) {
          return new Response(
            JSON.stringify({ access_token: 'hf-A-2', refresh_token: 'hf-R-2', expires_in: 3600 }),
            { status: 200 },
          )
        }
        if (u.includes('/api/whoami-v2')) {
          gate.signalStarted()
          await gate.released
          return new Response('', { status: 500 })
        }
        return new Response('', { status: 404 })
      }) as unknown as typeof fetch,
    },
  } as never)
  await within(gate.started)
  cancelled = true
  gate.release()
  const outcome = await within(outcomeP)
  check(
    'huggingface: a cancel during the identity probe still discloses settled-after-cancel (the store lands after the cancel)',
    outcome !== 'timed-out' &&
      (outcome as { ok: boolean }).ok === true &&
      (outcome as { settledAfterCancel?: boolean }).settledAfterCancel === true &&
      (outcome as { receipt: string }).receipt === HUGGINGFACE_SETTLED_AFTER_CANCEL_RECEIPT &&
      huggingface.huggingfaceStoredTokens()?.accessToken === 'hf-A-2',
    JSON.stringify(outcome),
  )
  huggingface.writeHuggingfaceTokens(null)
}

section('§8 accounts-side refusal hygiene + the gemini no-probe gate copy')

{
  const { readFileSync } = await import('node:fs')
  const REPO = join(import.meta.dir, '..', '..')
  const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
  const openrouterSrc = src('src/services/providers/openrouter/openrouterAccounts.ts')
  const geminiSrc = src('src/services/providers/gemini/geminiAccounts.ts')
  const openaiSrc = src('src/services/providers/openai/openaiAccounts.ts')
  const moonshotSrc = src('src/services/providers/moonshot/moonshotAccounts.ts')
  const hfSrc = src('src/services/providers/huggingface/huggingfaceAccounts.ts')

  for (const [name, text] of [
    ['openrouter', openrouterSrc],
    ['gemini', geminiSrc],
    ['openai', openaiSrc],
    ['moonshot', moonshotSrc],
    ['huggingface', hfSrc],
  ] as const) {
    check(
      `${name}: no error/refusal arm stringifies a wire body or echoes a token`,
      !/new Error\([^)]*JSON\.stringify/.test(text) &&
        !/new Error\(`[^`]*\$\{[^}]*access_token/.test(text) &&
        !/new Error\(`[^`]*\$\{[^}]*refresh_token/.test(text),
    )
  }
  check(
    'the four token-endpoint refusals carry status (+ error code), nothing else',
    openrouterSrc.includes('`openrouter key exchange returned HTTP ${response.status}`') &&
      geminiSrc.includes('`google token endpoint returned HTTP ${response.status}${oauthError ? ` (${oauthError})` : \'\'}`') &&
      openaiSrc.includes('`openai token endpoint returned HTTP ${response.status}${oauthError ? ` (${oauthError})` : \'\'}`') &&
      moonshotSrc.includes('`Kimi device authorization refused (HTTP ${status}${detail})`') &&
      hfSrc.includes('`Hugging Face device authorization refused (HTTP ${status}${detail})`'),
  )

  const { GEMINI_CLIENT_STORED_UNVERIFIED_NOTE } = await import(
    '../../src/services/providers/gemini/geminiAccounts.js'
  )
  check(
    'the unverified note names the store-as-given fact, the invalid_client road, and the way back',
    GEMINI_CLIENT_STORED_UNVERIFIED_NOTE.includes('Stored as given') &&
      GEMINI_CLIENT_STORED_UNVERIFIED_NOTE.includes('invalid_client') &&
      GEMINI_CLIENT_STORED_UNVERIFIED_NOTE.includes('reopen this prompt'),
  )
  const faceSrc = src('src/components/BootLoginsScreen.tsx')
  const cardSrc = src('src/components/GeminiConnect.tsx')
  check(
    'both prompts render the ONE note (the face pane on the storing field; the in-chat card)',
    faceSrc.includes('wrapPlain(GEMINI_CLIENT_STORED_UNVERIFIED_NOTE, DETAIL_W)') &&
      cardSrc.includes('{GEMINI_CLIENT_STORED_UNVERIFIED_NOTE}'),
  )
}

section('§9 the evidence pair end-to-end + the dead-door sweep')

{
  const { readFileSync } = await import('node:fs')
  const REPO = join(import.meta.dir, '..', '..')
  const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

  const http = src('src/utils/http.ts')
  const refreshAt = http.indexOf('await handleOAuth401Error(tokens.accessToken)')
  const retryAt = http.indexOf('return await request()', refreshAt)
  check(
    'the 401/revoked-403 ladder refreshes FIRST and retries — the wall only past a dead refresh',
    refreshAt !== -1 && retryAt !== -1 && http.includes('isRevokedSignInText(error.response.data)'),
  )
  const errors = src('src/services/api/errors.ts')
  const wallAt = errors.indexOf('const wall = classifyCredentialWall(status, message)')
  const observedExpiredAt = errors.indexOf('status === 401 && isAnthropicOAuthSignInExpired()')
  const genericAt = errors.indexOf('// 23. Generic 401/403')
  check(
    'the presenter: the wall arm and the observed-expired arm both precede the generic 401/403 tail',
    wallAt !== -1 && observedExpiredAt !== -1 && genericAt !== -1 && wallAt < genericAt && observedExpiredAt < genericAt,
  )

  clearOAuthTokenCache()
  const { observedCredentialWall, credentialWallLineForModel } = await import(
    '../../src/services/providers/credentialWall.js'
  )
  check(
    "anthropic: the stranded sign-in answers the observed wall 'sign-in' with the full row line",
    observedCredentialWall('anthropic') === 'sign-in' &&
      credentialWallLineForModel('claude-fable-5') ===
        'Anthropic sign-in expired — switch providers (/model) or reconnect (/logins anthropic)',
    credentialWallLineForModel('claude-fable-5'),
  )
  const { recordLaneBillingRefusal, recordLaneTurnSettled, __resetLaneBillingStateForTest } =
    await import('../../src/services/providers/laneBillingState.js')
  __resetLaneBillingStateForTest()
  recordLaneBillingRefusal('openrouter' as never, {
    detail: 'Key limit exceeded (HTTP 403)',
    remedy: 'add credits at openrouter.ai or connect another key.',
  })
  const walled = observedCredentialWall('openrouter')
  recordLaneTurnSettled('openrouter' as never)
  const cleared = observedCredentialWall('openrouter')
  check(
    "openrouter: the recorded 403 key-limit refusal answers 'key-limit' and a settled turn clears it",
    walled === 'key-limit' && cleared === undefined,
    `walled=${walled} cleared=${cleared}`,
  )

  const sentences: string[] = []
  const usabilityMap = resolveProviderUsability(absentReads)
  for (const family of families) {
    sentences.push(...usabilityMap[family as keyof typeof usabilityMap].blockers)
    sentences.push(credentialWallLine(family, 'sign-in'))
    sentences.push(credentialWallLine(family, 'key-limit'))
    sentences.push(credentialWallLine(family, 'sign-in', { nonInteractive: true }))
  }
  const ceiling = signinCeilingRefusal('anthropic', 2)
  if (ceiling) sentences.push(ceiling.message)
  const limitedMap = resolveProviderUsability({
    ...absentReads,
    anthropicApiKey: () => 'key-fixture-000000000001',
    anthropicLimitStatus: () => 'rejected',
    openrouterKeyPresent: () => true,
    openrouterLimitWindow: () => ({ state: 'limited' }),
  })
  sentences.push(...limitedMap.anthropic.blockers, ...limitedMap.openrouter.blockers)
  const slotFor = (removal: AccountSlotT['removal']): AccountSlotT =>
    ({
      family: 'x',
      id: 'x',
      name: 'x',
      kind: 'api-key',
      kindLabel: 'k',
      identity: 'i',
      active: true,
      envPinned: false,
      signedIn: true,
      removal,
    }) as AccountSlotT
  for (const removal of [
    { route: 'env', envVar: 'ZAI_API_KEY' },
    { route: 'anthropic-managed-key' },
    { route: 'openai-subscription' },
    { route: 'openrouter-oauth-key' },
    { route: 'gemini-oauth' },
    { route: 'moonshot-oauth' },
    { route: 'huggingface-oauth' },
  ] as AccountSlotT['removal'][]) {
    sentences.push(
      executeSlotRemoval(slotFor(removal), {
        disconnectOpenaiSubscription: () => {},
        disconnectOpenrouterOauthKey: () => {},
        disconnectGeminiOauth: () => {},
        disconnectMoonshotOauth: () => {},
        disconnectHuggingfaceOauth: () => {},
        clearManagedAnthropicKey: () => {},
        openaiApiKeyAfter: () => undefined,
      }).note,
    )
  }
  const { lateSettleNotice: faceNotice } = await import('../../src/components/BootLoginsScreen.js')
  sentences.push(faceNotice('openrouter'))
  const { KIMI_CONNECT_STOPPED_RECEIPT, KIMI_SETTLED_AFTER_CANCEL_RECEIPT } = await import(
    '../../src/services/providers/moonshot/moonshotLogin.js'
  )
  const { HUGGINGFACE_SETTLED_AFTER_CANCEL_RECEIPT } = await import(
    '../../src/services/providers/huggingface/huggingfaceLogin.js'
  )
  sentences.push(KIMI_SETTLED_AFTER_CANCEL_RECEIPT, HUGGINGFACE_SETTLED_AFTER_CANCEL_RECEIPT)
  const { HUGGINGFACE_CONNECT_STOPPED_RECEIPT } = await import('../../src/services/providers/huggingface/huggingfaceLogin.js')
  const { OPENROUTER_CONNECT_STOPPED_RECEIPT } = await import('../../src/services/providers/openrouter/openrouterLogin.js')
  const { GEMINI_CONNECT_STOPPED_RECEIPT } = await import('../../src/services/providers/gemini/geminiLogin.js')
  const { OPENAI_CONNECT_STOPPED_RECEIPT } = await import('../../src/services/providers/openai/openaiLogin.js')
  sentences.push(
    KIMI_CONNECT_STOPPED_RECEIPT,
    HUGGINGFACE_CONNECT_STOPPED_RECEIPT,
    OPENROUTER_CONNECT_STOPPED_RECEIPT,
    GEMINI_CONNECT_STOPPED_RECEIPT,
    OPENAI_CONNECT_STOPPED_RECEIPT,
  )
  const { nonAnthropicBootNotice } = await import('../../src/services/providers/providerUsability.js')
  const bootNotice = nonAnthropicBootNotice({
    ...usabilityMap,
    zai: { ...usabilityMap.zai, usable: true, credential: 'api-key', blockers: [] },
  })
  if (bootNotice !== null) sentences.push(bootNotice)

  const { effectiveCatalogue } = await import('../../src/commands/effectiveCatalogue.js')
  const registered = new Set(
    effectiveCatalogue().flatMap(surface => [surface.name, ...surface.aliases]),
  )
  const DOOR_RE = /(^|[\s(`,])\/([a-z][a-z0-9-]*)(?![a-z0-9-/])/g
  const doorsIn = (sentence: string): string[] =>
    [...sentence.matchAll(DOOR_RE)].map(match => match[2]!)
  check(
    'the fence catches backtick/comma-glued doors and refuses URL/wire paths',
    doorsIn('use `/logins` or (/accounts),/model now').join(',') === 'logins,accounts,model' &&
      doorsIn('see https://x.ai/auth/callback and `/auth/callback` and openrouter.ai/settings/keys').length === 0,
    `glued=${JSON.stringify(doorsIn('use `/logins` or (/accounts),/model now'))} paths=${JSON.stringify(doorsIn('see https://x.ai/auth/callback and `/auth/callback` and openrouter.ai/settings/keys'))}`,
  )
  const doorTokens = new Set<string>()
  for (const sentence of sentences) {
    for (const door of doorsIn(sentence)) {
      doorTokens.add(door)
    }
  }
  check(
    `every named slash-door is a registered command (${[...doorTokens].sort().join(', ')})`,
    doorTokens.size > 0 && [...doorTokens].every(door => registered.has(door)),
    [...doorTokens].filter(door => !registered.has(door)).join(', '),
  )
}

section('§10 the cross-account laws: SF1 spoken · the structural ceiling fence · the release roads')

{
  const { scheduleAccountVerdict } = await import('../../src/daemon/saturnAccount.js')
  const base = { credentialed: true, stranded: false, refreshable: true, expiresAt: NOW_MS + 60_000 }
  const verdictOf = (live: Record<string, unknown>): string =>
    scheduleAccountVerdict({
      account: { source: 'oauth' } as never,
      nextFireMs: NOW_MS + 3_600_000,
      nowMs: NOW_MS,
      live: { ...base, ...live } as never,
    }).state
  check(
    'SF1: refreshable expiry is READY; refreshless expiry before the fire is EXPIRING; observed-dead is EXPIRED; signed-out is SIGNED-OUT',
    verdictOf({}) === 'ready' &&
      verdictOf({ refreshable: false }) === 'expiring' &&
      verdictOf({ stranded: true }) === 'expired' &&
      verdictOf({ credentialed: false }) === 'signed-out',
  )

  const REPO = join(import.meta.dir, '..', '..')
  const ticker = (await import('node:fs')).readFileSync(join(REPO, 'src/daemon/saturnTicker.ts'), 'utf8')
  check(
    'the mismatch hold speaks the SF1 sentence with the /logins door',
    ticker.includes(
      'held: account-mismatch — this schedule was made under a different ${family ?? \'provider\'} account; /logins or run-now releases on the current one',
    ),
  )
  const matchRoadAt = ticker.indexOf('if (resolvedHold.identityMismatch !== true) {')
  const freshRoadAt = ticker.indexOf('identityLabelOf(resolvedHold.account) !== h.mismatchIdentity')
  check(
    'the two release roads stand in the release bar (match-again · fresh-sign-in re-arm)',
    matchRoadAt !== -1 && freshRoadAt !== -1 && matchRoadAt < freshRoadAt,
  )

  const everything = accountSlots.deriveFamilySlotGroups(
    families.map(id => ({
      id,
      available: true,
      description: { account: { kind: 'none' as const, label: '' } },
    })) as never,
    {
      familyReads: {
        claudeSubscriber: () => true,
        subscriptionType: () => 'max',
        anthropicApiKeyPresent: () => true,
        bearerTokenSource: () => ({ source: 'none', hasToken: false }),
      },
      scanScopes: () => [
        {
          name: 'primary',
          dir: 'scope-a',
          isCurrent: true,
          hasConfig: true,
          authed: true,
          email: 'op@example.dev',
          claudeFamily: false,
        } as never,
      ],
      anthropicApiKey: () => ({ key: 'key-fixture-000000000001', source: 'claude.ai' as never }),
      openaiSubscription: () => ({ provider: 'openai', kind: 'chatgpt-subscription', label: 'ChatGPT Plus' }) as never,
      openaiActiveAccount: () => undefined,
      openaiApiKey: () => ({ key: 'openai-key-fixture-000001', source: 'stored' as const }),
      zaiEnvKey: () => undefined,
      zaiStoredKey: () => 'zai-key-fixture-000000001',
      zaiStoredKeyPlan: () => undefined,
      openrouterEnvKey: () => undefined,
      openrouterMintedKey: () => ({ key: 'or-minted-fixture-000001', mintedAtMs: NOW_MS }),
      openrouterStoredKey: () => 'or-key-fixture-0000000001',
      geminiOauthConnected: () => true,
      geminiActiveAccount: () => ({ kind: 'oauth' }) as never,
      geminiEnvGoogleKey: () => undefined,
      geminiEnvGeminiKey: () => undefined,
      geminiStoredKey: () => 'gem-key-fixture-000000001',
      moonshotEnvKey: () => undefined,
      moonshotStoredKey: () => 'kimi-key-fixture-00000001',
      moonshotOauth: () => ({ accessToken: 'kimi-access-fixture-00001', refreshToken: 'r' }),
      moonshotOauthRegion: () => 'global' as const,
      deepseekEnvKey: () => undefined,
      deepseekStoredKey: () => 'ds-key-fixture-0000000001',
      compatEnvKey: () => undefined,
      compatStoredKey: () => 'compat-key-fixture-000001',
      huggingfaceEnvKey: () => undefined,
      huggingfaceOauth: () => ({ accessToken: 'hf-access-fixture-000001', refreshToken: 'r' }),
      huggingfaceOauthIdentity: () => ({ username: 'op' }) as never,
      huggingfaceStoredKey: () => 'hf-key-fixture-0000000001',
      huggingfaceStoredKeyIdentity: () => undefined,
      localEnvKey: () => undefined,
      localStoredKey: () => 'local-key-fixture-00000001',
      localAccount: () => ({ kind: 'keyless', label: 'ollama' }) as never,
    },
  )
  for (const family of ['anthropic', 'openai'] as const) {
    const ceiling = familySigninCeiling(family)!
    const held = (everything.find(g => (g.family.id as string) === family)?.slots ?? []).filter(
      slot => !slot.envPinned,
    )
    check(
      `${family}: every Mercury-held credential present derives ≤ ${ceiling} held slots (the structural ceiling)`,
      held.length <= ceiling,
      `${held.length} slots: ${held.map(s => s.id).join(', ')}`,
    )
  }
  const anthropicIds = (everything.find(g => (g.family.id as string) === 'anthropic')?.slots ?? []).map(s => s.id)
  check(
    'slot ids are identity-stable (the scope dir names the ring slot; family:kind names the rest)',
    anthropicIds.includes('scope-a') && anthropicIds.includes('anthropic:api-key'),
    anthropicIds.join(', '),
  )
}

section('§11 the keyed search tier: Brave · Tavily — doors, refusals, quota, precedence')

{
  const { braveSearch, resolveBraveSearchApiKey } = await import('../../src/services/search/brave.js')
  const { tavilySearch, resolveTavilyApiKey } = await import('../../src/services/search/tavily.js')
  const { writeStoredBraveSearchApiKey, writeStoredTavilyApiKey } = await import(
    '../../src/utils/router/providerSecrets.js'
  )
  const request = { query: 'matrix fixture' } as never

  writeStoredBraveSearchApiKey('brave-stored-fixture-0001')
  const storedRead = resolveBraveSearchApiKey({} as NodeJS.ProcessEnv)
  const envRead = resolveBraveSearchApiKey({ BRAVE_API_KEY: 'brave-env-fixture-000001' } as never)
  check(
    'brave: the stored key signs in through /router key; an env pin wins over it',
    storedRead?.key === 'brave-stored-fixture-0001' &&
      storedRead?.source === 'stored' &&
      envRead?.key === 'brave-env-fixture-000001' &&
      envRead?.source === 'env',
  )
  writeStoredBraveSearchApiKey(null)

  const absent = await braveSearch(request, { env: {} as NodeJS.ProcessEnv })
  check(
    'brave: no key answers the typed no-backend line naming BRAVE_API_KEY and /router key brave',
    absent.ok === false &&
      (absent as { kind: string }).kind === 'no-backend' &&
      (absent as { message: string }).message.includes('BRAVE_API_KEY') &&
      (absent as { message: string }).message.includes('/router key brave'),
    JSON.stringify(absent),
  )

  const refusedIo = {
    env: { BRAVE_API_KEY: 'brave-env-fixture-000001' } as never,
    fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
  }
  const refused = await braveSearch(request, refusedIo as never)
  check(
    'brave: a refused key (401) answers key-refused with the dashboard and the /router re-key door',
    refused.ok === false &&
      (refused as { kind: string }).kind === 'key-refused' &&
      (refused as { message: string }).message.includes('api-dashboard.search.brave.com') &&
      (refused as { message: string }).message.includes('/router key brave again'),
    JSON.stringify(refused),
  )

  const spent = await braveSearch(request, {
    env: { BRAVE_API_KEY: 'brave-env-fixture-000001' } as never,
    fetchImpl: (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch,
  } as never)
  check(
    "brave: a spent plan (429) answers rate-limited naming the plan's quota",
    spent.ok === false &&
      (spent as { kind: string }).kind === 'rate-limited' &&
      (spent as { message: string }).message.includes('quota is spent'),
    JSON.stringify(spent),
  )

  writeStoredTavilyApiKey('tavily-stored-fixture-001')
  const tavStored = resolveTavilyApiKey({} as NodeJS.ProcessEnv)
  writeStoredTavilyApiKey(null)
  const tavRefused = await tavilySearch(request, {
    env: { TAVILY_API_KEY: 'tavily-env-fixture-00001' } as never,
    fetchImpl: (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch,
  } as never)
  const tavSpent = await tavilySearch(request, {
    env: { TAVILY_API_KEY: 'tavily-env-fixture-00001' } as never,
    fetchImpl: (async () => new Response('{}', { status: 432 })) as unknown as typeof fetch,
  } as never)
  check(
    'tavily: stored sign-in resolves; a refused key names app.tavily.com and the re-key door; 432 answers the spent plan',
    tavStored?.key === 'tavily-stored-fixture-001' &&
      tavRefused.ok === false &&
      (tavRefused as { message: string }).message.includes('app.tavily.com') &&
      (tavRefused as { message: string }).message.includes('/router key tavily again') &&
      tavSpent.ok === false &&
      (tavSpent as { kind: string }).kind === 'rate-limited',
    JSON.stringify({ tavRefused, tavSpent }),
  )

  const routerSrc = (await import('node:fs')).readFileSync(
    join(import.meta.dir, '..', '..', 'src/commands/router/router.tsx'),
    'utf8',
  )
  check(
    "the /router key vocabulary registers 'brave' and 'tavily'",
    routerSrc.includes("'brave', 'tavily'] as const"),
  )
}

console.log(
  failures === 0 ? '\nALL GREEN (auth flow matrix)' : `\n${failures} FAILURES`,
)
process.exit(failures === 0 ? 0 : 1)
