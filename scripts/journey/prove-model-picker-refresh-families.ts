#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'model-refresh-families-pure-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
writeFileSync(join(process.env.MERCURY_CONFIG_DIR, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-claude-access', refreshToken: 'fixture-claude-refresh', expiresAt: Date.now() + 86_400_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }), { mode: 0o600 })
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9/anthropic'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9/v1'
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:9/or/v1'
process.env.MERCURY_GEMINI_API_BASE = 'http://127.0.0.1:9/gemini/v1beta'
process.env.MERCURY_GEMINI_OAUTH_AUTH_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_HUGGINGFACE_API_BASE = 'http://127.0.0.1:9/hf/v1'
process.env.MERCURY_HUGGINGFACE_HUB_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'ollama=http://127.0.0.1:9/ollama'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.BROWSER = '/usr/bin/true'
const KEYS = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN'] as const
for (const key of ['CI', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', ...KEYS]) delete process.env[key]
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const React = await import('react')
const { render } = await import('../../src/ink.ts')
const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.tsx')
const { createStore } = await import('../../src/state/store.ts')
const { call } = await import('../../src/commands/model/mercuryModel.tsx')
const openrouter = await import('../../src/services/providers/openrouter/openrouterCatalogue.ts')
const gemini = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const huggingface = await import('../../src/services/providers/huggingface/huggingfaceCatalogue.ts')
const local = await import('../../src/services/providers/local/localDiscovery.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { getModelOptions, isProviderActionRow } = await import('../../src/utils/model/modelOptions.ts')
const stripAnsi = (await import('strip-ansi')).default
const flush = (ms = 150): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (seen: () => string, ok: (frame: string) => boolean, ms = 3000): Promise<void> => {
  const until = Date.now() + ms
  while (!ok(seen()) && Date.now() < until) await flush(50)
}
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type FamilyName = 'openrouter' | 'gemini' | 'huggingface' | 'local'
type Family = {
  name: FamilyName
  word: string
  group: string
  model: string
  keys: Record<string, string>
  listPath: string
  page: (rows: unknown[]) => unknown
  oldRows: unknown[]
  newRows: unknown[]
  oldName: string
  newName: string
  keepName: string
  refresh: (force: boolean) => Promise<unknown>
  cached: () => { models?: unknown[]; servers?: unknown[] } | null
  reset: () => void
  ids: (snapshot: unknown) => string[]
}

const orRow = (id: string, name: string) => ({ id, name, context_length: 131_072, created: 1_755_800_000 })
const gemRow = (id: string, displayName: string) => ({ name: `models/${id}`, displayName, supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1_048_576, outputTokenLimit: 8192 })
const hfRow = (id: string) => ({ id, object: 'model', created: 1_755_800_000, owned_by: 'fixture-org', providers: [{ provider: 'novita', status: 'live', context_length: 131_072, supports_tools: true }] })
const tagRow = (id: string) => ({ name: id, model: id, details: { family: 'llama', parameter_size: '8B', quantization_level: 'Q4_K_M' } })
const showBody = { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 131_072 }, parameters: 'num_ctx 131072' }

const FAMILIES: Family[] = [
  {
    name: 'openrouter',
    word: 'OpenRouter',
    group: openrouter.OPENROUTER_MODEL_GROUP,
    model: 'openrouter/fixture-vendor/refresh-alpha',
    keys: { OPENROUTER_API_KEY: 'sk-or-v1-fixture-refresh-000001' },
    listPath: '/or/v1/models',
    page: rows => ({ data: rows, total_count: rows.length, links: { next: null } }),
    oldRows: [orRow('fixture-vendor/refresh-alpha', 'Refresh Alpha'), orRow('fixture-vendor/refresh-beta', 'Refresh Beta')],
    newRows: [orRow('fixture-vendor/refresh-gamma', 'Refresh Gamma'), orRow('fixture-vendor/refresh-alpha', 'Refresh Alpha')],
    oldName: 'Refresh Beta',
    newName: 'Refresh Gamma',
    keepName: 'Refresh Alpha',
    refresh: force => openrouter.refreshOpenrouterCatalogue('env', { force }),
    cached: () => openrouter.getCachedOpenrouterCatalogue('env'),
    reset: () => openrouter.__resetOpenrouterCatalogueForTest(),
    ids: snapshot => ((snapshot as { models: { id: string }[] } | null)?.models ?? []).map(m => m.id),
  },
  {
    name: 'gemini',
    word: 'Gemini',
    group: gemini.GEMINI_MODEL_GROUP,
    model: 'gemini-refresh-alpha',
    keys: { GEMINI_API_KEY: 'AIza-fixture-refresh-0000000000000' },
    listPath: '/gemini/v1beta/models',
    page: rows => ({ models: rows }),
    oldRows: [gemRow('gemini-refresh-alpha', 'Gemini Refresh Alpha'), gemRow('gemini-refresh-beta', 'Gemini Refresh Beta')],
    newRows: [gemRow('gemini-refresh-gamma', 'Gemini Refresh Gamma'), gemRow('gemini-refresh-alpha', 'Gemini Refresh Alpha')],
    oldName: 'Gemini Refresh Beta',
    newName: 'Gemini Refresh Gamma',
    keepName: 'Gemini Refresh Alpha',
    refresh: force => gemini.refreshGeminiCatalogue('api-key', { force }),
    cached: () => gemini.getCachedGeminiCatalogue('api-key'),
    reset: () => gemini.__resetGeminiCatalogueForTest(),
    ids: snapshot => ((snapshot as { models: { id: string }[] } | null)?.models ?? []).map(m => m.id),
  },
  {
    name: 'huggingface',
    word: 'Hugging Face',
    group: huggingface.HUGGINGFACE_MODEL_GROUP,
    model: 'huggingface/fixture-org/refresh-alpha',
    keys: { HF_TOKEN: 'hf_fixture_refresh_token_000001' },
    listPath: '/hf/v1/models',
    page: rows => ({ object: 'list', data: rows }),
    oldRows: [hfRow('fixture-org/refresh-alpha'), hfRow('fixture-org/refresh-beta')],
    newRows: [hfRow('fixture-org/refresh-gamma'), hfRow('fixture-org/refresh-alpha')],
    oldName: 'refresh-beta',
    newName: 'refresh-gamma',
    keepName: 'refresh-alpha',
    refresh: force => huggingface.refreshHuggingfaceCatalogue({ force }),
    cached: () => huggingface.getCachedHuggingfaceCatalogue(),
    reset: () => huggingface.__resetHuggingfaceCatalogueForTest(),
    ids: snapshot => ((snapshot as { models: { id: string }[] } | null)?.models ?? []).map(m => m.id),
  },
  {
    name: 'local',
    word: 'Local',
    group: 'Mercury — local models',
    model: 'local/refresh-alpha',
    keys: {},
    listPath: '/ollama/api/tags',
    page: rows => ({ models: rows }),
    oldRows: [tagRow('refresh-alpha'), tagRow('refresh-beta')],
    newRows: [tagRow('refresh-gamma'), tagRow('refresh-alpha')],
    oldName: 'refresh-beta',
    newName: 'refresh-gamma',
    keepName: 'refresh-alpha',
    refresh: force => local.refreshLocalDiscovery({ force }),
    cached: () => local.getCachedLocalDiscovery(),
    reset: () => local.__resetLocalDiscoveryForTest(),
    ids: snapshot => ((snapshot as { servers: { models: { id: string }[] }[] } | null)?.servers ?? []).flatMap(s => s.models.map(m => m.id)),
  },
]

const requests: Record<FamilyName, number> = { openrouter: 0, gemini: 0, huggingface: 0, local: 0 }
let held: { family: FamilyName; answer: (response: Response) => void } | undefined
let immediate: { family: FamilyName; rows: unknown[] } | undefined
const realFetch = globalThis.fetch
const familyOfUrl = (url: string): FamilyName | undefined => {
  if (url.includes('/or/v1/')) return 'openrouter'
  if (url.includes('/gemini/v1beta/')) return 'gemini'
  if (url.includes('/hf/v1/')) return 'huggingface'
  if (url.includes('/ollama/')) return 'local'
  return undefined
}
const fetchFixture = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.includes('/anthropic/v1/models')) return json({ type: 'error', error: { type: 'not_found_error', message: 'fixture: no list here' } }, 404)
  const family = familyOfUrl(url)
  if (family === undefined) throw new Error(`Unexpected request: ${url}`)
  const spec = FAMILIES.find(f => f.name === family)!
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  if (family === 'local' && path !== '/ollama/api/tags') {
    if (path === '/ollama/api/version') return json({ version: '0.11.4' })
    if (path === '/ollama/api/ps') return json({ models: [] })
    if (path === '/ollama/api/show') return json(showBody)
    return json({}, 404)
  }
  if (path !== spec.listPath) return json({}, 404)
  requests[family]++
  if (immediate && immediate.family === family) return json(spec.page(immediate.rows))
  return new Promise<Response>(resolve => {
    held = { family, answer: resolve }
  })
}) as typeof fetch
globalThis.fetch = fetchFixture
const release = (spec: Family, rows: unknown[] | Response): void => {
  const waiting = held
  held = undefined
  if (!waiting || waiting.family !== spec.name) throw new Error(`nothing held for ${spec.name}`)
  waiting.answer(rows instanceof Response ? rows : json(spec.page(rows)))
}
const totalRequests = (): number => Object.values(requests).reduce((a, b) => a + b, 0)

const mount = async (model: string) => {
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
const live = (frame: string, name: string): boolean => new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*(switch|current)`).test(frame)
const setKeys = (spec: Family): void => {
  for (const key of KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(spec.keys)) process.env[key] = value
  process.env.MERCURY_LOCAL_PROBE_TARGETS = spec.name === 'local' ? 'ollama=http://127.0.0.1:9/ollama' : 'none'
}
const resetAll = (): void => {
  for (const spec of FAMILIES) spec.reset()
}

try {
  for (const spec of FAMILIES) {
    console.log(`\n── ${spec.word} ──`)
    setKeys(spec)
    resetAll()
    const others = FAMILIES.filter(f => f.name !== spec.name).map(f => f.name)
    const othersBefore = others.map(f => requests[f])
    const notice = `${spec.word} — the live list changed; rows updated`
    immediate = { family: spec.name, rows: spec.oldRows }
    await spec.refresh(true)
    immediate = undefined
    const primed = spec.cached()
    check(`${spec.word}: the cache is primed with the old list`, primed !== null && spec.ids(primed).length === 2, JSON.stringify(spec.ids(primed)))
    const base = requests[spec.name]

    const first = await mount(spec.model)
    await settle(first.seen, frame => live(frame, spec.oldName) && live(frame, spec.keepName))
    check(`${spec.word}: the open paints the cached rows without waiting for the request (the request stays held while they paint)`, live(first.seen(), spec.oldName) && live(first.seen(), spec.keepName) && held?.family === spec.name, first.seen().split('\n').filter(l => l.includes('refresh') || l.includes('Refresh')).join(' | ') || `held ${held?.family ?? 'nothing'}; frame ${first.seen().length} chars`)
    check(`${spec.word}: the open starts one background refresh despite the primed cache`, requests[spec.name] === base + 1, `requests ${requests[spec.name] - base}`)
    first.rerender()
    await flush()
    check(`${spec.word}: a re-render does not start another refresh`, requests[spec.name] === base + 1, `requests ${requests[spec.name] - base}`)
    const action = spec.refresh(true)
    const duplicate = spec.refresh(true)
    check(`${spec.word}: the action row shares the in-flight request`, action === duplicate)
    await flush()
    check(`${spec.word}: open and action together make one request`, requests[spec.name] === base + 1, `requests ${requests[spec.name] - base}`)
    first.clear()
    release(spec, spec.newRows)
    await action
    await settle(first.seen, frame => live(frame, spec.newName))
    check(`${spec.word}: the changed rows replace the cached list`, live(first.seen(), spec.newName) && !live(first.seen(), spec.oldName), first.seen().split('\n').filter(l => l.includes('refresh') || l.includes('Refresh')).join(' | '))
    check(`${spec.word}: the highlight follows the same id when the row moves`, first.seen().includes(`${spec.model} · model IDs`), first.seen().split('\n').filter(l => l.includes('model IDs')).join(' | '))
    check(`${spec.word}: the changed list paints the family's notice`, first.seen().includes(notice), first.seen().split('\n').filter(l => l.includes('catalogue')).join(' | '))
    first.unmount()

    const second = await mount(spec.model)
    check(`${spec.word}: a second open makes its own refresh within the span`, requests[spec.name] === base + 2, `requests ${requests[spec.name] - base}`)
    const unchanged = spec.refresh(true)
    await flush(400)
    const before = catalogueEpoch()
    second.clear()
    release(spec, spec.newRows)
    await unchanged
    await flush(400)
    check(`${spec.word}: an unchanged list does not bump the catalogue epoch`, catalogueEpoch() === before, `${before} -> ${catalogueEpoch()}`)
    check(`${spec.word}: an unchanged list does not repaint or show a notice`, second.seen() === '', second.seen())
    second.unmount()

    if (spec.name !== 'local') {
      const third = await mount(spec.model)
      const failed = spec.refresh(true)
      await flush()
      third.clear()
      release(spec, new Response('fixture unavailable', { status: 503 }))
      await failed
      await flush()
      check(`${spec.word}: a failed background read retains the last usable rows`, spec.cached() !== null && spec.ids(spec.cached()).length === 2 && spec.ids(spec.cached()).some(id => id.includes('refresh-gamma')), JSON.stringify(spec.ids(spec.cached())))
      check(`${spec.word}: a failed read does not claim a changed list`, !third.seen().includes(notice), third.seen().split('\n').filter(l => l.includes('catalogue')).join(' | '))
      third.unmount()

      process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
      const count = requests[spec.name]
      const dark = await mount(spec.model)
      check(`${spec.word}: traffic-off makes no request and does not discard the cache`, requests[spec.name] === count && spec.cached() !== null && spec.ids(spec.cached()).length === 2, `requests ${count} -> ${requests[spec.name]}`)
      dark.unmount()
      delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
    } else {
      process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
      const count = requests[spec.name]
      const dark = await mount(spec.model)
      check(`${spec.word}: the local probe is exempt from the catalogue-traffic switch (the gate's own law) and still runs on open`, requests[spec.name] === count + 1, `requests ${count} -> ${requests[spec.name]}`)
      dark.clear()
      if (held !== undefined) release(spec, spec.newRows)
      await flush()
      dark.unmount()
      delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
    }

    spec.reset()
    const beforeCold = requests[spec.name]
    const cold = await mount(spec.model)
    check(`${spec.word}: a cold open starts only one request`, requests[spec.name] === beforeCold + 1, `requests ${requests[spec.name] - beforeCold}`)
    const firstArrival = spec.refresh(true)
    release(spec, spec.newRows)
    await firstArrival
    await settle(cold.seen, frame => live(frame, spec.newName), 1500)
    check(`${spec.word}: the first catalogue arrives without a changed-list notice`, spec.ids(spec.cached()).some(id => id.includes('refresh-gamma')) && !cold.seen().includes(notice), cold.seen().split('\n').filter(l => l.includes('catalogue')).join(' | '))
    cold.unmount()

    if (spec.name !== 'local') {
      for (const key of KEYS) delete process.env[key]
      spec.reset()
      const beforeKeyless = requests[spec.name]
      const keyless = await mount(spec.model)
      const rows = getModelOptions().filter(row => row.group === spec.group)
      check(`${spec.word}: a keyless family sends nothing on open (its rows are the sign-in row alone)`, requests[spec.name] === beforeKeyless && rows.length === 1 && isProviderActionRow(rows[0]!.value), `requests ${beforeKeyless} -> ${requests[spec.name]}; rows ${rows.map(row => row.label).join(', ')}`)
      keyless.unmount()
    }
    check(`${spec.word}: the other families sent nothing during this leg`, others.every((f, i) => requests[f] === othersBefore[i]), JSON.stringify(requests))
  }
} finally {
  globalThis.fetch = realFetch
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
