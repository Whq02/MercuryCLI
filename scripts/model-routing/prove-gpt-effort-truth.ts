#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' GPT effort truth (display ≡ dispatch, nearest-below)')
console.log('============================================================')

const ROOT = join(import.meta.dir, '..', '..')
const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'OPENAI_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_OPENAI_API_BASE',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-gpt-effort-'))
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const { resolveGptReasoningProfile, refreshOpenaiCatalogue, __resetOpenaiCatalogueForTest } = catalogue
const capabilities = await import('../../src/utils/model/capabilities.js')
const effort = await import('../../src/utils/effort.js')

const liveModel = (efforts: string[], def?: string) =>
  ({
    id: 'gpt-5.6-sol',
    supportedReasoningEfforts: efforts,
    ...(def ? { defaultReasoningEffort: def } : {}),
  }) as Parameters<typeof resolveGptReasoningProfile>[1]

{
  console.log('\n— 1 · resolveGptReasoningProfile nearest-below —')
  const full = liveModel(['low', 'medium', 'high', 'xhigh', 'max'], 'low')
  const p1 = resolveGptReasoningProfile('max', full)
  check("supported 'max' passes through as the user's choice", p1.wireEffort === 'max' && p1.source === 'user')

  const noMax = liveModel(['low', 'medium', 'high', 'xhigh'], 'medium')
  const p2 = resolveGptReasoningProfile('max', noMax)
  check(
    "'max' on a low…xhigh vocabulary steps DOWN to 'xhigh' (never the default)",
    p2.wireEffort === 'xhigh' && p2.source === 'unsupported-fallback' && p2.adjustedFrom === 'max',
    JSON.stringify(p2),
  )

  const lowHigh = liveModel(['low', 'medium', 'high'], 'medium')
  const p3 = resolveGptReasoningProfile('xhigh', lowHigh)
  check("'xhigh' on a low…high vocabulary steps down to 'high'", p3.wireEffort === 'high')

  const deepOnly = liveModel(['high', 'xhigh'], 'high')
  const p4 = resolveGptReasoningProfile('low', deepOnly)
  check("a request BELOW the vocabulary floor rises to the floor ('high')", p4.wireEffort === 'high')

  const p5 = resolveGptReasoningProfile('banana', lowHigh)
  check("an unrankable request falls to the live default (visible note)", p5.wireEffort === 'medium' && p5.source === 'unsupported-fallback')

  const empty = liveModel([])
  const p6 = resolveGptReasoningProfile('max', empty)
  check('an empty vocabulary omits the wire key (server default)', p6.wireEffort === undefined)

  const p7 = resolveGptReasoningProfile(undefined, full)
  check("no request ⇒ the model default ('low'), source 'model-default'", p7.wireEffort === 'low' && p7.source === 'model-default')

  const six = liveModel(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium')
  const p8 = resolveGptReasoningProfile('ultra', six)
  check("a served 'ultra' passes through as the user's choice", p8.wireEffort === 'ultra' && p8.source === 'user', JSON.stringify(p8))
  const p9 = resolveGptReasoningProfile('ultra', full)
  check("'ultra' on a low…max vocabulary steps DOWN to 'max' with the adjustment named", p9.wireEffort === 'max' && p9.source === 'unsupported-fallback' && p9.adjustedFrom === 'ultra', JSON.stringify(p9))
}

{
  console.log('\n— 2 · Anthropic rows untouched —')
  __resetOpenaiCatalogueForTest()
  check('Anthropic rows untouched: opus-4-8 max cap', capabilities.modelSupportsMaxEffort('claude-opus-4-8'))
  check('Anthropic rows untouched: haiku has no effort', !capabilities.modelSupportsEffort('claude-haiku-4-5-20251001'))
}

{
  console.log('\n— 3 · catalogue unfetched: full-ladder offering —')
  process.env.OPENAI_API_KEY = 'prover-key'
  __resetOpenaiCatalogueForTest()
  check('unfetched gpt: max cap TRUE (offering; dispatch re-validates live)', capabilities.modelSupportsMaxEffort('gpt-5.6-sol'))
  check('any gpt id: the same full offering (max + xhigh TRUE unfetched)', capabilities.modelSupportsMaxEffort('gpt-5.5') && capabilities.modelSupportsXHighEffort('gpt-5.5'))
}

{
  console.log('\n— 4 · live catalogue: display ≡ dispatch —')
  const fixtureFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'], default_reasoning_level: 'low' },
          { id: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'], default_reasoning_level: 'medium' },
          { id: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list', priority: 3, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium' },
          { id: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', priority: 4, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_reasoning_level: 'medium' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
  __resetOpenaiCatalogueForTest()
  await refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fixtureFetch })

  check('Sol (live max) supports max', capabilities.modelSupportsMaxEffort('gpt-5.6-sol'))
  check('Terra (live …xhigh) supports xhigh, not max', capabilities.modelSupportsXHighEffort('gpt-5.6-terra') && !capabilities.modelSupportsMaxEffort('gpt-5.6-terra'))
  check('Luna (live …high) supports neither xhigh nor max', !capabilities.modelSupportsXHighEffort('gpt-5.6-luna') && !capabilities.modelSupportsMaxEffort('gpt-5.6-luna'))
  check('ceilings: sol=max · terra=xhigh · luna=high',
    capabilities.getMaxSupportedEffortLevel('gpt-5.6-sol') === 'max' &&
    capabilities.getMaxSupportedEffortLevel('gpt-5.6-terra') === 'xhigh' &&
    capabilities.getMaxSupportedEffortLevel('gpt-5.6-luna') === 'high')
  check("Sol's Mercury-ladder default follows the LIVE default ('low')", capabilities.gptModelDefaultEffort('gpt-5.6-sol') === 'low')
  check('Astra (live …ultra) serves ultra, Sol (live …max) does not, and the ceilings say so', capabilities.modelOffersEffortLevel('gpt-6-astra', 'ultra') && !capabilities.modelOffersEffortLevel('gpt-5.6-sol', 'ultra') && capabilities.getMaxSupportedEffortLevel('gpt-6-astra') === 'ultra')
  check("applied 'ultra' on Astra stays 'ultra'; on Sol it steps to 'max'; on Luna to 'high'", effort.resolveAppliedEffort('gpt-6-astra', 'ultra') === 'ultra' && effort.resolveAppliedEffort('gpt-5.6-sol', 'ultra') === 'max' && effort.resolveAppliedEffort('gpt-5.6-luna', 'ultra') === 'high')
  check('DISPLAY ≡ DISPATCH on Astra at ultra', effort.getDisplayedEffortLevel('gpt-6-astra', 'ultra') === 'ultra' && resolveGptReasoningProfile('ultra', liveModel(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium')).wireEffort === 'ultra')
  check("the 'ultra' description names the GPT family when a live vocabulary serves it", effort.getEffortLevelDescription('ultra').includes('GPT'), effort.getEffortLevelDescription('ultra'))

  check("applied 'max' on Sol stays 'max' (the reported bug: it clamped to high)", effort.resolveAppliedEffort('gpt-5.6-sol', 'max') === 'max')
  check("applied 'max' on Terra steps to 'xhigh' (never straight past it)", effort.resolveAppliedEffort('gpt-5.6-terra', 'max') === 'xhigh')
  check("applied 'max' on Luna steps to 'high'", effort.resolveAppliedEffort('gpt-5.6-luna', 'max') === 'high')
  check("no effort set on Sol ⇒ applied = the LIVE default 'low' (display was claiming 'high')", effort.resolveAppliedEffort('gpt-5.6-sol', undefined) === 'low')

  const displayedSol = effort.getDisplayedEffortLevel('gpt-5.6-sol', 'max')
  const wireSol = resolveGptReasoningProfile('max', liveModel(['low', 'medium', 'high', 'xhigh', 'max'], 'low'))
  check('DISPLAY ≡ DISPATCH on Sol at max', displayedSol === 'max' && wireSol.wireEffort === 'max')
  const displayedTerra = effort.getDisplayedEffortLevel('gpt-5.6-terra', 'max')
  const wireTerra = resolveGptReasoningProfile(String(effort.resolveAppliedEffort('gpt-5.6-terra', 'max')), liveModel(['low', 'medium', 'high', 'xhigh'], 'medium'))
  check('DISPLAY ≡ DISPATCH on Terra at max (both xhigh)', displayedTerra === 'xhigh' && wireTerra.wireEffort === 'xhigh' && wireTerra.source === 'user')

  check('effort ceiling on Sol is max', effort.getMaxSupportedEffortLevel('gpt-5.6-sol') === 'max')
  check('effort ceiling on Terra is xhigh', effort.getMaxSupportedEffortLevel('gpt-5.6-terra') === 'xhigh')

  check("the 'max' description names the GPT family when a live vocabulary serves it", effort.getEffortLevelDescription('max').includes('GPT'), effort.getEffortLevelDescription('max'))
}

{
  console.log('\n— 5 · turn-machine byline stamp —')
  const src = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  check(
    'the pulse stamp rides the resolution owner LABEL (truthful for out-of-ladder tiers + omitted keys), never the raw appState value',
    src.includes('const truth = resolveEffortTruth(iter.currentModel, effortValue, { agentId: toolUseContext.agentId })') &&
      src.includes("const effortLabel = truth.wire === undefined ? undefined : truth.label") &&
      /notePulseModel\(iter\.currentModel, effortLabel\)/.test(src),
  )
}

{
  console.log('\n— 6 · the FULL provider vocabulary rides the resolution; the served top rung is selectable —')
  const ultraFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_reasoning_level: 'ultra' },
          { id: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list', priority: 3, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
  __resetOpenaiCatalogueForTest()
  await refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: ultraFetch })

  const solTruth = effort.resolveEffortTruth('gpt-5.6-sol', undefined)
  check(
    "EF-09 prep: providerVocabulary carries the FULL ordered vocabulary including 'ultra' (un-intersected)",
    JSON.stringify(solTruth.providerVocabulary) === JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    `got ${JSON.stringify(solTruth.providerVocabulary)}`,
  )
  check(
    "`selectable` (what controls OFFER) reaches the served top: 'ultra' is a stop on the row that serves it, directly above max",
    solTruth.selectable.includes('ultra') && solTruth.selectable.indexOf('ultra') === solTruth.selectable.indexOf('max') + 1,
    JSON.stringify(solTruth.selectable),
  )
  check(
    "EF-03 shape: a provider default of 'ultra' is REPRESENTED coherently — wire sends it, label shows it, applied is the ladder word, providerDefault records it",
    solTruth.wire === 'ultra' &&
      solTruth.label === 'ultra' &&
      solTruth.applied === 'ultra' &&
      solTruth.providerDefault === 'ultra',
    `wire=${String(solTruth.wire)} label=${solTruth.label} providerDefault=${String(solTruth.providerDefault)}`,
  )
  const lunaTruth = effort.resolveEffortTruth('gpt-5.6-luna', undefined)
  check(
    'EF-01: a ladder-terminal vocabulary carries no ultra anywhere (vocabulary, selectable, default)',
    JSON.stringify(lunaTruth.providerVocabulary) === JSON.stringify(['low', 'medium', 'high']) &&
      !lunaTruth.selectable.includes('max') &&
      !lunaTruth.selectable.includes('ultra') &&
      lunaTruth.providerDefault === 'medium',
  )
  const stepDown = effort.resolveEffortTruth('gpt-5.6-luna', 'max')
  check(
    'EF-07: requested / applied / wire / adjustedFrom stay SEPARATE facts through a step-down',
    stepDown.requested === 'max' &&
      stepDown.wire === 'high' &&
      stepDown.applied === 'high' &&
      stepDown.adjustedFrom === 'max',
    `req=${String(stepDown.requested)} wire=${String(stepDown.wire)} adj=${String(stepDown.adjustedFrom)}`,
  )

  __resetOpenaiCatalogueForTest()
  const unavailable = effort.resolveEffortTruth('gpt-5.6-sol', 'max')
  check(
    'EF-04: catalogue unavailable ⇒ the wire omits the key (no blind send) and providerVocabulary stays ABSENT (never invented)',
    unavailable.wire === undefined && unavailable.providerVocabulary === undefined,
    `catalogue=${unavailable.catalogue} wire=${String(unavailable.wire)}`,
  )

  const slider = readFileSync(join(ROOT, 'src/commands/effort/EffortSlider.tsx'), 'utf8')
  check(
    'EF-06: the slider derives its base stops from the ladder owner (ultra among them, stamped from the vocabulary) and supercode rides max-support (separate mode, never masquerading)',
    slider.includes('EFFORT_LEVELS.map(level => ({') &&
      slider.includes("ultra: 'blaze'") &&
      slider.includes('supported: vocabulary.has(String(tier.value))') &&
      /modelSupportsMaxEffort\(model\)[\s\S]{0,400}value: 'supercode'/.test(slider),
  )

  const effortSrc = readFileSync(join(ROOT, 'src/utils/effort.ts'), 'utf8')
  const attachmentSrc = readFileSync(join(ROOT, 'src/utils/messages/attachmentText.ts'), 'utf8')
  check(
    "EF-11: the settings copy names the prompt-level nudge and no longer promises \"the model's deepest effort\"",
    effortSrc.includes('prompt-level nudge') && !effortSrc.includes("the model's deepest effort"),
  )
  check(
    'EF-11: the nudge mechanism exists at the attachment renderer (deepthink rendered into the turn, wire untouched)',
    attachmentSrc.includes("'deepthink_effort'") && attachmentSrc.includes('keyword "deepthink"'),
  )
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
__resetOpenaiCatalogueForTest()

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('ALL GPT EFFORT-TRUTH PROOFS PASS')
else console.log(`${failures} GPT EFFORT-TRUTH PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
