#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_HOME', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MODEL_API_KEY', 'META_API_KEY', 'MISTRAL_API_KEY',
  'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_CUSTOM_MODEL_OPTION', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
]) {
  delete process.env[ambient]
}
const home = mkdtempSync(join(tmpdir(), 'models-reference-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'models-reference-cwd-')))
mkdirSync(join(home, '.mercury'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(home, '.mercury')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_META_API_BASE', 'MERCURY_MISTRAL_API_BASE']) {
  process.env[base] = 'http://127.0.0.1:1'
}

const XAI_KEY = 'xai-fixture-key-never-shown'
const ZAI_KEY = 'zai-fixture-key-never-shown'
const hits = { xai: 0, zai: 0 }
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (!path.endsWith('/models')) return new Response('not found', { status: 404 })
    if (path.startsWith('/xai/')) {
      hits.xai++
      return Response.json({ object: 'list', data: [{ id: 'grok-4.7', created: 2 }, { id: 'grok-fixture-new', created: 3 }] })
    }
    hits.zai++
    return Response.json({ error: 'fixture outage' }, { status: 500 })
  },
})
process.env.MERCURY_XAI_API_BASE = `http://127.0.0.1:${server.port}/xai/v1`
process.env.MERCURY_ZAI_API_BASE = `http://127.0.0.1:${server.port}/zai/v4`

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail ? `\n      ${detail.slice(0, 900)}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n── ${title}`)
}
const j = (v: unknown): string => JSON.stringify(v)

