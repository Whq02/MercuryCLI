#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-session-account-chip.ts — the boot face's account
//  chip names the session's sign-in on the FIRST frame (snapshot-first) and
//  heals when the live catalogue settles.
//
//  THE SIGHTING: for a ChatGPT operator on the computed default, the Acct
//  chip showed the email only after a minute, or after hopping into the
//  concourse and back; the Anthropic chip painted at once.
//
//  ROOT CAUSE (adjudicated from the source): with the OpenAI live catalogue
//  unfetched, the computed default has no usable row and reads keyless, so
//  the main model is the keyless PLACEHOLDER (a first-party id); the chip
//  followed the placeholder's route to a family the operator had not signed
//  into and painted no account. The catalogue landing bumped nothing the
//  face subscribed to, so the chip healed only on an unrelated re-render.
//
//  THE LAWS:
//    C1  an explicit model setting: the chip follows the model's route;
//    C2  on the default with a provider landed: that family's identity —
//        whatever the placeholder's route;
//    C3  on the default with no usable row yet but sign-ins considered: the
//        sign-in the default is being composed for (the first considered
//        credential) — the operator's ChatGPT email on the first frame;
//    C4  keyless with nothing considered: no account (the real no-sign-in
//        state);
//    C5  the words are the ONE identity composer's: the recorded identity
//        over the plan label; a credential without one shows its label;
//    C6  the face wires the composer and keys the strip on the catalogue
//        epoch and the sign-in epoch (structural).
//
//  Run: ~/.bun/bin/bun run scripts/accounts/prove-session-account-chip.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

