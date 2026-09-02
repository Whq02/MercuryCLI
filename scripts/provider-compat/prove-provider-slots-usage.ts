#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-provider-slots-usage.ts — the key-lane families on
//  the wallet/usage surfaces, hermetic (injected
//  reads; a scratch config home; no ambient credentials).
//
//    1. /accounts SLOTS: each new family derives its slots from the OWNING
//       reads — env pin its own always-winning slot, stored key shadow-noted
//       under an env pin, the Moonshot OAuth identity its own slot; masked
//       TAILS only, never a value; removal ROUTES to the owning store and
//       env pins are refused with the shell named.
//    2. ACTIVE-SOURCE USAGE: the new lanes answer the honest shapes —
//       credentialed ⇒ 'api-spend', absent ⇒ 'none' with the provider label;
//       the DeepSeek lane surfaces the provider-STATED balance record with
//       its observation stamp (and no record ⇒ no balance field — labeled
//       absence, never a fabricated figure).
//    3. BALANCE DECODE: the documented GET /user/balance field names decode
//       exactly; junk shapes refuse (undefined), never a guessed record.
//    4. /usage SECTIONS: usageSectionPlan yields a section per new family
//       with the connect route naming the lane's real attach verb.
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-provider-slots-usage.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'provider-slots-proof-'))
delete process.env.OPENAI_API_KEY
delete process.env.ZAI_API_KEY
delete process.env.ANTHROPIC_API_KEY
delete process.env.MOONSHOT_API_KEY
delete process.env.DEEPSEEK_API_KEY
delete process.env.MERCURY_COMPAT_API_KEY
delete process.env.MERCURY_COMPAT_BASE_URL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { deriveFamilySlotGroups, executeSlotRemoval } = await import(
  '../../src/services/providers/accountSlots.ts'
)
const { activeSourceUsage } = await import('../../src/services/providers/providerUsage.ts')
const { decodeDeepseekBalance } = await import(
  '../../src/services/providers/deepseek/deepseekUsageState.ts'
)
const { decodeMoonshotBalance, moonshotBalanceUrl } = await import(
  '../../src/services/providers/moonshot/moonshotUsageState.ts'
)
const { moonshotLaneProfile } = await import(
  '../../src/services/providers/moonshot/moonshotCallModel.ts'
)
const { deepseekLaneProfile } = await import(
  '../../src/services/providers/deepseek/deepseekCallModel.ts'
)
const { compatSlotLaneProfile } = await import(
  '../../src/services/providers/openaicompat/compatCallModel.ts'
)
const { usageSectionPlan } = await import('../../src/components/Settings/Usage.tsx')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

// A fabricated provider snapshot covering the three new families (the
// derivation law: presence flows from providerFamilyPresences over exactly
// these descriptions; no live adapter/status is consulted).
type ProvidersDouble = Parameters<typeof deriveFamilySlotGroups>[0]
const providers = [
  {
    id: 'moonshot',
    available: true,
    transport: 'openai-compat-chat-completions',
    description: { account: { kind: 'api-key', label: 'MOONSHOT_API_KEY (env)' } },
  },
  {
    id: 'deepseek',
    available: true,
    transport: 'openai-compat-chat-completions',
    description: { account: { kind: 'api-key', label: 'DeepSeek API key (stored, auth-scoped)' } },
  },
  {
    id: 'openai-compat',
    available: true,
    transport: 'openai-compat-chat-completions',
    description: { account: { kind: 'keyless', label: 'LM Studio — no key (local/auth-free endpoint)' } },
  },
] as unknown as ProvidersDouble

