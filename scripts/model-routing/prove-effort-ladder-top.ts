#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

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

const runtimeTypes = await import('../../src/entrypoints/sdk/runtimeTypes.js')
const effort = await import('../../src/utils/effort.js')
const pins = await import('../../src/services/providers/openai/gptPins.js')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const capabilities = await import('../../src/utils/model/capabilities.js')
const effortModel = await import('../../src/utils/cockpit/effortModel.js')
const store = await import('../../src/services/providers/openai/qualificationStore.js')
const figures = await import('../../src/constants/figures.js')
const indicator = await import('../../src/components/EffortIndicator.js')

const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const LIST_WORD = 'ultra'

{
  console.log('\n— §1 · one tuple, five words, max at the top; every surface reads it —')
  check('the ladder is exactly low · medium · high · xhigh · max', JSON.stringify(runtimeTypes.EFFORT_LEVELS) === JSON.stringify(LADDER), JSON.stringify(runtimeTypes.EFFORT_LEVELS))
  check('the owner re-exports the same tuple (one owner, no mirror)', effort.EFFORT_LEVELS === runtimeTypes.EFFORT_LEVELS)
  check('the cockpit axis IS the tuple', effortModel.EFFORT_AXIS === runtimeTypes.EFFORT_LEVELS)
  check('the list word is not a level anywhere the type can reach', !effort.isEffortLevel(LIST_WORD) && !(effort.EFFORT_LEVELS as readonly string[]).includes(LIST_WORD))
  check('every ladder word has a glyph and none is left for a word above max', LADDER.every(level => indicator.effortLevelToSymbol(level).length > 0) && !('EFFORT_ULTRA' in figures))
  check('every ladder word has a description and the description switch is exhaustive over the tuple', LADDER.every(level => effort.getEffortLevelDescription(level).length > 0))
  check('every ladder word has a cockpit note', LADDER.every(level => effortModel.describeEffortLevel(level, true).note.length > 0))
  const slider = src('src/commands/effort/EffortSlider.tsx')
  check("the slider's treatments are a Record over the ladder type with no word above max", /const TREATMENTS: Record<EffortLevel, Treatment> = \{/.test(slider) && !/\bultra\b/.test(slider) && !/blaze/.test(slider))
  check('the /effort option list derives from the tuple', src('src/commands/effort/effort.tsx').includes("const OPTION_LIST = `${EFFORT_LEVELS.join('|')}|supercode|auto`"))
  check('the settings schema takes its enum from the tuple', src('src/utils/settings/types.ts').includes('effortLevel: z.enum(EFFORT_LEVELS)'))
  check("the Agent tool's effort field takes its enum from the tuple", /effort: z\s*\.enum\(EFFORT_LEVELS\)/.test(src('src/tools/AgentTool/AgentTool.tsx')))
  check('the workflow prompt spells the ladder from the tuple and no longer names a word above max', src('src/tools/WorkflowTool/workflowPrompt.ts').includes("EFFORT_LEVELS.map(level => `'${level}'`).join(' | ')") && !/\bultra\b/.test(src('src/tools/WorkflowTool/workflowPrompt.ts')))
  const coordinator = src('src/services/concourse/coordinatorTools.ts')
  check("the coordinator's launch tool names the ladder from the tuple and says max is the top", coordinator.includes("EFFORT_LEVELS.join(' | ')") && coordinator.includes('max IS the top tier') && !/\bultra\b/.test(coordinator))
  check('the --effort door names the ladder from the tuple', src('src/main.tsx').includes("Reasoning effort level (${EFFORT_LEVELS.join(', ')})"))
  for (const file of ['src/utils/effort.ts', 'src/utils/cockpit/effortModel.ts', 'src/components/EffortIndicator.ts', 'src/entrypoints/sdk/runtimeTypes.ts']) {
    check(`${file} carries no switch arm or record row for a word above max`, !/case 'ultra'|ultra:/.test(src(file)))
  }
}

{
  console.log('\n— §2 · the wire order ends at max and does not rank the list word —')
  check('max is the top rank', pins.WIRE_EFFORT_RANK.max === Math.max(...Object.values(pins.WIRE_EFFORT_RANK)))
  check('the list word has no rank', !pins.isRankedWireEffort(LIST_WORD) && pins.WIRE_EFFORT_RANK[LIST_WORD] === undefined)
  check('every ladder word is ranked, in ladder order', LADDER.every((level, i) => pins.isRankedWireEffort(level) && (i === 0 || pins.WIRE_EFFORT_RANK[level]! > pins.WIRE_EFFORT_RANK[LADDER[i - 1]!]!)))
  const listed = [...LADDER, LIST_WORD]
  check('the nearest-served resolution answers undefined for the list word even where the list carries it', pins.nearestSupportedWireEffort(LIST_WORD, listed) === undefined)
  check('…and max stays max on that list (never clamped by a word above it)', pins.nearestSupportedWireEffort('max', listed) === 'max')
  check('the delegation-lead word is the list word, read off a list verbatim', pins.DELEGATION_LEAD_LIST_WORD === LIST_WORD && pins.listMarksDelegationLead(listed) && !pins.listMarksDelegationLead([...LADDER]) && !pins.listMarksDelegationLead(undefined))
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

  check("the provider's list marks the rows that carry the word as able to lead delegation, and no other", capabilities.providerMarksDelegationLead('gpt-6-astra') && capabilities.providerMarksDelegationLead('gpt-5.6-nova') && !capabilities.providerMarksDelegationLead('gpt-5.6-sol') && !capabilities.providerMarksDelegationLead('claude-opus-5') && !capabilities.providerMarksDelegationLead('local/qwen3:8b'))
  check('the supercode summary carries the flag only when told, and never a wire word', effortModel.describeSupercodeMode({ providerMarksDelegationLead: true }).summary.endsWith(effortModel.DELEGATION_LEAD_NOTE) && !effortModel.describeSupercodeMode().summary.includes(effortModel.DELEGATION_LEAD_NOTE) && effortModel.describeSupercodeMode().pinsEffort === 'max')
  check("the slider's supercode line adds the flag from the capability edge", /providerMarksDelegationLead\(model\) \? ` · \$\{DELEGATION_LEAD_NOTE\}` : ''/.test(src('src/commands/effort/EffortSlider.tsx')))

  const WIRE_LIST = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  store.recordWireEffortRefusal({ modelId: 'gpt-6-astra', sourceKind: 'api-key', refused: 'max', levels: WIRE_LIST })
  check('a remembered refusal narrows the served row (max gone, ceiling xhigh) while the LISTED words and the flag stand', capabilities.getMaxSupportedEffortLevel('gpt-6-astra') === 'xhigh' && JSON.stringify(catalogue.liveGptListedEffortWords('gpt-6-astra')) === JSON.stringify([...LADDER, LIST_WORD]) && capabilities.providerMarksDelegationLead('gpt-6-astra'))
  store.noteWireEffortAccepted({ modelId: 'gpt-6-astra', sourceKind: 'api-key', word: 'max' })
  check('an accepted max clears the memory', store.readWireEffortVocabularies().length === 0 && capabilities.getMaxSupportedEffortLevel('gpt-6-astra') === 'max')
  catalogue.__resetOpenaiCatalogueForTest()
  delete process.env.OPENAI_API_KEY
  check('with no catalogue the flag is simply false (never an error)', !capabilities.providerMarksDelegationLead('gpt-6-astra'))
}

{
  console.log('\n— §5 · the receipt: a wire-refused word names the road and the re-probe —')
  const plain = effort.effortAdjustedReceiptLine({ model: 'gpt-5.5', name: 'GPT-5.5', asked: 'max', sent: 'xhigh' })
  check('a plain step-down names the model', plain === 'effort max is not served on GPT-5.5 today — sent xhigh', plain)
  const refused = effort.effortAdjustedReceiptLine({ model: 'gpt-6-astra', name: 'GPT-6 Astra', asked: 'max', sent: 'xhigh', wireRefused: { road: 'ChatGPT subscription', reprobeAfter: store.describeWireEffortProbeWindow() } })
  check('a wire-refused word names the road and the re-probe', refused === 'effort max: the wire refused it for GPT-6 Astra on the ChatGPT subscription road today — sent xhigh, the nearest word it serves; Mercury asks the wire again after a day', refused)
  check('the window words: a day · an hour · 3 hours · 2 days', store.describeWireEffortProbeWindow() === 'a day' && store.describeWireEffortProbeWindow(3_600_000) === 'an hour' && store.describeWireEffortProbeWindow(3 * 3_600_000) === '3 hours' && store.describeWireEffortProbeWindow(48 * 3_600_000) === '2 days')
  const lane = src('src/services/providers/openai/openaiCallModel.ts')
  check('the OpenAI lane stamps the road and the re-probe on a fresh refusal and on a remembered one (the listed word the served row lacks)', lane.includes('effortAdjusted = receiptOf(profile, true)') && lane.includes('wireRefused: { road: accountRoad, reprobeAfter: describeWireEffortProbeWindow() }') && lane.includes('const accountRoad = auth.account.label') && lane.includes('listedWords.includes(asked)'))
  check('the turn machine paints the line from the one owner', src('src/run-core/turn-machine.ts').includes('effortAdjustedReceiptLine(adjusted)'))
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
