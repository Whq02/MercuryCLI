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
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN']) {
  delete process.env[key]
}
process.env.NODE_ENV = 'test'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

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
  check('the strip keys on the catalogue epoch (a live catalogue settling repaints it) beside the sign-in and presence epochs', face.includes('const catalogueEpoch = useCatalogueEpoch();') && face.includes('}, [mainModel, presenceEpoch, signInEpoch, catalogueEpoch]);'))
  check("the Logins row's glance keys on the sign-in epoch (a removal leaves no stale count)", face.includes('}, [presenceEpoch, signInEpoch]);'))
  const hook = readFileSync(join(ROOT, 'src/hooks/useCatalogueEpoch.ts'), 'utf8')
  check('the catalogue epoch hook subscribes through the one catalogue signal', hook.includes('useSyncExternalStore(subscribeCatalogueEpoch, catalogueEpoch, catalogueEpoch)'))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('SESSION ACCOUNT CHIP: ALL GREEN')
else console.log(`❌ ${failures} CHIP LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
