#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-account-slots.ts — THE PLAIN SLOT MODEL
//  (account-slot simplification, operator ruling).
//  This prover RE-PINS the accounts suite onto the new model —
//  the laws that defended rotation/switching were re-cut with the ruling
//  named (see each section), never silently dropped.
//
//  §1 CEILINGS ARE TYPED (ideology law 3): anthropic and openai carry a
//     2-concurrent-sign-in ceiling; the refusal is a typed shape naming the
//     family, the ceiling, and the remedy — never a silent drop.
//  §2 THE CEILING IS STRUCTURAL: with every store maximally populated, no
//     family's derivation can exceed its ceiling of Mercury-HELD sign-ins
//     (env pins are the shell's, not sign-ins). Other families' found
//     shapes are RECORDED as facts (the brief's record-what-you-find).
//  §3 PLAIN SIGN-OUT PER SLOT: the anthropic OAuth slot's ⌫ signs out THIS
//     login through the owning route — tokens leave, the home dir and
//     transcripts stay; a signed-out slot answers honestly with no mutation.
//     (Replaces the retired scope-ring removal guidance.)
//  §4 THE SWITCHING MACHINERY IS ABSENT (the superseded laws' tombstone —
//     the operator's word supersedes the older ratified switching laws):
//     no slot re-pointing, no staged switch, no persisted selection, no
//     relay ring anywhere in src.
//  §5 RE-LOGIN IS THE ONE GESTURE: the board's ↵ on the anthropic slot
//     begins the in-place scoped sign-in (own OAuth link, code pastes in
//     place); the save lands through the audited scope bracket.
// ============================================================================
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

const slots = await import('../../src/services/providers/accountSlots.ts')
const {
  deriveFamilySlotGroups,
  executeSlotRemoval,
  familySigninCeiling,
  familySigninCount,
  signinCeilingRefusal,
} = slots

section('§1 ceilings are typed')
{
  check('anthropic ceiling is 2', familySigninCeiling('anthropic') === 2)
  check('openai ceiling is 2', familySigninCeiling('openai') === 2)
  check('un-ruled families carry no ceiling', familySigninCeiling('zai') === undefined && familySigninCeiling('local') === undefined)
  const r = signinCeilingRefusal('anthropic', 2)
  check('at the ceiling: a typed refusal', r !== undefined && r.refused === true && r.family === 'anthropic' && r.ceiling === 2 && r.current === 2)
  check('the refusal NAMES the ceiling and the remedy', r !== undefined && /2 concurrent/.test(r.message) && /sign out/.test(r.message))
  check('re-login stays allowed by the refusal copy itself', r !== undefined && /re-login/.test(r.message))
  check('below the ceiling: no refusal', signinCeilingRefusal('anthropic', 1) === undefined)
  check('no ceiling ⇒ never refuses', signinCeilingRefusal('huggingface', 9) === undefined)
}

