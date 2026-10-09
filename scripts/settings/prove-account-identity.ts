#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

const ROOT = join(import.meta.dir, '../..')
const framesAt = process.argv.indexOf('--frames')
const framesDir = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (framesDir !== undefined) mkdirSync(framesDir, { recursive: true })
const save = (name: string, frame: string): void => {
  if (framesDir !== undefined) writeFileSync(join(framesDir, `${name}.txt`), frame + '\n')
}
const NOW = 1_800_000_000_000
const DAY = 86_400_000
const MODEL = 'claude-fable-5-1'
const ANTHROPIC_EMAIL = 'owner@example.com'
const ANTHROPIC_TOKEN = 'fixture-claude-access-token-0001'
const OPENAI_EMAIL = 'chatgpt-owner@example.com'
const HF_USERNAME = 'hf-owner'
const KIMI_TOKEN = 'fixture-kimi-access-token-0001'
const STORED_KEYS = {
  zai: 'zz-fixture-zai-coding-plan-key-YtbT',
  deepseek: 'zz-fixture-deepseek-stored-key-dsk1',
  xai: 'zz-fixture-xai-stored-key-xai1',
  meta: 'zz-fixture-meta-stored-key-mta1',
  compat: 'zz-fixture-compat-stored-key-cmp1',
  openrouterMinted: 'zz-fixture-openrouter-minted-key-orm1',
}
const TAILS = Object.values(STORED_KEYS).map(key => `…${key.slice(-4)}`)
const IDENTITIES = [ANTHROPIC_EMAIL, OPENAI_EMAIL, HF_USERNAME]

delete process.env.NODE_ENV
delete process.env.MERCURY_CRITTER
const SCRATCH_ROOT = process.env.MERCURY_CONFIG_DIR?.trim() || tmpdir()
mkdirSync(SCRATCH_ROOT, { recursive: true })
const HOME = mkdtempSync(join(SCRATCH_ROOT, 'account-identity-'))
for (const name of Object.keys(process.env)) {
  if (/^(MERCURY_|ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|XAI_|META_|MODEL_API_KEY$|HF_|HUGGINGFACE_|AWS_|AZURE_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
}
Object.assign(process.env, {
  HOME,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_AUTH_SCOPE_DIR: HOME,
  MERCURY_HOME: HOME,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_EVOLUTION_LEDGER: '0',
  MERCURY_HELM_CONSOLE: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_REDUCED_MOTION: '1',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  BROWSER: '/usr/bin/true',
  TZ: 'UTC',
  LANG: 'en_GB.UTF-8',
  LC_ALL: 'en_GB.UTF-8',
})
const FIXTURE_BASES = ['MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_XAI_API_BASE', 'MERCURY_XAI_MANAGEMENT_API_BASE', 'MERCURY_META_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE']
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const originalNow = Date.now
const originalLocale = Date.prototype.toLocaleString
Date.now = () => NOW
Date.prototype.toLocaleString = function (_locales, options) {
  return originalLocale.call(this, 'en-GB', { ...options, timeZone: 'UTC', hourCycle: 'h23' })
}
const anthropicUsage = JSON.parse(readFileSync(join(ROOT, 'scripts/providers/fixtures/anthropic-oauth-usage.json'), 'utf8')).body
const openaiUsage = JSON.parse(readFileSync(join(ROOT, 'scripts/providers/fixtures/openai-chatgpt-usage.json'), 'utf8')).body
const huggingfaceWhoami = JSON.parse(readFileSync(join(ROOT, 'scripts/provider-compat/fixtures/huggingface-whoami-v2-documented.json'), 'utf8')).user
openaiUsage.rate_limit.primary_window.reset_at = (NOW + 2 * 3_600_000) / 1000
openaiUsage.rate_limit.primary_window.reset_after_seconds = 7200
const utilization = {
  extra_usage: anthropicUsage.extra_usage,
  five_hour: { utilization: 52, resets_at: new Date(NOW + 2 * 3_600_000).toISOString() },
  seven_day: { utilization: 49, resets_at: new Date(NOW + 3 * DAY).toISOString() },
  seven_day_fable: { utilization: 46, resets_at: new Date(NOW + 3 * DAY).toISOString() },
}
const kimiUsages = {
  usage: { used: '120', limit: '1000', resetTime: new Date(NOW + 7 * DAY).toISOString() },
  limits: [
    { window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { used: '31', limit: '100', resetTime: new Date(NOW + 2 * 3_600_000).toISOString() } },
    { window: { duration: 1, timeUnit: 'TIME_UNIT_WEEK' }, detail: { used: '410', limit: '1000', resetTime: new Date(NOW + 3 * DAY).toISOString() } },
  ],
}
const ollamaTags = { models: [{ name: 'fixture-model:latest', model: 'fixture-model:latest', details: { family: 'llama', parameter_size: '8B', quantization_level: 'Q4_K_M' } }] }
const requests: string[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    const bearer = request.headers.get('authorization')
    if (request.method === 'GET' && path === '/api/oauth/usage' && bearer === `Bearer ${ANTHROPIC_TOKEN}`) return Response.json(utilization)
    if (request.method === 'GET' && path === '/usages' && bearer === `Bearer ${KIMI_TOKEN}`) return Response.json(kimiUsages)
    if (request.method === 'GET' && path === '/wham/usage' && bearer === 'Bearer fixture-chatgpt-access-token-0001') return Response.json(openaiUsage)
    if (request.method === 'GET' && path === '/api/whoami-v2') return Response.json({ ...huggingfaceWhoami, name: HF_USERNAME })
    if (request.method === 'GET' && path === '/models') return Response.json({ data: [], models: [] })
    if (request.method === 'GET' && path === '/key') return Response.json({ data: { usage: 2, limit: 20, limit_remaining: 18, is_free_tier: false } })
    if (request.method === 'GET' && path === '/user/balance') return Response.json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '18.00', granted_balance: '0.00', topped_up_balance: '18.00' }] })
    if (request.method === 'GET' && path === '/users/me/balance') return Response.json({ code: 0, data: { available_balance: 18, voucher_balance: 0, cash_balance: 18 } })
    if (request.method === 'GET' && path === '/api/monitor/usage/quota/limit') return Response.json({ success: true, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 25, unit: 3, number: 5, nextResetTime: NOW + 2 * 3_600_000 }] } })
    if (request.method === 'GET' && path === '/api/tags') return Response.json(ollamaTags)
    if (request.method === 'GET' && path === '/api/version') return Response.json({ version: '0.11.4' })
    if (request.method === 'GET' && path === '/api/ps') return Response.json({ models: [] })
    if (request.method === 'POST' && path === '/api/show') return Response.json({ capabilities: ['tools'], model_info: {} })
    return new Response(null, { status: 404 })
  },
})
const FIXTURE_ORIGIN = `http://127.0.0.1:${server.port}`
for (const name of FIXTURE_BASES) process.env[name] = FIXTURE_ORIGIN
process.env.ANTHROPIC_BASE_URL = FIXTURE_ORIGIN
process.env.MERCURY_MOONSHOT_CODING_BASE = FIXTURE_ORIGIN
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${FIXTURE_ORIGIN}`
process.env.MERCURY_COMPAT_BASE_URL = FIXTURE_ORIGIN
const escaped: string[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== FIXTURE_ORIGIN) {
    escaped.push(url.href)
    throw new Error('only the loopback fixture may be contacted')
  }
  return originalFetch(input, { ...init, redirect: 'error' })
}) as typeof fetch

let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n── ${title}`)
}
async function stub(relative: string, overrides: Record<string, unknown>): Promise<void> {
  const target = join(ROOT, relative)
  const actual = await import(target)
  mock.module(target, () => ({ ...actual, ...overrides }))
}
await stub('src/utils/proxy.ts', { getApiFetch: () => globalThis.fetch, getProxyFetchOptions: () => ({}) })

