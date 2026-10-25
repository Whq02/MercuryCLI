import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import fixture from '../provider-compat/fixtures/orcarouter-documented.json'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[key]
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { storeOrcarouterApiKeyLogin, runOrcarouterDeviceLogin, ORCAROUTER_CONNECT_ROWS } = await import('../../src/services/providers/orcarouter/orcarouterLogin.ts')
const { readStoredOrcarouterApiKey, writeStoredOrcarouterApiKey } = await import('../../src/services/providers/providerSecrets.ts')
const { resolveOrcarouterApiKey } = await import('../../src/services/providers/orcarouter/orcarouterAccounts.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/services/providers/accountSlots.ts')
const { loginFamilyRows, keyPageLine } = await import('../../src/components/loginFamilyRows.ts')
const { loginsPickOptions, deviceWaitPaneLines } = await import('../../src/components/BootLoginsScreen.tsx')
const { providerAuthList } = await import('../../src/cli/handlers/providerAuth.ts')
let checks = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); checks++; console.log(`[PASS] ${name}`) }
const keyFetch = (status: number): typeof fetch => (async () => Response.json(status === 200 ? fixture.catalogue : { error: { type: 'orcarouter_api_error', message: 'invalid api key' } }, { status })) as typeof fetch
try {
  check('the login row uses the existing device-code and API-key grammar', loginFamilyRows({ engineLegs: true }).some(row => row.value === 'orcarouter' && row.label === 'OrcaRouter — device-code sign-in or API key'))
  check('boot and in-chat sign-in choices share one owner', JSON.stringify(loginsPickOptions('orcarouter')) === JSON.stringify(ORCAROUTER_CONNECT_ROWS))
  check('the key door points to the published console', keyPageLine('orcarouter').includes('orcarouter.ai/console/token'))
  check('a blank key stores nothing', !(await storeOrcarouterApiKeyLogin('')).stored && readStoredOrcarouterApiKey() === undefined)
  const saved = await storeOrcarouterApiKeyLogin('sk-orca-fixture-manual-not-real', { fetchImpl: keyFetch(200) })
  check('a pasted key is stored without printing it', saved.ok && saved.stored && readStoredOrcarouterApiKey() === 'sk-orca-fixture-manual-not-real' && !saved.receipt.includes('sk-orca-'))
  check('the stored key resolves for dispatch', resolveOrcarouterApiKey()?.source === 'stored')
  const refused = await storeOrcarouterApiKeyLogin('sk-orca-fixture-refused-not-real', { fetchImpl: keyFetch(401) })
  check('a refused paste cannot overwrite the existing key', !refused.stored && readStoredOrcarouterApiKey() === 'sk-orca-fixture-manual-not-real')
  const unavailable = await storeOrcarouterApiKeyLogin('sk-orca-fixture-unread-not-real', { fetchImpl: keyFetch(503) })
  check('a model-list outage is not credential revocation', unavailable.stored && readStoredOrcarouterApiKey() === 'sk-orca-fixture-unread-not-real')
  process.env.ORCAROUTER_API_KEY = 'sk-orca-fixture-env-not-real'
  check('the environment key outranks the stored key', resolveOrcarouterApiKey()?.key === process.env.ORCAROUTER_API_KEY)
  delete process.env.ORCAROUTER_API_KEY
  const rows = await providerAuthList({ json: true }, { writeOut: () => {} })
  check('terminal auth lists the connected account', rows.rows.some(row => row.id === 'orcarouter' && row.signedIn))
  const slot = deriveFamilySlotGroups().find(group => group.family.id === 'orcarouter')?.slots.find(row => row.removal.route === 'orcarouter-stored-key')
  check('accounts owns a removable OrcaRouter key slot', slot !== undefined)
  executeSlotRemoval(slot!)
  check('account removal clears the dispatch credential', resolveOrcarouterApiKey() === undefined)

  let clock = 0
  let tokenCalls = 0
  let discoveryHttp = false
  let crossOrigin = false
  let scope = 'api'
  let outcome = 'success'
  let cancel = false
  let cancelOnToken = false
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  const sleeps: number[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url, body })
    if (url.endsWith('/.well-known/openid-configuration')) {
      const issuer = discoveryHttp ? 'http://www.orcarouter.ai' : 'https://www.orcarouter.ai'
      return Response.json({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: crossOrigin ? 'https://unexpected.example/api/v1/auth/keys' : `${issuer}/api/v1/auth/keys`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256', 'plain'], token_endpoint_auth_methods_supported: ['none'] })
    }
    if (url.endsWith('/api/v1/auth/device/code')) return Response.json({ device_code: 'fixture-device-secret', user_code: 'BCDF-GHJK', verification_uri: 'https://www.orcarouter.ai/device', verification_uri_complete: 'https://www.orcarouter.ai/device?code=BCDF-GHJK', expires_in: 600, interval: 5 })
    assert.equal(url, 'https://www.orcarouter.ai/api/v1/auth/device/token')
    tokenCalls++
    if (cancelOnToken) cancel = true
    if (outcome !== 'success') return Response.json({ error: outcome }, { status: outcome === 'access_denied' ? 429 : 400 })
    if (tokenCalls === 1) return Response.json({ error: 'authorization_pending' }, { status: 400 })
    if (tokenCalls === 2) return Response.json({ error: 'slow_down' }, { status: 400 })
    return Response.json({ key: 'sk-orca-fixture-minted-not-real', user_id: '123', scope })
  }) as typeof fetch
  const drive = () => runOrcarouterDeviceLogin({ io: { fetchImpl, now: () => clock }, sleep: async ms => { sleeps.push(ms); clock += ms }, cancelled: () => cancel })
  const connected = await drive()
  check('anonymous device sign-in stores the minted inference key', connected.ok && readStoredOrcarouterApiKey() === 'sk-orca-fixture-minted-not-real')
  check('discovery precedes the anonymous device grant', requests[0]?.url.endsWith('/.well-known/openid-configuration') && requests[1]?.body?.app_name === 'Mercury' && requests[1]?.body?.scope === 'api' && !('client_id' in requests[1]!.body!))
  check('device polling uses the RFC grant type and the private code', requests[2]?.body?.grant_type === 'urn:ietf:params:oauth:grant-type:device_code' && requests[2]?.body?.device_code === 'fixture-device-secret')
  check('pending and slow_down keep polling with the increased interval', JSON.stringify(sleeps) === '[5000,5000,10000]')
  check('successful receipts contain neither minted key nor device code', !connected.receipt.includes('sk-orca-') && !connected.receipt.includes('fixture-device'))
  writeStoredOrcarouterApiKey(null)
  scope = 'connector'; tokenCalls = 2; clock = 0
  check('connector scope is never stored as an inference key', !(await drive()).ok && readStoredOrcarouterApiKey() === undefined)
  scope = 'api'; discoveryHttp = true; requests.length = 0
  const insecure = await drive()
  check('today’s insecure discovery document refuses before any device request', !insecure.ok && requests.length === 1 && insecure.receipt.includes('insecure'))
  discoveryHttp = false; crossOrigin = true; requests.length = 0
  check('cross-origin discovery refuses before sending a code', !(await drive()).ok && requests.length === 1)
  crossOrigin = false; outcome = 'access_denied'; tokenCalls = 0; clock = 0
  check('a declined or quota-refused grant ends polling immediately', !(await drive()).ok && tokenCalls === 1 && readStoredOrcarouterApiKey() === undefined)
  outcome = 'expired_token'; tokenCalls = 0; clock = 0
  check('expired device codes are terminal', !(await drive()).ok && tokenCalls === 1)
  outcome = 'success'; cancel = true; requests.length = 0
  check('pre-cancelled sign-in does no network work', !(await drive()).ok && requests.length === 0)
  cancel = false; cancelOnToken = true; tokenCalls = 2; clock = 0
  const late = await drive()
  check('an approval already in flight is retained after cancellation', late.ok && late.settledAfterCancel && readStoredOrcarouterApiKey() === 'sk-orca-fixture-minted-not-real')
  check('boot device instructions contain only the code, URL and next action', deviceWaitPaneLines({ family: 'orcarouter', phase: 'waiting', userCode: 'BCDF-GHJK', verificationUri: 'https://www.orcarouter.ai/device', expiresAtMs: 600000, polls: 8, copied: false }, 0).join('\n').includes('BCDF-GHJK') && !deviceWaitPaneLines({ family: 'orcarouter', phase: 'waiting', polls: 8, copied: false }, 0).join(' ').includes('checks'))
  const { createElement } = await import('react')
  const { OrcarouterConnect } = await import('../../src/services/providers/orcarouter/OrcarouterConnect.tsx')
  const { PopupCompactContext } = await import('../../src/context/popupFormContext.ts')
  const { ThemeProvider } = await import('../../src/ink.ts')
  const { App } = await import('../../src/components/App.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
  const { mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.ts')
  const frameArg = process.argv.indexOf('--frames')
  const frames = frameArg >= 0 ? process.argv[frameArg + 1] : undefined
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { gridToPng } = await import('../ui/gridToPng.ts')
  if (frames) mkdirSync(frames, { recursive: true })
  for (const [columns, rows, compact] of [[120, 24, false], [64, 12, true]] as const) {
    const card = createElement(PopupCompactContext.Provider, { value: { compact, setMarker: () => {} } }, createElement(OrcarouterConnect, { onResult: () => {}, onBack: () => {} }))
    const mounted = await mountOffscreen(createElement(ThemeProvider, null, createElement(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, createElement(KeybindingSetup, null, card))), columns, rows)
    try {
      check(`${columns} columns: sign-in choices render`, await waitFor(() => mounted.screen().includes('Paste an API key'), 3000))
      check(`${columns} columns: no storage or verification labels are added`, !/auth-scoped|mode 600|UNVERIFIED|verified|checks/.test(mounted.screen()))
      if (frames) {
        const lines = mounted.lines()
        const grid = lines.map((line, y) => Array.from(line.padEnd(columns)).slice(0, columns).map((c, x) => ({ c, ...mounted.styleAt(x, y) })))
        const path = join(frames, `orcarouter-choice-${columns}.json`)
        writeFileSync(path, JSON.stringify({ grid, cols: columns, rows }))
        await gridToPng(path, join(frames, `orcarouter-choice-${columns}.png`))
      }
      mounted.push('2')
      check(`${columns} columns: the API-key choice opens a masked input`, await waitFor(() => mounted.screen().includes('Key:'), 3000))
      mounted.push('sk-orca-fixture-hidden')
      check(`${columns} columns: key input stays secret`, await waitFor(() => mounted.screen().includes('****'), 3000) && !mounted.screen().includes('sk-orca-fixture-hidden'))
    } finally { mounted.unmount() }
  }
  console.log(`ORCAROUTER LOGIN GREEN (${checks} checks; documented fixture only)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
