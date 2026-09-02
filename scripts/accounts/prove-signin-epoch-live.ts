#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-signin-epoch-live.ts — signing in or out updates
//  every reader in this process, and the warm session runner reads the
//  disk's truth at its claim (the operator sighting: after a sign-in the chat
//  still said "No <family> account for the current model" until a NEW
//  session was started).
//
//  ROOT CAUSES (adjudicated from the source):
//    · the composer's not-logged-in gate memoised on [apiKeyStatus,
//      mainLoopModel] — the wallet enumeration inside it is live, but the
//      memo had no key that moved on a sign-in, so the steering line stood
//      until the composer re-mounted with the next session;
//    · the sign-in ledger bumped its epoch on landed records but nothing
//      could SUBSCRIBE, and a sign-OUT bumped nothing at all;
//    · the warm runner's credential reads are process-lifetime memos whose
//      only cross-process invalidator runs on the token-refresh road — a
//      runner booted before the sign-in served the claimed session its
//      boot-time null (and a beta-header set computed under it);
//    · the usage-limit latches are keyed on the family or the source kind,
//      never the credential — a departed account's wall refused work on its
//      successor, its usage bands painted the successor's meters.
//
//  THE LAWS:
//    E1  the ledger's epoch moves on every landed record AND every removal,
//        and subscribers hear every move (unsubscribe honoured);
//    E2  the per-slot removal owner announces the move and forgets the
//        family's observations; the everything-verb forgets every family's;
//    E3  a fresh ChatGPT sign-in and a disconnect both forget the
//        subscription source's observations (the raw wall AND the bands);
//    E4  the composer's gate and the boot chip key on the epoch through the
//        ONE hook (structural); the warm claim drops the credential memos
//        (structural); dropCredentialMemos re-reads the disk (behavioural).
//
//  Run: ~/.bun/bin/bun run scripts/accounts/prove-signin-epoch-live.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'signin-epoch-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.OPENAI_API_KEY
delete process.env.ANTHROPIC_API_KEY

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const ledger = await import('../../src/utils/accounts/signInLedger.ts')
const slots = await import('../../src/services/providers/accountSlots.ts')
const openaiLimits = await import('../../src/services/providers/openai/openaiLimitState.ts')
const openrouterLimits = await import('../../src/services/providers/openrouter/openrouterUsageState.ts')
const geminiLimits = await import('../../src/services/providers/gemini/geminiUsageState.ts')
const hfLimits = await import('../../src/services/providers/huggingface/huggingfaceUsageState.ts')
const accounts = await import('../../src/services/providers/openai/openaiAccounts.ts')
const cap = await import('../../src/services/capFailover.ts')
const auth = await import('../../src/utils/auth.ts')

section('E1 the epoch moves on sign-ins AND removals, and subscribers hear it')
{
  const before = ledger.signInLedgerEpoch()
  let heard = 0
  const unsubscribe = ledger.subscribeSignInEpoch(() => {
    heard += 1
  })
  check('a landed record bumps the epoch and wakes the subscriber', ledger.recordSignIn('openai', 'subscription', { home: HOME }) && ledger.signInLedgerEpoch() === before + 1 && heard === 1)
  ledger.noteCredentialRemoval()
  check('a removal bumps the SAME epoch and wakes the subscriber', ledger.signInLedgerEpoch() === before + 2 && heard === 2)
  const throwing = ledger.subscribeSignInEpoch(() => {
    throw new Error('a subscriber down')
  })
  ledger.noteCredentialRemoval()
  check('a throwing subscriber never fails the move, and the others still hear it', ledger.signInLedgerEpoch() === before + 3 && heard === 3)
  throwing()
  unsubscribe()
  ledger.noteCredentialRemoval()
  check('an unsubscribed listener hears nothing more', heard === 3 && ledger.signInLedgerEpoch() === before + 4)
  check('the ledger keeps its records across a removal (a sign-out is not a sign-in)', ledger.readSignInRecord('openai', { home: HOME })?.kind === 'subscription')
}