const writeJson = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
writeJson(join(HOME, '.credentials.json'), {
  claudeAiOauth: {
    accessToken: ANTHROPIC_TOKEN,
    refreshToken: 'fixture-claude-refresh-token-0001',
    expiresAt: NOW + 30 * DAY,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_5x',
    profile: { account: { uuid: 'uuid-profile-fixture', email: ANTHROPIC_EMAIL, display_name: 'Fixture Owner', created_at: '2025-06-01T00:00:00Z' }, organization: { uuid: 'org-profile-fixture', organization_type: 'claude_max' } },
    tokenAccount: { uuid: 'uuid-profile-fixture', emailAddress: ANTHROPIC_EMAIL },
  },
})
writeJson(join(HOME, '.openai-auth.json'), { version: 1, tokens: { idToken: 'fixture.id.token', accessToken: 'fixture-chatgpt-access-token-0001', refreshToken: 'fixture-chatgpt-refresh-token-0001', accountId: 'acct-fixture-0001', planType: 'plus', email: OPENAI_EMAIL, accessTokenExpiresAtMs: NOW + 30 * DAY } })
writeJson(join(HOME, '.huggingface-auth.json'), { version: 1, tokens: { accessToken: 'fixture-hf-access-token-0001', refreshToken: 'fixture-hf-refresh-token-0001', accessTokenExpiresAtMs: NOW + 30 * DAY }, identity: { username: HF_USERNAME, fullName: 'Fixture Owner', observedAtMs: NOW } })
writeJson(join(HOME, '.gemini-auth.json'), { version: 1, client: { clientId: 'fixture-google-client' }, tokens: { accessToken: 'fixture-google-access-token-0001', refreshToken: 'fixture-google-refresh-token-0001', accessTokenExpiresAtMs: NOW + 30 * DAY } })
writeJson(join(HOME, '.moonshot-auth.json'), { version: 1, tokens: { accessToken: KIMI_TOKEN, refreshToken: 'fixture-kimi-refresh-token-0001', accessTokenExpiresAtMs: NOW + 30 * DAY }, region: 'global' })
writeJson(join(HOME, '.openrouter-auth.json'), { version: 1, minted: { key: STORED_KEYS.openrouterMinted, mintedAtMs: NOW } })
writeJson(join(HOME, '.provider-secrets.json'), { version: 1, zaiApiKey: STORED_KEYS.zai, zaiKeyPlan: 'coding', deepseekApiKey: STORED_KEYS.deepseek, xaiApiKey: STORED_KEYS.xai, metaApiKey: STORED_KEYS.meta, compatApiKey: STORED_KEYS.compat })

