import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { hfEndpointsFixture } from './hfEndpointsFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
process.env.HOME = f.home
if (process.platform === 'win32') process.env.USERPROFILE = f.home
delete process.env.MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID
const hf = await hfEndpointsFixture()
const requests: { path: string; scope: string | null; client: string | null }[] = []
let registrations = 0
let grantedScope = 'openid profile inference-api'
const oauth = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (path === '/oauth/register') {
    const body = await req.json() as { scope: string }
    requests.push({ path, scope: body.scope, client: null })
    return Response.json({ client_id: 'fixture-client-' + ++registrations, scope: body.scope }, { status: 201 })
  }
  const form = new URLSearchParams(await req.text())
  requests.push({ path, scope: form.get('scope'), client: form.get('client_id') })
  if (path === '/oauth/device') {
    grantedScope = form.get('scope') ?? ''
    return Response.json({ device_code: 'fixture-device', user_code: 'HF-CODE', verification_uri: 'https://example.com/hf/device', expires_in: 300 })
  }
  if (path === '/oauth/token') return Response.json({ access_token: hf.key, refresh_token: 'fixture-refresh', expires_in: 7200, ...(form.get('grant_type') === 'refresh_token' ? {} : { scope: grantedScope }) })
  return Response.json({}, { status: 404 })
} })
process.env.MERCURY_HUGGINGFACE_HUB_BASE = 'http://127.0.0.1:' + oauth.port
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { escaped.push(url.origin); throw new Error('Only loopback fixtures are allowed') }
  return nativeFetch(request)
}, nativeFetch)
let mounted: Mounted | undefined
let failures = 0
let checks = 0
function check(name: string, truth: unknown) { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name) }
try {
  const accounts = await import('../../src/services/providers/huggingface/huggingfaceAccounts.ts')
  const { writeStoredHuggingfaceApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const start = await accounts.startHuggingfaceDeviceAuth()
  const wanted = 'openid profile inference-api write-endpoints'
  check('fresh registration requests exactly identity, inference-api and write-endpoints', requests.find(row => row.path === '/oauth/register')?.scope === wanted)
  check('device-code sign-in requests write-endpoints without broadening repository access', requests.find(row => row.path === '/oauth/device')?.scope === wanted)
  const result = await accounts.pollHuggingfaceDeviceToken(start)
  assert.equal(result.state, 'authorized')
  if (result.state === 'authorized') accounts.writeHuggingfaceTokens(result.tokens)
  check('fresh OAuth grant preserves the granted endpoint scope', accounts.huggingfaceStoredTokens()?.scope === wanted)
  await accounts.refreshHuggingfaceTokens()
  check('refresh without scope retains the granted scope rather than inventing a new one', accounts.huggingfaceStoredTokens()?.scope === wanted)
  const authPath = accounts.huggingfaceAuthPathForDisplay()
  const old = JSON.parse(readFileSync(authPath, 'utf8'))
  old.registeredClient = { clientId: 'fixture-old-client', hubBase: process.env.MERCURY_HUGGINGFACE_HUB_BASE, issuedAtMs: 1 }
  delete old.tokens.clientId
  writeFileSync(authPath, JSON.stringify(old))
  const renewed = await accounts.startHuggingfaceDeviceAuth()
  check('re-sign-in replaces a legacy client registration that did not request endpoint management', registrations === 2 && requests.filter(row => row.path === '/oauth/device').at(-1)?.client === 'fixture-client-2')
  await accounts.refreshHuggingfaceTokens()
  check('an unfinished re-sign-in keeps the existing grant bound to its original client', requests.at(-1)?.client === 'fixture-old-client')
  const renewedResult = await accounts.pollHuggingfaceDeviceToken(renewed)
  assert.equal(renewedResult.state, 'authorized')
  if (renewedResult.state === 'authorized') accounts.writeHuggingfaceTokens(renewedResult.tokens)
  await accounts.refreshHuggingfaceTokens()
  check('a completed re-sign-in refreshes with the new client', requests.at(-1)?.client === 'fixture-client-2')
  await accounts.startHuggingfaceDeviceAuth()
  check('current scoped registration is reused for subsequent sign-ins', registrations === 2)
  accounts.writeHuggingfaceTokens({ accessToken: hf.key, refreshToken: 'fixture-refresh', scope: 'openid profile inference-api' })
  await accounts.refreshHuggingfaceTokens()
  check('refresh does not silently upgrade an older grant', accounts.huggingfaceStoredTokens()?.scope === 'openid profile inference-api')

  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { call: logins } = await import('../../src/commands/login/login.tsx')
  let question: LlmHostQuestion | undefined
  let width = 120, height = 40
  const screen = () => mounted!.screen()
  const normal = () => screen().replace(/[│\s]+/g, ' ')
  const until = async (predicate: () => boolean, label: string) => assert.ok(await waitFor(predicate, 10000), label + '\n' + screen())
  const mount = async (columns: number, rows: number) => {
    width = columns; height = rows
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(KeybindingSetup, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot))))), width, height)
  }
  const capture = async (name: string) => {
    check(name + ' has intact borders and no secret or internal jargon', screen().includes('╰') && !screen().includes('RENDER ERROR') && !screen().includes(hf.key) && !/\b(door|road|seat|fold|lane|ladder|owner|law|pin|prover)s?\b/i.test(screen()))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), screen())
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => ({ c, bg: mounted!.styleAt(x, y)?.bg ?? 'default', fg: mounted!.styleAt(x, y)?.fg ?? 'default', bold: mounted!.styleAt(x, y)?.bold ?? false })))
    const path = join(frames, name + '.json')
    writeFileSync(path, JSON.stringify({ grid, cols: width, rows: height }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  let session = 0
  const open = async () => {
    question = undefined
    const implementation = createHostRoad({ vendorApiBaseUrls: { huggingface: hf.baseUrl }, sessionId: 'hf-scope-' + ++session })
    const road: LlmHostRoad = (ask, emit, signal) => implementation(plan => { question = plan; return ask(plan) }, emit, signal)
    popup.openSettingsPopup(llmHostPopupRequest(road))
    await until(() => question?.step === 'door-models' && screen().includes('Which model?'), 'first host screen')
  }
  const close = async () => { popup.closeSettingsPopup(); await until(() => !popup.isSettingsPopupOpen(), 'popup closes') }
  const forbidden = () => { hf.state.failNext = { route: 'GET /v2/provider/fixture-owner', status: 403, times: 1 } }
  for (const [columns, rows] of [[120, 40], [80, 24]]) {
    accounts.writeHuggingfaceTokens({ accessToken: hf.key, scope: 'openid profile inference-api' })
    await mount(columns!, rows!)
    forbidden(); await open()
    check('old OAuth 403 states the missing management permission and re-sign-in remedy at ' + width, normal().includes('this sign-in lacks Inference Endpoints management') && normal().includes('sign in again with /logins huggingface') && normal().includes('HTTP 403'))
    check('old OAuth 403 appears once, without exposing raw request details', (normal().match(/HTTP 403/g) ?? []).length === 1 && !normal().includes('GET /provider'))
    await capture('llmhost-oauth-' + width)
    await close()
    await logins(() => {}, { onChangeAPIKey() {}, setMessages() {}, getAppState: () => ({}), setAppState() {} } as never, 'huggingface')
    await until(() => normal().includes('Hugging Face — device-code sign-in'), 'Hugging Face menu row')
    mounted!.push(KEY.enter)
    await until(() => normal().includes('Sign in / re-login'), 'Hugging Face account card')
    mounted!.push(KEY.enter)
    await until(() => normal().includes('Sign in with Hugging Face'), 'Hugging Face sign-in card')
    check('logins card discloses inference and endpoint management at ' + width, normal().includes('Inference Providers and Inference Endpoints management'))
    await capture('logins-huggingface-' + width)
    await close(); mounted!.unmount(); mounted = undefined
  }
  await mount(120, 40)
  accounts.writeHuggingfaceTokens(null)
  writeStoredHuggingfaceApiKey(hf.key)
  forbidden(); await open()
  check('pasted token refusal does not prescribe repeating OAuth sign-in', question!.found.includes('Inference Endpoints permission required (HTTP 403)') && !question!.found.includes('sign in again'))
  await close()
  process.env.HF_TOKEN = hf.key
  accounts.writeHuggingfaceTokens({ accessToken: 'fixture-shadowed-oauth', scope: 'openid profile inference-api' })
  forbidden(); await open()
  check('HF_TOKEN precedence does not misdiagnose a shadowed OAuth grant', !question!.found.includes('this sign-in lacks') && !question!.found.includes('sign in again'))
  await close(); delete process.env.HF_TOKEN
  accounts.writeHuggingfaceTokens({ accessToken: hf.key, scope: wanted })
  forbidden(); await open()
  check('a fully scoped OAuth 403 is not diagnosed as missing consent', !question!.found.includes('this sign-in lacks') && !question!.found.includes('sign in again'))
  await close()
  await open()
  check('authorized endpoint reads work without a permission notice', !question!.found.includes('HTTP 403'))
  check('no request escaped the local fixtures', escaped.length === 0)
  await close()
} finally { mounted?.unmount(); globalThis.fetch = nativeFetch; oauth.stop(true); await hf.close(); f.close() }
console.log(`HF OAUTH ENDPOINTS ${failures ? 'RED' : 'GREEN'} — ${checks - failures}/${checks} checks`)
process.exit(failures ? 1 : 0)
