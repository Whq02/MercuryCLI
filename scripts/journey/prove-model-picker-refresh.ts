#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'model-refresh-pure-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
writeFileSync(join(process.env.MERCURY_CONFIG_DIR, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-claude-access', refreshToken: 'fixture-claude-refresh', expiresAt: Date.now() + 86_400_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }), { mode: 0o600 })
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.OPENAI_API_KEY = 'sk-fixture-catalogue-refresh'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9/v1'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.BROWSER = '/usr/bin/true'
for (const key of ['CI', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const React = await import('react')
const { render } = await import('../../src/ink.ts')
const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.tsx')
const { createStore } = await import('../../src/state/store.ts')
const { call } = await import('../../src/commands/model/mercuryModel.tsx')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const stripAnsi = (await import('strip-ansi')).default
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 150))
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const row = (id: string, display_name: string, priority: number) => ({ id, display_name, priority, visibility: 'public', supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', context_window: 400_000 })
const oldPage = { data: [row('gpt-5.6-sol', 'GPT-5.6 Sol', 1), row('gpt-5.6-terra', 'GPT-5.6 Terra', 2)] }
const newPage = { data: [row('gpt-6-astra', 'GPT-6 Astra', 1), row('gpt-5.6-sol', 'GPT-5.6 Sol', 2)] }
const response = (page: unknown): Response => new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } })
await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: (async () => response(oldPage)) as typeof fetch })
const primed = catalogue.getCachedOpenaiCatalogue('api-key')
check('the cache is primed within its freshness span', primed !== null && Date.now() - primed.fetchedAtMs < 1000)
let requests = 0
let answer: ((response: Response) => void) | undefined
const realFetch = globalThis.fetch
const fetchFixture = (async (url: string | URL | Request) => {
  if (!String(url).includes('/models')) throw new Error(`Unexpected request: ${url}`)
  requests++
  return new Promise<Response>(resolve => { answer = resolve })
}) as typeof fetch
globalThis.fetch = fetchFixture
const mount = async (model = 'gpt-5.6-sol') => {
  let output = ''
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40 })
  stdout.on('data', chunk => { output += String(chunk) })
  const input: string[] = []
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return input.shift() ?? null }, readableLength: 0, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } })
  const store = createStore({ ...getDefaultAppState(), mainLoopModel: model }, () => {})
  const picker = await call(() => {}, { messages: [] } as never, '')
  const instance = await render(React.createElement(AppStoreContext.Provider, { value: store }, picker), { stdout: stdout as never, stdin: stdin as never, patchConsole: false })
  await flush()
  return { seen: () => stripAnsi(output), clear: () => { output = '' }, unmount: () => instance.unmount(), rerender: () => store.setState(state => ({ ...state, effortValue: 'high' })), send: (keys: string) => { input.push(keys); stdin.emit('readable') } }
}