const USER_SETTINGS = join(HOME, 'settings.json')
type Leg = 'absent' | 'shown' | 'hidden'
const settingOf: Record<Leg, boolean | undefined> = { absent: undefined, shown: true, hidden: false }
writeJson(USER_SETTINGS, { engine: { model: MODEL } })

const config = await import(join(ROOT, 'src/utils/config.ts'))
config.enableConfigs()
config.saveGlobalConfig((current: Record<string, unknown>) => ({ ...current, hasCompletedOnboarding: true, oauthAccount: undefined }))
const { resetSettingsCache } = await import(join(ROOT, 'src/utils/settings/settingsCache.ts'))
const ledger = await import(join(ROOT, 'src/utils/accounts/signInLedger.ts'))
const localDiscovery = await import(join(ROOT, 'src/services/providers/local/localDiscovery.ts'))
const discovery = await import(join(ROOT, 'src/utils/router/providerDiscovery.ts'))
const registry = await import(join(ROOT, 'src/utils/router/modelRegistry.ts'))
await localDiscovery.refreshLocalDiscovery({ force: true })
discovery.__resetProviderDiscoveryForTest()
registry.resetRouterModelSnapshotMemo()
ledger.noteCredentialChange()

function setIdentity(leg: Leg): void {
  const value = settingOf[leg]
  writeJson(USER_SETTINGS, value === undefined ? { engine: { model: MODEL } } : { engine: { model: MODEL }, view: { accountIdentity: value } })
  resetSettingsCache()
}

await stub('src/keybindings/useKeybinding.ts', { useKeybinding: () => undefined, useKeybindings: () => undefined })
await stub('src/hooks/useExitOnCtrlCD.ts', { useExitOnCtrlCD: () => undefined })
await stub('src/context/notifications.tsx', { useNotifications: () => ({ addNotification() {}, removeNotification() {} }) })
await stub('src/utils/cockpit/healthCertSnapshot.ts', { healthCertSnapshot: () => ({ state: 'unavailable' }) })
let focusedModel = MODEL
const connector = {
  modelFacts: () => ({ main: focusedModel, effective: focusedModel }),
  subscribeModel: () => () => {},
  records: () => [],
  subscribeRecords: () => () => {},
  usage: () => ({ totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }),
}
await stub('src/services/engine-connector/focusedConnector.ts', {
  getFocusedSessionConnector: () => connector,
  subscribeThroughFocused: (subscribe: (connection: typeof connector, listener: () => void) => () => void) => (listener: () => void) => subscribe(connector, listener),
  hasFocusedSession: () => false,
  landingInFlight: () => false,
  subscribeFocusedSessionConnector: () => () => {},
})
await stub('src/components/tasks/useFocusedWork.ts', {
  useFocusedWorkRows: () => [],
  useFocusedWorkRoster: () => ({ rows: [], mission: [], reported: true }),
  otherSessionRunnerPids: () => new Set(),
  focusedSessionIdOrNull: () => null,
})
await stub('src/state/vitalsBus.ts', { useVitals: () => ({ trace: null, workflowsDisk: [] }) })