const scratch = mkdtempSync(join(tmpdir(), 'session-account-chip-'))
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
// The live decision (C7) walks the real owners on the scratch home: the
// file credential plane, every provider base dead, no local probe.
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
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
  process.env[base] = 'http://127.0.0.1:1'
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(2, 68 - t.length))}`)
}

console.log('============================================================')
console.log(' the account chip — snapshot-first, healed on the catalogue')
console.log('============================================================')

const { sessionAccountFamily, sessionAccountWords } = await import('../../src/utils/accounts/sessionAccount.ts')
type Reads = import('../../src/utils/accounts/sessionAccount.ts').SessionAccountReads

const PLACEHOLDER = 'claude-fable-5-1'
const presences = [
  { id: 'anthropic', credentialed: false },
  { id: 'openai', credentialed: true, credentialLabel: 'ChatGPT plus subscription', identity: 'gpt-operator@fixture.example' },
  { id: 'zai', credentialed: true, credentialLabel: 'Z.AI API key' },
]
const anthropicAbsent = { credentialed: false }
const anthropicPresent = { credentialed: true, credentialLabel: 'Claude subscription (max)', identity: 'claude-operator@fixture.example' }
const considered = (...familiesInOrder: string[]) =>
  familiesInOrder.map(family => ({ family, at: null, timed: false, recency: 'fixture', verdict: { usable: false, why: 'live catalogue not fetched yet — retry shortly' } }))
const reads = (over: Partial<Reads>): Reads => ({
  modelSetting: () => null,
  decision: () => ({ source: 'keyless', provider: null, considered: [] }),
  presences: () => presences,
  anthropic: () => anthropicAbsent,
  ...over,
})
const text = (words: ReturnType<typeof sessionAccountWords>): string | undefined => (words.state === 'email' ? words.text : undefined)

section('C1 an explicit setting follows the model\'s route')
{
  check('a GPT setting names the ChatGPT sign-in', text(sessionAccountWords('gpt-5.5', reads({ modelSetting: () => 'gpt-5.5' }))) === 'gpt-operator@fixture.example')
  check('a Claude setting names the Claude sign-in through the Anthropic read', text(sessionAccountWords('claude-opus-5', reads({ modelSetting: () => 'claude-opus-5', anthropic: () => anthropicPresent }))) === 'claude-operator@fixture.example')
  check('a Claude setting with no Anthropic credential names nobody (never a borrowed family)', sessionAccountWords('claude-opus-5', reads({ modelSetting: () => 'claude-opus-5' })).state === 'none')
  check('an id no family declares names nobody', sessionAccountFamily('mystery-9000', reads({ modelSetting: () => 'mystery-9000' })) === null)
}

section('C2 on the default with a provider landed: that family, whatever the placeholder says')
{
  const landed = reads({ decision: () => ({ source: 'sign-in', provider: 'openai', considered: considered('openai') }) })
  check('the family is the decision\'s provider', sessionAccountFamily(PLACEHOLDER, landed) === 'openai')
  check('…and the words are the ChatGPT email', text(sessionAccountWords(PLACEHOLDER, landed)) === 'gpt-operator@fixture.example')
  const fell = reads({ decision: () => ({ source: 'fallthrough', provider: 'zai', considered: considered('openai', 'zai') }), presences: () => presences })
  check('a fallthrough names the family it fell to, in its label (no identity recorded)', text(sessionAccountWords(PLACEHOLDER, fell)) === 'Z.AI API key')
}

section('C3 the sighting: a default still being composed names the sign-in it is composed for')
{
  const pending = reads({ decision: () => ({ source: 'keyless', provider: null, considered: considered('openai', 'zai') }) })
  check('the placeholder\'s own route is the first-party family (the old chip followed it to no account)', PLACEHOLDER.startsWith('claude-'))
  check('the family is the most recent sign-in (the first considered credential)', sessionAccountFamily(PLACEHOLDER, pending) === 'openai')
  check('…and the chip paints the ChatGPT email on the first frame', text(sessionAccountWords(PLACEHOLDER, pending)) === 'gpt-operator@fixture.example')
  const pendingOther = reads({ decision: () => ({ source: 'keyless', provider: null, considered: considered('zai', 'openai') }) })
  check('recency order decides which sign-in (the resolver\'s own order, never a family preference)', text(sessionAccountWords(PLACEHOLDER, pendingOther)) === 'Z.AI API key')
}

section('C4 keyless with nothing considered is the real no-sign-in state')
{
  check('no sign-in anywhere ⇒ no account', sessionAccountWords(PLACEHOLDER, reads({})).state === 'none' && sessionAccountFamily(PLACEHOLDER, reads({})) === null)
}

section('C5 the words are the ONE identity composer\'s')
{
  const labelOnly = reads({ modelSetting: () => 'gpt-5.5', presences: () => [{ id: 'openai', credentialed: true, credentialLabel: 'OpenAI API key (stored)' }] })
  check('a credential with no recorded identity shows its plan/source label', text(sessionAccountWords('gpt-5.5', labelOnly)) === 'OpenAI API key (stored)')
  const absent = reads({ modelSetting: () => 'gpt-5.5', presences: () => [{ id: 'openai', credentialed: false, credentialLabel: 'stale', identity: 'ghost@fixture.example' }] })
  check('an uncredentialed family names nobody even with words recorded (presence outranks the snapshot)', sessionAccountWords('gpt-5.5', absent).state === 'none')
}

section('C6 the face wires the composer (structural)')
{
  const face = readFileSync(join(ROOT, 'src/components/BootSplashScreen.tsx'), 'utf8')
  check('the chips memo reads the ONE session-account composer', face.includes("import { sessionAccountWords } from '../utils/accounts/sessionAccount.js'") && face.includes('const words = sessionAccountWords(mainModel);'))
  check('…and no longer follows the raw route to a presence itself', !face.includes('declaredRouteOf(mainModel)') && !face.includes('anthropicCredentialPresence()'))
  check('the strip keys on the catalogue epoch (a live catalogue settling repaints it) beside the presence and sign-in epochs', face.includes('const catalogueEpoch = useCatalogueEpoch();') && face.includes('}, [mainModel, presenceEpoch, catalogueEpoch, signInEpoch]);'))
  check("the Logins row's glance keys on the sign-in epoch (a removal leaves no stale count)", face.includes('}, [presenceEpoch, signInEpoch]);'))
  const hook = readFileSync(join(ROOT, 'src/hooks/useCatalogueEpoch.ts'), 'utf8')
  check('the catalogue epoch hook subscribes through the one catalogue signal', hook.includes('useSyncExternalStore(subscribeCatalogueEpoch, catalogueEpoch, catalogueEpoch)'))
}

section('C7 the model chip beside it: the decision\'s own row word, healed when the catalogue lands')
{
  // The two keyless states carry two row words: no credential anywhere is
  // "no sign-in yet"; sign-ins whose rows are not usable yet (a catalogue
  // composing, or unreachable) is "no usable row yet" — never "no sign-in
  // yet" beside the ChatGPT email the account chip paints.
  const computed = await import('../../src/utils/model/computedDefault.ts')
  const catalogue = await import('../../src/services/providers/catalogueEpoch.ts')
  const keyless = { setting: 'claude-fable-5-1', why: 'no provider is signed in yet — /logins signs one in, and its newest usable row becomes the default' }
  const gated = (why: string) => ({ usable: false as const, why })
  const nothing = computed.evaluateComputedDefault({ credentials: [], registryOrder: ['anthropic', 'openai'], laneRow: () => gated('unreached'), keyless })
  check('no credential anywhere ⇒ the row is "no sign-in yet" and the Default row is the logins door', nothing.row === computed.NO_SIGN_IN_ROW && computed.describeComputedDefaultRow(nothing) === `Default (${computed.NO_SIGN_IN_REASON})` && computed.keylessReason(nothing) === computed.NO_SIGN_IN_REASON, JSON.stringify(nothing.row))
  const composing = computed.evaluateComputedDefault({
    credentials: [{ family: 'openai', at: 1_756_000_000_000, kind: 'subscription' }],
    registryOrder: ['anthropic', 'openai'],
    laneRow: () => gated('GPT-5.5: live catalogue not fetched yet — retry shortly'),
    keyless,
  })
  check('a sign-in whose catalogue is composing ⇒ keyless with the "no usable row yet" row (the sign-in is not denied)', composing.source === 'keyless' && composing.provider === null && composing.row === computed.NO_USABLE_ROW && composing.considered.length === 1, JSON.stringify({ row: composing.row, why: composing.why }))
  check("…the Default row and the picker's gate carry each sign-in's own gate, then the logins door (never the no-sign-in words)", computed.keylessReason(composing) === composing.why && composing.why.includes('live catalogue not fetched yet') && composing.why.endsWith('/logins signs another provider in') && computed.describeComputedDefaultRow(composing) === `Default (${composing.why})`, computed.describeComputedDefaultRow(composing))
  check('…/model\'s label and the terse line lead with the row word', computed.describeComputedDefaultLabel(composing).startsWith(`${computed.NO_USABLE_ROW} (default — `) && computed.describeComputedDefault(composing) === `${computed.NO_USABLE_ROW} · ${composing.why}`, computed.describeComputedDefaultLabel(composing))
  // The live memo follows the catalogue epoch: a decision taken while a
  // catalogue composed is dropped the moment it settles.
  computed.resetComputedDefaultMemo()
  const first = computed.computedDefault()
  const second = computed.computedDefault()
  check('inside the memo window the same decision is served', first === second)
  catalogue.bumpCatalogueEpoch()
  const third = computed.computedDefault()
  check('a live catalogue settling drops the memo — the next read re-derives', third !== first && third.source === first.source)
  const chip = readFileSync(join(ROOT, 'src/components/BootSplashScreen.tsx'), 'utf8')
  check("the model chip prints the decision's own row word on a keyless default (structural)", chip.includes("decision.source === 'keyless' ? decision.row : null") && chip.includes('keylessRow ?? renderModelChip(mainModel)') && !chip.includes('NO_SIGN_IN_ROW'))
  const resolver = readFileSync(join(ROOT, 'src/utils/model/computedDefault.ts'), 'utf8')
  check('the memo keys on the catalogue epoch (structural)', resolver.includes('memo.catalogue === catalogue') && resolver.includes("import { catalogueEpoch } from '../../services/providers/catalogueEpoch.js'"))
  const picker = readFileSync(join(ROOT, 'src/utils/model/modelOptions.ts'), 'utf8')
  const standing = readFileSync(join(ROOT, 'src/commands/defaultprovider/defaultprovider.tsx'), 'utf8')
  check("the picker's Default-row gate and /defaultprovider's standing line read the same keyless words (structural)", picker.includes('unavailable: keylessReason(decision)') && standing.includes('? decision.row') && !standing.includes('NO_SIGN_IN_ROW'))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('SESSION ACCOUNT CHIP: ALL GREEN')
else console.log(`❌ ${failures} CHIP LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
