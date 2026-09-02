#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-gpt-effort-truth.ts
//  PROOF (the GPT effort-truth fix — live-found on a Sol session:
//  /effort max showed "thinking · max" in the hero byline while the statusbar
//  chip said '● high' and the wire could silently run the MODEL DEFAULT).
//
//  The law: DISPLAY truth ≡ DISPATCH truth for gpt-* effort, resolved from
//  the ONE live per-model vocabulary.
//    1. resolveGptReasoningProfile maps order-aware NEAREST-BELOW — a raised
//       effort steps down to the deepest supported tier, never the default.
//    2. capabilities.ts effort predicates consult the LIVE vocabulary for
//       gpt ids (full-ladder OFFERING while unfetched — dispatch re-validates
//       live; the era per-generation cap died with the ≥5.6 floor,
//
//    3. resolveAppliedEffort steps max→xhigh when xhigh is supported (the
//       gpt-5.5-class vocabulary), and gpt defaults follow the LIVE default
//       ('low' for Sol) — the displayed level equals what the wire sends.
//    4. The pulse byline stamps the APPLIED effort (source pin on the
//       turn-machine stamp — the max-on-top/high-on-bottom class).
//    5. The max/xhigh copy labels name GPT only when a live vocabulary
//       actually serves the level.
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-gpt-effort-truth.ts
// ============================================================================
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
// Ambient-state law: any accidental real fetch dies on an unroutable port.
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

// ── 1. the pure nearest-below mapping ───────────────────────────────────────
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
}

// ── 2. Anthropic rows untouched by the engine lanes ─────────────────────────
{
  console.log('\n— 2 · Anthropic rows untouched —')
  __resetOpenaiCatalogueForTest()
  check('Anthropic rows untouched: opus-4-8 max cap', capabilities.modelSupportsMaxEffort('claude-opus-4-8'))
  check('Anthropic rows untouched: haiku has no effort', !capabilities.modelSupportsEffort('claude-haiku-4-5-20251001'))
}

// ── 3. catalogue unfetched: the full-ladder offering fallback ───────────────
{
  console.log('\n— 3 · catalogue unfetched: full-ladder offering —')
  process.env.OPENAI_API_KEY = 'prover-key'
  __resetOpenaiCatalogueForTest()
  check('unfetched gpt: max cap TRUE (offering; dispatch re-validates live)', capabilities.modelSupportsMaxEffort('gpt-5.6-sol'))
  // Every gpt id gets the same offering while live truth is unavailable —
  // the old per-generation cap restated a dated observation as a rule and
  // died with the ≥5.6 floor.
  check('any gpt id: the same full offering (max + xhigh TRUE unfetched)', capabilities.modelSupportsMaxEffort('gpt-5.5') && capabilities.modelSupportsXHighEffort('gpt-5.5'))
}