const ink = await import(join(ROOT, 'src/ink.ts'))
const { default: StdinContext } = await import(join(ROOT, 'src/ink/components/StdinContext.ts'))
const { InputEvent } = await import(join(ROOT, 'src/ink/events/input-event.ts'))
const { interpretKey } = await import(join(ROOT, 'src/ink/input/interpreter.ts'))
const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index++) {
    ink.flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const MODE_SEQUENCES = /\x1b\[[?>=<][0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[<u|\x1b\[>4m/g
function plain(raw: string): string {
  return stripAnsi(raw.replace(MODE_SEQUENCES, ''))
    .replace(/\n$/, '')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/^\n+/, '')
}
async function paint(content: React.ReactNode, columns: number, rows: number, walk = 0, done: (frames: string[]) => boolean = () => false): Promise<string[]> {
  const emitter = new ink.EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows, isTTY: true }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(ink.Box, { width: columns, height: rows, flexDirection: 'column' }, content))
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await ink.render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  await new Promise<void>(resolve => setTimeout(resolve, 250))
  await settle()
  const read = (): string => plain(instance.lastFrame())
  const quiet = async (): Promise<string> => {
    let last = read()
    let still = 0
    for (let waited = 0; waited < 8000 && still < 300; waited += 25) {
      await new Promise<void>(resolve => setTimeout(resolve, 25))
      await settle()
      const next = read()
      still = next === last ? still + 25 : 0
      last = next
    }
    return last
  }
  const frames = [await quiet()]
  for (let step = 0; step < walk && !done(frames); step++) {
    emitter.emit('input', new InputEvent(interpretKey('\x1b[B')))
    let moved = false
    for (let waited = 0; waited < 3000 && !moved; waited += 20) {
      await new Promise<void>(resolve => setTimeout(resolve, 20))
      await settle()
      moved = read() !== frames[frames.length - 1]
    }
    if (!moved) break
    frames.push(await quiet())
  }
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return frames
}

const COLS = 178
const ROWS = 51
const { HelmVitalsRail } = await import(join(ROOT, 'src/components/HelmVitalsRail.tsx'))
const { railPlanAt } = await import(join(ROOT, 'src/utils/helmGeometry.ts'))
const { settingsPopupGeometry } = await import(join(ROOT, 'src/components/SettingsPopupSlot.tsx'))
const popupStore = await import(join(ROOT, 'src/utils/cockpit/settingsPopup.ts'))
const usageCommand = await import(join(ROOT, 'src/commands/usage/usage.tsx'))
const logins = await import(join(ROOT, 'src/components/BootLoginsScreen.tsx'))
const { BootSplashScreen } = await import(join(ROOT, 'src/components/BootSplashScreen.tsx'))
const usage = await import(join(ROOT, 'src/services/providers/providerUsage.ts'))
const identityLine = await import(join(ROOT, 'src/services/providers/providerIdentityLine.ts'))
const slots = await import(join(ROOT, 'src/services/providers/accountSlots.ts'))
const words = await import(join(ROOT, 'src/services/wallet/identityWords.ts'))
const status = await import(join(ROOT, 'src/utils/status.tsx'))

const POPUP_TITLES = ['Anthropic usage', 'OpenAI usage', 'Z.AI usage', 'OpenRouter usage', 'Gemini usage', 'Moonshot usage', 'DeepSeek usage', 'xAI usage', 'Meta usage', 'Custom endpoint usage', 'Hugging Face usage', 'Local models usage']
async function paintPopup(): Promise<string[]> {
  await usageCommand.call('', {} as never)
  const request = popupStore.settingsPopupRequest()
  popupStore.closeSettingsPopup()
  const geometry = request === null ? null : settingsPopupGeometry(request, COLS, ROWS)
  if (request === null || geometry === null) return ['no usage popup request']
  const seenAll = (frames: string[]): boolean => POPUP_TITLES.every(title => frames.some(frame => frame.includes(title)))
  return paint(request.body({ width: geometry.width, inner: geometry.inner, rowBudget: geometry.rowBudget }) as React.ReactNode, COLS, ROWS, 400, seenAll)
}
const RAIL_FAMILIES: Array<{ id: string; model: string }> = [
  { id: 'anthropic', model: MODEL },
  { id: 'openai', model: 'gpt-5' },
  { id: 'huggingface', model: 'huggingface/fixture/model' },
  { id: 'zai', model: 'glm-4.6' },
  { id: 'openrouter', model: 'openrouter/fixture/model' },
  { id: 'deepseek', model: 'deepseek-chat' },
]
async function paintRail(model: string): Promise<string> {
  focusedModel = model
  const plan = railPlanAt(COLS, true)
  const frame = (await paint(React.createElement(ink.Box, { flexDirection: 'row', justifyContent: 'flex-end', width: COLS }, React.createElement(HelmVitalsRail, { width: plan.vitalsW, availRows: ROWS - 7 })), COLS, ROWS))[0]!
  focusedModel = MODEL
  return frame
}
function railCells(frame: string): string[] {
  const lines = frame.split('\n')
  const head = lines.findIndex(line => line.includes('USAGE'))
  if (head < 0) return []
  const cells: string[] = []
  for (const line of lines.slice(head + 1)) {
    if (line.includes('╰')) break
    const open = line.indexOf('│')
    const close = line.lastIndexOf('│')
    cells.push(open < 0 || close <= open ? line.trim() : line.slice(open + 1, close).trim())
  }
  return cells
}
type Surfaces = { popup: string[]; rails: Map<string, string>; face: string; logins: string }
async function paintSurfaces(leg: Leg): Promise<Surfaces> {
  setIdentity(leg)
  const popup = await paintPopup()
  const rails = new Map<string, string>()
  for (const family of RAIL_FAMILIES) rails.set(family.id, await paintRail(family.model))
  const face = (await paint(React.createElement(BootSplashScreen), COLS, ROWS))[0]!
  const loginsFrame = (await paint(React.createElement(logins.BootLoginsScreen, { fullScene: { columns: COLS, rows: ROWS } }), COLS, ROWS))[0]!
  popup.forEach((frame, index) => save(`${leg}-usage-${String(index).padStart(3, '0')}`, frame))
  for (const [family, frame] of rails) save(`${leg}-rail-${family}`, frame)
  save(`${leg}-face`, face)
  save(`${leg}-logins`, loginsFrame)
  return { popup, rails, face, logins: loginsFrame }
}
const leaks = (text: string): string[] => [...(text.includes('@') ? ['@'] : []), ...TAILS.filter(tail => text.includes(tail)), ...IDENTITIES.filter(identity => text.includes(identity))]
const lineWith = (frame: string, needle: string): string => frame.split('\n').find(line => line.includes(needle)) ?? ''
const lineUnder = (frames: string[], title: string): string => {
  for (const frame of frames) {
    const lines = frame.split('\n')
    const at = lines.findIndex(line => line.includes(title))
    if (at < 0 || at + 1 >= lines.length) continue
    const start = lines[at]!.indexOf(title)
    return (lines[at + 1] ?? '').slice(start, start + 40).trim()
  }
  return ''
}

section('§1 view.accountIdentity is a declared setting, a boolean, absent unless written')
{
  const { SettingsSchema } = await import(join(ROOT, 'src/utils/settings/types.ts'))
  const on = SettingsSchema().safeParse({ view: { accountIdentity: true } })
  const off = SettingsSchema().safeParse({ view: { accountIdentity: false } })
  const bad = SettingsSchema().safeParse({ view: { accountIdentity: 'hidden' } })
  check('the schema accepts true and false and refuses a word', on.success && off.success && !bad.success, JSON.stringify({ on: on.success, off: off.success, bad: bad.success }))
  check('the parsed setting carries false through', off.success && (off.data as { view?: { accountIdentity?: boolean } }).view?.accountIdentity === false)
  const snapshot = JSON.parse(readFileSync(join(ROOT, 'scripts/settings/settings-schema.json'), 'utf8')) as { properties?: { view?: { properties?: Record<string, { type?: string }> } } }
  check('the generated settings schema names view.accountIdentity as a boolean', snapshot.properties?.view?.properties?.accountIdentity?.type === 'boolean')
  setIdentity('absent')
  check('absent reads as shown (the default changes nothing)', typeof words.accountIdentityShown === 'function' && words.accountIdentityShown() === true)
  setIdentity('hidden')
  check('false reads as hidden', typeof words.accountIdentityShown === 'function' && words.accountIdentityShown() === false)
  setIdentity('absent')
}

section('§2 the owners: the identity line, the presence words and the label owner hide the identifying part only')
{
  const line = (family: string): { kind: string; text: string } => identityLine.providerIdentityLine(family)
  setIdentity('absent')
  const shownLines = new Map(RAIL_FAMILIES.map(family => [family.id, line(family.id)]))
  check('shown: the Claude line is the sign-in email (an account line)', shownLines.get('anthropic')?.kind === 'account' && shownLines.get('anthropic')?.text === ANTHROPIC_EMAIL, JSON.stringify(shownLines.get('anthropic')))
  check('shown: the Coding Plan key line carries its tail', shownLines.get('zai')?.text === 'Coding Plan key · …YtbT', JSON.stringify(shownLines.get('zai')))
  setIdentity('hidden')
  const want: Record<string, string> = { anthropic: 'Claude account', openai: 'ChatGPT account', huggingface: 'Hugging Face account', zai: 'Coding Plan key', openrouter: 'OAuth key', deepseek: 'API key' }
  for (const family of RAIL_FAMILIES) {
    const hidden = line(family.id)
    check(`hidden: the ${family.id} line is ${JSON.stringify(want[family.id])}, a label, no identity`, hidden.kind === 'label' && hidden.text === want[family.id] && leaks(hidden.text).length === 0, JSON.stringify(hidden))
  }
  check('hidden: a label carrying no identity stays (the Google sign-in)', line('gemini').text === 'Google account (OAuth)', JSON.stringify(line('gemini')))
  check('hidden: a local server keeps its server words', line('local').text === 'Ollama 0.11.4 (1)', JSON.stringify(line('local')))
  check('hidden: no family has an identity line', usage.providerFamilyPresences().every((presence: { id: string }) => line(presence.id).kind !== 'account'))
  const presences = usage.providerFamilyPresences() as Array<{ id: string; credentialed: boolean; identity?: string; credentialLabel?: string }>
  const hiddenWords = presences.map(presence => usage.presenceIdentityWords(presence) ?? '')
  check('hidden: the presence words of every family carry no address, username or tail', hiddenWords.every(text => leaks(text).length === 0), JSON.stringify(hiddenWords))
  check('hidden: the presence words name the Claude account by its word', usage.presenceIdentityWords(presences.find(presence => presence.id === 'anthropic')!) === 'Claude account')
  check('hidden: a presence with no identity keeps its label (the Kimi sign-in)', usage.presenceIdentityWords(presences.find(presence => presence.id === 'moonshot')!) === presences.find(presence => presence.id === 'moonshot')!.credentialLabel)
  check('the explicit flag answers the shown words whatever the setting (the board road)', usage.presenceIdentityWords(presences.find(presence => presence.id === 'openai')!, true) === OPENAI_EMAIL)
  const shown = typeof identityLine.shownIdentityWords === 'function' ? identityLine.shownIdentityWords : undefined
  check('the label owner exists', shown !== undefined)
  if (shown !== undefined) {
    check('hidden: a Hugging Face label carrying the username becomes the account word', shown('huggingface', `Hugging Face account (${HF_USERNAME})`) === 'Hugging Face account')
    check('hidden: a slot identity drops its key tail and keeps its words', shown('openrouter', 'OPENROUTER_API_KEY (env) …orr1') === 'OPENROUTER_API_KEY (env)')
    check('hidden: an address becomes the account word', shown('openai', OPENAI_EMAIL) === 'ChatGPT account')
    check('hidden: words carrying neither stay', shown('openai', 'ChatGPT plus subscription') === 'ChatGPT plus subscription')
    check('shown: the words pass through untouched', shown('huggingface', `Hugging Face account (${HF_USERNAME})`, true) === `Hugging Face account (${HF_USERNAME})`)
  }
  setIdentity('absent')
}

section('§3 the screens: /usage, the rail and the boot chip hide every identity; the Logins screen names the account; on or absent, today\'s bytes')
await paintSurfaces('absent')
const painted = new Map<Leg, Surfaces>()
for (const leg of ['absent', 'shown', 'hidden'] as Leg[]) painted.set(leg, await paintSurfaces(leg))
{
  const absent = painted.get('absent')!
  const shown = painted.get('shown')!
  const hidden = painted.get('hidden')!
  check('absent: /usage names the Claude sign-in under its title (the fixture is live)', lineUnder(absent.popup, 'Anthropic usage') === `Signed in as ${ANTHROPIC_EMAIL}`, lineUnder(absent.popup, 'Anthropic usage'))
  check('absent: /usage shows the Hugging Face username and a key tail somewhere (the check below has teeth)', absent.popup.join('\n').includes(HF_USERNAME) && TAILS.some(tail => absent.popup.join('\n').includes(tail)))
  check('absent: the rail names the Claude email', railCells(absent.rails.get('anthropic')!).includes(ANTHROPIC_EMAIL), JSON.stringify(railCells(absent.rails.get('anthropic')!).slice(0, 4)))
  check('absent: the boot chip names the Claude email', lineWith(absent.face, 'Acct').includes(`Acct ${ANTHROPIC_EMAIL}`), lineWith(absent.face, 'Acct'))
  check('true: every /usage frame is byte-identical to absent', JSON.stringify(shown.popup) === JSON.stringify(absent.popup), `${shown.popup.length} vs ${absent.popup.length} frames`)
  check('true: every rail frame is byte-identical to absent', RAIL_FAMILIES.every(family => shown.rails.get(family.id) === absent.rails.get(family.id)))
  check('true: the boot chip line is byte-identical to absent', lineWith(shown.face, 'Acct') === lineWith(absent.face, 'Acct'))
  check('true: the Logins frame is byte-identical to absent', shown.logins === absent.logins)
  check('hidden: /usage painted every family block', POPUP_TITLES.every(title => hidden.popup.some(frame => frame.includes(title))), POPUP_TITLES.filter(title => !hidden.popup.some(frame => frame.includes(title))).join(', '))
  check('hidden: no /usage frame carries an address, a username or a key tail', leaks(hidden.popup.join('\n')).length === 0, JSON.stringify(leaks(hidden.popup.join('\n'))))
  check('hidden: /usage puts the account word under the Anthropic title, no "Signed in as"', lineUnder(hidden.popup, 'Anthropic usage') === 'Claude account' && !hidden.popup.join('\n').includes('Signed in as'), lineUnder(hidden.popup, 'Anthropic usage'))
  check('hidden: /usage puts the door word under the Z.AI title', lineUnder(hidden.popup, 'Z.AI usage') === 'Coding Plan key', lineUnder(hidden.popup, 'Z.AI usage'))
  for (const family of RAIL_FAMILIES) {
    const frame = hidden.rails.get(family.id)!
    check(`hidden: the rail on ${family.id} carries no address, username or tail`, leaks(frame).length === 0, JSON.stringify(leaks(frame)))
  }
  check('hidden: the rail names the Claude account by its word', railCells(hidden.rails.get('anthropic')!).includes('Claude account'), JSON.stringify(railCells(hidden.rails.get('anthropic')!).slice(0, 4)))
  check('hidden: the boot chip names the Claude account by its word', lineWith(hidden.face, 'Acct').includes('Acct Claude account') && leaks(lineWith(hidden.face, 'Acct')).length === 0, lineWith(hidden.face, 'Acct'))
  check('hidden: the Logins screen still names the Claude account (the owner\'s exception)', lineWith(hidden.logins, ANTHROPIC_EMAIL) !== '', 'no Claude email on the Logins roster')
  check('hidden: the Logins frame is byte-identical to absent', hidden.logins === absent.logins)
}

section('§4 the roads that stay: the command line and the /accounts board')
{
  const RUNNER = join(HOME, 'auth-status-runner.ts')
  writeFileSync(RUNNER, [
    ";(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }",
    `const { enableConfigs } = await import(${JSON.stringify(join(ROOT, 'src/utils/config.ts'))})`,
    'enableConfigs()',
    `const { authStatus } = await import(${JSON.stringify(join(ROOT, 'src/cli/handlers/auth.ts'))})`,
    'await authStatus({ json: true })',
  ].join('\n') + '\n')
  const authStatus = (leg: Leg): string => {
    setIdentity(leg)
    const result = Bun.spawnSync([process.execPath, RUNNER], { cwd: HOME, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
    return result.stdout.toString()
  }
  const absentJson = authStatus('absent')
  const hiddenJson = authStatus('hidden')
  check('auth status --json names the Claude email with the setting absent (the verb is live)', absentJson.includes(ANTHROPIC_EMAIL), absentJson.slice(0, 200))
  check('auth status --json is byte-identical when hidden (the command line stays)', hiddenJson === absentJson && hiddenJson.length > 0)
  setIdentity('hidden')
  const emailRow = status.buildAccountProperties().find((property: { label?: string }) => property.label === 'Email')
  check('the auth status Email row still reads the account when hidden', emailRow !== undefined && status.propertyValueToText(emailRow.value) === ANTHROPIC_EMAIL, JSON.stringify(emailRow?.label))
  const board = (): string => slots.mainLoopIdentity({ model: 'gpt-5', presences: usage.providerFamilyPresences() }).text
  const hiddenBoard = board()
  setIdentity('absent')
  check('the /accounts main-loop row names the ChatGPT sign-in whatever the setting (the board names what ⌫ removes)', hiddenBoard === board() && hiddenBoard.includes(OPENAI_EMAIL), hiddenBoard)
}

section('§5 /config carries the one row in the view group: Account identity · shown / hidden')
{
  const source = readFileSync(join(ROOT, 'src/components/Settings/Config.tsx'), 'utf8')
  check("the row is id 'accountIdentity', labelled Account identity", source.includes("id: 'accountIdentity'") && source.includes("label: 'Account identity'"))
  check('its value reads shown unless the setting is false', source.includes("merged.view?.accountIdentity !== false ? 'shown' : 'hidden'"))
  check('←/→ writes false to the user settings and removes the key to show again', source.includes("writeSource('userSettings', { view: { accountIdentity: next ? undefined : false } })"))
  check('the mount snapshot and the esc revert carry the key', source.includes('accountIdentity: user.view?.accountIdentity') && source.includes('accountIdentity: snapshots.user.view?.accountIdentity'))
  check('the row sits after Ping, beside the other view.* rows', source.includes("id: 'ping'") && source.includes("id: 'accountIdentity'") && source.includes("id: 'motion'") && source.indexOf("id: 'accountIdentity'") > source.indexOf("id: 'ping'") && source.indexOf("id: 'accountIdentity'") < source.indexOf("id: 'motion'"))
  const still = readFileSync(join(ROOT, 'scripts/ui/fixtures/settings-popup-header/config-120x40.txt'), 'utf8')
  check('the stored /config still paints the row with its default word', /Account identity\s+shown/.test(still), still.split('\n').find(line => line.includes('Account identity')) ?? 'no row in the still')
}

section('§6 the other mints: the Saturn trail, the window refusal and the sign-in wall row drop the address when hidden')
{
  const saturn = await import(join(ROOT, 'src/components/BootSaturnScreen.tsx'))
  const stills = await import(join(ROOT, 'scripts/ui/saturn-screen-stills.ts'))
  const row = (stills.FIXTURE_FACTS.rows as Array<{ schedule: { account: { family: string; source: string; identity?: string } } }>).find(candidate => candidate.schedule.account.identity !== undefined)
  check('the Saturn fixture carries a schedule with a captured identity', row !== undefined)
  if (row !== undefined) {
    const { family, source, identity } = row.schedule.account
    const trail = (leg: Leg): string => {
      setIdentity(leg)
      return (saturn.saturnDetailLines(row, stills.FIXED_NOW, []) as string[]).join('\n')
    }
    check('shown: the Saturn trail names the captured account', trail('absent').split('\n').join(' ').includes(`account: ${family}/${source} · ${identity}`), trail('absent').split('\n').find(line => line.startsWith('account:')))
    const hiddenTrail = trail('hidden')
    check('hidden: the Saturn trail keeps the family and source and drops the address', hiddenTrail.split('\n').some(line => line === `account: ${family}/${source}`) && !hiddenTrail.includes(identity!), hiddenTrail.split('\n').find(line => line.startsWith('account:')))
  }
  const limits = await import(join(ROOT, 'src/services/anthropicLimits.ts'))
  const refusal = await import(join(ROOT, 'src/services/providers/anthropicRefusal.ts'))
  const OWNER = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000aa'
  limits.resetLimitsForCredentialSwitch()
  limits.__setAnthropicOwnerResolverForTest(() => OWNER, () => ANTHROPIC_EMAIL)
  const adopted = limits.adoptAnthropicWindowFact({ status: 'rejected', observedAtMs: NOW - 10_000, owner: OWNER, resetsAtMs: NOW + 5 * DAY, claim: 'seven_day' })
  check('a rejected weekly window is seated for the refusal', adopted === true)
  setIdentity('absent')
  const shownWords = refusal.standingAnthropicRefusal()?.words ?? ''
  setIdentity('hidden')
  const hiddenWords = refusal.standingAnthropicRefusal()?.words ?? ''
  check('shown: the window refusal names the account', shownWords.includes(`reached for ${ANTHROPIC_EMAIL}`), shownWords)
  check('hidden: the window refusal names the signed-in account, no address', hiddenWords.includes('reached for the signed-in account') && !hiddenWords.includes('@'), hiddenWords)
  limits.__setAnthropicOwnerResolverForTest(null)
  limits.resetLimitsForCredentialSwitch()
  const { APIError } = await import('@anthropic-ai/sdk')
  const errors = await import(join(ROOT, 'src/services/api/errors.ts'))
  const RECORD = 'record@example.com'
  config.saveGlobalConfig((current: Record<string, unknown>) => ({ ...current, oauthAccount: { accountUuid: 'uuid-record-fixture', emailAddress: RECORD, organizationUuid: 'org-record-fixture' } }))
  const wallRow = (leg: Leg): string => {
    setIdentity(leg)
    const error = new APIError(401, { type: 'error', error: { type: 'authentication_error', message: 'OAuth token has expired' } }, 'OAuth token has expired', new Headers())
    return JSON.stringify(errors.getAssistantMessageFromError(error, MODEL).message.content)
  }
  const shownRow = wallRow('absent')
  const hiddenRow = wallRow('hidden')
  check('shown: the sign-in wall row names the account', shownRow.includes(`account ${RECORD}`), shownRow.slice(0, 240))
  check('hidden: the sign-in wall row carries no address, the rest of its words kept', !hiddenRow.includes('@') && hiddenRow === shownRow.replace(` · account ${RECORD}`, ''), hiddenRow.slice(0, 240))
  config.saveGlobalConfig((current: Record<string, unknown>) => ({ ...current, oauthAccount: undefined }))
  setIdentity('absent')
}

section('§7 the model picker header and /router engines read the owners')
{
  const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
  const model = await import(join(ROOT, 'src/commands/model/mercuryModel.tsx'))
  const router = await import(join(ROOT, 'src/commands/router/router.tsx'))
  const picker = async (leg: Leg): Promise<string> => {
    setIdentity(leg)
    ledger.noteCredentialChange()
    const frame = (await paint(React.createElement(AppStateProvider, null, React.createElement(model.MercuryModelChoicePicker, { current: MODEL, onSelect: () => {}, onClose: () => {} })), COLS, ROWS))[0]!
    save(`${leg}-picker`, frame)
    return frame
  }
  const shownPicker = await picker('absent')
  const truePicker = await picker('shown')
  const hiddenPicker = await picker('hidden')
  const heading = (frame: string): string => frame.split('\n').find(line => /\bANTHROPIC\b/.test(line)) ?? ''
  check('absent: the picker header names the Claude sign-in beside its door (the check below has teeth)', heading(shownPicker).includes(ANTHROPIC_EMAIL), heading(shownPicker).trim())
  check('true: the picker frame is byte-identical to absent', truePicker === shownPicker)
  check('hidden: the picker header keeps the door and drops the account', heading(hiddenPicker) !== '' && !heading(hiddenPicker).includes('@') && heading(hiddenPicker).includes('login'), heading(hiddenPicker).trim())
  check('hidden: no line of the picker carries an address, a username or a key tail', leaks(hiddenPicker).length === 0, JSON.stringify(leaks(hiddenPicker)))
  const source = readFileSync(join(ROOT, 'src/commands/model/mercuryModel.tsx'), 'utf8')
  check('the picker composes the door account through the owner, no copy of its own', source.includes('const account = providerDoorAccount(slot, identity)') && !source.includes('function accountOfSlot('))
  const engines = async (leg: Leg): Promise<string> => {
    setIdentity(leg)
    let text = ''
    await router.call((value?: string) => { text = value ?? '' }, {} as never, 'engines')
    return text
  }
  const hfLine = (text: string): string => text.split('\n').find(line => line.startsWith('huggingface:')) ?? ''
  const shownEngines = await engines('absent')
  const hiddenEngines = await engines('hidden')
  check('absent: /router engines names the Hub account on the Hugging Face lane', hfLine(shownEngines).includes(`Hugging Face account (${HF_USERNAME})`), hfLine(shownEngines))
  check('hidden: the Hugging Face lane names the account by its word, no username', hfLine(hiddenEngines).includes('· Hugging Face account ·') && !hfLine(hiddenEngines).includes(HF_USERNAME), hfLine(hiddenEngines))
  check('hidden: every other lane reads as it did', shownEngines.split('\n').filter(line => !line.startsWith('huggingface:')).join('\n') === hiddenEngines.split('\n').filter(line => !line.startsWith('huggingface:')).join('\n'))
  setIdentity('absent')
}

section('§8 the fixture never left the loopback box')
{
  check('the Anthropic usage endpoint was read with the fixture bearer', requests.includes('GET /api/oauth/usage'), JSON.stringify(requests.slice(0, 12)))
  check('no request reached an OAuth profile endpoint while painting', !requests.some(path => path.includes('/api/oauth/profile')), JSON.stringify(requests))
  check('no fetch escaped the loopback box', escaped.length === 0, JSON.stringify(escaped))
}

server.stop(true)
globalThis.fetch = originalFetch
Date.now = originalNow
Date.prototype.toLocaleString = originalLocale
rmSync(HOME, { recursive: true, force: true })
console.log(`\naccount identity: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