section('§2 the ceiling is structural (maximal stores) + found shapes recorded')
{
  // Maximal injected reads: every family's stores fully populated at once.
  const key = 'sk-test-000000000000'
  const reads = {
    scanScopes: () => [
      { name: 'primary', dir: '/tmp/prove-slots-home', isCurrent: true, hasConfig: true, authed: true, email: 'a@x.com', uuid: 'u-1', claudeFamily: false },
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
  // The count reads the ONE sign-in derivation: a scope slot counts only
  // through its live identity read (here the verifier's answer for the
  // fixture scope is 'verified'); keys and tokens count by presence.
  const identities = { '/tmp/prove-slots-home': { state: 'verified' as const, email: 'a@x.com' } }
  const counts: Record<string, number> = {}
  for (const g of groups) counts[g.family.id] = familySigninCount(g.slots, identities)
  for (const fam of ['anthropic', 'openai']) {
    const ceiling = familySigninCeiling(fam)!
    check(
      `${fam}: maximal stores yield ${counts[fam]} Mercury-held sign-ins ≤ ceiling ${ceiling}`,
      counts[fam] !== undefined && counts[fam]! <= ceiling,
      String(counts[fam]),
    )
  }
  check('anthropic maximal = exactly 2 (OAuth login + managed key)', counts['anthropic'] === 2, String(counts['anthropic']))
  check('openai maximal = exactly 2 (subscription + stored key)', counts['openai'] === 2, String(counts['openai']))
  // Found shapes, recorded as facts (record-what-you-find): the other
  // families' Mercury-held maxima under today's stores.
  const found: Record<string, number> = { zai: 1, openrouter: 2, gemini: 2, moonshot: 2, deepseek: 1, 'openai-compat': 1, huggingface: 2, local: 2 }
  for (const [fam, expected] of Object.entries(found)) {
    check(`found shape: ${fam} holds ${expected} (recorded fact)`, counts[fam] === expected, `${fam}=${counts[fam]}`)
  }
}

section('§3 plain sign-out per slot (the anthropic OAuth slot)')
{
  const signedIn = {
    family: 'anthropic', id: '/tmp/prove-slots-home', name: 'primary', kind: 'oauth' as const,
    kindLabel: 'OAuth', identity: 'a@x.com', active: true, envPinned: false, signedIn: true,
    scope: { name: 'primary', dir: '/tmp/prove-slots-home', isCurrent: true, hasConfig: true, authed: true, claudeFamily: false },
    removal: { route: 'anthropic-oauth' as const, dir: '/tmp/prove-slots-home' },
  }
  let fired = 0
  const out = executeSlotRemoval(signedIn as never, { signOutAnthropicOauth: () => { fired++ } })
  check('⌫ on a signed-in slot routes to the sign-out owner exactly once', fired === 1 && out.mutated, JSON.stringify(out))
  check('the note says tokens leave and the home stays', /sign/.test(out.note) && /home/.test(out.note) && /stay/.test(out.note), out.note)
  const signedOut = { ...signedIn, signedIn: false, identity: 'not signed in' }
  let fired2 = 0
  const out2 = executeSlotRemoval(signedOut as never, { signOutAnthropicOauth: () => { fired2++ } })
  check('a signed-out slot answers honestly, mutating nothing', fired2 === 0 && !out2.mutated && /not signed in/.test(out2.note), out2.note)
  // The home dir is never deleted by any removal route (structural).
  const slotsSrc = readFileSync(join(import.meta.dir, '../../src/services/providers/accountSlots.ts'), 'utf8')
  check('no removal route deletes a directory', !slotsSrc.includes('rmSync') && !slotsSrc.includes('rm -rf'))
}

section('§4 the switching machinery is ABSENT (superseded-law tombstone)')
{
  // The ruling SUPERSEDES the ratified switching laws these
  // symbols carried (seamless switch · staged switch · relay ring · boot
  // scope pin). Their absence is the new law.
  const gone = [
    'slotScopeCredential',
    'applyBootAuthScope',
    'applyStagedAccountSwitch',
    'cycleStagedAccount',
    'writeSelectedAccount',
    'launchAccounts(',
    'onUsageLimitError',
    'isCursusEnabled',
  ]
  for (const sym of gone) {
    const hits = execSync(
      `grep -rl ${JSON.stringify(sym)} ../../src --include='*.ts' --include='*.tsx' || true`,
      { cwd: import.meta.dir, encoding: 'utf8' },
    ).trim()
    check(`absent from src: ${sym.replace(/\($/, '')}`, hits === '', hits)
  }
}

section('§5 the login gesture reroutes to Logins (board wiring — operator-ruled)')
{
  // Re-trued from the retired in-place arm: the board is INVENTORY ONLY
  // (prove-accounts-inventory-only carries the full law); this section keeps
  // the slot-derivation half — the current-scope reroute, the wrong-store
  // exception, and the audited reauth bracket that the Logins owner still
  // rides for scoped sign-ins.
  const board = readFileSync(join(import.meta.dir, '../../src/components/mercury-ui/parity/AccountView.tsx'), 'utf8')
  check('↵ on the current anthropic scope reroutes to Logins, family-focused', board.includes("rerouteToLogins('anthropic'"))
  check('a non-current scope names the honest road (never the wrong store)', board.includes('MERCURY_CONFIG_DIR='))
  const reauth = readFileSync(join(import.meta.dir, '../../src/utils/accounts/scopedReauth.ts'), 'utf8')
  check('the reauth save lands through the audited scope bracket', reauth.includes('setAuthScope(pending.dir)') && reauth.includes('saveOAuthTokensIfNeeded'))
  check('the board headers surface the ceiling headroom through the one derivation', board.includes('familySigninCeiling(group.family.id)') && board.includes('familySigninHeaderNote(group.family.id, group.slots, identities)'))
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('ACCOUNT SLOTS: ALL GREEN')
else console.log(`❌ ${failures} ACCOUNT-SLOT LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
