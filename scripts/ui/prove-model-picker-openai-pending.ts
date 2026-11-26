#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, painted, pinScratchHome, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('model-picker-openai-pending')
process.env.MERCURY_HOME = HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9/openai/v1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9/openai/chatgpt'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:9/openai/auth'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9/anthropic'
process.env.BROWSER = '/usr/bin/true'
for (const key of [
  'CI',
  'NODE_ENV',
  'MERCURY_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'META_API_KEY',
  'MODEL_API_KEY',
  'MISTRAL_API_KEY',
  'NOUS_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_CUSTOM_MODEL_OPTION',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
]) delete process.env[key]

const NOW = Date.now()
writeFileSync(
  join(HOME, '.credentials.json'),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-claude-access-0000000001',
      refreshToken: 'fixture-claude-refresh-00000001',
      expiresAt: NOW + 86_400_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    },
  }),
  { mode: 0o600 },
)

const writeOpenaiAuth = (accessTokenExpiresAtMs: number): void => {
  writeFileSync(
    join(HOME, '.openai-auth.json'),
    JSON.stringify({
      version: 1,
      preferredSource: 'chatgpt-subscription',
      tokens: {
        idToken: 'fixture-id-token',
        accessToken: 'fixture-openai-access-00000001',
        refreshToken: 'fixture-openai-refresh-0000001',
        accountId: 'acct_fixture_001',
        planType: 'pro',
        email: 'operator@example.test',
        accessTokenExpiresAtMs,
      },
    }),
    { mode: 0o600 },
  )
}
writeOpenaiAuth(NOW + 86_400_000)

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const React = (await import('react')).default
const { AppStoreContext, getDefaultAppState } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { createStore } = await import('../../src/platform/primitives/store.ts')
const { call } = await import('../../src/commands/model/mercuryModel.tsx')
const { FAMILY_GENERATIONS } = await import('../../src/models/facts/builtInModelTable.ts')
const { getPinnedModelIds } = await import('../../src/models/facts/pinnedModelIds.ts')
const { renderModelName } = await import('../../src/models/catalogue/engineModel.ts')
const openaiCatalogue = await import('../../src/models/roads/openai/openaiCatalogue.ts')
const { qualifyRequestedModel } = await import('../../src/models/roads/openai/call-model/qualify.ts')
const { resolveOpenaiRequestAuth } = await import('../../src/models/roads/openai/openaiAccounts.ts')
const { catalogueEpoch } = await import('../../src/models/roads/catalogueEpoch.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { FileStateCache } = await import('../../src/platform/files/fileStateCache.ts')
const { resetOverlayStackForTests } = await import('../../src/screen/overlays/overlayStack.ts')
type LocalJSXCommandContext = import('../../src/commands/catalogue/command.ts').LocalJSXCommandContext
type ModelFactsV1 = import('../../src/engine/connector/types.ts').ModelFactsV1
type ModelSwitchReceiptV1 = import('../../src/engine/connector/types.ts').ModelSwitchReceiptV1

const arg = (name: string): string | undefined => {
  const idx = process.argv.indexOf(name)
  return idx < 0 ? undefined : process.argv[idx + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
const saveFrame = (label: string, screen: string): void => {
  if (frameDir !== undefined) writeFileSync(join(frameDir, `${label}.txt`), `${screen}\n`)
}

const strings = getPinnedModelIds()
const SONNET = strings[FAMILY_GENERATIONS.sonnet[0]!]!
const OPUS = strings[FAMILY_GENERATIONS.opus[0]!]!

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

interface DeferredResponse {
  url: string
  resolve: (response: Response) => void
  settled: boolean
}

const deferreds = {
  anthropic: [] as DeferredResponse[],
  openaiToken: [] as DeferredResponse[],
  openaiModels: [] as DeferredResponse[],
}
const requestLog: string[] = []
const realFetch = globalThis.fetch

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const anthropicPage = {
  data: [
    { id: OPUS, display_name: renderModelName(OPUS), type: 'model' },
    { id: SONNET, display_name: renderModelName(SONNET), type: 'model' },
  ],
  has_more: false,
}

const openaiPage = {
  models: [
    {
      slug: 'gpt-6.2-sol',
      display_name: 'GPT-6.2 Sol',
      priority: 1,
      visibility: 'public',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
      default_reasoning_level: 'medium',
      context_window: 1_050_000,
    },
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6 Astra',
      priority: 2,
      visibility: 'public',
      supported_reasoning_levels: ['low', 'medium', 'high'],
      default_reasoning_level: 'medium',
      context_window: 1_050_000,
    },
    {
      slug: 'gpt-5.6-cyber',
      display_name: 'GPT-5.6 Cyber',
      priority: 3,
      visibility: 'hide',
      supported_reasoning_levels: ['medium', 'high'],
      default_reasoning_level: 'medium',
      context_window: 400_000,
    },
  ],
}

const encodeJwt = (payload: Record<string, unknown>): string =>
  `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

const refreshedTokenBody = {
  id_token: encodeJwt({
    email: 'operator@example.test',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_fixture_001', chatgpt_plan_type: 'pro' },
  }),
  access_token: encodeJwt({ exp: Math.floor((Date.now() + 86_400_000) / 1000) }),
  refresh_token: 'fixture-openai-refresh-0000001',
}

const holdRequest = (bucket: DeferredResponse[], url: string): Promise<Response> =>
  new Promise<Response>(resolve => {
    const entry: DeferredResponse = {
      url,
      settled: false,
      resolve: res => {
        if (entry.settled) return
        entry.settled = true
        resolve(res)
      },
    }
    bucket.push(entry)
  })

const fetchStub: typeof fetch = (input: string | URL | Request): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.includes('/anthropic/v1/models')) {
    requestLog.push('anthropic:models')
    return holdRequest(deferreds.anthropic, url)
  }
  if (url.includes('/openai/auth/oauth/token')) {
    requestLog.push('openai:token')
    return holdRequest(deferreds.openaiToken, url)
  }
  if (url.includes('/openai/chatgpt/models')) {
    requestLog.push('openai:models')
    return holdRequest(deferreds.openaiModels, url)
  }
  throw new Error(`unexpected fetch in fixture: ${url}`)
}
globalThis.fetch = fetchStub
class FixtureSeatConnector extends NoSessionConnector {
  readonly switches: string[] = []
  private readonly served: string
  constructor(served: string) {
    super()
    this.served = served
  }
  override sessionId(): string {
    return 'proof-openai-pending-session'
  }
  override modelFacts(): ModelFactsV1 {
    return {
      effective: this.served,
      main: this.served,
      setting: this.served,
      sessionPin: null,
      pendingSwitch: null,
      effectiveSource: 'live',
    }
  }
  override async setModel(model?: string | null): Promise<ModelSwitchReceiptV1> {
    this.switches.push(model ?? 'default')
    return { state: 'applied' }
  }
}

const makeContext = (store: ReturnType<typeof createStore<ReturnType<typeof getDefaultAppState>>>): LocalJSXCommandContext => ({
  options: {
    commands: [],
    verbose: false,
    engineModel: SONNET,
    tools: [],
    mcpClients: [],
    isNonInteractiveSession: false,
    agentDefinitions: { activeAgents: [] },
    theme: 'dark',
  },
  startTurn: async function* () {
    throw new Error('startTurn unused in picker proof')
  },
  abortController: new AbortController(),
  readFileState: new FileStateCache(16, 1024 * 1024),
  getAppState: () => store.getState(),
  setAppState: updater => store.setState(updater),
  messages: [],
  setMessages: () => {},
  onChangeAPIKey: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
})

async function mountRealPicker(served: string) {
  const connector = new FixtureSeatConnector(served)
  setFocusedSessionConnector(connector)
  const receipts: string[] = []
  const store = createStore<ReturnType<typeof getDefaultAppState>>({ ...getDefaultAppState(), engineModel: served }, () => {})
  const picker = await call(result => { receipts.push(result ?? '') }, makeContext(store), '')
  const node = React.createElement(
    AppStoreContext.Provider,
    { value: store },
    React.createElement(KeybindingSetup, null, picker),
  )
  const mounted = await mountOffscreen(node, 178, 51)
  await waitFor(() => mounted.screen().includes('Mercury · model') && mounted.screen().includes('↑↓ select'), 8000)
  await painted(120)
  const press = async (keys: string): Promise<void> => {
    mounted.push(keys)
    await painted(80)
  }
  const walkTo = async (needle: string, maxSteps = 45): Promise<boolean> => {
    for (let step = 0; step < maxSteps; step++) {
      if (mounted.lines().some(line => line.includes('❯ ') && line.includes(needle))) return true
      await press(KEY.down)
    }
    return false
  }
  const close = async (): Promise<void> => {
    mounted.unmount()
    resetOverlayStackForTests()
    await painted(40)
  }
  return { mounted, connector, receipts, press, walkTo, close }
}

const rowFor = (lines: string[], id: string): string =>
  lines.find(line => new RegExp(`\\s${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(line)) ?? ''
const headingFor = (lines: string[], name: string): string =>
  lines.find(line => line.includes(`${name} ·`) || line.trim().endsWith(name)) ?? ''
const footerLine = (lines: string[]): string =>
  lines.find(line => line.includes('↑↓ select')) ?? ''
const openaiRows = (lines: string[]): string[] =>
  lines.filter(line => /\sgpt-[0-9]/.test(line))
const hasUnavailable = (line: string): boolean => /\bunavailable\b/.test(line)

try {
  section('§1 Two-stage /model open: Anthropic catalogue lands first, OpenAI live catalogue lands second (held by deterministic gate)')
  {
    openaiCatalogue.__resetOpenaiCatalogueForTest()
    const epoch0 = catalogueEpoch()
    const logStart = requestLog.length
    const session = await mountRealPicker(SONNET)
    const { mounted, connector, receipts, press, walkTo, close } = session

    const anthropicReqArrived = await waitFor(() => deferreds.anthropic.length >= 1, 5000)
    const openaiReqArrived = await waitFor(() => deferreds.openaiModels.length >= 1, 5000)
    check('opening /model started both Anthropic and OpenAI catalogue requests (no duplicate fetch)', anthropicReqArrived && openaiReqArrived && requestLog.slice(logStart).filter(x => x === 'openai:models').length === 1 && requestLog.slice(logStart).filter(x => x === 'anthropic:models').length === 1, requestLog.slice(logStart).join(', '))

    const beforeLines = mounted.lines()
    saveFrame('s1-before', mounted.screen())
    const beforeOpenai = openaiRows(beforeLines)
    check('before either resolves: OpenAI shows connecting row and pending lineup rows without falsely labeling them unavailable', beforeLines.some(l => l.includes('GPT — connecting…')) && beforeOpenai.length > 0 && beforeOpenai.every(l => !hasUnavailable(l)), beforeOpenai.slice(0, 4).join(' | '))

    deferreds.anthropic.shift()!.resolve(jsonResponse(anthropicPage))
    const epoch1Reached = await waitFor(() => catalogueEpoch() > epoch0, 4000)
    await painted(120)
    const epoch1 = catalogueEpoch()
    const middleLines = mounted.lines()
    saveFrame('s1-between', mounted.screen())

    check('Fact 1 landed: Anthropic catalogue bumped epoch while OpenAI catalogue remained held in flight', epoch1Reached && epoch1 > epoch0 && deferreds.openaiModels.length === 1 && !deferreds.openaiModels[0]!.settled, `epoch ${epoch0} -> ${epoch1}`)
    const middleHeading = headingFor(middleLines, 'OPENAI')
    check('between facts: OPENAI heading reports pending status and never claims live count', middleHeading.includes('live catalogue not fetched yet') && !/\d+ live/.test(middleHeading), middleHeading)

    const middleOpenai = openaiRows(middleLines)
    const middleSol = rowFor(middleLines, 'gpt-6.2-sol')
    const middleAstra = rowFor(middleLines, 'gpt-6-astra')
    const middleOmitted = rowFor(middleLines, 'gpt-6.2-astra')
    const falseUnavailableCount = middleOpenai.filter(hasUnavailable).length
    check('between facts: ZERO pending OpenAI rows read unavailable (false-unavailable count 0)', middleOpenai.length > 0 && falseUnavailableCount === 0 && !hasUnavailable(middleSol) && !hasUnavailable(middleAstra), `falseUnavailable=${falseUnavailableCount}/${middleOpenai.length} · sol="${middleSol.trim()}" · astra="${middleAstra.trim()}"`)

    const reachedPending = await walkTo('gpt-6.2-sol')
    await painted(80)
    const focusedPendingLines = mounted.lines()
    saveFrame('s1-between-focused-pending', mounted.screen())
    const pendingFooter = footerLine(focusedPendingLines)
    check('between facts: focusing a pending OpenAI row neither promises ↵ switch nor calls it gated', reachedPending && !pendingFooter.includes('↵ switch') && !pendingFooter.includes('gated'), pendingFooter)
    check('between facts: pending row notice explains the catalogue is not fetched yet without claiming permanent refusal', focusedPendingLines.some(l => l.includes('gpt-6.2-sol · live catalogue not fetched yet')) && !focusedPendingLines.some(l => l.includes('— not selectable')), focusedPendingLines.filter(l => l.includes('gpt-6.2-sol') || l.includes('live catalogue')).join(' | '))

    await press(KEY.enter)
    await painted(120)
    check('between facts: pressing Enter on a pending OpenAI row does NOT grant access or switch model', connector.switches.length === 0 && receipts.length === 0 && mounted.screen().includes('Mercury · model'), `switches=${connector.switches.join(',')} receipts=${receipts.join(',')}`)

    const anthropicUnchanged = rowFor(focusedPendingLines, SONNET)
    check('between facts: Anthropic current row stays intact and unaffected', anthropicUnchanged.includes('current') && !hasUnavailable(anthropicUnchanged), anthropicUnchanged)

    deferreds.openaiModels.shift()!.resolve(jsonResponse(openaiPage))
    const epoch2Reached = await waitFor(() => catalogueEpoch() > epoch1, 4000)
    await painted(150)
    const epoch2 = catalogueEpoch()
    const afterLines = mounted.lines()
    saveFrame('s1-after', mounted.screen())

    check('Fact 2 landed: OpenAI catalogue bumped epoch once with zero extra fetches', epoch2Reached && epoch2 === epoch1 + 1 && requestLog.slice(logStart).filter(x => x === 'openai:models').length === 1, `epoch ${epoch1} -> ${epoch2} · requests=${requestLog.slice(logStart).join(',')}`)
    const afterHeading = headingFor(afterLines, 'OPENAI')
    check('after both facts: OPENAI heading names the ChatGPT login door and 2 live rows; connecting row is gone', afterHeading.includes('ChatGPT Pro login') && afterHeading.includes('2 live') && !afterLines.some(l => l.includes('GPT — connecting…')), afterHeading)

    const afterSol = rowFor(afterLines, 'gpt-6.2-sol')
    const afterAstra = rowFor(afterLines, 'gpt-6-astra')
    const afterOmitted = rowFor(afterLines, 'gpt-6.2-astra')
    const afterCyber = rowFor(afterLines, 'gpt-5.6-cyber')
    check('after both facts: confirmed usable rows (gpt-6.2-sol, gpt-6-astra) are usable with no unavailable word and stale pending notice cleared', afterSol !== '' && !hasUnavailable(afterSol) && afterAstra !== '' && !hasUnavailable(afterAstra) && !afterLines.some(l => l.includes('live catalogue not fetched yet')), `sol="${afterSol.trim()}" · astra="${afterAstra.trim()}"`)
    check('after both facts: confirmed denials (omitted gpt-6.2-astra, hidden gpt-5.6-cyber) STILL read unavailable', hasUnavailable(afterOmitted) && hasUnavailable(afterCyber) && middleOmitted !== '', `omitted="${afterOmitted.trim()}" · cyber="${afterCyber.trim()}"`)

    const reachedDenied = await walkTo('gpt-5.6-cyber')
    await painted(80)
    const deniedLines = mounted.lines()
    check('after both facts: confirmed denied row still shows gated footer, not-selectable notice, and refuses Enter', reachedDenied && footerLine(deniedLines).includes('gated') && deniedLines.some(l => l.includes('— not selectable')), footerLine(deniedLines))
    await press(KEY.enter)
    await painted(100)
    check('after both facts: pressing Enter on confirmed denied row switches nothing', connector.switches.length === 0 && receipts.length === 0, `switches=${connector.switches.join(',')}`)

    await press('\x1b[H')
    const reachedUsable = await walkTo('gpt-6.2-sol')
    await painted(80)
    check('after both facts: confirmed usable row offers ↵ switch in the footer', reachedUsable && footerLine(mounted.lines()).includes('↵ switch'), footerLine(mounted.lines()))
    await press(KEY.enter)
    await waitFor(() => connector.switches.length === 1 && receipts.length === 1, 3000)
    check('after both facts: choosing confirmed usable gpt-6.2-sol applies the switch cleanly', connector.switches.length === 1 && connector.switches[0] === 'gpt-6.2-sol' && receipts[0]?.includes('GPT-6.2 Sol') === true, `switches=${connector.switches.join(',')} receipt=${receipts[0] ?? ''}`)

    await close()
  }

  section('§2 Two-stage OpenAI subscription refresh: OAuth token refresh resolves first, /models resolves second')
  {
    openaiCatalogue.__resetOpenaiCatalogueForTest()
    writeOpenaiAuth(Date.now() - 60_000)
    const logStart = requestLog.length
    const session = await mountRealPicker(SONNET)
    const { mounted, connector, receipts, press, walkTo, close } = session

    const tokenArrived = await waitFor(() => deferreds.openaiToken.length >= 1, 5000)
    if (deferreds.anthropic.length > 0) deferreds.anthropic.shift()!.resolve(jsonResponse(anthropicPage))
    check('expired subscription token triggered OAuth refresh before /models', tokenArrived && deferreds.openaiModels.length === 0, requestLog.slice(logStart).join(', '))

    deferreds.openaiToken.shift()!.resolve(jsonResponse(refreshedTokenBody))
    const modelsArrived = await waitFor(() => deferreds.openaiModels.length >= 1, 5000)
    await painted(120)
    const midLines = mounted.lines()
    saveFrame('s2-after-token-before-models', mounted.screen())
    const midOpenai = openaiRows(midLines)
    check('after token refresh, while /models is still in flight: ZERO OpenAI rows read unavailable', modelsArrived && midOpenai.length > 0 && midOpenai.every(l => !hasUnavailable(l)), midOpenai.slice(0, 4).join(' | '))

    const reached = await walkTo('gpt-6-astra')
    await press(KEY.enter)
    await painted(100)
    check('after token refresh, before /models: Enter on pending row grants no access', reached && connector.switches.length === 0 && receipts.length === 0, `switches=${connector.switches.join(',')}`)

    const beforeSettleEpoch = catalogueEpoch()
    deferreds.openaiModels.shift()!.resolve(jsonResponse(openaiPage))
    await waitFor(() => catalogueEpoch() > beforeSettleEpoch, 4000)
    await painted(120)
    const settledLines = mounted.lines()
    saveFrame('s2-after-models', mounted.screen())
    check('after /models resolves: usable rows are usable and omitted rows read unavailable', !hasUnavailable(rowFor(settledLines, 'gpt-6-astra')) && hasUnavailable(rowFor(settledLines, 'gpt-6.2-astra')), `astra="${rowFor(settledLines, 'gpt-6-astra').trim()}" · omitted="${rowFor(settledLines, 'gpt-6.2-astra').trim()}"`)
    check('subscription refresh made exactly one token request and one models request', requestLog.slice(logStart).filter(x => x === 'openai:token').length === 1 && requestLog.slice(logStart).filter(x => x === 'openai:models').length === 1, requestLog.slice(logStart).join(', '))

    await close()
  }

  section('§3 Confirmed failure (HTTP 503) and traffic-off still show unavailable, and dispatch qualification is preserved')
  {
    openaiCatalogue.__resetOpenaiCatalogueForTest()
    writeOpenaiAuth(Date.now() + 86_400_000)
    const session = await mountRealPicker(SONNET)
    const { mounted, close } = session
    await waitFor(() => deferreds.openaiModels.length >= 1, 5000)
    if (deferreds.anthropic.length > 0) deferreds.anthropic.shift()!.resolve(jsonResponse(anthropicPage))
    const ep = catalogueEpoch()
    deferreds.openaiModels.shift()!.resolve(new Response('service unavailable', { status: 503 }))
    await waitFor(() => catalogueEpoch() > ep, 4000)
    await painted(120)
    const errLines = mounted.lines()
    saveFrame('s3-catalogue-error', mounted.screen())
    const errOpenai = openaiRows(errLines)
    check('confirmed catalogue HTTP 503: OpenAI rows read unavailable (not silenced)', errLines.some(l => l.includes('GPT — catalogue unreachable')) && errOpenai.length > 0 && errOpenai.every(hasUnavailable), errOpenai.slice(0, 3).join(' | '))
    await close()

    openaiCatalogue.__resetOpenaiCatalogueForTest()
    process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    const logBeforeOff = requestLog.length
    const offSession = await mountRealPicker(SONNET)
    await painted(120)
    const offLines = offSession.mounted.lines()
    const offOpenai = openaiRows(offLines)
    check('traffic-off: zero fetches and OpenAI rows read unavailable', requestLog.length === logBeforeOff && offLines.some(l => l.includes('GPT — catalogue off')) && offOpenai.length > 0 && offOpenai.every(hasUnavailable), offOpenai.slice(0, 3).join(' | '))
    await offSession.close()
    delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

    openaiCatalogue.__resetOpenaiCatalogueForTest()
    const auth = await resolveOpenaiRequestAuth({ sourceKind: 'chatgpt-subscription' })
    check('dispatch qualification control: auth resolves', auth !== undefined)
    if (auth !== undefined) {
      const controller = new AbortController()
      const qualifying = qualifyRequestedModel('gpt-6.2-sol', auth, controller.signal)
      await waitFor(() => deferreds.openaiModels.length >= 1, 4000)
      deferreds.openaiModels.shift()!.resolve(jsonResponse(openaiPage))
      const admitted = await qualifying
      const refused = await qualifyRequestedModel('gpt-5.4-pro', auth, controller.signal)
      check('dispatch qualification still admits listed gpt-6.2-sol and refuses unlisted gpt-5.4-pro', admitted.kind === 'ok' && refused.kind === 'refused', `admitted=${admitted.kind} refused=${refused.kind}`)
    }
  }
} finally {
  globalThis.fetch = realFetch
  releaseFocusedSessionConnector()
  await releaseScratchHome(HOME)
}

console.log(`\nprove-model-picker-openai-pending: ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
