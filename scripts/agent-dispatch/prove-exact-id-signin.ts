#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'exact-id-signin-'))
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
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_DEEPSEEK_API_BASE']) {
  process.env[base] = 'http://127.0.0.1:1'
}

type Mode = 'ok' | 'fail' | 'empty'
const modes: Record<'xai' | 'meta' | 'mistral' | 'zai', Mode> = { xai: 'ok', meta: 'fail', mistral: 'fail', zai: 'fail' }
const lists: Record<'xai' | 'meta' | 'mistral' | 'zai', unknown[]> = {
  xai: [{ id: 'grok-4.7', created: 2 }, { id: 'grok-fixture-new', created: 3 }],
  meta: [],
  mistral: [],
  zai: [],
}
const hits: Record<string, number> = { xai: 0, meta: 0, mistral: 0, zai: 0 }
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    const family = (['xai', 'meta', 'mistral', 'zai'] as const).find(name => path.startsWith(`/${name}/`))
    if (family === undefined || !path.endsWith('/models')) return new Response('not found', { status: 404 })
    hits[family] = (hits[family] ?? 0) + 1
    const mode = modes[family]
    if (mode === 'fail') return Response.json({ error: 'fixture outage' }, { status: 500 })
    if (mode === 'empty') return Response.json({ object: 'list', data: [] })
    return Response.json({ object: 'list', data: lists[family] })
  },
})
const base = `http://127.0.0.1:${server.port}`
process.env.MERCURY_XAI_API_BASE = `${base}/xai/v1`
process.env.MERCURY_META_API_BASE = `${base}/meta/v1`
process.env.MERCURY_MISTRAL_API_BASE = `${base}/mistral/v1`
process.env.MERCURY_ZAI_API_BASE = `${base}/zai/v4`

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
console.log(' an exact id of a signed-in family needs no catalogue row: live row, else the known pin, else an honest refusal that names the next rung')
console.log('============================================================')

;(await import('../../src/utils/config.ts')).enableConfigs()
const engine = await import('../../src/utils/crew/engineDispatch.ts')
const { MODEL_LOOKUP_LADDER } = await import('../../src/utils/model/modelLookup.ts')
const roadModule = await import('../../src/utils/model/modelNameRoad.ts')
const discovery = await import('../../src/services/providers/providerDiscovery.ts')
const xai = await import('../../src/services/providers/xai/xaiCatalogue.ts')
const meta = await import('../../src/services/providers/meta/metaCatalogue.ts')
const mistral = await import('../../src/services/providers/mistral/mistralCatalogue.ts')
const zai = await import('../../src/services/providers/zai/zaiCatalogue.ts')

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
  zai.__resetZaiCatalogueForTest()
}
const launchRoad = (typed: string): { refused?: string; passedTo?: string } => {
  const matched = roadModule.matchReachableModelName(typed, 'pass')
  if (matched !== null && (matched.kind === 'ambiguous' || matched.kind === 'none')) return { refused: roadModule.modelNameHeadlessRefusal(matched, 'model') }
  return { passedTo: matched !== null && (matched.kind === 'match' || matched.kind === 'exact') ? matched.id : typed }
}

