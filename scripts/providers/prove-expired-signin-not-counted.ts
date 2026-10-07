import { mkdtempSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const parent = process.env.MERCURY_CONFIG_DIR
const realHome = join(homedir(), '.mercury')
if (!parent || parent === realHome || parent.startsWith(realHome + '/')) throw new Error('An isolated scratch config home is required')
const home = mkdtempSync(join(parent, 'expired-signin-'))
for (const name of Object.keys(process.env)) {
  if (/^(MERCURY_|ANTHROPIC_|CLAUDE_|OPENROUTER_|OPENAI_|ZAI_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|TYPESAFE_|AWS_|AZURE_|XAI_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
}
Object.assign(process.env, { MERCURY_CONFIG_DIR: home, MERCURY_AUTH_SCOPE_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_HELM_CONSOLE: '0', MERCURY_EVOLUTION_LEDGER: '0', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const slots = await import('../../src/services/providers/accountSlots.js')
const logins = await import('../../src/components/BootLoginsScreen.js')

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const scope = { name: 'personal', dir: join(home, 'scope-personal'), isCurrent: true, hasConfig: true, authed: true, foreignHarness: false, email: 'op@example.com' }
const providers = [{ id: 'anthropic', available: true, description: { account: { kind: 'oauth', label: 'Claude subscription' } } }] as never
const familyReads = { claudeSubscriber: () => true, subscriptionType: () => 'pro', anthropicApiKeyPresent: () => false, bearerTokenSource: () => ({ source: 'claude.ai', hasToken: true }), anthropicEmail: () => 'op@example.com' }
const world = (expired: boolean) => slots.deriveFamilySlotGroups(providers, { familyReads, scanScopes: () => [scope], anthropicApiKey: () => ({ key: null, source: 'none' as never }), anthropicSignInExpired: () => expired })
const claudeArm = logins.loginsCatalogue().find(arm => arm.arm === 'subscription')!
const factsOf = (groups: ReturnType<typeof world>) => ({ groups, usability: {} as never }) as never
const words = (slot: { signedIn: boolean; expired?: boolean; active: boolean; identity: string } | undefined) => slot === undefined ? '(absent)' : `signedIn=${slot.signedIn} expired=${slot.expired ?? false} active=${slot.active} identity=${slot.identity}`

console.log('§1 a stored claude.ai sign-in the product has recorded as expired is present, not signed in')
const dead = world(true)
const deadSlot = dead.find(g => g.family.id === 'anthropic')?.slots.find(s => s.scope !== undefined)
console.log(`  slot: ${words(deadSlot)}`)
check('the slot still exists (the login is stored) and carries its email', deadSlot !== undefined && deadSlot.identity === 'op@example.com', words(deadSlot))
check('the slot is NOT signed in and says it is expired', deadSlot?.signedIn === false && deadSlot.expired === true, words(deadSlot))
check('the Boot face counts no family as signed in', logins.loginsFamilyCounts(dead).signed === 0, `signed=${logins.loginsFamilyCounts(dead).signed}`)
const deadState = slots.slotSigninState(deadSlot!, {})
check("the board's sign-in derivation says expired, not signed out", deadState.signedIn === false && deadState.basis === 'expired', JSON.stringify(deadState))
const deadRow = logins.loginsRowStateOf(claudeArm, factsOf(dead))
console.log(`  Logins row: chip="${deadRow.chip}" loud=${deadRow.loud} signedIn=${deadRow.signedIn}`)
check('the Logins row keeps the identity chip, says expired, stands out, and is not grouped as signed in', deadRow.chip === 'op@example.com · expired' && deadRow.loud === true && deadRow.signedIn === false, JSON.stringify(deadRow))
const deadDetail = logins.loginsDetailLines(claudeArm, factsOf(dead)).join(' ').replace(/\s+/g, ' ')
check("the row's detail names the slot as active and not signed in", deadDetail.includes('op@example.com · active · not signed in'), deadDetail)

console.log('§2 the same sign-in, not expired, counts as before')
const live = world(false)
const liveSlot = live.find(g => g.family.id === 'anthropic')?.slots.find(s => s.scope !== undefined)
console.log(`  slot: ${words(liveSlot)}`)
check('the slot is signed in with no expiry', liveSlot?.signedIn === true && liveSlot.expired === undefined, words(liveSlot))
check('the Boot face counts the family', logins.loginsFamilyCounts(live).signed === 1, `signed=${logins.loginsFamilyCounts(live).signed}`)
const liveRow = logins.loginsRowStateOf(claudeArm, factsOf(live))
check('the Logins row wears the identity, quiet, grouped as signed in', liveRow.chip === 'op@example.com' && liveRow.loud === false && liveRow.signedIn === true, JSON.stringify(liveRow))

console.log('§3 another scope that is not the current one is never read as expired')
const other = { ...scope, name: 'work', dir: join(home, 'scope-work'), isCurrent: false }
const twoScopes = slots.deriveFamilySlotGroups(providers, { familyReads, scanScopes: () => [scope, other], anthropicApiKey: () => ({ key: null, source: 'none' as never }), anthropicSignInExpired: () => true })
const otherSlot = twoScopes.find(g => g.family.id === 'anthropic')?.slots.find(s => s.scope?.dir === other.dir)
console.log(`  other scope: ${words(otherSlot)}`)
check('the expiry is a fact about the current sign-in only', otherSlot?.signedIn === true && otherSlot.expired === undefined, words(otherSlot))

console.log(failures === 0 ? 'PASS: an expired sign-in the product recorded is never counted as signed in' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
