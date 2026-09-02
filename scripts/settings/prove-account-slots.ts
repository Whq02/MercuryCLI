#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-account-slots.ts:
//  /accounts is the account-slots board — every login and stored key, across
//  ALL provider families, one slot each, per-slot removal routed to owners.
//
//  The design laws under proof:
//    · DERIVATION — the slot set walks providerFamilyPresences over the
//      catalogue plus each family's owning account resolvers; a THIRD family
//      in the catalogue yields its slot with NO board or seam edit; dark
//      lanes yield nothing; an uncredentialed family yields the empty group
//      (the board's absent row).
//    · SECRECY — a slot carries source labels and masked last-four TAILS
//      only; the key value itself rides no slot field.
//    · ROUTED REMOVAL — executeSlotRemoval maps each slot to exactly its
//      owning store; env-pinned keys are refused with the shell named and NO
//      owner call; scope-ring rows come back as guidance naming /logout as
//      the global verb.
//    · BOARD STRUCTURE — AccountView renders the derived groups and routes
//      ⌫ through the executor; the hand-kept provider table and the board's
//      direct store writes are absent; the board names the global /logout verb
//      and the /logins route.
//
//  Leg (5) exercises the REAL owner path over a hermetic home fixture; its
//  assertions are add-side only (ambient Anthropic state on a dev machine can
//  only ADD families/slots, so every assertion is monotone-safe under them).
//
//  Run:  ~/.bun/bin/bun run scripts/settings/prove-account-slots.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Env BEFORE any src import: hermetic config home; no credentials until leg (5);
// ambient shell keys cleared so slot sources are the fixture's, never the
// dev machine's.
const HOME = mkdtempSync(join(tmpdir(), 'account-slots-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.OPENAI_API_KEY
delete process.env.ZAI_API_KEY
delete process.env.ANTHROPIC_API_KEY

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { deriveFamilySlotGroups, executeSlotRemoval, maskedKeyTail } = await import(
  '../../src/services/providers/accountSlots.ts'
)
type Groups = ReturnType<typeof deriveFamilySlotGroups>
type Slot = Groups[number]['slots'][number]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' /accounts slot board — derivation + routed removal laws')
console.log('============================================================')

// The fabricated catalogue double: the real two families plus a THIRD the
// board has never heard of (the widened-id-union stand-in, Lane N's cast).
type ProvidersDouble = Parameters<typeof deriveFamilySlotGroups>[0]
const account = (kind: string, label: string) => ({ kind, label })
const double = [
  {
    id: 'anthropic',
    available: true,
    transport: 'anthropic-messages',
    description: { account: account('inherited-main', 'main-loop credentials') },
  },
  {
    id: 'openai',
    available: true,
    transport: 'openai-responses',
    description: { account: account('chatgpt-login', 'ChatGPT plus subscription') },
  },
  {
    id: 'acme',
    available: true,
    transport: 'acme-wire',
    description: { account: account('api-key', 'ACME_API_KEY (env)') },
  },
] as unknown as ProvidersDouble

const SCAN_DOUBLE = [
  {
    name: 'primary',
    dir: '/proof-home/.mercury',
    isCurrent: true,
    hasConfig: true,
    authed: true,
    email: 'main@example.com',
    uuid: 'uuid-main',
    claudeFamily: false,
  },
  {
    name: 'b',
    dir: '/proof-home/.mercury-account-b',
    isCurrent: false,
    hasConfig: true,
    authed: false,
    claudeFamily: false,
  },
]

const FULL_READS = {
  familyReads: {
    claudeSubscriber: () => true,
    subscriptionType: () => 'max',
    anthropicApiKeyPresent: () => true,
  },
  scanScopes: () => SCAN_DOUBLE,
  anthropicApiKey: () => ({ key: 'sk-ant-proof-value-9876', source: '/logins managed key' as const }),
  openaiSubscription: () => ({
    provider: 'openai' as const,
    kind: 'chatgpt-subscription' as const,
    label: 'ChatGPT plus subscription',
    accountId: 'acct_proof',
    planType: 'plus',
  }),
  openaiActiveAccount: () => ({
    provider: 'openai' as const,
    kind: 'chatgpt-subscription' as const,
    label: 'ChatGPT plus subscription',
  }),
  openaiApiKey: () => ({ key: 'sk-proof-openai-value-4321', source: 'stored' as const }),
  zaiEnvKey: () => 'zai-proof-env-value-8888',
  zaiStoredKey: () => 'zai-proof-stored-value-2468',
}

//
section('(1) derivation — one slot per signed-in identity, catalogue-driven')
{
  const groups = deriveFamilySlotGroups(double, FULL_READS)
  check('three catalogue families ⇒ three groups, catalogue order',
    groups.length === 3 && groups[0]?.family.id === 'anthropic' && groups[2]?.family.id === ('acme' as never))

  const anthropic = groups[0]!.slots
  check('anthropic: the scope ring + the API-key ladder ⇒ 3 slots', anthropic.length === 3, JSON.stringify(anthropic.map(s => s.id)))
  check('ring slot: OAuth kind, identity from the scan owner',
    anthropic[0]?.kind === 'oauth' && anthropic[0]?.identity === 'main@example.com' && anthropic[0]?.active === true)
  check('signed-out ring position stays a slot (honest ring, not signed in)',
    anthropic[1]?.signedIn === false && anthropic[1]?.kind === 'oauth')
  check('managed key slot: removable through its owner route',
    anthropic[2]?.kind === 'api-key' && anthropic[2]?.removal.route === 'anthropic-managed-key' && anthropic[2]?.envPinned === false)
  check('managed key slot: masked last-four tail rides the identity',
    anthropic[2]?.identity.includes('…9876') === true, String(anthropic[2]?.identity))

  const openai = groups[1]!.slots
  check('openai: subscription AND stored key ⇒ two slots (never just the active one)',
    openai.length === 2 && openai[0]?.kind === 'subscription' && openai[1]?.kind === 'api-key')
  check('the active source follows the owning resolver (subscription active, key standby)',
    openai[0]?.active === true && openai[1]?.active === false)
  check('stored key removal routes to the auth-scoped store',
    openai[1]?.removal.route === 'openai-stored-key')

  const acme = groups[2]!.slots
  check('THE THIRD-FAMILY LAW: acme yields its slot with no seam edit',
    acme.length === 1 && acme[0]?.kind === 'api-key' && acme[0]?.identity === 'ACME_API_KEY (env)')
  check('unknown family removal names the owning route (never a fake arm)',
    acme[0]?.removal.route === 'owner')

  const everySlot: Slot[] = groups.flatMap(g => g.slots)
  const dump = JSON.stringify(everySlot)
  check('SECRECY: no key value rides any slot field',
    !dump.includes('sk-ant-proof-value-9876') && !dump.includes('sk-proof-openai-value-4321') &&
      !dump.includes('zai-proof-env-value-8888') && !dump.includes('zai-proof-stored-value-2468'))
  check('maskedKeyTail: last four only, short values yield nothing',
    maskedKeyTail('sk-proof-openai-value-4321') === '…4321' && maskedKeyTail('short') === '')
}

//
section('(2) env pins + shadowing — the shell is named, never edited')
{
  const groups = deriveFamilySlotGroups(double, {
    ...FULL_READS,
    openaiApiKey: () => ({ key: 'sk-proof-openai-value-4321', source: 'env' as const }),
  })
  const openaiKey = groups[1]!.slots[1]
  check('env-sourced key is env-pinned with the env removal route',
    openaiKey?.envPinned === true && openaiKey?.removal.route === 'env' &&
      (openaiKey?.removal as { envVar?: string }).envVar === 'OPENAI_API_KEY')

  const zai = groups.find(g => g.family.id === 'zai')
  // The double carries no zai family — zai slots appear only when the
  // catalogue lists the family. Assert exactly that: derivation never
  // invents a family the catalogue does not know.
  check('no catalogue family ⇒ no group (derivation invents nothing)', zai === undefined)

  const withZai = deriveFamilySlotGroups(
    [...(double as unknown as unknown[]), {
      id: 'zai',
      available: true,
      transport: 'zai-chat-completions',
      description: { account: account('api-key', 'ZAI_API_KEY (env)') },
    }] as unknown as ProvidersDouble,
    FULL_READS,
  )
  const zaiSlots = withZai.find(g => g.family.id === ('zai' as never))?.slots ?? []
  check('zai: env pin + stored key ⇒ two slots, env the winner',
    zaiSlots.length === 2 && zaiSlots[0]?.envPinned === true && zaiSlots[0]?.active === true &&
      zaiSlots[1]?.active === false && zaiSlots[1]?.stateNote?.includes('shadowed') === true,
    JSON.stringify(zaiSlots.map(s => [s.id, s.active, s.stateNote])))
}

//
section('(3) absent + dark families')
{
  const absentDouble = [
    (double as unknown as Record<string, unknown>[])[0],
    {
      id: 'openai',
      available: false,
      reason: 'no-account:openai',
      transport: 'openai-responses',
      description: { account: account('none', 'no OpenAI account source connected') },
    },
  ] as unknown as ProvidersDouble
  const groups = deriveFamilySlotGroups(absentDouble, {
    ...FULL_READS,
    openaiSubscription: () => undefined,
    openaiApiKey: () => undefined,
    openaiActiveAccount: () => undefined,
  })
  const openai = groups.find(g => g.family.id === 'openai')
  check('no login anywhere ⇒ the EMPTY group (the board renders its absent row)',
    openai !== undefined && openai.slots.length === 0)

  const uncredentialedDouble = [
    (double as unknown as Record<string, unknown>[])[0],
    {
      id: 'openai',
      available: false,
      reason: 'no-account:openai',
      transport: 'openai-responses',
      description: { account: account('none', 'no OpenAI account source connected') },
    },
  ] as unknown as ProvidersDouble
  const uncredGroups = deriveFamilySlotGroups(uncredentialedDouble, FULL_READS)
  check('an uncredentialed lane still yields its group (absent ≠ hidden — /logins connects)',
    uncredGroups.some(g => g.family.id === 'openai'))
}

//
section('(4) executeSlotRemoval — each slot to exactly its owning store')
{
  const groups = deriveFamilySlotGroups(double, FULL_READS)
  const calls: string[] = []
  const spies = {
    disconnectOpenaiSubscription: () => calls.push('openai-sub'),
    clearStoredOpenaiKey: () => calls.push('openai-key'),
    clearStoredZaiKey: () => calls.push('zai-key'),
    clearManagedAnthropicKey: () => calls.push('anthropic-key'),
    signOutAnthropicOauth: () => calls.push('anthropic-signout'),
    openaiApiKeyAfter: () => ({ key: 'sk-proof-openai-value-4321', source: 'stored' as const }),
  }

  const sub = groups[1]!.slots[0]!
  calls.length = 0
  const subOut = executeSlotRemoval(sub, spies)
  check('subscription slot ⇒ the disconnect owner alone, honest still-resolves appendix',
    calls.join(',') === 'openai-sub' && subOut.mutated && subOut.note.includes('still resolves'))

  const storedKey = groups[1]!.slots[1]!
  calls.length = 0
  const keyOut = executeSlotRemoval(storedKey, spies)
  check('stored openai key ⇒ the providerSecrets clear alone',
    calls.join(',') === 'openai-key' && keyOut.mutated)

  const managed = groups[0]!.slots[2]!
  calls.length = 0
  const managedOut = executeSlotRemoval(managed, spies)
  check('managed anthropic key ⇒ the removeApiKey owner alone',
    calls.join(',') === 'anthropic-key' && managedOut.mutated)

  const envSlot = deriveFamilySlotGroups(double, {
    ...FULL_READS,
    openaiApiKey: () => ({ key: 'sk-proof-openai-value-4321', source: 'env' as const }),
  })[1]!.slots[1]!
  calls.length = 0
  const envOut = executeSlotRemoval(envSlot, spies)
  check('ENV PIN: refused, the shell named, NO owner called, nothing mutated',
    calls.length === 0 && !envOut.mutated && envOut.note.includes('OPENAI_API_KEY') && envOut.note.includes('shell'))

  // The plain slot model (account-slot simplification, operator
  // ruling): ⌫ on the signed-in Anthropic OAuth slot is a per-slot
  // SIGN-OUT through the owning route — tokens leave, the home stays, and
  // /logout remains the global verb. A signed-out ring position answers
  // honestly with no owner call.
  const current = groups[0]!.slots[0]!
  calls.length = 0
  const currentOut = executeSlotRemoval(current, spies)
  check('current signed-in OAuth slot ⇒ the sign-out owner alone, mutated',
    calls.join(',') === 'anthropic-signout' && currentOut.mutated && currentOut.note.includes('tokens'))
  check('the sign-out note keeps the home and names /logout as the GLOBAL verb',
    currentOut.note.includes('stay') && currentOut.note.includes('/logout'))

  const signedOutPosition = groups[0]!.slots[1]!
  calls.length = 0
  const signedOutOut = executeSlotRemoval(signedOutPosition, spies)
  check('a signed-out ring position ⇒ honest no-op, no owner called, nothing mutated',
    calls.length === 0 && !signedOutOut.mutated && signedOutOut.note.includes('not signed in'))

  // The primary ~/.mercury home is a login like any other: ⌫ signs its
  // login out through the same owner — the directory itself is never a
  // removal target (no rm arm exists in the seam).
  const primary = deriveFamilySlotGroups(double, {
    ...FULL_READS,
    scanScopes: () => [{ ...SCAN_DOUBLE[0]!, isCurrent: false, dir: join(homedir(), '.mercury') }],
  })[0]!.slots[0]!
  calls.length = 0
  const primaryOut = executeSlotRemoval(primary, spies)
  check('the primary home slot signs out through the owner — the home itself is never removed',
    calls.join(',') === 'anthropic-signout' && primaryOut.mutated && primaryOut.note.includes('home') && !primaryOut.note.includes('rm -rf'))

  const claudeSlot = deriveFamilySlotGroups(double, {
    ...FULL_READS,
    scanScopes: () => [{ ...SCAN_DOUBLE[1]!, dir: '/proof-home/.claude', name: 'external', claudeFamily: true }],
  })[0]!.slots[0]!
  calls.length = 0
  const claudeOut = executeSlotRemoval(claudeSlot, spies)
  check("a Claude-family scope is excluded (class isolation) — never a Mercury removal",
    calls.length === 0 && !claudeOut.mutated && claudeOut.note.includes('not a Mercury slot'))

  const acme = groups[2]!.slots[0]!
  calls.length = 0
  const acmeOut = executeSlotRemoval(acme, spies)
  check('unknown family ⇒ the owning-route note, no owner called',
    calls.length === 0 && !acmeOut.mutated && acmeOut.note.includes('owning store'))
}

//
section('(5) the board renders the seam — structural pins on AccountView')
{
  const source = readFileSync(
    new URL('../../src/components/mercury-ui/parity/AccountView.tsx', import.meta.url),
    'utf8',
  )
  check('the board derives its rows from the seam', source.includes('deriveFamilySlotGroups()'))
  check('⌫ routes through executeSlotRemoval (never an inlined store write)',
    source.includes('executeSlotRemoval(') &&
      !source.includes('writeStoredOpenaiApiKey') &&
      !source.includes('disconnectOpenaiSubscription'))
  check('the hand-kept provider row table is dead', !source.includes('PROVIDER_ROW_PRESENTATION'))
  check('the Anthropic-first section framing is dead',
    !source.includes('Anthropic accounts — Mercury slots'))
  check('the board names the global verb', source.includes('/logout signs out of everything'))
  check('absent families carry the /logins route', source.includes('/logins'))
}

//
section('(6) the REAL owner path — hermetic home fixture (add-side assertions)')
{
  writeFileSync(
    join(HOME, '.openai-auth.json'),
    JSON.stringify({
      version: 1,
      tokens: {
        idToken: '',
        accessToken: 'fixture-access',
        refreshToken: 'fixture-refresh',
        accountId: 'acct_fixture',
        planType: 'plus',
      },
    }),
  )
  writeFileSync(
    join(HOME, '.provider-secrets.json'),
    JSON.stringify({
      version: 1,
      openaiApiKey: 'sk-fixture-openai-key-abcd',
      zaiApiKey: 'zai-fixture-key-efgh',
      zaiKeyPlan: 'coding',
      moonshotApiKey: 'sk-moonshot-fixture-key-ijkl',
      deepseekApiKey: 'sk-deepseek-fixture-key-mnop',
    }),
  )
  // A Kimi sign-in beside the stored Moonshot key (the /logins device leg's
  // own store shape: tokens + the region they were minted in).
  writeFileSync(
    join(HOME, '.moonshot-auth.json'),
    JSON.stringify({
      version: 1,
      tokens: { accessToken: 'kimi-fixture-access-token-qrst', refreshToken: 'kimi-fixture-refresh', accessTokenExpiresAtMs: 4102444800000 },
      region: 'global',
    }),
  )
  delete process.env.MOONSHOT_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  const groups = deriveFamilySlotGroups()
  const openai = groups.find(g => g.family.id === 'openai')
  check('real owners: the subscription slot carries the plan label',
    openai?.slots.some(s => s.kind === 'subscription' && s.identity === 'ChatGPT plus subscription') === true,
    JSON.stringify(openai?.slots.map(s => s.identity)))
  check('real owners: the stored key slot appears BESIDE the subscription, tail-masked',
    openai?.slots.some(s => s.kind === 'api-key' && s.identity.includes('…abcd') && s.removal.route === 'openai-stored-key') === true)
  const zai = groups.find(g => g.family.id === 'zai')
  check('real owners: the stored Z.AI key yields its slot',
    zai?.slots.some(s => s.identity.includes('…efgh') && s.removal.route === 'zai-stored-key') === true,
    JSON.stringify(zai?.slots))
  check('real owners: a GLM Coding Plan key names its plan on the slot (the base it is valid on)',
    zai?.slots.some(s => s.identity.startsWith('GLM Coding Plan key') && s.kindLabel === 'Coding Plan key') === true,
    JSON.stringify(zai?.slots))
  // The three /logins families from ONE credential truth each: the Kimi
  // sign-in is the active Moonshot source and the stored key says the
  // sign-in shadows it; the DeepSeek key stands alone.
  const moonshot = groups.find(g => g.family.id === 'moonshot')
  const kimi = moonshot?.slots.find(s => s.id === 'moonshot:oauth')
  const moonshotKey = moonshot?.slots.find(s => s.id === 'moonshot:stored-key')
  check('real owners: the Kimi sign-in slot is the active source, named by region, tail-masked',
    kimi?.active === true && kimi.signedIn && kimi.kindLabel === 'Kimi sign-in' && kimi.identity.includes('global (kimi.ai)') && kimi.identity.includes('…qrst') && kimi.removal.route === 'moonshot-oauth',
    JSON.stringify(kimi))
  check('real owners: the stored Moonshot key stands shadowed by the sign-in',
    moonshotKey?.active === false && moonshotKey.stateNote === 'shadowed — the Kimi sign-in wins' && moonshotKey.identity.includes('…ijkl'),
    JSON.stringify(moonshotKey))
  check('real owners: the family presence derives the SAME winner (the Kimi sign-in label)',
    moonshot?.family.credentialed === true && moonshot.family.credentialLabel?.startsWith('Kimi account (device-code sign-in') === true,
    JSON.stringify(moonshot?.family))
  const deepseek = groups.find(g => g.family.id === 'deepseek')
  check('real owners: the stored DeepSeek key yields its active slot',
    deepseek?.slots.some(s => s.id === 'deepseek:stored-key' && s.active && s.identity.includes('…mnop')) === true,
    JSON.stringify(deepseek?.slots))
  const dump = JSON.stringify(groups.flatMap(g => g.slots))
  check('real owners: no fixture key value rides any slot',
    !dump.includes('sk-fixture-openai-key-abcd') && !dump.includes('zai-fixture-key-efgh') &&
      !dump.includes('sk-moonshot-fixture-key-ijkl') && !dump.includes('sk-deepseek-fixture-key-mnop') && !dump.includes('kimi-fixture-access-token-qrst'))
}

//
console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ account slots: all green')
  process.exit(0)
}
console.log(` ❌ ${failures} ACCOUNT-SLOT FAILURE(S)`)
process.exit(1)
