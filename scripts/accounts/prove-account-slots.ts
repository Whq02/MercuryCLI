#!/usr/bin/env bun

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(2, 66 - t.length))}`)
}

console.log('============================================================')
console.log(' account slots — the plain slot model')
console.log('============================================================')

const slots = await import('../../src/models/roads/accountSlots.ts')
const {
  deriveFamilySlotGroups,
  executeSlotRemoval,
  familySigninCeiling,
  familySigninCount,
  signinCeilingRefusal,
} = slots

section('§1 ceilings are typed')
{
  check('anthropic ceiling is 2', familySigninCeiling('anthropic') === 2, 'familySigninCeiling in src/models/roads/account-slots/signin.ts must return 2 for anthropic')
  check('openai ceiling is 2', familySigninCeiling('openai') === 2, 'familySigninCeiling in src/models/roads/account-slots/signin.ts must return 2 for openai')
  check('un-ruled families carry no ceiling', familySigninCeiling('zai') === undefined && familySigninCeiling('local') === undefined, 'familySigninCeiling in src/models/roads/account-slots/signin.ts must return undefined for families with no ceiling')
  const r = signinCeilingRefusal('anthropic', 2)
  check('at the ceiling: a typed refusal', r !== undefined && r.refused === true && r.family === 'anthropic' && r.ceiling === 2 && r.current === 2, 'signinCeilingRefusal in src/models/roads/account-slots/signin.ts must return a typed refusal (refused, family, ceiling, current) at the ceiling')
  check('the refusal NAMES the ceiling and the remedy', r !== undefined && /2 concurrent/.test(r.message) && /sign out/.test(r.message), 'the refusal message of signinCeilingRefusal in src/models/roads/account-slots/signin.ts must state the ceiling (2 concurrent) and say to sign out')
  check('re-login stays allowed by the refusal copy itself', r !== undefined && /re-login/.test(r.message), 'the refusal message of signinCeilingRefusal in src/models/roads/account-slots/signin.ts must say that re-login stays allowed')
  check('below the ceiling: no refusal', signinCeilingRefusal('anthropic', 1) === undefined, 'signinCeilingRefusal in src/models/roads/account-slots/signin.ts must return undefined below the ceiling')
  check('no ceiling ⇒ never refuses', signinCeilingRefusal('huggingface', 9) === undefined, 'signinCeilingRefusal in src/models/roads/account-slots/signin.ts must return undefined for a family with no ceiling')
}

section('§2 the ceiling is structural (maximal stores) + found shapes recorded')
{
  const key = 'sk-test-000000000000'
  const reads = {
    scanScopes: () => [
      { name: 'primary', dir: '/tmp/prove-slots-home', isCurrent: true, hasConfig: true, authed: true, email: 'a@x.com', uuid: 'u-1', foreignHarness: false },
    ],
    anthropicApiKey: () => ({ key, source: 'login-managed' as const }),
    openaiSubscription: () => ({ kind: 'chatgpt-subscription' as const, label: 'ChatGPT · plus' }),
    openaiActiveAccount: () => ({ kind: 'chatgpt-subscription' as const, label: 'ChatGPT · plus' }),
    openaiApiKey: () => ({ key, source: 'stored' as const }),
    zaiEnvKey: () => key,
    zaiStoredKey: () => key,
    openrouterEnvKey: () => key,
    openrouterMintedKey: () => ({ key, mintedAtMs: Date.now() }),
    openrouterStoredKey: () => key,
    geminiOauthConnected: () => true,
    geminiActiveAccount: () => ({ kind: 'oauth' as const }),
    geminiEnvGoogleKey: () => key,
    geminiEnvGeminiKey: () => key,
    geminiStoredKey: () => key,
    moonshotEnvKey: () => key,
    moonshotStoredKey: () => key,
    moonshotOauth: () => ({ accessToken: key }),
    deepseekEnvKey: () => key,
    deepseekStoredKey: () => key,
    compatEnvKey: () => key,
    compatStoredKey: () => key,
    huggingfaceEnvKey: () => key,
    huggingfaceOauth: () => ({ accessToken: key }),
    huggingfaceOauthIdentity: () => ({ username: 'hf-user' }),
    huggingfaceStoredKey: () => key,
    huggingfaceStoredKeyIdentity: () => ({ username: 'hf-user' }),
    localEnvKey: () => key,
    localStoredKey: () => key,
    localAccount: () => ({ kind: 'keyless' as const, label: 'ollama :11434' }),
    familyReads: { claudeSubscriber: () => true },
  }
  const groups = deriveFamilySlotGroups(undefined, reads as never)
  const identities = { '/tmp/prove-slots-home': { state: 'verified' as const, email: 'a@x.com' } }
  const counts: Record<string, number> = {}
  for (const g of groups) counts[g.family.id] = familySigninCount(g.slots, identities)
  for (const fam of ['anthropic', 'openai']) {
    const ceiling = familySigninCeiling(fam)!
    check(
      `${fam}: maximal stores yield ${counts[fam]} Mercury-held sign-ins ≤ ceiling ${ceiling}`,
      counts[fam] !== undefined && counts[fam]! <= ceiling,
      `${String(counts[fam])} · familySigninCount in src/models/roads/account-slots/signin.ts must not count more Mercury-held sign-ins than the ceiling, however full the stores are`,
    )
  }
  check('anthropic maximal = exactly 2 (OAuth login + managed key)', counts['anthropic'] === 2, `${String(counts['anthropic'])} · familySigninCount in src/models/roads/account-slots/signin.ts and deriveFamilySlotGroups in src/models/roads/accountSlots.ts must count the OAuth login and the managed key as two`)
  check('openai maximal = exactly 2 (subscription + stored key)', counts['openai'] === 2, `${String(counts['openai'])} · familySigninCount in src/models/roads/account-slots/signin.ts and deriveFamilySlotGroups in src/models/roads/accountSlots.ts must count the subscription and the stored key as two`)
  const found: Record<string, number> = { zai: 1, openrouter: 2, gemini: 2, moonshot: 2, deepseek: 1, 'openai-compat': 1, huggingface: 2, local: 2 }
  for (const [fam, expected] of Object.entries(found)) {
    check(`found shape: ${fam} holds ${expected} (recorded fact)`, counts[fam] === expected, `${fam}=${counts[fam]} · deriveFamilySlotGroups in src/models/roads/accountSlots.ts changed how many slots ${fam} holds; restore it, or update the recorded count in this proof if the change was meant`)
  }
}

section('§3 plain sign-out per slot (the anthropic OAuth slot)')
{
  const signedIn = {
    family: 'anthropic', id: '/tmp/prove-slots-home', name: 'primary', kind: 'oauth' as const,
    kindLabel: 'OAuth', identity: 'a@x.com', active: true, envPinned: false, signedIn: true,
    scope: { name: 'primary', dir: '/tmp/prove-slots-home', isCurrent: true, hasConfig: true, authed: true, foreignHarness: false },
    removal: { route: 'anthropic-oauth' as const, dir: '/tmp/prove-slots-home' },
  }
  let fired = 0
  const out = executeSlotRemoval(signedIn as never, { signOutAnthropicOauth: () => { fired++ } })
  check('⌫ on a signed-in slot routes to the sign-out owner exactly once', fired === 1 && out.mutated, `${JSON.stringify(out)} · executeSlotRemoval in src/models/roads/account-slots/removal.ts must call the anthropic OAuth sign-out once and report mutated`)
  check('the note says tokens leave and the home stays', /sign/.test(out.note) && /home/.test(out.note) && /stay/.test(out.note), `${out.note} · the note from executeSlotRemoval in src/models/roads/account-slots/removal.ts must say tokens leave and the home stays`)
  const signedOut = { ...signedIn, signedIn: false, identity: 'not signed in' }
  let fired2 = 0
  const out2 = executeSlotRemoval(signedOut as never, { signOutAnthropicOauth: () => { fired2++ } })
  check('a signed-out slot answers honestly, mutating nothing', fired2 === 0 && !out2.mutated && /not signed in/.test(out2.note), `${out2.note} · executeSlotRemoval in src/models/roads/account-slots/removal.ts must call no sign-out and answer not signed in for a signed-out slot`)
}


console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('ACCOUNT SLOTS: ALL GREEN')
else console.log(`❌ ${failures} ACCOUNT-SLOT LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
