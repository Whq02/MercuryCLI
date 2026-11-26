#!/usr/bin/env bun
import figures from 'figures'
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
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9/openai/v1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9/openai/chatgpt'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9/anthropic'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.BROWSER = '/usr/bin/true'
for (const key of ['CI', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const React = await import('react')
const { render } = await import('../../src/screen/themedRenderer.ts')
const { AppStoreContext, getDefaultAppState } = await import('../../src/screen/app-state/AppState.tsx')
const { createStore } = await import('../../src/platform/primitives/store.ts')
const { call } = await import('../../src/commands/model/mercuryModel.tsx')
const catalogue = await import('../../src/models/roads/openai/openaiCatalogue.ts')
const { catalogueEpoch } = await import('../../src/models/roads/catalogueEpoch.ts')
const stripAnsi = (await import('strip-ansi')).default
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 150))
const settle = async (seen: () => string, ok: (frame: string) => boolean, ms = 3000): Promise<void> => {
  const until = Date.now() + ms
  while (!ok(seen()) && Date.now() < until) await flush()
}
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = '', fix = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && fix ? ` — to fix: ${fix}` : ''}`)
}
const row = (id: string, display_name: string, priority: number) => ({ id, display_name, priority, visibility: 'public', supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', context_window: 400_000 })
const oldPage = { data: [row('gpt-5.6-sol', 'GPT-5.6 Sol', 1), row('gpt-5.6-terra', 'GPT-5.6 Terra', 2)] }
const newPage = { data: [row('gpt-6-astra', 'GPT-6 Astra', 1), row('gpt-5.6-sol', 'GPT-5.6 Sol', 2)] }
const response = (page: unknown): Response => new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } })
await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: (async () => response(oldPage)) as typeof fetch })
const primed = catalogue.getCachedOpenaiCatalogue('api-key')
check('the cache is primed within its freshness span', primed !== null && Date.now() - primed.fetchedAtMs < 1000, '', 'refreshOpenaiCatalogue in src/models/roads/openai/openaiCatalogue.ts must store fetchedAtMs on a forced refresh')
let requests = 0
let answer: ((response: Response) => void) | undefined
const realFetch = globalThis.fetch
let doorRequests = 0
const ledger: string[] = []
const fetchFixture = (async (url: string | URL | Request, init?: RequestInit) => {
  const spelled = String(url instanceof Request ? url.url : url)
  const headers = new Headers(init?.headers as HeadersInit | undefined)
  if (spelled.includes('/anthropic/v1/models')) {
    doorRequests++
    ledger.push(headers.has('x-api-key') ? 'anthropic:api-key' : headers.has('anthropic-beta') ? 'anthropic:subscription' : 'anthropic:bearer')
    return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fixture: no list here' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  if (!(spelled.includes('/openai/') && spelled.includes('/models'))) throw new Error(`Unexpected request: ${spelled}`)
  ledger.push('gpt')
  requests++
  return new Promise<Response>(resolve => { answer = resolve })
}) as typeof fetch
globalThis.fetch = fetchFixture
const { anthropicDoors } = await import('../../src/models/roads/anthropic/anthropicCatalogue.ts')
const credentialedRoads = (): string[] => ['gpt', ...anthropicDoors().map(door => `anthropic:${door.door}`)]
const ledgerSince = (from: number): { words: string; oncePerRoad: boolean } => {
  const counts = new Map<string, number>()
  for (const road of ledger.slice(from)) counts.set(road, (counts.get(road) ?? 0) + 1)
  const roads = credentialedRoads()
  const words = [...counts.entries()].map(([road, n]) => `${road} ${n}`).join(' · ') || 'nothing'
  return { words, oncePerRoad: roads.every(road => counts.get(road) === 1) && [...counts.keys()].every(road => roads.includes(road)) }
}
const mount = async (model = 'gpt-5.6-sol') => {
  let output = ''
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40 })
  stdout.on('data', chunk => { output += String(chunk) })
  const input: string[] = []
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return input.shift() ?? null }, readableLength: 0, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } })
  const store = createStore({ ...getDefaultAppState(), engineModel: model }, () => {})
  const picker = await call(() => {}, { messages: [] } as never, '')
  const instance = await render(React.createElement(AppStoreContext.Provider, { value: store }, picker), { stdout: stdout as never, stdin: stdin as never, patchConsole: false })
  await flush()
  return { seen: () => stripAnsi(output), clear: () => { output = '' }, unmount: () => instance.unmount(), rerender: () => store.setState(state => ({ ...state, effortValue: 'high' })), send: (keys: string) => { input.push(keys); stdin.emit('readable') } }
}

try {
  const first = await mount()
  await settle(first.seen, frame => frame.includes('GPT-5.6 Terra') && frame.includes('GPT-5.6 Sol'))
  check('the open paints the cached rows without waiting for the request (the request is still held)', first.seen().includes('GPT-5.6 Terra') && first.seen().includes('GPT-5.6 Sol') && answer !== undefined, `requests ${requests}`, 'the picker in src/commands/model/picker/roads.ts must paint getCachedOpenaiCatalogue rows at once and start refreshOpenaiCatalogue in the background; answer stays undefined when no GPT request was started')
  check('the open starts one background refresh despite the primed cache', requests === 1, `requests ${requests}`, 'the open in src/commands/model/picker/roads.ts must start exactly one forced refreshOpenaiCatalogue even when the cache is fresh')
  check('each signed-in Anthropic door read its own list once on the same open, counted apart from the GPT refresh', doorRequests === anthropicDoors().length && doorRequests >= 1, `doors ${anthropicDoors().length} door requests ${doorRequests}`, 'each door from anthropicDoors in src/models/roads/anthropic/anthropicCatalogue.ts must be listed once per open')
  const firstOpen = ledgerSince(0)
  check('one open makes exactly one list request per credentialed road, the ledger naming each road once (three roads, three requests, never one road three times)', firstOpen.oncePerRoad && ledger.length === credentialedRoads().length, `ledger: ${firstOpen.words} · roads: ${credentialedRoads().join(', ')}`, 'the open must request each credentialed road once; see the picker refresh in src/commands/model/picker/roads.ts and anthropicDoors in src/models/roads/anthropic/anthropicCatalogue.ts')
  first.rerender()
  await flush()
  check('a re-render does not start another refresh', requests === 1, `requests ${requests}`, 'the refresh in src/commands/model/picker/roads.ts must run once per open, not on every render')
  check('a re-render adds nothing to the ledger of any road', ledger.length === credentialedRoads().length, `ledger: ${ledgerSince(0).words}`, 'a re-render must not trigger any list request; check the refresh effect in src/commands/model/picker/roads.ts')
  const action = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  const duplicate = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  check('the action row shares the in-flight request', action === duplicate, '', 'refreshOpenaiCatalogue in src/models/roads/openai/openaiCatalogue.ts must return the same in-flight promise for a second forced call')
  await flush()
  check('open and action together make one request', requests === 1, `requests ${requests}`, 'refreshOpenaiCatalogue in src/models/roads/openai/openaiCatalogue.ts must join a request already in flight')
  first.clear()
  answer!(response(newPage))
  await action
  await flush()
  check('the changed rows replace the cached list', /GPT-6 Astra\s{2,}gpt-6-astra\s{2,}\d/.test(first.seen()) && !/GPT-5\.6 Terra\s{2,}gpt-5\.6-terra\s{2,}\d/.test(first.seen()), first.seen(), 'the picker in src/commands/model/picker/roads.ts must repaint from the new catalogue after refreshOpenaiCatalogue bumps the epoch')
  check('the highlight follows the same id when the row moves', new RegExp(`│\\s+${figures.pointer} GPT-5\\.6 Sol\\s{2,}gpt-5\\.6-sol\\s{2,}current`).test(first.seen()), first.seen().split('\n').filter(l => l.includes(`${figures.pointer} `)).join(' | '), 'the focused row in src/commands/model/picker/roads.ts must follow the model id, not its index, when rows move')
  check('the changed list uses the existing notice', first.seen().includes('GPT — the live list changed'), '', 'the notice is set in src/commands/model/picker/roads.ts when the live list changes')
  first.unmount()

  const beforeSecond = ledger.length
  const second = await mount()
  check('a second open makes its own refresh within the span', requests === 2, `requests ${requests}`, 'each open in src/commands/model/picker/roads.ts must start its own forced refresh')
  const secondOpen = ledgerSince(beforeSecond)
  check('a second open adds exactly one request per credentialed road, none twice', secondOpen.oncePerRoad && ledger.length - beforeSecond === credentialedRoads().length, `ledger since the first open: ${secondOpen.words}`, 'a second open must request each credentialed road once; see src/commands/model/picker/roads.ts')
  const unchanged = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  await flush()
  const before = catalogueEpoch()
  second.clear()
  answer!(response(newPage))
  await unchanged
  await flush()
  check('an unchanged list does not bump the catalogue epoch', catalogueEpoch() === before, `${before} -> ${catalogueEpoch()}`, 'refreshOpenaiCatalogue in src/models/roads/openai/openaiCatalogue.ts must call bumpCatalogueEpoch only when the rows changed')
  check('an unchanged list does not repaint or show a notice', second.seen() === '', second.seen(), 'the picker in src/commands/model/picker/roads.ts must repaint and set the notice only when the rows changed')
  second.unmount()

  const third = await mount()
  const failed = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  await flush()
  answer!(new Response('fixture unavailable', { status: 503 }))
  await failed
  await flush()
  check('a failed background read retains the last usable rows', catalogue.getCachedOpenaiCatalogue('api-key')?.models.some(model => model.id === 'gpt-6-astra') === true, '', 'refreshOpenaiCatalogue in src/models/roads/openai/openaiCatalogue.ts must keep the cached rows when the request fails')
  check('a failed read does not claim a changed list', !third.seen().includes('GPT — the live list changed'), '', 'the notice in src/commands/model/picker/roads.ts must not be set when the refresh failed')
  third.unmount()

  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const count = requests
  const dark = await mount()
  check('traffic-off makes no request and does not discard the cache', requests === count && catalogue.getCachedOpenaiCatalogue('api-key')?.models.some(model => model.id === 'gpt-6-astra') === true, `requests ${count} -> ${requests}`, 'with MERCURY_DISABLE_NONESSENTIAL_TRAFFIC set the open must send no list request; see src/commands/model/picker/roads.ts and src/models/roads/openai/openaiCatalogue.ts')
  dark.unmount()
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

  catalogue.__resetOpenaiCatalogueForTest()
  const beforeCold = requests
  const cold = await mount()
  check('a cold open starts only one request', requests === beforeCold + 1, '', 'the open in src/commands/model/picker/roads.ts must start one refreshOpenaiCatalogue when the cache is empty')
  const firstArrival = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  answer!(response(newPage))
  await firstArrival
  await flush()
  check('the first catalogue arrives without a changed-list notice', cold.seen().includes('GPT-6 Astra') && !cold.seen().includes('GPT — the live list changed'), '', 'the first catalogue must paint its rows without the changed-list notice; see src/commands/model/picker/roads.ts')
  cold.unmount()

  const reordered = await mount()
  const reorder = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  await flush()
  const beforeOrder = catalogueEpoch()
  reordered.clear()
  answer!(response({ data: [...newPage.data].reverse() }))
  await reorder
  await flush()
  check('wire reordering with the same priorities is unchanged on screen', catalogueEpoch() === beforeOrder && reordered.seen() === '', `${beforeOrder} -> ${catalogueEpoch()}; output ${JSON.stringify(reordered.seen())}`, 'the change check in src/models/roads/openai/openaiCatalogue.ts must compare rows by priority, not by wire order')
  reordered.unmount()

  delete process.env.ANTHROPIC_API_KEY
  const { saveApiKey } = await import('../../src/models/sign-in/credentials/auth.ts')
  const { slotSeatView, switchActiveSlot } = await import('../../src/models/roads/slotSwitch.ts')
  await saveApiKey('proof-managed-slot-key')
  const anthropic = await mount('claude-fable-5-1')
  const background = catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  answer!(response(newPage))
  await background
  await flush()
  const seatBefore = slotSeatView('anthropic').active
  check('the fixture has an Anthropic pair and its row is focused', slotSeatView('anthropic').other !== undefined && anthropic.seen().includes('fable'), '', 'saveApiKey in src/models/sign-in/credentials/auth.ts must give Anthropic a second slot, and the picker must open on the claude-fable-5-1 row')
  const beforeSlot = requests
  switchActiveSlot('anthropic')
  await flush()
  check('the Anthropic slot flip through the one owner switches that family while the picker stands (the bare s went with the typed-letter ruling)', slotSeatView('anthropic').active !== seatBefore, '', 'switchActiveSlot in src/models/roads/slotSwitch.ts must flip the active Anthropic slot')
  check('switching an Anthropic slot does not refresh OpenAI', requests === beforeSlot, `requests ${beforeSlot} -> ${requests}`, 'switchActiveSlot in src/models/roads/slotSwitch.ts and the picker in src/commands/model/picker/roads.ts must not refresh the OpenAI list on an Anthropic flip')
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
  openai.unmount()
  switchActiveSlot('openai')
  const coldSlot = await mount()
  coldSlot.clear()
  await flush()
  check('the next open on a cold OpenAI slot starts one request (the slot flips on the Logins screen; the picker has no slot key)', slotSeatView('openai').active === 'subscription' && requests === beforeOpenaiSlot + 1, `active ${slotSeatView('openai').active} · requests ${beforeOpenaiSlot} -> ${requests}`, 'switchActiveSlot in src/models/roads/slotSwitch.ts must make subscription active, and the next open in src/commands/model/picker/roads.ts must start one request')
  const newSlot = catalogue.refreshOpenaiCatalogue('chatgpt-subscription', { force: true })
  await flush()
  answer!(response(newPage))
  await newSlot
  await flush()
  coldSlot.send('\x1b[B')
  await flush()
  check('a cold slot arrival stays silent about catalogue changes', !coldSlot.seen().includes('GPT — the live list changed'), '', 'the notice in src/commands/model/picker/roads.ts must not be set for the first catalogue of a slot')
  coldSlot.unmount()
} finally {
  globalThis.fetch = realFetch
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