const { resolveResource, resourceAdapterKinds, listResourceKind } = await import('../../src/services/resources/registry.ts')
const owner = (await import('../../src/services/run/resolveOwner.ts')).ownerFromToolUseContext({})
const pages = (await import('../../src/services/resources/adapters/models.ts').catch(() => null)) as typeof import('../../src/services/resources/adapters/models.ts') | null
const { reachableModelEntries } = await import('../../src/utils/model/modelNameRoad.ts')
const { BARE_FAMILY_WORDS } = await import('../../src/utils/model/bareFamilyWords.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { MERCURY_VERSION } = await import('../../src/constants/product.ts')
const xai = await import('../../src/services/providers/xai/xaiCatalogue.ts')
const zai = await import('../../src/services/providers/zai/zaiCatalogue.ts')
const discovery = await import('../../src/services/providers/providerDiscovery.ts')
const { XAI_DISPLAY_PINS } = await import('../../src/services/providers/xai/xaiPins.ts')
const { GLM_DISPLAY_PINS } = await import('../../src/services/providers/zai/glmPins.ts')
const { KIMI_DISPLAY_PINS } = await import('../../src/services/providers/moonshot/kimiPins.ts')
const { GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.ts')

type LivePage = import('../../src/services/resources/adapters/models.ts').LiveModelsReference
type KnownPage = import('../../src/services/resources/adapters/models.ts').KnownModelsReference

section('§1 the models kind exists beside the seat, with two forms and a listing')
{
  check('the models adapter module exists (RED on the base: absent)', pages !== null)
  check('the models kind is registered for the Inspect prompt and names both pages', resourceAdapterKinds().some(kind => kind.kind === 'models' && kind.describe.includes('mercury://models') && kind.describe.includes('mercury://models/known')), j(resourceAdapterKinds().map(kind => kind.kind)))
  const wrong = await resolveResource('mercury://models/other', { owner, cwd })
  check('an id other than known is absent, with the two forms named', wrong.state === 'absent' && wrong.note.includes('mercury://models/known'), j(wrong))
  const listing = await listResourceKind('models', { owner, cwd })
  check('the kind lists its two pages', listing.state === 'ok' && listing.children.map(child => child.ref).join(',') === 'mercury://models,mercury://models/known', j(listing))
  const { InspectTool } = await import('../../src/tools/InspectTool/InspectTool.ts')
  const prompt = await InspectTool.prompt({} as never)
  check('the Inspect tool lists the models kind', prompt.includes('models — the model pages: mercury://models'), prompt.slice(-600))
}

section('§2 the live page: two sign-ins, one list reading, one list failing — the picker\'s rows, one owner')
{
  process.env.XAI_API_KEY = XAI_KEY
  process.env.ZAI_API_KEY = ZAI_KEY
  discovery.__resetProviderDiscoveryForTest()
  xai.__resetXaiCatalogueForTest()
  zai.__resetZaiCatalogueForTest()
  check('the xAI cache is cold before the page is read', xai.getCachedXaiCatalogue() === null && hits.xai === 0)
  const live = await resolveResource('mercury://models', { owner, cwd, engineModel: 'grok-4.7' })
  check('mercury://models resolves ok outside a turn-bound fact (sign-ins and lists are facts of the machine)', live.state === 'ok', j(live))
  const page = live.state === 'ok' ? (live.resource.structured as LivePage) : null
  const text = live.state === 'ok' ? live.resource.text ?? '' : ''
  check('the page read the cold xAI list itself, live', hits.xai === 1 && hits.zai >= 1, j(hits))
  check('exactly the two signed-in providers are listed, in the router\'s order', page !== null && page.providers.map(provider => provider.provider).join(',') === 'zai,xai', j(page?.providers.map(provider => provider.provider)))
  const xaiPage = page?.providers.find(provider => provider.provider === 'xai')
  const zaiPage = page?.providers.find(provider => provider.provider === 'zai')
  check('each provider carries its account label, never the key', xaiPage?.account === 'XAI_API_KEY (env)' && zaiPage?.account === 'ZAI_API_KEY (env)' && !text.includes(XAI_KEY) && !text.includes(ZAI_KEY) && !j(page).includes(XAI_KEY), j({ xai: xaiPage?.account, zai: zaiPage?.account }))
  check('the xAI list is live with its count and read time', xaiPage?.list.kind === 'live' && xaiPage.list.count === 2 && /\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC/.test(xaiPage.list.readAt), j(xaiPage?.list))
  const pickerXai = reachableModelEntries().filter(entry => declaredRouteOf(entry.id) === 'xai').map(entry => entry.id)
  const pickerZai = reachableModelEntries().filter(entry => declaredRouteOf(entry.id) === 'zai').map(entry => entry.id)
  check('the xAI rows are exactly the picker\'s reachable xAI rows, in order (one owner: getModelOptions)', xaiPage !== undefined && xaiPage.models.map(row => row.id).join(',') === pickerXai.join(',') && pickerXai.length === 2, j({ page: xaiPage?.models.map(row => row.id), picker: pickerXai }))
  check('the Z.AI rows are exactly the picker\'s rows while its list is unread (the floor rows)', zaiPage !== undefined && zaiPage.models.map(row => row.id).join(',') === pickerZai.join(',') && pickerZai.length > 0, j({ page: zaiPage?.models.map(row => row.id), picker: pickerZai }))
  const everyPageId = page?.providers.flatMap(provider => provider.models.map(row => row.id)) ?? []
  const everyPickerId = reachableModelEntries().filter(entry => ['xai', 'zai'].includes(declaredRouteOf(entry.id) ?? '')).map(entry => entry.id)
  check('the page as a whole lists exactly the picker\'s reachable rows of the signed-in providers', everyPageId.slice().sort().join(',') === everyPickerId.slice().sort().join(','), j({ page: everyPageId, picker: everyPickerId }))
  check('the row this turn runs on is marked, with its display name, window and efforts (the picker\'s facts)', xaiPage?.models.some(row => row.id === 'grok-4.7' && row.current === true && row.displayName === 'Grok 4.7' && row.contextWindow === 500_000 && (row.efforts ?? []).includes('high')) === true, j(xaiPage?.models))
  check("the newest live row is marked as what the family word 'grok' runs, and as live-but-unknown to this build", xaiPage?.models.some(row => row.id === 'grok-fixture-new' && row.familyWord === 'grok' && row.liveUnknown === true) === true, j(xaiPage?.models))
  check('the Z.AI list says it could not be read, with the failure', zaiPage?.list.kind === 'unread' && (zaiPage.list.error ?? '').includes('HTTP 500'), j(zaiPage?.list))
  check("…and names the known default the family word 'glm' will run", zaiPage?.knownDefault?.id === 'glm-5.3' && zaiPage.knownDefault.familyWord === 'glm', j(zaiPage?.knownDefault))
  check('the text carries both facts in words, the read failure with the service\'s own words', text.includes('Z.AI — ZAI_API_KEY (env) · the live list could not be read (Z.AI models endpoint returned HTTP 500 — fixture outage)') && text.includes("the family word 'glm' runs GLM-5.3 (glm-5.3), the default this build knows") && text.includes('xAI — XAI_API_KEY (env) · live list read '), text)
  check('the text marks the seat\'s row and the family-word row', text.includes('grok-4.7  Grok 4.7 · this turn runs on it') && text.includes("grok-fixture-new  the family word 'grok' runs this"), text)
  check('the providers not signed in are named with the door, and the model is told how to name a model and never to switch provider', text.includes('not signed in: Anthropic, OpenAI') && text.includes('/logins connects one') && text.includes('Never switch to another provider on your own') && text.includes('mercury://models/known'), text)
  const known = page?.notSignedIn ?? []
  check('the not-signed-in list names the sign-in families only, never the local or custom slots', known.includes('Anthropic') && known.includes('Moonshot') && !known.includes('Local models') && !known.includes('Custom endpoint'), j(known))
  const liveAgain = await resolveResource('mercury://models', { owner, cwd })
  check('read again outside a turn the page still answers, with no row marked as this turn\'s', liveAgain.state === 'ok' && !(liveAgain.resource.text ?? '').includes('this turn runs on it'), j(liveAgain.state))
}

section('§3 the known page: the pin tables this build ships, with the version, never a reachability claim')
{
  const known = await resolveResource('mercury://models/known', { owner, cwd })
  check('mercury://models/known resolves ok (RED on the base: unknown kind)', known.state === 'ok', j(known))
  const page = known.state === 'ok' ? (known.resource.structured as KnownPage) : null
  const text = known.state === 'ok' ? known.resource.text ?? '' : ''
  check('the page carries the build version and says it is not what is reachable now', page?.version === MERCURY_VERSION && text.startsWith(`what this build knows (Mercury ${MERCURY_VERSION}), not what is reachable now`), text.slice(0, 200))
  check('the resource is immutable and versioned by the build', known.state === 'ok' && known.resource.mutable === false && known.resource.version === MERCURY_VERSION)
  const byRoute = new Map((page?.providers ?? []).map(provider => [provider.provider, provider]))
  check('xAI lists exactly the xAI pin table, in order, with grok-4.7 as the default the family word runs', byRoute.get('xai')?.models.map(row => row.id).join(',') === XAI_DISPLAY_PINS.map(pin => pin.id).join(',') && byRoute.get('xai')?.defaultId === 'grok-4.7' && byRoute.get('xai')?.familyWord === 'grok', j(byRoute.get('xai')))
  check('Z.AI lists exactly the GLM pin table', byRoute.get('zai')?.models.map(row => row.id).join(',') === GLM_DISPLAY_PINS.map(pin => pin.id).join(','), j(byRoute.get('zai')?.models.map(row => row.id)))
  check('Moonshot lists exactly the Kimi pin table with kimi-k3 as the default', byRoute.get('moonshot')?.models.map(row => row.id).join(',') === KIMI_DISPLAY_PINS.map(pin => pin.id).join(',') && byRoute.get('moonshot')?.defaultId === KIMI_DISPLAY_PINS[0]!.id, j(byRoute.get('moonshot')?.models.map(row => row.id)))
  check('OpenAI lists exactly the GPT pin table', byRoute.get('openai')?.models.map(row => row.id).join(',') === GPT_DISPLAY_PINS.map(pin => pin.id).join(','), j(byRoute.get('openai')?.models.map(row => row.id)))
  for (const entry of BARE_FAMILY_WORDS) {
    check(`${entry.route} on the known page is the table's knownRows() for '${entry.word}' (one owner)`, byRoute.get(entry.route)?.models.map(row => row.id).join(',') === entry.knownRows().map(row => row.id).join(','), j(byRoute.get(entry.route)?.models.map(row => row.id)))
  }
  check('Anthropic, Gemini, Hugging Face and OpenCode Zen are listed from their own tables', ['anthropic', 'gemini', 'huggingface', 'zen'].every(route => (byRoute.get(route)?.models.length ?? 0) > 0) && byRoute.get('anthropic')!.models.some(row => row.id === 'claude-fable-5-1' && row.displayName === 'Fable 5.1'), j([...byRoute.keys()]))
  check('the text names the default each family word runs when its list cannot be read, and closes on reachability being the live page\'s to say', text.includes("xAI — family word 'grok' — runs grok-4.7 when the live list cannot be read") && text.includes('this page never says a model is reachable'), text.slice(-300))
  check('the known page never claims a live read', !text.includes('live list read') && !j(page).includes('readAt'))
}

section('§4 the Read tool renders both pages like mercury://seat')
{
  const { renderResourceTarget } = await import('../../src/tools/FileReadTool/readTarget.ts')
  const rendered = await renderResourceTarget('mercury://models', { owner, cwd, engineModel: 'grok-4.7' })
  check('Read renders the live page with its kind, title and the known page as a child', rendered.content.includes('(target: resource · owner: resources · state: ok · kind: models)') && rendered.content.includes('models reachable now') && rendered.content.includes('mercury://models/known — models this build knows') && rendered.content.includes('xAI — XAI_API_KEY (env)'), rendered.content.slice(0, 600))
  const renderedKnown = await renderResourceTarget('mercury://models/known', { owner, cwd })
  check('Read renders the known page with the build version', renderedKnown.content.includes(`models this build knows [v ${MERCURY_VERSION}]`) && renderedKnown.content.includes('grok-4.7  Grok 4.7'), renderedKnown.content.slice(0, 400))
  delete process.env.XAI_API_KEY
  delete process.env.ZAI_API_KEY
  discovery.__resetProviderDiscoveryForTest()
  const signedOut = await resolveResource('mercury://models', { owner, cwd })
  check('with no sign-in the live page says so and names /logins, listing nothing as reachable', signedOut.state === 'ok' && (signedOut.resource.structured as LivePage).providers.length === 0 && (signedOut.resource.text ?? '').includes('no provider is signed in — /logins connects one'), j(signedOut))
}

server.stop(true)
rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
