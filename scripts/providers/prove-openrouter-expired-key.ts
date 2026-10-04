import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

const parent = process.env.MERCURY_CONFIG_DIR
const realHome = join(homedir(), '.mercury')
if (!parent || parent === realHome || parent.startsWith(realHome + '/')) throw new Error('An isolated scratch config home is required')
const home = mkdtempSync(join(parent, 'openrouter-proof-'))
for (const name of Object.keys(process.env)) {
  if (/^(MERCURY_|ANTHROPIC_|CLAUDE_|OPENROUTER_|OPENAI_|ZAI_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|TYPESAFE_|AWS_|AZURE_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
}
Object.assign(process.env, { MERCURY_CONFIG_DIR: home, MERCURY_AUTH_SCOPE_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_HELM_CONSOLE: '0', MERCURY_EVOLUTION_LEDGER: '0', MERCURY_MODEL: 'openrouter/fixture/model', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' })
for (const name of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_GEMINI_OAUTH_AUTH_BASE', 'MERCURY_GEMINI_OAUTH_TOKEN_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_JEV_BASE']) process.env[name] = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const mintedKey = 'proof-openrouter-minted-key'
const storedKey = 'proof-openrouter-stored-key'
const envKey = 'proof-openrouter-env-key'
const requests: string[] = []
const escaped: string[] = []
let mintedStatus = 401
let storedStatus = 200
let mintedBody: unknown = { error: { code: 401, message: 'API key expired' } }
const payload = { data: { label: 'fixture credits', usage: 12.5, limit: 50, limit_remaining: 37.5 } }
let beforeReply: (() => void) | undefined
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const bearer = request.headers.get('authorization')
  const source = bearer === `Bearer ${mintedKey}` ? 'minted' : bearer === `Bearer ${storedKey}` ? 'stored' : bearer === `Bearer ${envKey}` ? 'env' : 'unknown'
  const path = new URL(request.url).pathname
  requests.push(`${request.method} ${path} ${source}`)
  if (request.method === 'POST' && path === '/auth/keys') return Response.json({ key: mintedKey })
  if (request.method !== 'GET' || path !== '/key') return new Response(null, { status: 404 })
  const callback = beforeReply
  beforeReply = undefined
  callback?.()
  if (source === 'minted') return mintedStatus !== 200 && mintedBody === undefined
    ? new Response(null, { status: mintedStatus })
    : Response.json(mintedStatus === 200 ? payload : mintedBody, { status: mintedStatus })
  if (source === 'stored') return Response.json(storedStatus === 200 ? payload : { error: { code: 401, message: 'Stored key refused' } }, { status: storedStatus })
  if (source === 'env') return Response.json(payload)
  return new Response(null, { status: 403 })
} })
const base = `http://127.0.0.1:${server.port}`
process.env.MERCURY_OPENROUTER_API_BASE = base
const originalFetch = globalThis.fetch
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== base) { escaped.push(url.origin); throw new Error('Only the loopback key fixture may be contacted') }
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
const owner = await import('../../src/services/providers/providerUsage.js')
const seedMint = () => writeFileSync(accounts.openrouterAuthPathForDisplay(), JSON.stringify({ version: 1, retained: true, minted: { key: mintedKey, mintedAtMs: 1, label: 'fixture mint' } }), { mode: 0o600 })
const family = { id: 'openrouter', available: true, credentialed: true, credentialLabel: 'OpenRouter fixture' }
await stub('../../src/services/providers/providerUsage.js', { providerFamilyPresences: () => [family] })
const readSlots = () => slots.deriveFamilySlotGroups([]).find(group => group.family.id === 'openrouter')!.slots
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const compact = (text: string) => text.replace(/│/g, ' ').replace(/\s+/g, ' ').trim()
const framesAt = process.argv.indexOf('--frames')
const frames = framesAt < 0 ? undefined : process.argv[framesAt + 1]
const index: string[] = []
try {
  seedMint()
  secrets.writeStoredOpenrouterApiKey(storedKey)
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  const observed = reader.openrouterObservedKeyUsage()
  const initialSlots = readSlots()
  const minted = initialSlots.find(slot => slot.id === 'openrouter:oauth-key')!
  const stored = initialSlots.find(slot => slot.id === 'openrouter:stored-key')!
  console.log(`resolution after 401: ${accounts.resolveOpenrouterApiKey()?.source ?? 'none'}`)
  console.log(`credits read: ${JSON.stringify(observed)}`)
  console.log(`key endpoint requests: ${requests.join(' | ')}`)
  console.log(`minted slot: ${minted.active ? 'active' : 'inactive'} · ${minted.stateNote ?? '(no note)'}`)
  console.log(`stored slot: ${stored.active ? 'active' : 'inactive'} · ${stored.stateNote ?? '(no note)'}`)
  check('an expired OAuth-minted OpenRouter key must not shadow a valid stored API key', accounts.resolveOpenrouterApiKey()?.key === storedKey)
  check('the credits read retries the stored key at once after the minted 401', requests.join('|') === 'GET /key minted|GET /key stored', requests.join(' | '))
  check('the stored key 200 credits are observed', observed.usage?.limitRemaining === 37.5 && observed.lastError === undefined, JSON.stringify(observed))
  check('the minted slot keeps the expired provider message and how to drop it', !minted.active && minted.stateNote === 'API key expired · /logins openrouter: ⌫ removes it', minted.stateNote ?? '(no note)')
  check('the stored slot is active, not shadowed, and has no minted 401 words', stored.active && stored.stateNote === undefined, stored.stateNote ?? '(no note)')
  check('request auth uses the stored bearer for calls', accounts.resolveOpenrouterRequestAuth()?.headers.authorization === `Bearer ${storedKey}`)
  check('unknown auth-file fields survive the expiry update', JSON.parse(readFileSync(accounts.openrouterAuthPathForDisplay(), 'utf8')).retained === true)
  reader.__resetOpenrouterUsageStateForTest()
  check('the expired fact survives usage-state reset', accounts.resolveOpenrouterApiKey()?.source === 'stored')
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })

  await stub('../../src/utils/model/computedDefault.js', { recentSignIns: () => [{ family: 'openrouter' }] })
  await stub('../../src/hooks/useProviderUsageOnShow.js', { useProviderUsageOnShow: () => undefined })
  await stub('../../src/keybindings/useKeybinding.js', { useKeybinding: () => undefined, useKeybindings: () => undefined })
  await stub('../../src/hooks/useExitOnCtrlCD.js', { useExitOnCtrlCD: () => undefined })
  await stub('../../src/context/notifications.js', { useNotifications: () => ({ addNotification() {}, removeNotification() {} }) })
  const connector = { modelFacts: () => ({ main: 'openrouter/fixture/model' }), subscribeModel: () => () => {}, usage: () => ({ totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }) }
  await stub('../../src/services/engine-connector/focusedConnector.js', { getFocusedSessionConnector: () => connector, subscribeThroughFocused: () => () => () => {} })
  await stub('../../src/components/tasks/useFocusedWork.js', { useFocusedWorkRows: () => [], useFocusedWorkRoster: () => ({ rows: [], mission: [], reported: true }), otherSessionRunnerPids: () => new Set(), focusedSessionIdOrNull: () => null })
  await stub('../../src/state/telemetryBus.js', { useTelemetry: () => ({ trace: null, workflowsDisk: [] }) })
  await stub('../../src/utils/cockpit/healthCertSnapshot.js', { healthCertSnapshot: () => ({ state: 'unavailable' }) })
  let columns = 178
  let rows = 51
  await stub('../../src/hooks/useTerminalSize.js', { useTerminalSize: () => ({ columns, rows }) })
  await stub('../../src/components/mercury-ui/components.js', { useNowTick: () => Date.now() })
  const { Usage } = await import('../../src/components/Settings/Usage.js')
  const { HelmTelemetryRail } = await import('../../src/components/HelmTelemetryRail.js')
  const { Deck } = await import('../../src/components/Deck.js')
  const { railPlanAt } = await import('../../src/utils/helmGeometry.js')
  const ink = await import('../../src/ink.js')
  const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
  async function renderRefusal(message: string | undefined, tag: string) {
    for (const size of message ? [[178, 51], [80, 21]] : [[120, 51], [80, 51]]) {
      ;[columns, rows] = size as [number, number]
      for (const surface of message ? ['rail', 'usage'] : ['rail', 'usage', 'deck']) {
        const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
        const stream = new PassThrough()
        stream.resume()
        const stdout = Object.assign(stream, { columns, rows }) as unknown as NodeJS.WriteStream
        const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: new ink.EventEmitter(), internal_querier: null }
        const child = surface === 'rail' ? React.createElement(HelmTelemetryRail, { width: railPlanAt(columns, true).telemetryW, availRows: rows }) : surface === 'deck' ? React.createElement(Deck, { onClose() {} }) : React.createElement(Usage, { width: Math.min(146, columns - 4), rowBudget: rows === 51 ? 29 : 21, openToken: columns })
        const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(ink.Box, { flexDirection: 'column', width: columns }, child))
        let painted = () => {}
        const firstFrame = new Promise<void>(resolve => { painted = resolve })
        const instance = await ink.render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
        await firstFrame
        for (let tick = 0; tick < 8; tick++) { ink.flushPendingSyncWork(); await new Promise<void>(resolve => setTimeout(resolve, 5)) }
        const frame = stripAnsi(instance.lastFrame()).replace(/\n$/, '').split('\n').map(line => line.trimEnd()).join('\n')
        const name = `${tag}-${surface}-${columns}x${rows}.txt`
        if (frames) { writeFileSync(join(frames, name), frame); index.push(name) }
        const text = compact(frame)
        if (message === undefined) {
          check(`${name}: the OAuth source credits paint within the source-render budgets`, frame.split('\n').length <= rows && frame.split('\n').every(line => stringWidth(line) <= columns) && text.includes('37.50') && text.includes('credits') && (surface === 'deck' || text.includes('OAuth-minted key')), frame)
          instance.unmount(); instance.cleanup(); stream.destroy()
          continue
        }
        check(`${name}: source render stays within both budgets and carries both slot headings`, frame.split('\n').length <= rows && frame.split('\n').every(line => stringWidth(line) <= columns) && text.includes('OAuth-minted key') && text.includes('API key'), frame)
        const mintedAt = text.indexOf('OAuth-minted key')
        const messageAt = text.indexOf(message, mintedAt)
        const removalAt = text.indexOf('⌫ removes it', messageAt)
        const apiAt = text.indexOf('API key', removalAt)
        check(`${name}: the provider message paints verbatim under the minted slot`, mintedAt >= 0 && messageAt > mintedAt && removalAt > messageAt && apiAt > removalAt, text)
        check(`${name}: expiry is not invented when the provider did not say expired`, message.includes('expired') || !text.includes('expired'), text)
        check(`${name}: API slot has stored credits, not the minted failure`, apiAt >= 0 && text.slice(apiAt).includes('37.50') && !text.slice(apiAt).includes(message), text)
        instance.unmount(); instance.cleanup(); stream.destroy()
      }
    }
  }
  await renderRefusal('API key expired', 'expired')

  process.env.OPENROUTER_API_KEY = envKey
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  check('an env-pinned key keeps winning for calls and credits', accounts.resolveOpenrouterApiKey()?.source === 'env' && requests.at(-1) === 'GET /key env' && readSlots().find(slot => slot.id === 'openrouter:env-key')?.active === true)
  delete process.env.OPENROUTER_API_KEY
  storedStatus = 401
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  const refusedSlots = readSlots()
  check('a later stored 401 belongs only to the stored slot', refusedSlots.find(slot => slot.id === 'openrouter:stored-key')?.stateNote?.includes('Stored key refused') === true && !refusedSlots.find(slot => slot.id === 'openrouter:oauth-key')?.stateNote?.includes('Stored key refused'))
  check('the block-level failure names the API key slot', owner.usageForProvider('openrouter').readerNote?.includes('API key (stored)') === true, owner.usageForProvider('openrouter').readerNote)
  storedStatus = 200
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  check('a successful stored read clears only its own error', readSlots().find(slot => slot.id === 'openrouter:stored-key')?.stateNote === undefined && readSlots().find(slot => slot.id === 'openrouter:oauth-key')?.stateNote?.includes('API key expired') === true)
  secrets.writeStoredOpenrouterApiKey(null)
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  check('without a stored key there is no usable credential or stale credits', accounts.resolveOpenrouterApiKey() === undefined && reader.openrouterObservedKeyUsage().usage === null && owner.usageForProvider('openrouter').whyNot?.includes('no usable key') === true)
  accounts.disconnectOpenrouterOauthKey()
  check('dropping the minted key drops its expired mark', accounts.readMintedOpenrouterKey() === undefined && readSlots().every(slot => slot.id !== 'openrouter:oauth-key'))
  seedMint()
  mintedBody = { error: { code: 401, message: 'User not found.' } }
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  check('a minted bearer 401 keeps User not found. without inventing expiry', readSlots().find(slot => slot.id === 'openrouter:oauth-key')?.stateNote === 'User not found. · /logins openrouter: ⌫ removes it')
  check('User not found. still marks the minted key unusable', accounts.readMintedOpenrouterKey()?.expiredMessage === 'User not found.' && accounts.resolveOpenrouterApiKey() === undefined)
  check('the no-usable-key notice does not invent expiry', owner.usageForProvider('openrouter').readerNote === 'OAuth-minted key refused — no usable key' && !owner.usageForProvider('openrouter').whyNot?.includes('expired'), JSON.stringify(owner.usageForProvider('openrouter')))
  seedMint()
  secrets.writeStoredOpenrouterApiKey(storedKey)
  mintedBody = { error: { code: 401, message: ' \r\nUser not\nfound.\r\n ' } }
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  check('provider words are trimmed to one line before persistence and display', accounts.readMintedOpenrouterKey()?.expiredMessage === 'User not found.' && readSlots().find(slot => slot.id === 'openrouter:oauth-key')?.stateNote === 'User not found. · /logins openrouter: ⌫ removes it')
  await renderRefusal('User not found.', 'invalid')
  if (frames) writeFileSync(join(frames, 'index.txt'), index.join('\n') + '\nSource-rendered real USAGE surfaces with isolated minted refusals and stored 200 keys. The compact cockpit hides its rail; the small rail captures exercise the component.\n')
  secrets.writeStoredOpenrouterApiKey(null)
  const connect = accounts.beginOpenrouterConnect({ mode: 'headless', skipBrowserOpen: true, fetchImpl })
  connect.completeWithRedirect('fixture-code')
  await connect.result
  check('re-minting clears expiration even when the fixture reuses the key', accounts.resolveOpenrouterApiKey()?.source === 'oauth' && readSlots().find(slot => slot.id === 'openrouter:oauth-key')?.stateNote === undefined)
  mintedStatus = 200
  const now = Date.now()
  const countBefore = requests.length
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true, now: () => now })
  const oauthUsage = owner.usageForProvider('openrouter')
  check('the newly OAuth-minted key rides the existing key reader once', accounts.resolveOpenrouterApiKey()?.source === 'oauth' && requests.length === countBefore + 1 && requests.at(-1) === 'GET /key minted')
  check('OAuth credits are the same capped-key credits with the same stamp', oauthUsage.credits?.display === '37.50 remaining under the key cap' && oauthUsage.credits.observedAtMs === now && oauthUsage.windows[0]?.observedAtMs === now)
  await renderRefusal(undefined, 'oauth-credits')
  const fresh = await import('../../src/services/providers/usageFreshness.js')
  check('OAuth credits retain the generic stale spelling', owner.usageCreditsLine(oauthUsage.credits, now + fresh.usageStaleAfterMs() + 60_000)?.includes('stale') === true)
  mintedStatus = 503
  mintedBody = { error: { message: 'Fixture credits temporarily unavailable' } }
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  const failedOAuth = owner.usageForProvider('openrouter')
  check('a refused OAuth credit read keeps its last balance and names the OAuth slot', failedOAuth.credits?.display === oauthUsage.credits?.display && failedOAuth.credits?.observedAtMs === now && failedOAuth.readerNote === 'credit truth unavailable for OAuth-minted key' && readSlots().find(slot => slot.id === 'openrouter:oauth-key')?.stateNote === 'Fixture credits temporarily unavailable')
  const noCap = owner.usageForProvider('openrouter', { openrouterKeyPresent: () => true, openrouterObserved: () => ({ usage: { limit: null, limitRemaining: null, observedAtMs: now } }) })
  check('an OAuth key with no cap never fabricates account credits', noCap.credits?.state === 'unreported' && noCap.credits.reason?.includes('uncapped key') === true)
  mintedStatus = 401
  mintedBody = undefined
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  check('a bodiless minted 401 reports HTTP 401 without inventing expiry', readSlots().find(slot => slot.id === 'openrouter:oauth-key')?.stateNote === 'key endpoint returned HTTP 401 · /logins openrouter: ⌫ removes it')
  check('a bodiless 401 still marks the minted key unusable', accounts.readMintedOpenrouterKey()?.expiredMessage === 'key endpoint returned HTTP 401' && accounts.resolveOpenrouterApiKey() === undefined)
  seedMint()
  mintedBody = { error: { code: 401 } }
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  check('an envelope with no provider words reports HTTP 401', readSlots().find(slot => slot.id === 'openrouter:oauth-key')?.stateNote === 'key endpoint returned HTTP 401 · /logins openrouter: ⌫ removes it')
  seedMint()
  mintedStatus = 503
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  check('a transient refusal never expires the minted key', accounts.resolveOpenrouterApiKey()?.source === 'oauth' && !readSlots().find(slot => slot.id === 'openrouter:oauth-key')?.stateNote?.startsWith('expired'))
  mintedStatus = 401
  beforeReply = () => writeFileSync(accounts.openrouterAuthPathForDisplay(), JSON.stringify({ version: 1, minted: { key: 'proof-replacement-minted-key', mintedAtMs: 2 } }), { mode: 0o600 })
  await reader.refreshOpenrouterKeyUsage({ fetchImpl, force: true })
  check('a delayed old 401 never expires the replacement minted key', accounts.resolveOpenrouterApiKey()?.key === 'proof-replacement-minted-key' && !readSlots().find(slot => slot.id === 'openrouter:oauth-key')?.stateNote?.includes('API key expired'))
  check('no request escaped the loopback stand-in', escaped.length === 0, escaped.join('|'))
} finally {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
console.log(`openrouter expired key: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