section('1 · /accounts slots for the key-lane families')
{
  const groups = deriveFamilySlotGroups(providers, {
    moonshotEnvKey: () => 'sk-moon-env-0123456789',
    moonshotStoredKey: () => 'sk-moon-stored-987654321',
    moonshotOauth: () => ({ accessToken: 'tok-never-shown' }),
    deepseekEnvKey: () => undefined,
    deepseekStoredKey: () => 'sk-deep-stored-13579246',
    compatEnvKey: () => 'sk-compat-env-2468013579',
    compatStoredKey: () => undefined,
  })
  const byFamily = new Map(groups.map(g => [g.family.id, g]))

  const moonshot = byFamily.get('moonshot')
  check('moonshot group present', moonshot !== undefined)
  const moonshotIds = moonshot?.slots.map(s => s.id) ?? []
  check(
    'moonshot: OAuth + env + stored slots',
    moonshotIds.includes('moonshot:oauth') &&
      moonshotIds.includes('moonshot:env-key') &&
      moonshotIds.includes('moonshot:stored-key'),
    moonshotIds.join(','),
  )
  const moonshotEnv = moonshot?.slots.find(s => s.id === 'moonshot:env-key')
  const moonshotStored = moonshot?.slots.find(s => s.id === 'moonshot:stored-key')
  check('moonshot env pin is the active winner', moonshotEnv?.active === true && moonshotEnv.envPinned === true)
  check(
    'moonshot stored key shadow-noted under the env pin',
    moonshotStored?.active === false && (moonshotStored?.stateNote ?? '').includes('env pin wins'),
  )
  const serialized = JSON.stringify(groups)
  check('no key VALUE rides any slot', !serialized.includes('sk-moon-env-0123456789') && !serialized.includes('sk-deep-stored-13579246') && !serialized.includes('tok-never-shown'))
  check('masked tails only', (moonshotEnv?.identity ?? '').includes('…6789'))
  const moonshotOauthUnderEnv = moonshot?.slots.find(s => s.id === 'moonshot:oauth')
  check(
    'the Kimi sign-in stands shadowed under the env pin (env > sign-in > stored)',
    moonshotOauthUnderEnv?.active === false && (moonshotOauthUnderEnv?.stateNote ?? '').includes('env pin wins'),
  )
  // Without the env pin the sign-in is the active source and the stored
  // key says so — the same precedence the dispatch resolver bills.
  const signedIn = deriveFamilySlotGroups(providers, {
    moonshotEnvKey: () => undefined,
    moonshotStoredKey: () => 'sk-moon-stored-987654321',
    moonshotOauth: () => ({ accessToken: 'tok-never-shown-0001', refreshToken: 'rt' }),
    moonshotOauthRegion: () => 'mainland-cn',
    deepseekEnvKey: () => undefined,
    deepseekStoredKey: () => undefined,
    compatEnvKey: () => undefined,
    compatStoredKey: () => undefined,
  }).find(g => g.family.id === 'moonshot')
  const kimi = signedIn?.slots.find(s => s.id === 'moonshot:oauth')
  const shadowedKey = signedIn?.slots.find(s => s.id === 'moonshot:stored-key')
  check(
    'no env pin ⇒ the Kimi sign-in is ACTIVE, named by region, tail-masked',
    kimi?.active === true && kimi.kindLabel === 'Kimi sign-in' && kimi.identity.includes('mainland China (kimi.com)') && kimi.identity.includes('…0001') && !kimi.identity.includes('tok-never-shown'),
    JSON.stringify(kimi),
  )
  check(
    'the stored key under a sign-in is shadow-noted by the sign-in',
    shadowedKey?.active === false && shadowedKey.stateNote === 'shadowed — the Kimi sign-in wins',
    JSON.stringify(shadowedKey),
  )

  const deepseek = byFamily.get('deepseek')
  const deepseekStored = deepseek?.slots.find(s => s.id === 'deepseek:stored-key')
  check('deepseek stored key is active without an env pin', deepseekStored?.active === true)

  // Removal routing.
  const envRefusal = executeSlotRemoval(moonshotEnv!)
  check(
    'env pin removal refused naming the shell',
    envRefusal.mutated === false && envRefusal.note.includes('MOONSHOT_API_KEY'),
  )
  let moonshotCleared = 0
  let oauthDropped = 0
  const storedRemoval = executeSlotRemoval(moonshotStored!, {
    clearStoredMoonshotKey: () => void moonshotCleared++,
  })
  check('stored-key removal routes to the owning store', storedRemoval.mutated === true && moonshotCleared === 1)
  const oauthSlot = moonshot?.slots.find(s => s.id === 'moonshot:oauth')
  const oauthRemoval = executeSlotRemoval(oauthSlot!, {
    disconnectMoonshotOauth: () => void oauthDropped++,
  })
  check('OAuth removal routes to the token store', oauthRemoval.mutated === true && oauthDropped === 1)
}