// ── 4. the LIVE vocabulary drives display ≡ dispatch ────────────────────────
{
  console.log('\n— 4 · live catalogue: display ≡ dispatch —')
  const fixtureFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'], default_reasoning_level: 'low' },
          { id: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'], default_reasoning_level: 'medium' },
          { id: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list', priority: 3, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium' },
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

  // resolveAppliedEffort: the step-down law + the live default.
  check("applied 'max' on Sol stays 'max' (the reported bug: it clamped to high)", effort.resolveAppliedEffort('gpt-5.6-sol', 'max') === 'max')
  check("applied 'max' on Terra steps to 'xhigh' (never straight past it)", effort.resolveAppliedEffort('gpt-5.6-terra', 'max') === 'xhigh')
  check("applied 'max' on Luna steps to 'high'", effort.resolveAppliedEffort('gpt-5.6-luna', 'max') === 'high')
  check("no effort set on Sol ⇒ applied = the LIVE default 'low' (display was claiming 'high')", effort.resolveAppliedEffort('gpt-5.6-sol', undefined) === 'low')

  // Displayed level ≡ what the wire profile sends for the SAME vocabulary.
  const displayedSol = effort.getDisplayedEffortLevel('gpt-5.6-sol', 'max')
  const wireSol = resolveGptReasoningProfile('max', liveModel(['low', 'medium', 'high', 'xhigh', 'max'], 'low'))
  check('DISPLAY ≡ DISPATCH on Sol at max', displayedSol === 'max' && wireSol.wireEffort === 'max')
  const displayedTerra = effort.getDisplayedEffortLevel('gpt-5.6-terra', 'max')
  const wireTerra = resolveGptReasoningProfile(String(effort.resolveAppliedEffort('gpt-5.6-terra', 'max')), liveModel(['low', 'medium', 'high', 'xhigh'], 'medium'))
  check('DISPLAY ≡ DISPATCH on Terra at max (both xhigh)', displayedTerra === 'xhigh' && wireTerra.wireEffort === 'xhigh' && wireTerra.source === 'user')

  // Ceiling truth survives the floor retirement: the
  // vocabulary ceilings stay live facts even though the ultrathink keyword
  // no longer touches effort (prose-only nudge).
  check('effort ceiling on Sol is max', effort.getMaxSupportedEffortLevel('gpt-5.6-sol') === 'max')
  check('effort ceiling on Terra is xhigh', effort.getMaxSupportedEffortLevel('gpt-5.6-terra') === 'xhigh')

  // Copy labels name GPT only from live truth.
  // The label is generation-neutral ('GPT') — which GPT models take max is
  // the live catalogue's per-model answer, never a pinned era label.
  check("the 'max' description names the GPT family when a live vocabulary serves it", effort.getEffortLevelDescription('max').includes('GPT'), effort.getEffortLevelDescription('max'))
}

// ── 5. the byline stamps the APPLIED effort (source pin) ────────────────────
{
  console.log('\n— 5 · turn-machine byline stamp —')
  const src = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  check(
    'the pulse stamp rides the resolution owner LABEL (truthful for out-of-ladder tiers + omitted keys), never the raw appState value',
    src.includes('const truth = resolveEffortTruth(iter.currentModel, effortValue)') &&
      src.includes("const effortLabel = truth.wire === undefined ? undefined : truth.label") &&
      /notePulseModel\(iter\.currentModel, effortLabel\)/.test(src),
  )
}

// ── 6..5.6 — provider vocabulary beyond the ladder ──────
{
  console.log('\n— 6 · EF prep: the FULL provider vocabulary rides the resolution —')
  // The ultra-terminal fixture: whether a live source ever advertises literal
  // 'ultra' is UNKNOWN until the EF-08 capture — this fixture proves the
  // RESOLUTION carries whatever the provider states, without the shared
  // ladder truncating the record.
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
    "EF-09 prep: `selectable` (what controls OFFER today) still ends at the shared ladder — 'ultra' becomes offerable only when the EF-08 capture verifies it",
    !solTruth.selectable.includes('ultra' as never) && solTruth.selectable.includes('max'),
  )
  check(
    "EF-03 shape: a provider default of 'ultra' is REPRESENTED coherently — wire sends it, label shows it, applied is honestly out-of-ladder, providerDefault records it",
    solTruth.wire === 'ultra' &&
      solTruth.label === 'ultra' &&
      solTruth.applied === undefined &&
      solTruth.providerDefault === 'ultra',
    `wire=${String(solTruth.wire)} label=${solTruth.label} providerDefault=${String(solTruth.providerDefault)}`,
  )
  const lunaTruth = effort.resolveEffortTruth('gpt-5.6-luna', undefined)
  check(
    'EF-01: a ladder-terminal vocabulary carries no ultra anywhere (vocabulary, selectable, default)',
    JSON.stringify(lunaTruth.providerVocabulary) === JSON.stringify(['low', 'medium', 'high']) &&
      !lunaTruth.selectable.includes('max') &&
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

  // EF-04: catalogue unavailable ⇒ never a blind send, and no invented
  // vocabulary on the resolution.
  __resetOpenaiCatalogueForTest()
  const unavailable = effort.resolveEffortTruth('gpt-5.6-sol', 'max')
  check(
    'EF-04: catalogue unavailable ⇒ the wire omits the key (no blind send) and providerVocabulary stays ABSENT (never invented)',
    unavailable.wire === undefined && unavailable.providerVocabulary === undefined,
    `catalogue=${unavailable.catalogue} wire=${String(unavailable.wire)}`,
  )

  // EF-06: supercode stays a separate orchestration mode — the slider's
  // extra stop exists only under max-SUPPORT and no surface offers a
  // literal 'ultra' effort value.
  const slider = readFileSync(join(ROOT, 'src/commands/effort/EffortSlider.tsx'), 'utf8')
  check(
    "EF-06: the slider never offers literal 'ultra' and supercode rides max-support (separate mode, never masquerading)",
    !slider.includes("'ultra'") &&
      /modelSupportsMaxEffort\(model\)[\s\S]{0,400}value: 'supercode'/.test(slider),
  )

  // EF-11: the deepthink copy tells the prose-nudge TRUTH (the mechanism
  // lives at the attachment renderer; the wire effort is untouched).
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

// Restore the ambient env exactly.
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