section('E2 the per-slot removal owner: the move is announced, the observations leave with the credential')
{
  const now = Date.now()
  openaiLimits.recordOpenaiUsageLimit(now + 3_600_000, 'chatgpt-subscription')
  openaiLimits.recordOpenaiRateHeaders(new Headers({ 'x-codex-primary-used-percent': '88', 'x-codex-primary-window-minutes': '10080' }))
  openaiLimits.recordOpenaiUsageLimit(now + 3_600_000, 'api-key')
  const epochBefore = ledger.signInLedgerEpoch()
  let woke = 0
  const off = ledger.subscribeSignInEpoch(() => {
    woke += 1
  })
  const subscriptionSlot = {
    family: 'openai',
    id: 'openai:subscription',
    name: 'chatgpt',
    kind: 'subscription',
    kindLabel: 'prolite subscription',
    identity: 'gpt-operator@example.com',
    active: true,
    envPinned: false,
    signedIn: true,
    removal: { route: 'openai-subscription' },
  }
  const out = slots.executeSlotRemoval(subscriptionSlot as never, { disconnectOpenaiSubscription: () => {}, openaiApiKeyAfter: () => undefined })
  check('the removal mutated through its owner', out.mutated === true)
  check('…and announced the move (the epoch bumped, the subscriber woke)', ledger.signInLedgerEpoch() === epochBefore + 1 && woke === 1)
  check("…and the subscription source's observations left with it — the wall AND the bands", openaiLimits.openaiObservedWall('chatgpt-subscription') === null && Object.keys(openaiLimits.openaiObservedUsage()).length === 0)
  check("…while the OTHER source's wall stands (a separate pool)", openaiLimits.openaiObservedWall('api-key') !== null)
  const keySlot = { ...subscriptionSlot, id: 'openai:stored-key', name: 'api-key', kind: 'api-key', kindLabel: 'API key', removal: { route: 'openai-stored-key' } }
  slots.executeSlotRemoval(keySlot as never, { clearStoredOpenaiKey: () => {} })
  check("the key slot's removal forgets the key source's wall", openaiLimits.openaiObservedWall('api-key') === null)
  const guidance = { ...subscriptionSlot, envPinned: true, removal: { route: 'env', envVar: 'OPENAI_API_KEY' } }
  const woken = woke
  const refused = slots.executeSlotRemoval(guidance as never)
  check('a refused removal (an env pin) announces nothing', refused.mutated === false && woke === woken)
  // The handoff note whose home is the removed family clears; another
  // family's note stands.
  cap.noteCapHandoff('gpt-5.6-sol', 'openai')
  slots.executeSlotRemoval(subscriptionSlot as never, { disconnectOpenaiSubscription: () => {}, openaiApiKeyAfter: () => undefined })
  check('a removal of the HOME family clears the failover handoff note', cap.capHandoffState() === null)
  cap.noteCapHandoff('claude-fable-5', 'anthropic')
  slots.executeSlotRemoval(subscriptionSlot as never, { disconnectOpenaiSubscription: () => {}, openaiApiKeyAfter: () => undefined })
  check("a removal of ANOTHER family leaves the note standing", cap.capHandoffState()?.homeFamily === 'anthropic')
  cap.noteCapReturn()
  off()

  // The everything-verb forgets every engine family's observations.
  openrouterLimits.recordOpenrouterRateHeaders(new Headers({ 'retry-after': '120' }))
  geminiLimits.recordGeminiUsageLimit(now + 60_000)
  hfLimits.recordHuggingfaceRateHeaders(new Headers({ 'retry-after': '90' }), 429)
  openaiLimits.recordOpenaiUsageLimit(now + 3_600_000, 'chatgpt-subscription')
  slots.signOutEveryEngineCredential({
    disconnectOpenaiSubscription: () => {},
    clearStoredOpenaiKey: () => {},
    clearStoredZaiKey: () => {},
    disconnectOpenrouterOauthKey: () => {},
    clearStoredOpenrouterKey: () => {},
    disconnectGeminiOauth: () => {},
    clearStoredGeminiKey: () => {},
    clearStoredMoonshotKey: () => {},
    disconnectMoonshotOauth: () => {},
    clearStoredDeepseekKey: () => {},
    clearStoredCompatKey: () => {},
    disconnectHuggingfaceOauth: () => {},
    clearStoredHuggingfaceKey: () => {},
    clearStoredLocalKey: () => {},
  })
  check('/logout\'s engine half forgets every family\'s observed wall', openaiLimits.openaiObservedWall('chatgpt-subscription') === null && openrouterLimits.openrouterObservedWall() === null && geminiLimits.geminiObservedWall() === null && hfLimits.huggingfaceObservedWall() === null)
}

