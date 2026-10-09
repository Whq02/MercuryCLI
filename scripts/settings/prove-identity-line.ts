#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

const ROOT = join(import.meta.dir, '../..')
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const framesDir = argument('--frames')
if (framesDir) mkdirSync(framesDir, { recursive: true })

const SIZES = [{ columns: 178, rows: 51 }, { columns: 80, rows: 21 }] as const
const NOW = 1_800_000_000_000
const DAY = 86_400_000
const PROOF_KEY = 'proof-key-ci-gate-not-a-real-key'
const NO_ACCOUNT = 'no account'
const SIGNED_IN_AS = 'Signed in as'
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
const ENV_KEYS: Record<string, string> = {
  ANTHROPIC_API_KEY: PROOF_KEY,
  OPENAI_API_KEY: 'zz-fixture-openai-env-key-oai1',
  ZAI_API_KEY: 'zz-fixture-zai-env-key-zai1',
  OPENROUTER_API_KEY: 'zz-fixture-openrouter-env-key-orr1',
  GEMINI_API_KEY: 'zz-fixture-gemini-env-key-gem1',
  MOONSHOT_API_KEY: 'zz-fixture-moonshot-env-key-msk1',
  DEEPSEEK_API_KEY: 'zz-fixture-deepseek-env-key-dsk2',
  XAI_API_KEY: 'zz-fixture-xai-env-key-xai2',
  MODEL_API_KEY: 'zz-fixture-meta-env-key-mta2',
  MERCURY_COMPAT_API_KEY: 'zz-fixture-compat-env-key-cmp2',
  HF_TOKEN: 'zz-fixture-huggingface-env-token-hft1',
  MERCURY_LOCAL_API_KEY: 'zz-fixture-local-env-key-loc1',
}

type Leg = 'accounts' | 'keys' | 'nothing'
const LEGS: Leg[] = ['accounts', 'keys', 'nothing']

delete process.env.NODE_ENV
const SCRATCH_ROOT = process.env.MERCURY_CONFIG_DIR?.trim() || tmpdir()
mkdirSync(SCRATCH_ROOT, { recursive: true })
const HOME = mkdtempSync(join(SCRATCH_ROOT, 'identity-line-'))
for (const name of Object.keys(process.env)) {
  if (/^(MERCURY_|ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|XAI_|META_|MODEL_API_KEY$|HF_|HUGGINGFACE_|AWS_|AZURE_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
}
Object.assign(process.env, {
  HOME,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_AUTH_SCOPE_DIR: HOME,
  MERCURY_HOME: HOME,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_EVOLUTION_LEDGER: '0',
  MERCURY_HELM_CONSOLE: '0',
  MERCURY_LIVE_GLYPHS: '0',
  BROWSER: '/usr/bin/true',
  TZ: 'UTC',
  LANG: 'en_GB.UTF-8',
  LC_ALL: 'en_GB.UTF-8',
})
const FIXTURE_BASES = ['MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_XAI_API_BASE', 'MERCURY_XAI_MANAGEMENT_API_BASE', 'MERCURY_META_API_BASE', 'MERCURY_ZEN_API_BASE', 'MERCURY_ZEN_GO_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE']
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
const unserved: string[] = []
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
    if (request.method === 'GET' && path === '/api/whoami-v2' && ['Bearer fixture-hf-access-token-0001', `Bearer ${ENV_KEYS.HF_TOKEN}`].includes(bearer ?? '')) return Response.json({ ...huggingfaceWhoami, name: HF_USERNAME })
    if (request.method === 'GET' && path === '/models') return Response.json({ data: [], models: [] })
    if (request.method === 'GET' && path === '/key') return Response.json({ data: { usage: 2, limit: 20, limit_remaining: 18, is_free_tier: false } })
    if (request.method === 'GET' && path === '/user/balance') return Response.json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '18.00', granted_balance: '0.00', topped_up_balance: '18.00' }] })
    if (request.method === 'GET' && path === '/users/me/balance') return Response.json({ code: 0, data: { available_balance: 18, voucher_balance: 0, cash_balance: 18 } })
    if (request.method === 'GET' && path === '/api/monitor/usage/quota/limit') return Response.json({ success: true, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 25, unit: 3, number: 5, nextResetTime: NOW + 2 * 3_600_000 }] } })
    if (request.method === 'GET' && path === '/api/tags') return Response.json(ollamaTags)
    if (request.method === 'GET' && path === '/api/version') return Response.json({ version: '0.11.4' })
    if (request.method === 'GET' && path === '/api/ps') return Response.json({ models: [] })
    if (request.method === 'POST' && path === '/api/show') return Response.json({ capabilities: ['tools'], model_info: {} })
    unserved.push(`${request.method} ${path}`)
    return new Response(null, { status: 404 })
  },
})
const FIXTURE_ORIGIN = `http://127.0.0.1:${server.port}`
for (const name of FIXTURE_BASES) process.env[name] = FIXTURE_ORIGIN
process.env.ANTHROPIC_BASE_URL = FIXTURE_ORIGIN
process.env.MERCURY_MOONSHOT_CODING_BASE = FIXTURE_ORIGIN
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
const rejections: string[] = []
process.on('unhandledRejection', reason => {
  rejections.push(reason instanceof Error ? reason.message : String(reason))
})

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

