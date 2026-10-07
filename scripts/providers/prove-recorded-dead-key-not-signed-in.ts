import { mock } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const parent = process.env.MERCURY_CONFIG_DIR
const realHome = join(homedir(), '.mercury')
if (!parent || parent === realHome || parent.startsWith(realHome + '/')) throw new Error('An isolated scratch config home is required')
const home = mkdtempSync(join(parent, 'openrouter-dead-key-'))
for (const name of Object.keys(process.env)) {
  if (/^(MERCURY_|ANTHROPIC_|CLAUDE_|OPENROUTER_|OPENAI_|ZAI_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|TYPESAFE_|AWS_|AZURE_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
}
Object.assign(process.env, { MERCURY_CONFIG_DIR: home, MERCURY_AUTH_SCOPE_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_HELM_CONSOLE: '0', MERCURY_EVOLUTION_LEDGER: '0', MERCURY_MODEL: 'openrouter/fixture/model', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' })
for (const name of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_GEMINI_OAUTH_AUTH_BASE', 'MERCURY_GEMINI_OAUTH_TOKEN_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_JEV_BASE']) process.env[name] = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const mintedKey = 'proof-openrouter-minted-key'
const storedKey = 'proof-openrouter-stored-key'
const envKey = 'proof-openrouter-env-key'
const status: Record<'minted' | 'stored' | 'env', number> = { minted: 200, stored: 200, env: 200 }
const payload = { data: { label: 'fixture credits', usage: 12.5, limit: 50, limit_remaining: 37.5 } }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const bearer = request.headers.get('authorization')
  const source = bearer === `Bearer ${mintedKey}` ? 'minted' : bearer === `Bearer ${storedKey}` ? 'stored' : bearer === `Bearer ${envKey}` ? 'env' : undefined
  const path = new URL(request.url).pathname
  if (request.method !== 'GET' || path !== '/key' || source === undefined) return new Response(null, { status: 404 })
  const code = status[source]
  if (code === 200) return Response.json(payload)
  if (code === 401) return Response.json({ error: { code: 401, message: 'API key expired' } }, { status: 401 })
  if (code === 403) return Response.json({ error: { code: 403, message: 'Key disabled' } }, { status: 403 })
  return Response.json({ error: { message: 'Fixture credits temporarily unavailable' } }, { status: code })
} })
const base = `http://127.0.0.1:${server.port}`
process.env.MERCURY_OPENROUTER_API_BASE = base
const originalFetch = globalThis.fetch
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== base) throw new Error('Only the loopback key fixture may be contacted')
  return originalFetch(input, { ...init, redirect: 'error' })
}) as typeof fetch
globalThis.fetch = fetchImpl
async function stub(path: string, overrides: Record<string, unknown>) {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...overrides }))
}
await stub('../../src/utils/proxy.js', { getApiFetch: () => fetchImpl, getProxyFetchOptions: () => ({}) })
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const accounts = await import('../../src/services/providers/openrouter/openrouterAccounts.js')
const reader = await import('../../src/services/providers/openrouter/openrouterUsageState.js')
const secrets = await import('../../src/utils/router/providerSecrets.js')
const slots = await import('../../src/services/providers/accountSlots.js')
const family = { id: 'openrouter', available: true, credentialed: true, credentialLabel: 'OpenRouter fixture' }
await stub('../../src/services/providers/providerUsage.js', { providerFamilyPresences: () => [family] })
const logins = await import('../../src/components/BootLoginsScreen.js')
const seedMint = () => writeFileSync(accounts.openrouterAuthPathForDisplay(), JSON.stringify({ version: 1, minted: { key: mintedKey, mintedAtMs: 1, label: 'fixture mint' } }), { mode: 0o600 })
const readSlots = () => slots.deriveFamilySlotGroups([]).find(group => group.family.id === 'openrouter')!.slots
const slot = (id: string) => readSlots().find(entry => entry.id === id)
const signedFamilies = () => logins.loginsFamilyCounts(slots.deriveFamilySlotGroups([])).signed
const refresh = () => reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const words = (entry: ReturnType<typeof slot>) => entry === undefined ? '(absent)' : `signedIn=${entry.signedIn} active=${entry.active} note=${entry.stateNote ?? '(none)'}`
try {
  console.log('§1 a stored key the key endpoint refused with 401 is present, not signed in')
  secrets.writeStoredOpenrouterApiKey(storedKey)
  status.stored = 401
  await refresh()
  const refusedStored = slot('openrouter:stored-key')
  console.log(`  stored slot: ${words(refusedStored)}`)
  check('the slot still exists (the key is stored) and keeps the recorded refusal as its note', refusedStored !== undefined && refusedStored.stateNote === 'API key expired', words(refusedStored))
  check('the slot is NOT signed in', refusedStored?.signedIn === false, words(refusedStored))
  check('the Boot face counts no OpenRouter family as signed in', signedFamilies() === 0, `signed=${signedFamilies()}`)
  check('the ledger records the refusal with its status', reader.openrouterObservedKeyUsage().errorStatus === 401 && reader.openrouterKeyRecordedDead('stored'), JSON.stringify(reader.openrouterObservedKeyUsage()))

  console.log('§2 a probe that failed without refusing the key (503) says nothing about the key')
  status.stored = 503
  await refresh()
  const flakyStored = slot('openrouter:stored-key')
  console.log(`  stored slot: ${words(flakyStored)}`)
  check('the slot carries the probe failure as its note', flakyStored?.stateNote === 'Fixture credits temporarily unavailable', words(flakyStored))
  check('the slot stays signed in — a failed probe is not a dead key', flakyStored?.signedIn === true, words(flakyStored))
  check('the Boot face still counts the family', signedFamilies() === 1, `signed=${signedFamilies()}`)
  check('the ledger does not call it dead', !reader.openrouterKeyRecordedDead('stored'), JSON.stringify(reader.openrouterObservedKeyUsage()))

  console.log('§3 a 403 is a refusal like a 401')
  status.stored = 403
  await refresh()
  const disabledStored = slot('openrouter:stored-key')
  console.log(`  stored slot: ${words(disabledStored)}`)
  check('a 403 refusal is not signed in', disabledStored?.signedIn === false && disabledStored.stateNote === 'Key disabled', words(disabledStored))

  console.log('§4 a successful read brings the slot back')
  status.stored = 200
  await refresh()
  const liveStored = slot('openrouter:stored-key')
  console.log(`  stored slot: ${words(liveStored)}`)
  check('the slot is signed in again with no note', liveStored?.signedIn === true && liveStored.stateNote === undefined, words(liveStored))
  check('the Boot face counts the family again', signedFamilies() === 1, `signed=${signedFamilies()}`)

  console.log('§5 an OAuth-minted key the product recorded as expired is not signed in')
  seedMint()
  status.minted = 401
  await refresh()
  const expiredMinted = slot('openrouter:oauth-key')
  const storedBeside = slot('openrouter:stored-key')
  console.log(`  minted slot: ${words(expiredMinted)}`)
  console.log(`  stored slot: ${words(storedBeside)}`)
  check('the minted key is marked expired on disk', accounts.readMintedOpenrouterKey()?.expiredMessage === 'API key expired')
  check('the minted slot is present, inactive and NOT signed in, with the provider message and the way out', expiredMinted !== undefined && !expiredMinted.active && expiredMinted.signedIn === false && expiredMinted.stateNote === 'API key expired · /logins openrouter: ⌫ removes it', words(expiredMinted))
  check('the live stored key beside it is signed in and active', storedBeside?.signedIn === true && storedBeside.active === true, words(storedBeside))
  check('the family counts as signed in through the live key only', signedFamilies() === 1, `signed=${signedFamilies()}`)

  console.log('§6 the recorded expiry outlives the process memory (a fresh read of the ledger still says not signed in)')
  reader.__resetOpenrouterUsageStateForTest()
  const afterReset = slot('openrouter:oauth-key')
  console.log(`  minted slot: ${words(afterReset)}`)
  check('the minted slot stays not signed in from the persisted expiry alone', afterReset?.signedIn === false, words(afterReset))

  console.log('§7 with the stored key gone, a dead minted key leaves no signed-in slot and no counted family')
  secrets.writeStoredOpenrouterApiKey(null)
  console.log(`  slots: ${readSlots().map(entry => `${entry.id}:${entry.signedIn}`).join(' ')}`)
  check('no slot is signed in', readSlots().every(entry => entry.signedIn === false), readSlots().map(entry => `${entry.id}:${entry.signedIn}`).join(' '))
  check('the Boot face counts the family out', signedFamilies() === 0, `signed=${signedFamilies()}`)

  console.log('§8 an env-pinned key the endpoint refused is not signed in either')
  process.env.OPENROUTER_API_KEY = envKey
  status.env = 401
  await refresh()
  const refusedEnv = slot('openrouter:env-key')
  console.log(`  env slot: ${words(refusedEnv)}`)
  check('the env slot is present, active for the wire, and NOT signed in', refusedEnv !== undefined && refusedEnv.active && refusedEnv.signedIn === false && refusedEnv.stateNote === 'API key expired', words(refusedEnv))
  delete process.env.OPENROUTER_API_KEY
} finally {
  server.stop(true)
  globalThis.fetch = originalFetch
}
console.log(failures === 0 ? 'PASS: a key the product recorded dead is never counted as signed in' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
