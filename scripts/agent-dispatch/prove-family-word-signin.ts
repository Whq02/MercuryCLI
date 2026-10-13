#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'family-word-signin-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'MERCURY_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MODEL_API_KEY', 'META_API_KEY',
  'MISTRAL_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_CUSTOM_MODEL_OPTION', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'NODE_ENV',
]) {
  delete process.env[key]
}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_DEEPSEEK_API_BASE']) {
  process.env[base] = 'http://127.0.0.1:1'
}

type Mode = 'ok' | 'fail' | 'refuse' | 'empty' | 'drop'
const modes: Record<'xai' | 'meta' | 'mistral' | 'moonshot', Mode> = { xai: 'ok', meta: 'fail', mistral: 'fail', moonshot: 'fail' }
const hits: Record<string, number> = { xai: 0, meta: 0, mistral: 0, moonshot: 0 }
const XAI_LIST = [{ id: 'grok-4.3', created: 1 }, { id: 'grok-fixture-new', created: 3 }, { id: 'grok-4.7', created: 2 }]
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    const family = (['xai', 'meta', 'mistral', 'moonshot'] as const).find(name => path.startsWith(`/${name}/`))
    if (family === undefined || !path.endsWith('/models')) return new Response('not found', { status: 404 })
    hits[family] = (hits[family] ?? 0) + 1
    const mode = modes[family]
    if (mode === 'fail') return Response.json({ error: 'fixture outage' }, { status: 500 })
    if (mode === 'refuse') return Response.json({ error: 'fixture refusal' }, { status: 401 })
    if (mode === 'drop') return new Response('not json at all', { status: 200, headers: { 'content-type': 'text/plain' } })
    if (mode === 'empty') return Response.json({ object: 'list', data: [] })
    return Response.json({ object: 'list', data: XAI_LIST })
  },
})
const base = `http://127.0.0.1:${server.port}`
process.env.MERCURY_XAI_API_BASE = `${base}/xai/v1`
process.env.MERCURY_META_API_BASE = `${base}/meta/v1`
process.env.MERCURY_MISTRAL_API_BASE = `${base}/mistral/v1`
process.env.MERCURY_MOONSHOT_API_BASE = `${base}/moonshot/v1`

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const show = (v: unknown): string => JSON.stringify(v) ?? String(v)

console.log('============================================================')
console.log(' a family word resolves from the sign-in: live head, else the known default, never a cold-cache refusal')
console.log('============================================================')

