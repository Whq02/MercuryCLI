#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { writeFileSync } from 'node:fs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_GEMINI_OAUTH_CLIENT_ID = 'client-fixture'
delete process.env.GOOGLE_API_KEY
delete process.env.GEMINI_API_KEY

let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const accounts = await import('../../src/services/providers/gemini/geminiAccounts.ts')
const login = await import('../../src/services/providers/gemini/geminiLogin.ts')
const guide = await import('../../src/components/geminiConnectGuide.ts')
const secrets = await import('../../src/services/providers/providerSecrets.ts')

const noCatalogue = { refreshCatalogue: async () => null }
const grant = (serial: number): typeof fetch =>
  (async () => new Response(JSON.stringify({ access_token: `GA-${serial}`, refresh_token: `GR-${serial}`, expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch

async function connectGoogleAccount(serial: number): Promise<void> {
  const handles = accounts.beginGeminiBrowserConnect({ skipBrowserOpen: true, loopbackPort: 0, fetchImpl: grant(serial) })
  handles.completeWithRedirect(`http://127.0.0.1:1/oauth2/callback?code=OK&state=${encodeURIComponent(new URL(handles.authorizeUrl).searchParams.get('state') ?? '')}`)
  await handles.result
}

console.log('── one store at a time: the only source is the active one ──')
writeFileSync(accounts.geminiAuthPathForDisplay(), JSON.stringify({ version: 1 }), { mode: 0o600 })
const keyOnly = await login.storeGeminiApiKeyLogin('AIzaFixtureKeyOnly0000000000000000000001', noCatalogue)
check('a pasted key alone is the active source and its receipt says what requests ride', keyOnly.ok && accounts.resolveGeminiAccount()?.kind === 'api-key' && keyOnly.receipt.includes('the active source') && keyOnly.receipt.includes('generativelanguage.googleapis.com'), keyOnly.receipt)
check('the key receipt names no second source when none is stored', !keyOnly.receipt.includes('Google account stays stored'), keyOnly.receipt)
secrets.writeStoredGeminiApiKey(null)
writeFileSync(accounts.geminiAuthPathForDisplay(), JSON.stringify({ version: 1 }), { mode: 0o600 })
await connectGoogleAccount(1)
const oauthOnly = await login.finishGeminiOauthConnect(noCatalogue)
check('a Google sign-in alone is the active source and its receipt says so', oauthOnly.ok && accounts.resolveGeminiAccount()?.kind === 'oauth' && oauthOnly.receipt.includes('the active source') && !oauthOnly.receipt.includes('An API key is also stored'), oauthOnly.receipt)

console.log('── both stored: the latest sign-in action is the active source ──')
const keyAfterGrant = await login.storeGeminiApiKeyLogin('AIzaFixtureKeyAfterGrant000000000000002', noCatalogue)
check('a key pasted while a Google grant stands becomes the active source', accounts.resolveGeminiAccount()?.kind === 'api-key' && accounts.readPreferredGeminiSource() === 'api-key', `active=${accounts.resolveGeminiAccount()?.kind} preferred=${accounts.readPreferredGeminiSource()}`)
check('its receipt names the key as the active source and the stored Google account with its row', keyAfterGrant.receipt.includes('the active source') && keyAfterGrant.receipt.includes('generativelanguage.googleapis.com') && keyAfterGrant.receipt.includes('Google account stays stored') && keyAfterGrant.receipt.includes('/logins'), keyAfterGrant.receipt)
check('the request auth for the active source is the key, not the grant', (await accounts.resolveGeminiRequestAuth())?.headers['x-goog-api-key'] !== undefined && (await accounts.resolveGeminiRequestAuth())?.account.kind === 'api-key')
await connectGoogleAccount(2)
const grantAfterKey = await login.finishGeminiOauthConnect(noCatalogue)
check('a Google sign-in completed while a key is stored becomes the active source', accounts.resolveGeminiAccount()?.kind === 'oauth' && accounts.readPreferredGeminiSource() === 'oauth')
check('its receipt names the account as the active source and the stored key with its row', grantAfterKey.receipt.includes('the active source') && grantAfterKey.receipt.includes('An API key is also stored') && grantAfterKey.receipt.includes('/logins'), grantAfterKey.receipt)

console.log('── a stored source is made active from its row, nothing re-entered ──')
const toKey = login.activateGeminiSource('api-key')
check('↵ on the key row makes the key active and says what rides', toKey.ok && accounts.resolveGeminiAccount()?.kind === 'api-key' && toKey.receipt.includes('API key is now the active source') && toKey.receipt.includes('generativelanguage.googleapis.com') && toKey.receipt.includes('Google account stays stored'), toKey.receipt)
check('the key value stored before is the one that rides (nothing re-entered)', secrets.readStoredGeminiApiKey() === 'AIzaFixtureKeyAfterGrant000000000000002')
const toGrant = login.activateGeminiSource('oauth')
check('↵ on the Google account row makes the grant active again, the key kept', toGrant.ok && accounts.resolveGeminiAccount()?.kind === 'oauth' && toGrant.receipt.includes('Google account is now the active source') && toGrant.receipt.includes('An API key is also stored') && secrets.readStoredGeminiApiKey() !== undefined, toGrant.receipt)
check('the grant stored before is the one that rides (no new sign-in)', (await accounts.currentGeminiTokens())?.accessToken === 'GA-2')

console.log('── the rows say which source rides and offer the switch ──')
const bothGrantActive = guide.geminiConnectRows({ keySource: 'stored', clientSource: 'env', oauthConnected: true, active: 'oauth' })
check('with the grant active the key row says it is stored and not active, ↵ making it active', bothGrantActive[0]!.value === 'plan' && bothGrantActive[1]!.label === 'API key — stored, not active · ↵ makes it active' && bothGrantActive[2]!.label === 'Google account — connected · ↵ signs in again (step 6)', JSON.stringify(bothGrantActive))
const bothKeyActive = guide.geminiConnectRows({ keySource: 'stored', clientSource: 'env', oauthConnected: true, active: 'api-key' })
check('with the key active the Google row says it is connected and not active, ↵ making it active', bothKeyActive[1]!.label === 'API key — connected (stored locally) · ↵ pastes a replacement' && bothKeyActive[2]!.label === 'Google account — connected, not active · ↵ makes it active', JSON.stringify(bothKeyActive))
const envKeyInactive = guide.geminiConnectRows({ keySource: 'env-google', clientSource: 'env', oauthConnected: true, active: 'oauth' })
check('an environment key that is not active names its variable and offers the switch', envKeyInactive[1]!.label === 'API key — GOOGLE_API_KEY in the environment, not active · ↵ makes it active', envKeyInactive[1]!.label)
check('the row action: a stored, inactive source activates; an active or absent one enters its road', guide.geminiConnectRowAction({ keySource: 'stored', clientSource: 'env', oauthConnected: true, active: 'oauth' }, 'key') === 'activate' && guide.geminiConnectRowAction({ keySource: 'stored', clientSource: 'env', oauthConnected: true, active: 'api-key' }, 'google') === 'activate' && guide.geminiConnectRowAction({ keySource: 'stored', oauthConnected: false, active: 'api-key' }, 'key') === 'enter' && guide.geminiConnectRowAction({ keySource: 'stored', clientSource: 'env', oauthConnected: true, active: 'oauth' }, 'google') === 'enter' && guide.geminiConnectRowAction({ oauthConnected: false }, 'google') === 'enter')
const live = guide.liveGeminiConnectFacts()
check('the live facts carry the active source', live.active === 'oauth' && live.keySource === 'stored' && live.oauthConnected, JSON.stringify(live))
const singleKey = guide.geminiConnectRows({ keySource: 'stored', oauthConnected: false, active: 'api-key' })
check('with one source stored the rows read as before, behind the Sign in with Google row', singleKey[0]!.label === guide.GEMINI_PLAN_ROW && singleKey[1]!.label === 'API key — connected (stored locally) · ↵ pastes a replacement' && singleKey[2]!.label === 'Google account — six steps, each opens its Console page')
check('the stored-sources note names the active source and the other row', login.geminiStoredSourcesNote({ keySource: 'stored', oauthConnected: true, active: 'oauth' }) === 'Active source: the Google account · an API key is also stored — ↵ on its /logins gemini row makes it active' && login.geminiStoredSourcesNote({ keySource: 'env-gemini', oauthConnected: true, active: 'api-key' }) === 'Active source: the API key (GEMINI_API_KEY) · the Google account is also stored — ↵ on its /logins gemini row makes it active' && login.geminiStoredSourcesNote({ keySource: 'stored', oauthConnected: false, active: 'api-key' }) === undefined)

console.log("── a wrong key is refused with Google's words: HTTP 400 API_KEY_INVALID, never stored, never 'catalogue-error' ──")
const catalogue = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const GOOGLE_WRONG_KEY_BODY = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } }] } }
const googleFetches: string[] = []
const googleAnswers = (answer: (url: string) => Response): typeof fetch => (async (url: unknown) => { googleFetches.push(String(url)); return answer(String(url)) }) as typeof fetch
const wrongKeyFetch = googleAnswers(() => Response.json(GOOGLE_WRONG_KEY_BODY, { status: 400, headers: { 'content-type': 'application/json; charset=UTF-8' } }))
const liveFetch = googleAnswers(() => Response.json({ models: [{ name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'] }] }))
catalogue.__resetGeminiCatalogueForTest()
secrets.writeStoredGeminiApiKey('AIzaFixtureGoodKey000000000000000000003')
accounts.writePreferredGeminiSource('api-key')
const goodSnapshot = await catalogue.refreshGeminiCatalogue('api-key', { force: true, fetchImpl: liveFetch })
check('the control: a key the catalogue answers lists its rows and the key is available', goodSnapshot?.models.length === 1 && catalogue.getGeminiAvailability().state === 'ready', JSON.stringify(catalogue.getGeminiAvailability()))
const refusedLogin = await login.storeGeminiApiKeyLogin('AIzaFixtureWrongKey00000000000000000004', { refreshCatalogue: () => catalogue.refreshGeminiCatalogue('api-key', { force: true, fetchImpl: wrongKeyFetch }) })
check("Google's HTTP 400 with reason API_KEY_INVALID refuses the pasted key with the service's words, stores nothing and keeps the key stored before", !refusedLogin.ok && !refusedLogin.stored && refusedLogin.receipt.includes('Google refused this key (HTTP 400) — API key not valid. Please pass a valid API key.') && refusedLogin.receipt.includes('nothing stored; the key stored before stays') && !refusedLogin.receipt.includes('UNVERIFIED') && !refusedLogin.receipt.includes('did not answer') && secrets.readStoredGeminiApiKey() === 'AIzaFixtureGoodKey000000000000000000003' && accounts.resolveGeminiAccount()?.kind === 'api-key', refusedLogin.receipt)
check('the probe asked generativelanguage once with the pasted key header and never leaked the key into the receipt', googleFetches.length === 2 && !refusedLogin.receipt.includes('AIzaFixtureWrongKey00000000000000000004'), googleFetches.join(' '))
secrets.writeStoredGeminiApiKey('AIzaFixtureWrongKey00000000000000000004')
catalogue.__resetGeminiCatalogueForTest()
const refusedSnapshot = await catalogue.refreshGeminiCatalogue('api-key', { force: true, fetchImpl: wrongKeyFetch })
const availability = catalogue.getGeminiAvailability()
check("a stored key Google answers with HTTP 400 API_KEY_INVALID reads as 'auth-invalid' with the words, never 'catalogue-error'", refusedSnapshot?.lastError === 'gemini models endpoint refused the credential (HTTP 400) — API key not valid. Please pass a valid API key.' && refusedSnapshot.lastStatus === 400 && availability.state === 'disabled' && availability.why === 'auth-invalid' && availability.reason === 'the stored Gemini API key was refused (HTTP 400: API key not valid. Please pass a valid API key.) · /logins replaces it', JSON.stringify({ lastError: refusedSnapshot?.lastError, availability }))
catalogue.__resetGeminiCatalogueForTest()
const otherArgument = await catalogue.refreshGeminiCatalogue('api-key', { force: true, fetchImpl: googleAnswers(() => Response.json({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } }, { status: 400 })) })
check("a 400 whose words do not name the key stays a catalogue error (the control), not a refusal", otherArgument?.lastError === 'gemini models endpoint returned HTTP 400' && catalogue.getGeminiAvailability().why === 'catalogue-error', JSON.stringify(catalogue.getGeminiAvailability()))
catalogue.__resetGeminiCatalogueForTest()
secrets.writeStoredGeminiApiKey(null)
accounts.writePreferredGeminiSource(null)
await connectGoogleAccount(3)
await login.finishGeminiOauthConnect(noCatalogue)
secrets.writeStoredGeminiApiKey('AIzaFixtureKeyAfterGrant000000000000002')
accounts.writePreferredGeminiSource('oauth')

console.log('── the disconnects keep the rule honest ──')
accounts.disconnectGeminiOauth()
check('removing the active grant leaves the stored key active', accounts.resolveGeminiAccount()?.kind === 'api-key' && accounts.readPreferredGeminiSource() === undefined)
secrets.writeStoredGeminiApiKey(null)
check('with nothing stored no source is active', accounts.resolveGeminiAccount() === undefined)

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