try {
  const first = await mount()
  check('the open paints the cached rows without waiting for the request', first.seen().includes('GPT-5.6 Terra') && first.seen().includes('GPT-5.6 Sol'))
  check('the open starts one background refresh despite the primed cache', requests === 1, `requests ${requests}`)
  first.rerender()
  await flush()
  check('a re-render does not start another refresh', requests === 1, `requests ${requests}`)
  const action = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  const duplicate = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  check('the action row shares the in-flight request', action === duplicate)
  await flush()
  check('open and action together make one request', requests === 1, `requests ${requests}`)
  first.clear()
  answer!(response(newPage))
  await action
  await flush()
  check('the changed rows replace the cached list', /GPT-6 Astra[^\n]*switch/.test(first.seen()) && !/GPT-5\.6 Terra[^\n]*switch/.test(first.seen()), first.seen())
  check('the highlight follows the same id when the row moves', first.seen().includes('gpt-5.6-sol · model IDs'))
  check('the changed list uses the existing notice', first.seen().includes('GPT — the live catalogue changed'))
  first.unmount()

  const second = await mount()
  check('a second open makes its own refresh within the span', requests === 2, `requests ${requests}`)
  const unchanged = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  await flush()
  const before = catalogueEpoch()
  second.clear()
  answer!(response(newPage))
  await unchanged
  await flush()
  check('an unchanged list does not bump the catalogue epoch', catalogueEpoch() === before, `${before} -> ${catalogueEpoch()}`)
  check('an unchanged list does not repaint or show a notice', second.seen() === '', second.seen())
  second.unmount()

  const third = await mount()
  const failed = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  await flush()
  answer!(new Response('fixture unavailable', { status: 503 }))
  await failed
  await flush()
  check('a failed background read retains the last usable rows', catalogue.getCachedOpenaiCatalogue('api-key')?.models.some(model => model.id === 'gpt-6-astra') === true)
  check('a failed read does not claim a changed list', !third.seen().includes('GPT — the live catalogue changed'))
  third.unmount()

  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const count = requests
  const dark = await mount()
  check('traffic-off makes no request and does not discard the cache', requests === count && catalogue.getCachedOpenaiCatalogue('api-key')?.models.some(model => model.id === 'gpt-6-astra') === true, `requests ${count} -> ${requests}`)
  dark.unmount()
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

  catalogue.__resetOpenaiCatalogueForTest()
  const beforeCold = requests
  const cold = await mount()
  check('a cold open starts only one request', requests === beforeCold + 1)
  const firstArrival = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  answer!(response(newPage))
  await firstArrival
  await flush()
  check('the first catalogue arrives without a changed-list notice', cold.seen().includes('GPT-6 Astra') && !cold.seen().includes('GPT — the live catalogue changed'))
  cold.unmount()

  const reordered = await mount()
  const reorder = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  await flush()
  const beforeOrder = catalogueEpoch()
  reordered.clear()
  answer!(response({ data: [...newPage.data].reverse() }))
  await reorder
  await flush()
  check('wire reordering with the same priorities is unchanged on screen', catalogueEpoch() === beforeOrder && reordered.seen() === '', `${beforeOrder} -> ${catalogueEpoch()}; output ${JSON.stringify(reordered.seen())}`)
  reordered.unmount()

  delete process.env.ANTHROPIC_API_KEY
  const { saveApiKey } = await import('../../src/utils/auth.ts')
  const { slotSeatView } = await import('../../src/services/providers/slotSwitch.ts')
  await saveApiKey('proof-managed-slot-key')
  const anthropic = await mount('claude-fable-5-1')
  const background = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  answer!(response(newPage))
  await background
  await flush()
  const seatBefore = slotSeatView('anthropic').active
  check('the fixture has an Anthropic pair and its row is focused', slotSeatView('anthropic').other !== undefined && anthropic.seen().includes('fable'))
  const beforeSlot = requests
  anthropic.send('s')
  await flush()
  check('the Anthropic slot key actually switches that family', slotSeatView('anthropic').active !== seatBefore)
  check('switching an Anthropic slot does not refresh OpenAI', requests === beforeSlot, `requests ${beforeSlot} -> ${requests}`)
  if (requests !== beforeSlot) {
    const extra = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
    answer!(response(newPage))
    await extra
  }
  anthropic.unmount()

  writeFileSync(join(process.env.MERCURY_CONFIG_DIR!, '.openai-auth.json'), JSON.stringify({ version: 1, preferredSource: 'api-key', tokens: { idToken: 'fixture-id', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus', email: 'sam@example.test', accessTokenExpiresAtMs: Date.now() + 86_400_000 } }), { mode: 0o600 })
  const openai = await mount()
  const initialSlot = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  answer!(response(newPage))
  await initialSlot
  await flush()
  const beforeOpenaiSlot = requests
  openai.clear()
  openai.send('s')
  await flush()
  check('switching to a cold OpenAI slot starts one request', slotSeatView('openai').active === 'subscription' && requests === beforeOpenaiSlot + 1)
  const newSlot = catalogue.refreshOpenaiCatalogue('chatgpt-subscription', { force: true })
  await flush()
  answer!(response(newPage))
  await newSlot
  await flush()
  openai.send('\x1b[B')
  await flush()
  check('a cold slot arrival stays silent about catalogue changes', !openai.seen().includes('GPT — the live catalogue changed'))
  openai.unmount()
} finally {
  globalThis.fetch = realFetch
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