section('2 · active-source usage shapes for the new lanes')
{
  const spend = () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 })
  const moonshot = activeSourceUsage({
    model: 'kimi-k3',
    reads: { moonshotAccount: () => ({ kind: 'api-key' }), spend },
  })
  check(
    'moonshot key ⇒ api-spend',
    moonshot.provider === 'moonshot' && moonshot.shape === 'api-spend' && moonshot.sourceKind === 'api-key',
  )
  const moonshotAbsent = activeSourceUsage({
    model: 'kimi-k3',
    reads: { moonshotAccount: () => undefined, spend },
  })
  check(
    "moonshot absent ⇒ shape 'none' with the provider label",
    moonshotAbsent.shape === 'none' && moonshotAbsent.label === 'Moonshot usage',
  )
  // The Kimi sign-in meters its plan: the stated rate windows shortest first
  // (the anthropic reading order), the overall quota last, each with its
  // stamp and reset; nothing observed ⇒ no windows (never a fabricated 0%).
  const kimiUsage = activeSourceUsage({
    model: 'kimi-k3',
    reads: {
      moonshotAccount: () => ({ kind: 'kimi-oauth' }),
      spend,
      kimiManagedUsage: () => ({
        observedAtMs: 1_755_900_000_000,
        quota: { used: 40, limit: 1000, resetsAtMs: 1_756_500_000_000 },
        windows: [
          { name: 'weekly', windowMinutes: 7 * 24 * 60, used: 40, limit: 1000, resetsAtMs: 1_756_500_000_000 },
          { windowMinutes: 300, used: 1, limit: 100, resetsAtMs: 1_755_950_000_000 },
        ],
      }),
    },
  })
  check(
    "a Kimi sign-in ⇒ 'subscription-windows' on the oauth source with the sign-in tier",
    kimiUsage.shape === 'subscription-windows' && kimiUsage.sourceKind === 'oauth' && kimiUsage.label === 'Kimi usage' && kimiUsage.tier === 'Kimi sign-in',
    JSON.stringify(kimiUsage),
  )
  check(
    'the windows read 5h · wk · quota with the stated percentages, resets and stamp',
    kimiUsage.windows.map(w => w.label).join(',') === '5h,wk,quota' &&
      kimiUsage.windows[0]?.usedPct === 1 &&
      kimiUsage.windows[1]?.usedPct === 4 &&
      kimiUsage.windows[2]?.usedPct === 4 &&
      kimiUsage.windows[0]?.resetsAtMs === 1_755_950_000_000 &&
      kimiUsage.windows.every(w => w.state === 'live' && w.observedAtMs === 1_755_900_000_000),
    JSON.stringify(kimiUsage.windows),
  )
  const kimiUnobserved = activeSourceUsage({
    model: 'kimi-k3',
    reads: { moonshotAccount: () => ({ kind: 'kimi-oauth' }), spend, kimiManagedUsage: () => null },
  })
  check('nothing observed yet ⇒ the sign-in shape with NO windows (labeled absence)', kimiUnobserved.shape === 'subscription-windows' && kimiUnobserved.windows.length === 0)
  const moonshotWithBalance = activeSourceUsage({
    model: 'kimi-k3',
    reads: {
      moonshotAccount: () => ({ kind: 'api-key' }),
      spend,
      moonshotBalance: () => ({ observedAtMs: 1_755_900_000_000, availableBalance: 49.58894 }),
    },
  })
  check(
    'moonshot surfaces the provider-stated balance (documented unit USD) with its stamp',
    moonshotWithBalance.balance?.display === 'USD 49.58894' &&
      moonshotWithBalance.balance.observedAtMs === 1_755_900_000_000,
  )
  const moonshotNoRecord = activeSourceUsage({
    model: 'kimi-k3',
    reads: { moonshotAccount: () => ({ kind: 'api-key' }), spend, moonshotBalance: () => null },
  })
  check('moonshot no observation ⇒ NO balance field (labeled absence)', moonshotNoRecord.balance === undefined)
  const deepseek = activeSourceUsage({
    model: 'deepseek-v4-pro',
    reads: {
      laneCredentialed: () => true,
      spend,
      deepseekBalance: () => ({
        observedAtMs: 1_755_800_000_000,
        isAvailable: true,
        balances: [{ currency: 'USD', totalBalance: '42.50' }],
      }),
    },
  })
  check(
    'deepseek surfaces the provider-stated balance with its stamp',
    deepseek.balance?.display === 'USD 42.50' && deepseek.balance.observedAtMs === 1_755_800_000_000,
  )
  const deepseekNoRecord = activeSourceUsage({
    model: 'deepseek-v4-pro',
    reads: { laneCredentialed: () => true, spend, deepseekBalance: () => null },
  })
  check('no observation ⇒ NO balance field (labeled absence)', deepseekNoRecord.balance === undefined)
  const compat = activeSourceUsage({
    model: 'compat/qwen3-32b',
    reads: { laneCredentialed: () => true, spend },
  })
  check('compat lane rides api-spend', compat.provider === 'openai-compat' && compat.shape === 'api-spend')
}

