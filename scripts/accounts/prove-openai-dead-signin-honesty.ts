#!/usr/bin/env bun
// ============================================================================
//  prove-openai-dead-signin-honesty — PRESENT-BUT-DEAD for the ChatGPT
// sign-in (find, red-first; the anthropic scope row's
//  parity). An invalid_grant verdict blanks the refresh token on disk
//  (identity kept) — before the fix that state VANISHED whole: no slot on
//  /accounts, "no OpenAI account" on the seat chain; not one surface said
//  the sign-in EXPIRED.
//
//    §1 the presence owner: blank grant ⇒ 'expired' with the identity
//       riding; a live grant ⇒ 'connected'; an empty store ⇒ 'absent'
//    §2 the /accounts board keeps the row — signedIn false, the expiry and
//       the one road named; ⌫ still routes to the owning disconnect
//    §3 the seat chain outranks absent with expired: why 'auth-expired'
//       and the sentence naming /logins openai
//    §4 the usability blocker carries the SAME typed sentence (the /logins
//       chips, the transition preview — every reader of the one resolver)
//    §5 controls: connected paints connected (no false-dead); absent
//       invents nothing
//
//  Run: ~/.bun/bin/bun run scripts/accounts/prove-openai-dead-signin-honesty.ts
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'openai-dead-signin-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.OPENAI_API_KEY
delete process.env.CI
delete process.env.NODE_ENV

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const AUTH_FILE = join(HOME, '.openai-auth.json')
const writeStore = (tokens: Record<string, unknown> | null): void => {
  writeFileSync(AUTH_FILE, JSON.stringify(tokens === null ? { version: 1 } : { version: 1, tokens }))
}
/** The store exactly as blankDeadRefreshTokenOnDisk leaves it. */
const DEAD = {
  idToken: 'id.x.y',
  accessToken: 'at_dead',
  refreshToken: '',
  accountId: 'acct_123',
  planType: 'plus',
  email: 'operator@example.com',
}

const { openaiSubscriptionPresence } = await import('../../src/services/providers/openai/openaiAccounts.ts')
const { getGptSeatAvailability } = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/services/providers/accountSlots.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')

section('§1 the presence owner')
{
  writeStore(DEAD)
  const dead = openaiSubscriptionPresence()
  check("a blanked grant reads 'expired' with the identity riding", dead.state === 'expired' && dead.email === 'operator@example.com' && dead.planType === 'plus')
  writeStore({ ...DEAD, refreshToken: 'rt_live' })
  check("a live grant reads 'connected'", openaiSubscriptionPresence().state === 'connected')
  writeStore(null)
  check("an empty store reads 'absent'", openaiSubscriptionPresence().state === 'absent')
}

section('§2 the /accounts board keeps the row')
{
  writeStore(DEAD)
  const openai = deriveFamilySlotGroups().find(g => (g.family.id as string) === 'openai')
  const slot = (openai?.slots ?? []).find(s => s.id === 'openai:subscription')
  check('the dead sign-in KEEPS its slot', slot !== undefined)
  check('…signedIn FALSE, never a live paint', slot?.signedIn === false && slot?.active === false)
  check('…the expiry and the one road named on the row', slot?.stateNote === 'sign-in expired — /logins openai signs in again')
  check('…the identity survives (whose sign-in died)', slot?.identity === 'operator@example.com')
  const removal = slot !== undefined ? executeSlotRemoval(slot, { disconnectOpenaiSubscription: () => {}, openaiApiKeyAfter: () => undefined }) : null
  check('⌫ still routes to the owning disconnect (the dead tokens clear)', removal !== null && removal.mutated === true)
}

section('§3 the seat chain outranks absent with expired')
{
  writeStore(DEAD)
  const seat = getGptSeatAvailability()
  check("why 'auth-expired', never 'no-account'", seat.state === 'disabled' && seat.why === 'auth-expired')
  check('the sentence names the family and the road', seat.state === 'disabled' && seat.reason === 'OpenAI sign-in expired — /logins openai signs in again')
}

section('§4 the usability blocker carries the same sentence')
{
  writeStore(DEAD)
  const lane = resolveProviderUsability().openai
  check('the lane is not usable and the blocker is the typed sentence', lane.usable === false && lane.blockers.some(b => b.includes('OpenAI sign-in expired — /logins openai signs in again')), JSON.stringify(lane.blockers))
  check("the credential axis reads 'none' (auth-expired is a credential absence)", lane.credential === 'none')
}

section('§5 controls — no false-dead, nothing invented')
{
  writeStore({ ...DEAD, refreshToken: 'rt_live' })
  const connected = deriveFamilySlotGroups().find(g => (g.family.id as string) === 'openai')
  const live = (connected?.slots ?? []).find(s => s.id === 'openai:subscription')
  check('a live sign-in paints signed in with NO expiry note', live?.signedIn === true && live?.stateNote === undefined)
  writeStore(null)
  const absent = deriveFamilySlotGroups().find(g => (g.family.id as string) === 'openai')
  check('an absent store invents no subscription slot', (absent?.slots ?? []).every(s => s.id !== 'openai:subscription'))
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('OPENAI DEAD-SIGNIN HONESTY: ALL GREEN')
else console.log(`❌ ${failures} DEAD-SIGNIN LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