section("§1 the launch road: an id-shaped word the picker does not list reaches the provider road; a loose word still gets the nearest rows")
{
  process.env.XAI_API_KEY = 'xai-fixture-key'
  resetAll()
  check('the picker lists no xAI row while the list is unread', !roadModule.reachableModelEntries().some(entry => entry.id.startsWith('grok-')), show(roadModule.reachableModelEntries().filter(entry => entry.id.startsWith('grok-'))))
  const asked = roadModule.matchReachableModelName('grok-4.7')
  check("the asking matcher (the base's Crewmate-tool road) refuses the id: 'names no listed model'", asked !== null && asked.kind === 'none' && roadModule.modelNameHeadlessRefusal(asked, 'model').includes("model 'grok-4.7' names no listed model"), show(asked))
  const passed = launchRoad('grok-4.7')
  check("the launch road passes 'grok-4.7' through to the provider road unchanged", passed.passedTo === 'grok-4.7' && passed.refused === undefined, show(passed))
  const windowed = launchRoad('grok-4.7[1m]')
  check('…and keeps a typed window on the word it passes', windowed.passedTo === 'grok-4.7[1m]', show(windowed))
  const loose = launchRoad('grok four point seven')
  check('a loose word that matches nothing still gets the nearest-rows refusal, never a pass-through', loose.refused !== undefined && loose.refused.includes("names no listed model"), show(loose))
  const tool = readFileSync(join(import.meta.dir, '../../src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  check("the Crewmate tool's launch calls the matcher with the pass policy, as the --model road does (RED on the base)", tool.includes("matchReachableModelName(typedModel, 'pass')"), tool.match(/matchReachableModelName\([^)]*\)/)?.[0] ?? '')
}

section("§2 the ladder for 'grok-4.7' with a signed-in xAI and an empty catalogue cache")
{
  modes.xai = 'fail'
  resetAll()
  const cold = await road('grok-4.7')
  check("the list cannot be read: 'grok-4.7' launches on xAI as the pin this build knows (RED on the base: 'not a catalogue-verified id')", cold.backend === 'xai' && cold.model === 'grok-4.7' && cold.displayLabel === 'Grok 4.7', show(cold))
  check('…with a note that names the read failure with the service\'s own words, the id that runs and the two pages', cold.note?.includes('the xAI model list could not be read (xAI models endpoint returned HTTP 500 — fixture outage)') === true && cold.note.includes('Grok 4.7 (grok-4.7)') && cold.note.includes('mercury://models/known'), show(cold))
  const windowed = await road('grok-4.7[1m]')
  check("a typed window is dressing for an xAI id: 'grok-4.7[1m]' looks up grok-4.7 and runs it", windowed.backend === 'xai' && windowed.model === 'grok-4.7', show(windowed))
  const unknown = await road('grok-9-fixture')
  check("an id on neither page refuses, naming both pages, the ids this build knows and the ask rung (RED on the base: 'listed: ' with nothing)", unknown.threw !== undefined && unknown.threw.includes("xAI model 'grok-9-fixture' is on neither mercury://models") && unknown.threw.includes('mercury://models/known') && unknown.threw.includes('grok-4.7') && unknown.threw.includes('ask the operator for the model id') && unknown.threw.includes(MODEL_LOOKUP_LADDER), show(unknown))

  modes.xai = 'ok'
  resetAll()
  const live = await road('grok-4.7')
  check("the list reads: 'grok-4.7' runs the live row with no note", live.backend === 'xai' && live.model === 'grok-4.7' && live.note === undefined, show(live))
  check('the road read the list itself', hits.xai >= 1, show(hits))
  const liveUnknown = await road('grok-fixture-new')
  check('a live id this build has no pin for runs under its own id (the live list is the truth)', liveUnknown.backend === 'xai' && liveUnknown.model === 'grok-fixture-new' && liveUnknown.note === undefined, show(liveUnknown))
  const absent = await road('grok-4.3')
  check("the list reads and lacks the id: a pinned id the account does not serve refuses, naming the listed ids, mercury://models and the ask rung", absent.threw !== undefined && absent.threw.includes("xAI model 'grok-4.3' is not on the account's live model list (listed: grok-fixture-new, grok-4.7)") && absent.threw.includes('mercury://models') && absent.threw.includes('ask the operator for the model id'), show(absent))

  modes.xai = 'empty'
  resetAll()
  const empty = await road('grok-4.7')
  check("a live list that serves no chat model: 'grok-4.7' refuses naming that fact and the ask rung (the list was read; nothing is invented)", empty.threw !== undefined && empty.threw.includes('the list serves no chat model') && empty.threw.includes('ask the operator'), show(empty))
}

section('§3 the other key lanes follow the same ladder with their own pin tables')
{
  process.env.MODEL_API_KEY = 'meta-fixture-key'
  process.env.MISTRAL_API_KEY = 'mistral-fixture-key'
  process.env.ZAI_API_KEY = 'zai-fixture-key'
  resetAll()
  const muse = await road('muse-spark-1.2')
  check("'muse-spark-1.2' with an unreadable Meta list runs the pin with the note (RED on the base: 'not listed by the account')", muse.backend === 'meta' && muse.model === 'muse-spark-1.2' && muse.note?.includes('the Meta model list could not be read') === true, show(muse))
  const mistralAlias = await road('mistral-medium-latest')
  check("'mistral-medium-latest' (a pin alias) with an unreadable Mistral list runs the pinned id mistral-medium-3-5 with the note (RED on the base)", mistralAlias.backend === 'mistral' && mistralAlias.model === 'mistral-medium-3-5' && mistralAlias.note?.includes('the Mistral model list could not be read') === true, show(mistralAlias))
  const glmFloor = await road('glm-5.2')
  check("'glm-5.2' with an unreadable Z.AI list runs from the floor rows the picker shows, no note (unchanged)", glmFloor.backend === 'zai' && glmFloor.model === 'glm-5.2' && glmFloor.note === undefined, show(glmFloor))
  const glmKnown = await road('glm-4.7')
  check("'glm-4.7' (pinned, not a floor row) with an unreadable Z.AI list runs with the note (RED on the base: 'not a catalogue-verified id')", glmKnown.backend === 'zai' && glmKnown.model === 'glm-4.7' && glmKnown.note?.includes('the Z.AI model list') === true, show(glmKnown))
  const nobody = await road('muse-spark-9-fixture')
  check('an unknown Meta id refuses naming both pages and the ask rung', nobody.threw !== undefined && nobody.threw.includes("Meta model 'muse-spark-9-fixture' is on neither mercury://models") && nobody.threw.includes('ask the operator'), show(nobody))
  for (const key of ['XAI_API_KEY', 'MODEL_API_KEY', 'MISTRAL_API_KEY', 'ZAI_API_KEY']) delete process.env[key]
  resetAll()
}

server.stop(true)
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