;(await import('../../src/utils/config.ts')).enableConfigs()
const engine = await import('../../src/utils/crew/engineDispatch.ts')
const words = await import('../../src/utils/model/bareFamilyWords.ts')
const discovery = await import('../../src/utils/router/providerDiscovery.ts')
const xai = await import('../../src/services/providers/xai/xaiCatalogue.ts')
const meta = await import('../../src/services/providers/meta/metaCatalogue.ts')
const mistral = await import('../../src/services/providers/mistral/mistralCatalogue.ts')
const moonshot = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')
const { XAI_DISPLAY_PINS } = await import('../../src/services/providers/xai/xaiPins.ts')
const { META_DISPLAY_PINS } = await import('../../src/services/providers/meta/metaPins.ts')
const { MISTRAL_DISPLAY_PINS } = await import('../../src/services/providers/mistral/mistralPins.ts')
const { KIMI_DISPLAY_PINS } = await import('../../src/services/providers/moonshot/kimiPins.ts')
const { buildAgentLaunchPlan } = await import('../../src/utils/crew/agentLaunchPlan.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

type Road = { model?: string; backend?: string; displayLabel?: string; note?: string; threw?: string }
const road = (word: string): Promise<Road> =>
  engine.resolveEngineDispatch(word).then(
    r => ({ ...(r ? { model: r.model, backend: r.backend, displayLabel: r.displayLabel, ...(r.note !== undefined ? { note: r.note } : {}) } : {}) }),
    e => ({ threw: e instanceof Error ? e.message : String(e) }),
  )
const resetAll = (): void => {
  discovery.__resetProviderDiscoveryForTest()
  xai.__resetXaiCatalogueForTest()
  meta.__resetMetaCatalogueForTest()
  mistral.__resetMistralCatalogueForTest()
  moonshot.__resetMoonshotCatalogueForTest()
}

section('§1 the table: every family word names its pinned default and reads its list state')
{
  const table = words.BARE_FAMILY_WORDS as ReadonlyArray<Partial<import('../../src/utils/model/bareFamilyWords.ts').BareFamilyWord> & { word: string }>
  const pinOf = (word: string): { id: string; displayName: string } | undefined => {
    const entry = table.find(row => row.word === word)
    return typeof entry?.pinnedDefault === 'function' ? entry.pinnedDefault() : undefined
  }
  for (const entry of table) {
    const pinned = pinOf(entry.word)
    check(`'${entry.word}' pins a default of its own family (${pinned?.id ?? 'none'}) (RED on the base: the table carries no pin)`, pinned !== undefined && pinned.id !== '' && pinned.displayName !== '', show(pinned))
    const state = typeof entry.listState === 'function' ? entry.listState() : undefined
    check(`'${entry.word}' reads a list state`, state !== undefined && ['live', 'pin', 'unread'].includes(state.kind), show(state))
  }
  check("'grok' pins grok-4.7 (Grok 4.7), the first xAI pin", pinOf('grok')?.id === XAI_DISPLAY_PINS[0]!.id && pinOf('grok')?.displayName === 'Grok 4.7', show(pinOf('grok')))
  check("'muse' pins the first Standard (non-contributor) Meta pin", pinOf('muse')?.id === META_DISPLAY_PINS.find(pin => !pin.id.includes('contributor'))!.id)
  check("'mistral' pins the first Mistral pin", pinOf('mistral')?.id === MISTRAL_DISPLAY_PINS[0]!.id)
  check("'kimi' pins the first Kimi pin", pinOf('kimi')?.id === KIMI_DISPLAY_PINS[0]!.id)
}

section('§2 no credential: the refusal names the sign-in door, never the catalogue')
{
  resetAll()
  const grok = await road('grok')
  check("'grok' with no xAI credential refuses naming the provider", grok.threw !== undefined && grok.threw.includes('Engine provider xai is unavailable'), show(grok))
  check('…and the refusal names /logins xai as the way out (RED on the base: "/health ROUTER and /capabilities name the fix")', grok.threw?.includes('/logins xai') === true && grok.threw.includes('not signed in'), show(grok))
  check('…and tells the model never to switch provider on its own', grok.threw?.includes('never switch to another provider') === true, show(grok))
  check('no list was asked for without a credential', hits.xai === 0, show(hits))
}

section('§3 a cold cache with a live sign-in: the road reads the list first and runs the newest live row')
{
  process.env.XAI_API_KEY = 'xai-fixture-key-one'
  modes.xai = 'ok'
  resetAll()
  check('the cache is cold before the launch', xai.getCachedXaiCatalogue() === null)
  const grok = await road('grok')
  check("'grok' resolves to the newest live Grok row (RED on the base: 'Engine provider xai has no catalogue entry')", grok.backend === 'xai' && grok.model === 'grok-fixture-new' && grok.note === undefined, show(grok))
  check('the road itself read the list (one request)', hits.xai === 1, show(hits))
  const again = await road('grok')
  check('a warm cache is not re-read', again.model === 'grok-fixture-new' && hits.xai === 1, show({ again, hits }))
}

section('§4 a re-keyed credential: the cache is keyed under the old identity; the road reads again under the new one')
{
  process.env.XAI_API_KEY = 'xai-fixture-key-two'
  discovery.__resetProviderDiscoveryForTest()
  check('the catalogue cache holds nothing under the new identity', xai.getCachedXaiCatalogue() === null)
  const grok = await road('grok')
  check("'grok' resolves to the newest live row after the key changed (RED on the base)", grok.backend === 'xai' && grok.model === 'grok-fixture-new', show(grok))
  check('…by a second read of the list', hits.xai === 2, show(hits))
}

section('§5 the list cannot be read while the sign-in is live: the known default runs, with the receipt line')
{
  modes.xai = 'fail'
  resetAll()
  process.env.XAI_API_KEY = 'xai-fixture-key-three'
  const grok = await road('grok')
  check("'grok' resolves to grok-4.7, the family's pinned default (RED on the base)", grok.backend === 'xai' && grok.model === 'grok-4.7' && grok.displayLabel === 'Grok 4.7', show(grok))
  check('…with a note that says the list could not be read, names the HTTP failure and the default that runs', grok.note !== undefined && grok.note.includes('the xAI model list could not be read') && grok.note.includes('HTTP 500') && grok.note.includes('Grok 4.7 (grok-4.7)'), show(grok))
  check('…and the note points at the two pages', grok.note?.includes('mercury://models') === true && grok.note.includes('mercury://models/known'), show(grok))
  const plan = buildAgentLaunchPlan({
    activeAgents: [{ agentType: 'general-purpose', whenToUse: 'x', tools: ['*'], source: 'built-in', baseDir: 'built-in', getSystemPrompt: () => '' } as never],
    toolPermissionContext: getEmptyToolPermissionContext(),
    defaultAgentType: 'general-purpose',
    engineModel: 'claude-opus-5',
    backgroundTasksDisabled: false,
    forceAsync: false,
    engineDispatch: { backend: 'xai', model: grok.model!, ...(grok.note !== undefined ? { note: grok.note } : {}) },
  })
  check('the launch plan carries the note on its receipt line after the engine words (RED on the base)', plan.modelNote !== undefined && plan.modelNote.startsWith('engine: xAI (grok-4.7)') && plan.modelNote.includes('the xAI model list could not be read'), show(plan.modelNote))

  modes.xai = 'refuse'
  resetAll()
  const refused = await road('grok')
  check("a 401 from the list endpoint is a list failure, not a sign-out: 'grok' still runs grok-4.7 and the note names the refusal", refused.model === 'grok-4.7' && refused.note?.includes('HTTP 401') === true, show(refused))

  modes.xai = 'drop'
  resetAll()
  const garbled = await road('grok')
  check("a list that is not JSON: 'grok' runs grok-4.7 with the note", garbled.model === 'grok-4.7' && garbled.note?.includes('could not be read') === true, show(garbled))
}

section('§6 a list read live but empty: the sign-in is the stronger fact — the default runs and the note says the list serves no chat model')
{
  modes.xai = 'empty'
  resetAll()
  const grok = await road('grok')
  check("'grok' runs grok-4.7 when the live list serves no chat model (RED on the base)", grok.model === 'grok-4.7' && grok.note?.includes('serves no chat model') === true && !grok.note.includes('could not be read'), show(grok))
}

section('§7 the other family words follow the same law with their own pins')
{
  modes.xai = 'ok'
  process.env.MODEL_API_KEY = 'meta-fixture-key'
  process.env.MISTRAL_API_KEY = 'mistral-fixture-key'
  process.env.MOONSHOT_API_KEY = 'moonshot-fixture-key'
  resetAll()
  const muse = await road('muse')
  check("'muse' with an unreadable Meta list runs the first Standard pin with the note (RED on the base)", muse.backend === 'meta' && muse.model === META_DISPLAY_PINS.find(pin => !pin.id.includes('contributor'))!.id && muse.note?.includes('the Meta model list could not be read') === true, show(muse))
  const mis = await road('mistral')
  check("'mistral' with an unreadable Mistral list runs the first pin with the note (RED on the base)", mis.backend === 'mistral' && mis.model === MISTRAL_DISPLAY_PINS[0]!.id && mis.note?.includes('the Mistral model list could not be read') === true, show(mis))
  const kimi = await road('kimi')
  check("'kimi' with an unreadable Moonshot list runs the first Kimi pin with the note (RED on the base: the 'has not been read' refusal)", kimi.backend === 'moonshot' && kimi.model === KIMI_DISPLAY_PINS[0]!.id && kimi.note?.includes('the Moonshot model list could not be read') === true && kimi.note.includes('HTTP 500'), show(kimi))
  for (const key of ['XAI_API_KEY', 'MODEL_API_KEY', 'MISTRAL_API_KEY', 'MOONSHOT_API_KEY']) delete process.env[key]
  resetAll()
}

server.stop(true)
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