section('3 · the documented balance decode')
{
  const decoded = decodeDeepseekBalance(
    {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      ],
    },
    123,
  )
  check(
    'documented field names decode exactly',
    decoded?.isAvailable === true &&
      decoded.balances[0]?.currency === 'CNY' &&
      decoded.balances[0].totalBalance === '110.00' &&
      decoded.balances[0].grantedBalance === '10.00' &&
      decoded.balances[0].toppedUpBalance === '100.00' &&
      decoded.observedAtMs === 123,
  )
  check('junk refuses (never a guessed record)', decodeDeepseekBalance({ nonsense: 1 }, 0) === undefined)
  check('null refuses', decodeDeepseekBalance(null, 0) === undefined)

  // Moonshot:
  // GET /v1/users/me/balance ⇒ { code, data: { available_balance,
  // voucher_balance, cash_balance }, scode, status } — USD numbers. The
  // doc's own 200 example carries code 123, so the decode gates on the
  // stated data fields, not an invented code contract.
  const kimi = decodeMoonshotBalance(
    {
      code: 123,
      data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
      scode: '0x0',
      status: true,
    },
    456,
  )
  check(
    'moonshot documented envelope decodes verbatim',
    kimi?.availableBalance === 49.58894 &&
      kimi.voucherBalance === 46.58893 &&
      kimi.cashBalance === 3.00001 &&
      kimi.observedAtMs === 456,
  )
  const owing = decodeMoonshotBalance(
    { code: 0, data: { available_balance: 5, voucher_balance: 5, cash_balance: -2.5 }, status: true },
    1,
  )
  check(
    'negative cash (documented: the user owes) decodes verbatim, never clamped',
    owing?.cashBalance === -2.5 && owing.availableBalance === 5,
  )
  check('moonshot junk refuses', decodeMoonshotBalance({ nonsense: 1 }, 0) === undefined)
  check('moonshot missing data refuses', decodeMoonshotBalance({ code: 0, status: true }, 0) === undefined)
  check(
    'balance url rides the pinned base seam',
    moonshotBalanceUrl({ MERCURY_MOONSHOT_API_BASE: 'https://fixture.invalid/v1' } as NodeJS.ProcessEnv) ===
      'https://fixture.invalid/v1/users/me/balance',
  )
}

section('4 · /usage sections per family')
{
  const plan = usageSectionPlan([
    { id: 'moonshot', available: true, credentialed: false },
    { id: 'deepseek', available: true, credentialed: true, credentialLabel: 'DeepSeek API key (stored, auth-scoped)' },
    { id: 'openai-compat', available: true, credentialed: true, credentialLabel: 'LM Studio — no key' },
  ] as never)
  const titles = plan.map(s => s.title)
  check(
    'each family yields its section',
    titles.includes('Moonshot usage') && titles.includes('DeepSeek usage') && titles.includes('Custom endpoint usage'),
    titles.join(' | '),
  )
  const moonshotPlan = plan.find(s => s.title === 'Moonshot usage')
  check(
    'the connect route names the /logins row (the Kimi sign-in or a key)',
    (moonshotPlan?.connect ?? '').includes('/logins moonshot') && (moonshotPlan?.connect ?? '').includes('MOONSHOT_API_KEY'),
  )
}

section('5 · reasoning-history contracts (documented per model, wired per lane)')
{
  // platform.kimi.ai use-thinking-models: Preserved
  // Thinking always-on for kimi-k3 + kimi-k2.7-code(+highspeed) — historical
  // reasoning_content is returned; kimi-k2.6/k2.5 default (no thinking.keep
  // sent) ignores history, so those stay omit.
  check('kimi-k3 returns reasoning history', moonshotLaneProfile.keepsReasoningHistory?.('kimi-k3') === true)
  check('kimi-k2.7-code returns reasoning history (doc-mandatory)', moonshotLaneProfile.keepsReasoningHistory?.('kimi-k2.7-code') === true)
  check('kimi-k2.7-code-highspeed matches its base model', moonshotLaneProfile.keepsReasoningHistory?.('kimi-k2.7-code-highspeed') === true)
  check('kimi-k2.6 stays omit (opt-in model; no thinking.keep sent)', moonshotLaneProfile.keepsReasoningHistory?.('kimi-k2.6') === false)
  check('kimi-k2.5 stays omit', moonshotLaneProfile.keepsReasoningHistory?.('kimi-k2.5') === false)
  // DeepSeek documents the OPPOSITE constraint (returned reasoning rejects):
  // the profile declares nothing, and the runtime's absent-flag default is
  // omit — pinned so a future profile edit cannot silently flip it.
  check('deepseek declares NO reasoning-history flag (absent = omit, the documented constraint)', deepseekLaneProfile.keepsReasoningHistory === undefined)
  check('compat slot declares NO reasoning-history flag (unknown servers, conservative)', compatSlotLaneProfile.keepsReasoningHistory === undefined)
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
