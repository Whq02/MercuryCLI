#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
const ladderTopHint = ' | to fix, change EFFORT_LEVELS in src/models/effort/effortLadder.ts, the effort parsers and resolveEffortTruth in src/models/effort/effort.ts, the wire ranks in src/models/facts/pins/gptPins.ts, the catalogue reads in src/models/roads/openai/openaiCatalogue.ts, or the refusal memory in src/models/roads/openai/qualificationStore.ts, whichever this label names'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${cond ? '' : ladderTopHint}`)
}

console.log('============================================================')
console.log(' the effort ladder ends at max (a list word above it is never a level)')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of ['OPENAI_API_KEY', 'MERCURY_CONFIG_DIR', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_EFFORT_LEVEL', 'MERCURY_OPENAI_API_BASE']) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-effort-ladder-top-'))
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

const ladderModule = await import('../../src/models/effort/effortLadder.js')
const effort = await import('../../src/models/effort/effort.js')
const pins = await import('../../src/models/facts/pins/gptPins.js')
const catalogue = await import('../../src/models/roads/openai/openaiCatalogue.js')
const capabilities = await import('../../src/models/facts/capabilities.js')
const store = await import('../../src/models/roads/openai/qualificationStore.js')
const figures = await import('../../src/screen/theme/rowGlyphs.js')
const indicator = await import('../../src/screen/widgets/effortIndicator.js')

const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const LIST_WORD = 'ultra'

{
  console.log('\n— §1 · one tuple, five words, max at the top; every surface reads it —')
  check('the ladder is exactly low · medium · high · xhigh · max', JSON.stringify(ladderModule.EFFORT_LEVELS) === JSON.stringify(LADDER), JSON.stringify(ladderModule.EFFORT_LEVELS))
  check('the owner re-exports the same tuple (one owner, no mirror)', effort.EFFORT_LEVELS === ladderModule.EFFORT_LEVELS)
  check('the list word is not a level anywhere the type can reach', !effort.isEffortLevel(LIST_WORD) && !(effort.EFFORT_LEVELS as readonly string[]).includes(LIST_WORD))
  check('every ladder word has a glyph and none is left for a word above max', LADDER.every(level => indicator.effortLevelToSymbol(level).length > 0) && !('EFFORT_ULTRA' in figures))
  check('every ladder word has a description and the description switch is exhaustive over the tuple', LADDER.every(level => effort.getEffortLevelDescription(level).length > 0))
  const { builtHelp } = await import('../lib/builtProduct.ts')
  check('the --effort door names the ladder from the tuple', builtHelp().includes(`--effort <level> Reasoning effort level (${ladderModule.EFFORT_LEVELS.join(', ')})`))
}

{
  console.log('\n— §2 · the wire order ends at max and does not rank the list word —')
  check('max is the top rank', pins.WIRE_EFFORT_RANK.max === Math.max(...Object.values(pins.WIRE_EFFORT_RANK)))
  check('the list word has no rank', !pins.isRankedWireEffort(LIST_WORD) && pins.WIRE_EFFORT_RANK[LIST_WORD] === undefined)
  check('every ladder word is ranked, in ladder order', LADDER.every((level, i) => pins.isRankedWireEffort(level) && (i === 0 || pins.WIRE_EFFORT_RANK[level]! > pins.WIRE_EFFORT_RANK[LADDER[i - 1]!]!)))
  const listed = [...LADDER, LIST_WORD]
  check('the nearest-served resolution answers undefined for the list word even where the list carries it', pins.nearestSupportedWireEffort(LIST_WORD, listed) === undefined)
  check('…and max stays max on that list (never clamped by a word above it)', pins.nearestSupportedWireEffort('max', listed) === 'max')
  check("a list default above the ladder steps to the convention word; a ranked default rides verbatim; a list of only the word sends nothing", pins.wireEffortForListDefault(LIST_WORD, listed) === 'high' && pins.wireEffortForListDefault('minimal', ['none', 'minimal', 'low']) === 'minimal' && pins.wireEffortForListDefault(undefined, ['xhigh', 'max']) === 'xhigh' && pins.wireEffortForListDefault(LIST_WORD, [LIST_WORD]) === undefined)
}

{
  console.log('\n— §3 · no door admits the list word —')
  check('the normaliser refuses it in every spelling', effort.normalizeEffortLevelString('ultra') === undefined && effort.normalizeEffortLevelString('ULTRA') === undefined && effort.normalizeEffortLevelString('ultra effort') === undefined)
  check('the general parser refuses it', effort.parseEffortValue('ultra') === undefined)
  check('the CLI flag refuses it naming the ladder up to max', effort.parseCliEffort('ultra').level === undefined && String(effort.parseCliEffort('ultra').refusal) === 'Unrecognised effort level "ultra". Valid values: low, medium, high, xhigh, max.')
  const env = effort.describeEffortEnvOverride({ MERCURY_EFFORT_LEVEL: 'ultra' })
  check('the env door ignores it and says so, naming the ladder up to max', env.state === 'ignored' && 'sentence' in env && env.sentence.includes('low, medium, high, xhigh, max;'))
  check('nothing persists it', effort.toPersistableEffort('ultra' as never) === undefined)
}

{
  console.log('\n— §4 · never offered, never sent; the row keeps the list; the flag reads it —')
  process.env.OPENAI_API_KEY = 'prover-key'
  const fixtureFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', priority: 1, supported_reasoning_levels: [...LADDER, LIST_WORD], default_reasoning_level: 'medium' },
          { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 2, supported_reasoning_levels: [...LADDER], default_reasoning_level: 'low' },
          { id: 'gpt-5.6-nova', display_name: 'GPT-5.6 Nova', visibility: 'list', priority: 3, supported_reasoning_levels: [...LADDER, LIST_WORD], default_reasoning_level: LIST_WORD },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fixtureFetch })

  const view = capabilities.gptEffortVocabularyView('gpt-6-astra')
  check('the decoded row keeps the list verbatim, the word above max included', view.state === 'live' && JSON.stringify(view.vocabulary) === JSON.stringify([...LADDER, LIST_WORD]), JSON.stringify(view))
  check('the listed words read the same off the raw accessor', JSON.stringify(catalogue.liveGptListedEffortWords('gpt-6-astra')) === JSON.stringify([...LADDER, LIST_WORD]) && catalogue.liveGptListedEffortWords('claude-opus-5') === undefined)
  const selectable = effort.selectableEffortLevels('gpt-6-astra')
  check('the controls offer the ladder up to max and never the list word', JSON.stringify(selectable) === JSON.stringify(LADDER) && capabilities.getMaxSupportedEffortLevel('gpt-6-astra') === 'max')
  check('the resolution carries the FULL provider vocabulary verbatim beside the selectable stops', JSON.stringify(effort.resolveEffortTruth('gpt-6-astra', undefined).providerVocabulary) === JSON.stringify([...LADDER, LIST_WORD]))

  const asked = effort.resolveEffortTruth('gpt-6-astra', LIST_WORD as never)
  const live = catalogue.evaluateGptCandidate('gpt-6-astra', 'api-key')
  const liveRow = live.ok ? live.candidate.live : undefined
  const profile = liveRow ? catalogue.resolveGptReasoningProfile(LIST_WORD, liveRow) : undefined
  check("asked raw, the owner never sends the list word: the row default ('medium') rides", asked.wire === 'medium' && asked.applied === 'medium' && asked.label === 'medium', JSON.stringify(asked))
  check('the wire profile agrees (display ≡ dispatch) and names the adjustment', profile?.wireEffort === 'medium' && profile.source === 'unsupported-fallback' && profile.adjustedFrom === LIST_WORD, JSON.stringify(profile))
  check('max asked on that row is served as max (the word above never clamps it)', effort.resolveEffortTruth('gpt-6-astra', 'max').wire === 'max' && (liveRow ? catalogue.resolveGptReasoningProfile('max', liveRow).wireEffort : undefined) === 'max')

  const aboveDefault = effort.resolveEffortTruth('gpt-5.6-nova', undefined)
  const novaLive = catalogue.evaluateGptCandidate('gpt-5.6-nova', 'api-key')
  const novaProfile = novaLive.ok ? catalogue.resolveGptReasoningProfile(undefined, novaLive.candidate.live) : undefined
  check("a list DEFAULT above the ladder is never sent: nothing asked sends the convention word 'high', the record keeps the list's own default", aboveDefault.wire === 'high' && aboveDefault.label === 'high' && aboveDefault.providerDefault === LIST_WORD && novaProfile?.wireEffort === 'high' && novaProfile.source === 'model-default', JSON.stringify({ aboveDefault, novaProfile }))


  const WIRE_LIST = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  store.recordWireEffortRefusal({ modelId: 'gpt-6-astra', sourceKind: 'api-key', refused: 'max', levels: WIRE_LIST })
  check('a remembered refusal narrows the served row (max gone, ceiling xhigh) while the LISTED words stand', capabilities.getMaxSupportedEffortLevel('gpt-6-astra') === 'xhigh' && JSON.stringify(catalogue.liveGptListedEffortWords('gpt-6-astra')) === JSON.stringify([...LADDER, LIST_WORD]))
  store.noteWireEffortAccepted({ modelId: 'gpt-6-astra', sourceKind: 'api-key', word: 'max' })
  check('an accepted max clears the memory', store.readWireEffortVocabularies().length === 0 && capabilities.getMaxSupportedEffortLevel('gpt-6-astra') === 'max')
  catalogue.__resetOpenaiCatalogueForTest()
  delete process.env.OPENAI_API_KEY
}

{
  console.log('\n— §5 · the receipt: a wire-refused word names the road and the re-probe —')
  const plain = effort.effortAdjustedReceiptLine({ model: 'gpt-5.5', name: 'GPT-5.5', asked: 'max', sent: 'xhigh' })
  check('a plain step-down names the model', plain === 'effort max is not served on GPT-5.5 today — sent xhigh', plain)
  const refused = effort.effortAdjustedReceiptLine({ model: 'gpt-6-astra', name: 'GPT-6 Astra', asked: 'max', sent: 'xhigh', wireRefused: { road: 'ChatGPT subscription', reprobeAfter: store.describeWireEffortProbeWindow() } })
  check('a wire-refused word names the road and the re-probe', refused === 'effort max: the wire refused it for GPT-6 Astra on the ChatGPT subscription road today — sent xhigh, the nearest word it serves; Mercury asks the wire again after a day', refused)
  check('the window words: a day · an hour · 3 hours · 2 days', store.describeWireEffortProbeWindow() === 'a day' && store.describeWireEffortProbeWindow(3_600_000) === 'an hour' && store.describeWireEffortProbeWindow(3 * 3_600_000) === '3 hours' && store.describeWireEffortProbeWindow(48 * 3_600_000) === '2 days')
  const t = await import('../core-runtime/turnScenarios.ts')
  const stamp = { model: 'gpt-6-astra', name: 'GPT-6 Astra', asked: 'max', sent: 'xhigh', wireRefused: { road: 'ChatGPT subscription', reprobeAfter: store.describeWireEffortProbeWindow() } }
  const stepped = await t.runScripted({ script: [t.fixtures.yields(Object.assign(t.fixtures.says('the reply at the lower effort.'), { effortAdjusted: stamp }))] })
  const painted = stepped.events.filter(event => event.kind === 'notice').map(event => `${String((event.message as { level?: unknown }).level)}: ${t.noticesOf([event])[0]}`)
  check(
    'the turn machine paints the line from the one owner',
    painted.length === 1 && painted[0] === `warning: ${refused}`,
    `a reply stamped effortAdjusted must reach the operator as one warning notice whose words are effortAdjustedReceiptLine(stamp), yielded after the model call's stream (streamModel, src/engine/loop/turn/streamModel.ts); the run yielded ${JSON.stringify(painted)}`,
  )
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('ALL EFFORT LADDER-TOP PROOFS PASS')
else console.log(`${failures} EFFORT LADDER-TOP PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