section('E3 a fresh ChatGPT sign-in and a disconnect both forget the subscription source')
{
  const now = Date.now()
  openaiLimits.recordOpenaiUsageLimit(now + 3_600_000, 'chatgpt-subscription')
  openaiLimits.recordOpenaiRateHeaders(new Headers({ 'x-codex-primary-used-percent': '95' }))
  openaiLimits.forgetOpenaiLimitSource('chatgpt-subscription')
  check('forgetOpenaiLimitSource clears the wall and the bands for the subscription', openaiLimits.openaiObservedWall('chatgpt-subscription') === null && openaiLimits.openaiObservedUsage().primary === undefined)
  openaiLimits.recordOpenaiUsageLimit(now + 3_600_000, 'api-key')
  openaiLimits.recordOpenaiRateHeaders(new Headers({ 'x-codex-primary-used-percent': '95' }))
  openaiLimits.forgetOpenaiLimitSource('api-key')
  check('…the key source forgets its wall and keeps the subscription\'s bands (they are the sign-in\'s)', openaiLimits.openaiObservedWall('api-key') === null && openaiLimits.openaiObservedUsage().primary?.usedPct === 95)
  openaiLimits.__resetOpenaiLimitStateForTest()
  openaiLimits.recordOpenaiUsageLimit(now + 3_600_000, 'chatgpt-subscription')
  accounts.disconnectOpenaiSubscription()
  check('the disconnect owner forgets the subscription source', openaiLimits.openaiObservedWall('chatgpt-subscription') === null)
  const src = readFileSync(join(ROOT, 'src/services/providers/openai/openaiAccounts.ts'), 'utf8')
  const landings = src.split("recordSignIn('openai', 'subscription')").length - 1
  const forgets = src.split("forgetOpenaiLimitSource('chatgpt-subscription')").length - 1
  check('every sign-in landing forgets the previous sign-in\'s observations before recording (two landings + the disconnect)', landings === 2 && forgets === 3, `${landings} landings · ${forgets} forgets`)
}

section('E4 the readers re-derive on the epoch; the warm claim reads the disk')
{
  const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
  const gate = read('src/components/PromptInput/Notifications.tsx')
  check('the composer\'s not-logged-in gate keys on the sign-in epoch through the ONE hook (the catalogue epoch beside it: a default landing when a catalogue settles moves the family)', gate.includes("import { useSignInEpoch } from '../../utils/accounts/useSignInEpoch.js'") && /\[notAuthenticated, mainLoopModel, signInEpoch, catalogueEpoch\]/.test(gate))
  const chip = read('src/components/BootSplashScreen.tsx')
  check('the boot chip keys on the same hook', chip.includes('useSignInEpoch()') && chip.includes('signInEpoch]'))
  const hook = read('src/utils/accounts/useSignInEpoch.ts')
  check('the hook subscribes through the ledger (one owner, no polling)', hook.includes('subscribeSignInEpoch(') && !hook.includes('setInterval'))
  const logout = read('src/commands/logout/logout.tsx')
  check('/logout announces the move after its teardown', logout.includes('noteCredentialRemoval()'))
  const runner = read('src/cli/print.ts')
  const claim = runner.slice(runner.indexOf("case 'claim_session': {"), runner.indexOf("case 'set_effort': {"))
  check('the warm claim drops the credential memos BEFORE it applies the session (presence is live at the claim)', claim.indexOf('dropCredentialMemos()') !== -1 && claim.indexOf('dropCredentialMemos()') < claim.indexOf('consumeSessionHomePin()'))
  // Behavioural: the memoised readers answer the disk after the drop. A
  // managed key lands in the config estate the way /logins stores it; a
  // process that memoised "no key" first answers null, then the key after
  // the drop.
  const { saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  const beforeKey = auth.getApiKeyFromConfigOrMacOSKeychain()
  saveGlobalConfig(current => ({ ...current, primaryApiKey: 'fixture-managed-key-000000000000' }))
  auth.dropCredentialMemos()
  const afterKey = auth.getApiKeyFromConfigOrMacOSKeychain()
  check('dropCredentialMemos: the managed-key memo re-reads the disk (null before the landing, the key after the drop)', beforeKey === null && afterKey === 'fixture-managed-key-000000000000', `${String(beforeKey)} → ${String(afterKey)}`)
  saveGlobalConfig(current => ({ ...current, primaryApiKey: undefined }))
  auth.dropCredentialMemos()
  check('…and the removal the same way', auth.getApiKeyFromConfigOrMacOSKeychain() === null)
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('SIGN-IN EPOCH LIVE: ALL GREEN')
else console.log(`❌ ${failures} EPOCH LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