const FILES = {
  credentials: join(HOME, '.credentials.json'),
  openai: join(HOME, '.openai-auth.json'),
  huggingface: join(HOME, '.huggingface-auth.json'),
  gemini: join(HOME, '.gemini-auth.json'),
  moonshot: join(HOME, '.moonshot-auth.json'),
  openrouter: join(HOME, '.openrouter-auth.json'),
  secrets: join(HOME, '.provider-secrets.json'),
}
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}
function writeStores(leg: Leg): void {
  for (const path of Object.values(FILES)) rmSync(path, { force: true })
  for (const name of Object.keys(ENV_KEYS)) delete process.env[name]
  delete process.env.MERCURY_COMPAT_BASE_URL
  process.env.MERCURY_LOCAL_PROBE_TARGETS = leg === 'nothing' ? 'none' : `ollama=${FIXTURE_ORIGIN}`
  if (leg === 'accounts') {
    writeJson(FILES.credentials, {
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
    writeJson(FILES.openai, { version: 1, tokens: { idToken: 'fixture.id.token', accessToken: 'fixture-chatgpt-access-token-0001', refreshToken: 'fixture-chatgpt-refresh-token-0001', accountId: 'acct-fixture-0001', planType: 'plus', email: OPENAI_EMAIL, accessTokenExpiresAtMs: NOW + 30 * DAY } })
    writeJson(FILES.huggingface, { version: 1, tokens: { accessToken: 'fixture-hf-access-token-0001', refreshToken: 'fixture-hf-refresh-token-0001', accessTokenExpiresAtMs: NOW + 30 * DAY }, identity: { username: HF_USERNAME, fullName: 'Fixture Owner', observedAtMs: NOW } })
    writeJson(FILES.gemini, { version: 1, client: { clientId: 'fixture-google-client' }, tokens: { accessToken: 'fixture-google-access-token-0001', refreshToken: 'fixture-google-refresh-token-0001', accessTokenExpiresAtMs: NOW + 30 * DAY } })
    writeJson(FILES.moonshot, { version: 1, tokens: { accessToken: KIMI_TOKEN, refreshToken: 'fixture-kimi-refresh-token-0001', accessTokenExpiresAtMs: NOW + 30 * DAY }, region: 'global' })
    writeJson(FILES.openrouter, { version: 1, minted: { key: STORED_KEYS.openrouterMinted, mintedAtMs: NOW } })
    writeJson(FILES.secrets, { version: 1, zaiApiKey: STORED_KEYS.zai, zaiKeyPlan: 'coding', deepseekApiKey: STORED_KEYS.deepseek, xaiApiKey: STORED_KEYS.xai, metaApiKey: STORED_KEYS.meta, compatApiKey: STORED_KEYS.compat })
    process.env.MERCURY_COMPAT_BASE_URL = FIXTURE_ORIGIN
  } else if (leg === 'keys') {
    writeJson(FILES.credentials, {})
    Object.assign(process.env, ENV_KEYS)
    process.env.MERCURY_COMPAT_BASE_URL = FIXTURE_ORIGIN
  } else {
    writeJson(FILES.credentials, {})
  }
}

writeStores('accounts')
const config = await import(join(ROOT, 'src/utils/config.ts'))
config.enableConfigs()
const auth = await import(join(ROOT, 'src/utils/auth.ts'))
const ledger = await import(join(ROOT, 'src/utils/accounts/signInLedger.ts'))
const wallet = await import(join(ROOT, 'src/services/wallet/wallet.ts'))
const limits = await import(join(ROOT, 'src/services/anthropicLimits.ts'))
const identityCache = await import(join(ROOT, 'src/utils/accounts/accountIdentity.ts'))
const registry = await import(join(ROOT, 'src/utils/router/modelRegistry.ts'))
const discovery = await import(join(ROOT, 'src/utils/router/providerDiscovery.ts'))
const localDiscovery = await import(join(ROOT, 'src/services/providers/local/localDiscovery.ts'))
const moonshotUsage = await import(join(ROOT, 'src/services/providers/moonshot/moonshotUsageState.ts'))
async function settleLeg(leg: Leg): Promise<void> {
  writeStores(leg)
  config.saveGlobalConfig(current => ({ ...current, hasCompletedOnboarding: true, oauthAccount: undefined }))
  auth.dropCredentialMemos()
  wallet.resetWalletEntriesMemo()
  identityCache.forgetScopeIdentity()
  limits.resetLimitsForCredentialSwitch()
  moonshotUsage.__resetMoonshotUsageForTest()
  localDiscovery.__resetLocalDiscoveryForTest()
  discovery.__resetProviderDiscoveryForTest()
  registry.resetRouterModelSnapshotMemo()
  ledger.noteCredentialChange()
  if (leg !== 'nothing') await localDiscovery.refreshLocalDiscovery({ force: true })
  discovery.__resetProviderDiscoveryForTest()
  registry.resetRouterModelSnapshotMemo()
  ledger.noteCredentialChange()
}
await settleLeg('accounts')
const { kimiRegionLabel } = await import(join(ROOT, 'src/services/providers/moonshot/moonshotAccounts.ts'))
const KIMI_LABEL = `Kimi account (device-code sign-in · ${kimiRegionLabel('global')})`

type Family = {
  id: string
  model: string
  popupTitle: string
  railTitle: Record<Leg, string>
  line: Record<Leg, string>
  account: Partial<Record<Leg, true>>
}
const FAMILIES: Family[] = [
  { id: 'anthropic', model: 'claude-fable-5-1', popupTitle: 'Anthropic usage', railTitle: { accounts: 'Anthropic usage', keys: 'API usage', nothing: 'Anthropic usage' }, line: { accounts: ANTHROPIC_EMAIL, keys: 'API key · …-key', nothing: NO_ACCOUNT }, account: { accounts: true } },
  { id: 'openai', model: 'gpt-5', popupTitle: 'OpenAI usage', railTitle: { accounts: 'OpenAI usage', keys: 'API usage', nothing: 'OpenAI usage' }, line: { accounts: OPENAI_EMAIL, keys: 'API key · …oai1', nothing: NO_ACCOUNT }, account: { accounts: true } },
  { id: 'zai', model: 'glm-4.6', popupTitle: 'Z.AI usage', railTitle: { accounts: 'GLM Coding Plan usage', keys: 'Z.AI usage', nothing: 'Z.AI usage' }, line: { accounts: 'Coding Plan key · …YtbT', keys: 'API key · …zai1', nothing: NO_ACCOUNT }, account: {} },
  { id: 'openrouter', model: 'openrouter/fixture/model', popupTitle: 'OpenRouter usage', railTitle: { accounts: 'API usage', keys: 'API usage', nothing: 'OpenRouter usage' }, line: { accounts: 'OAuth key · …orm1', keys: 'API key · …orr1', nothing: NO_ACCOUNT }, account: {} },
  { id: 'gemini', model: 'gemini-2.5-pro', popupTitle: 'Gemini usage', railTitle: { accounts: 'Gemini usage', keys: 'API usage', nothing: 'Gemini usage' }, line: { accounts: 'Google account (OAuth)', keys: 'API key · …gem1', nothing: NO_ACCOUNT }, account: {} },
  { id: 'moonshot', model: 'kimi-k2', popupTitle: 'Moonshot usage', railTitle: { accounts: 'Kimi usage', keys: 'API usage', nothing: 'Moonshot usage' }, line: { accounts: KIMI_LABEL, keys: 'API key · …msk1', nothing: NO_ACCOUNT }, account: {} },
  { id: 'deepseek', model: 'deepseek-chat', popupTitle: 'DeepSeek usage', railTitle: { accounts: 'API usage', keys: 'API usage', nothing: 'DeepSeek usage' }, line: { accounts: 'API key · …dsk1', keys: 'API key · …dsk2', nothing: NO_ACCOUNT }, account: {} },
  { id: 'xai', model: 'grok-4.7', popupTitle: 'xAI usage', railTitle: { accounts: 'API usage', keys: 'API usage', nothing: 'xAI usage' }, line: { accounts: 'API key · …xai1', keys: 'API key · …xai2', nothing: NO_ACCOUNT }, account: {} },
  { id: 'meta', model: 'muse-spark-1.3', popupTitle: 'Meta usage', railTitle: { accounts: 'API usage', keys: 'API usage', nothing: 'Meta usage' }, line: { accounts: 'API key · …mta1', keys: 'API key · …mta2', nothing: NO_ACCOUNT }, account: {} },
  { id: 'openai-compat', model: 'compat/fixture-model', popupTitle: 'Custom endpoint usage', railTitle: { accounts: 'API usage', keys: 'API usage', nothing: 'Endpoint usage' }, line: { accounts: 'API key · …cmp1', keys: 'API key · …cmp2', nothing: NO_ACCOUNT }, account: {} },
  { id: 'huggingface', model: 'huggingface/fixture/model', popupTitle: 'Hugging Face usage', railTitle: { accounts: 'Hugging Face usage', keys: 'API usage', nothing: 'Hugging Face usage' }, line: { accounts: HF_USERNAME, keys: 'token · …hft1', nothing: NO_ACCOUNT }, account: { accounts: true } },
  { id: 'local', model: 'local/fixture-model', popupTitle: 'Local models usage', railTitle: { accounts: 'Local usage', keys: 'Local usage', nothing: 'Local usage' }, line: { accounts: 'Ollama 0.11.4 (1)', keys: 'Ollama 0.11.4 (1) · key (env)', nothing: NO_ACCOUNT }, account: {} },
]
const popupLine = (family: Family, leg: Leg): string => (family.account[leg] ? `${SIGNED_IN_AS} ${family.line[leg]}` : family.line[leg])

await stub('src/keybindings/useKeybinding.ts', { useKeybinding: () => undefined, useKeybindings: () => undefined })
await stub('src/hooks/useExitOnCtrlCD.ts', { useExitOnCtrlCD: () => undefined })
await stub('src/context/notifications.tsx', { useNotifications: () => ({ addNotification() {}, removeNotification() {} }) })
await stub('src/utils/cockpit/healthCertSnapshot.ts', { healthCertSnapshot: () => ({ state: 'unavailable' }) })
let focusedModel = FAMILIES[0]!.model
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
  const frames = [plain(instance.lastFrame())]
  for (let step = 0; step < walk && !done(frames); step++) {
    emitter.emit('input', new InputEvent(interpretKey('\x1b[B')))
    await settle()
    await new Promise<void>(resolve => setTimeout(resolve, 60))
    await settle()
    const frame = plain(instance.lastFrame())
    if (frame === frames[frames.length - 1]) break
    frames.push(frame)
  }
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return frames
}
function save(name: string, frame: string): void {
  if (framesDir) writeFileSync(join(framesDir, `${name}.txt`), frame + '\n')
}
const inBounds = (frame: string, columns: number, rows: number): boolean =>
  frame.split('\n').length <= rows && frame.split('\n').every(line => stringWidth(line) <= columns)

const { HelmVitalsRail } = await import(join(ROOT, 'src/components/HelmVitalsRail.tsx'))
const { railPlanAt } = await import(join(ROOT, 'src/utils/helmGeometry.ts'))
const { railPanelInnerWidth } = await import(join(ROOT, 'src/components/mercury-ui/RailPanel.tsx'))
const { settingsPopupGeometry } = await import(join(ROOT, 'src/components/SettingsPopupSlot.tsx'))
const { usageBodyRows, usageColumns } = await import(join(ROOT, 'src/components/Settings/Usage.tsx'))
const popupStore = await import(join(ROOT, 'src/utils/cockpit/settingsPopup.ts'))
const usageCommand = await import(join(ROOT, 'src/commands/usage/usage.tsx'))

type Block = { title: string; under: string; frame: number }
function popupBlock(frames: string[], title: string, colW: number, capacity: number): Block | undefined {
  for (const [index, frame] of frames.entries()) {
    const lines = frame.split('\n')
    const at = lines.findIndex(line => line.includes(title))
    if (at < 0 || at + 1 >= Math.min(lines.length, capacity)) continue
    const start = lines[at]!.indexOf(title)
    const under = (lines[at + 1] ?? '').slice(start, start + colW).trimEnd()
    return { title: lines[at]!.slice(start, start + colW).trimEnd(), under, frame: index }
  }
  return undefined
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
function railBlock(frame: string, title: string, first: boolean): Block | undefined {
  const cells = railCells(frame)
  const at = first ? 0 : cells.findIndex(cell => cell === title)
  if (at < 0 || cells[at] === undefined) return undefined
  return { title: cells[at]!, under: cells[at + 1] ?? '', frame: 0 }
}

type Popup = { frames: string[]; colW: number; capacity: number }
async function paintPopup(size: { columns: number; rows: number }, leg: Leg): Promise<Popup> {
  await usageCommand.call('', {} as never)
  const request = popupStore.settingsPopupRequest()
  popupStore.closeSettingsPopup()
  const geometry = request === null ? null : settingsPopupGeometry(request, size.columns, size.rows)
  if (request === null || geometry === null) return { frames: ['no usage popup request'], colW: 0, capacity: 0 }
  const colW = usageColumns(geometry.inner, FAMILIES.length).colW
  const capacity = usageBodyRows(geometry.rowBudget).capacity
  const everyBlockSeen = (frames: string[]): boolean => FAMILIES.every(family => popupBlock(frames, family.popupTitle, colW, capacity) !== undefined)
  const frames = await paint(request.body({ width: geometry.width, inner: geometry.inner, rowBudget: geometry.rowBudget }) as React.ReactNode, size.columns, size.rows, size.columns >= 150 ? 120 : 400, everyBlockSeen)
  const saved = new Set<number>()
  for (const family of FAMILIES) {
    const block = popupBlock(frames, family.popupTitle, colW, capacity)
    if (block === undefined || saved.has(block.frame)) continue
    saved.add(block.frame)
    save(`popup-${leg}-${size.columns}x${size.rows}-${String(block.frame).padStart(3, '0')}`, frames[block.frame]!)
  }
  if (!saved.has(0)) save(`popup-${leg}-${size.columns}x${size.rows}-000`, frames[0]!)
  return { frames, colW, capacity }
}
async function paintRail(family: Family, leg: Leg): Promise<string> {
  focusedModel = family.model
  const plan = railPlanAt(178, true)
  const frame = (await paint(React.createElement(ink.Box, { flexDirection: 'row', justifyContent: 'flex-end', width: 178 }, React.createElement(HelmVitalsRail, { width: plan.vitalsW, availRows: 51 - 7 })), 178, 51))[0]!
  save(`rail-${leg}-${family.id}-178x51`, frame)
  return frame
}

const railBudget = railPanelInnerWidth(railPlanAt(178, true).vitalsW) - 2
for (const leg of LEGS) {
  if (leg !== 'accounts') await settleLeg(leg)
  section(`${leg}: the /usage popup prints an identity line under every family's title`)
  for (const size of SIZES) {
    const stamp = `${size.columns}x${size.rows}`
    const { frames, colW, capacity } = await paintPopup(size, leg)
    check(`${stamp} ${leg} popup: every frame stays inside the terminal`, frames.every(frame => inBounds(frame, size.columns, size.rows)))
    for (const family of FAMILIES) {
      const block = popupBlock(frames, family.popupTitle, colW, capacity)
      const want = popupLine(family, leg)
      if (block === undefined) {
        check(`${stamp} ${leg} popup ${family.id}: the block's title scrolled into view`, false, `${family.popupTitle} never painted in ${frames.length} frame(s)`)
        continue
      }
      const shown = stringWidth(want) > colW ? block.under.endsWith('…') && want.startsWith(block.under.slice(0, -1)) : block.under === want
      check(`${stamp} ${leg} popup ${family.id}: the row under "${block.title}" is ${JSON.stringify(want)}`, shown, `row under the title: ${JSON.stringify(block.under)}`)
    }
  }
  section(`${leg}: the rail's USAGE card prints an identity line under every family's block label`)
  const railFrames = new Map<string, string>()
  for (const family of FAMILIES) {
    const frame = await paintRail(family, leg)
    railFrames.set(family.id, frame)
    const block = railBlock(frame, family.railTitle[leg], true)
    const want = family.line[leg]
    check(`178x51 ${leg} rail ${family.id}: the focused block is labelled "${family.railTitle[leg]}"`, block?.title === family.railTitle[leg], JSON.stringify(block?.title))
    const fits = stringWidth(want) <= railBudget
    const shown = block !== undefined && (fits ? block.under === want : block.under.endsWith('…') && want.startsWith(block.under.slice(0, -1)) && stringWidth(block.under) <= railBudget)
    check(`178x51 ${leg} rail ${family.id}: the row under "${family.railTitle[leg]}" is ${JSON.stringify(want)}${fits ? '' : ' clipped with …'}`, shown, `row under the label: ${JSON.stringify(block?.under ?? '')}`)
    check(`178x51 ${leg} rail ${family.id}: the frame stays inside the terminal`, inBounds(frame, 178, 51))
  }
  if (leg === 'accounts') {
    const frame = railFrames.get('openai')!
    for (const other of ['anthropic', 'moonshot']) {
      const family = FAMILIES.find(candidate => candidate.id === other)!
      const block = railBlock(frame, family.railTitle.accounts, false)
      const want = family.line.accounts
      const fits = stringWidth(want) <= railBudget
      check(`178x51 accounts rail: the ${other} block beside the focused OpenAI block carries its line`, block !== undefined && (fits ? block.under === want : block.under.endsWith('…') && want.startsWith(block.under.slice(0, -1))), `block: ${JSON.stringify(block)}`)
    }
  }
  save(`rail-${leg}-80x21`, `no sidebar usage card at 80x21: the cockpit's vitals rail needs both rails engaged (railPlanAt vitals=${railPlanAt(80, true).vitals})`)
}

section('the fixture never left the loopback box')
{
  check('the Anthropic usage endpoint was read with the fixture bearer', requests.includes('GET /api/oauth/usage'), JSON.stringify(requests.slice(0, 12)))
  check('the Kimi usages endpoint was read with the fixture bearer', requests.includes('GET /usages'), JSON.stringify(requests.slice(0, 12)))
  check('the local server was discovered on the fixture', requests.includes('GET /api/tags'), JSON.stringify(requests.slice(0, 12)))
  check('no request reached an OAuth profile endpoint while painting', !requests.some(path => path.includes('/api/oauth/profile')), JSON.stringify(requests))
  check('the ChatGPT usage endpoint was read with the fixture bearer', requests.includes('GET /wham/usage'), JSON.stringify(requests))
  check('the Hugging Face account facts came from the fixture Hub', requests.includes('GET /api/whoami-v2'), JSON.stringify(requests))
  check('every loopback request has a fixture response', unserved.length === 0, JSON.stringify(unserved))
  check('no fetch escaped the loopback box', escaped.length === 0, JSON.stringify(escaped))
  if (rejections.length > 0) console.log(`[note] unhandled rejections while painting: ${JSON.stringify(rejections.slice(0, 4))}`)
}

section('one composer, one reader per family, both surfaces read it')
{
  const read = (relative: string): string => (existsSync(join(ROOT, relative)) ? readFileSync(join(ROOT, relative), 'utf8') : '')
  const composer = read('src/services/providers/providerIdentityLine.ts')
  check('the identity composer exists beside the usage owner', composer !== '', 'src/services/providers/providerIdentityLine.ts is absent')
  check('the composer reads the presence owner and the roster, never a second grammar of its own', composer.includes('deriveFamilySlotGroups(') && composer.includes('presenceIdentityWords(') && composer.includes(`'${NO_ACCOUNT}'`))
  check('the rail prints the composer\'s line under every block label', read('src/utils/cockpit/helmVitalsModel.ts').includes('providerIdentityLine('))
  check('the popup prints the composer\'s sentence under every section title', read('src/components/Settings/Usage.tsx').includes('providerIdentityLine('))
}

if (framesDir) {
  writeFileSync(join(framesDir, 'index.txt'), [
    'accounts-*: every family signed in — a Claude subscription with its profile email beside the token, a ChatGPT login with its email, a Hugging Face device-code sign-in with its username, a Google OAuth sign-in, a Kimi device-code sign-in (global), an OpenRouter OAuth-minted key, a stored GLM Coding Plan key, a stored DeepSeek key, a configured custom endpoint with a stored key, one discovered Ollama server',
    'keys-*: keys only — ANTHROPIC_API_KEY OPENAI_API_KEY ZAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY MOONSHOT_API_KEY DEEPSEEK_API_KEY MERCURY_COMPAT_API_KEY HF_TOKEN MERCURY_LOCAL_API_KEY (plus the discovered Ollama server the local key attaches to)',
    'nothing-*: no credential anywhere, no local server',
    'popup-<leg>-<columns>x<rows>-<NNN>: the /usage popup body at the store geometry, frame NNN of the ↓ walk (000 is the opening frame; later frames are the first in which a further family\'s block scrolled into view)',
    'rail-<leg>-<family>-178x51: the cockpit vitals rail (HelmVitalsRail) with the focused chat on that family\'s model; rail-<leg>-80x21 records that no rail exists at 80x21',
    `fixture usage endpoint: ${JSON.stringify(utilization)}`,
    `fixture Kimi usages: ${JSON.stringify(kimiUsages)}`,
  ].join('\n') + '\n')
}
server.stop(true)
globalThis.fetch = originalFetch
Date.now = originalNow
Date.prototype.toLocaleString = originalLocale
rmSync(HOME, { recursive: true, force: true })
console.log(`\nidentity line: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
