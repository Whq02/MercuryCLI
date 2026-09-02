#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-calibre-effort-matrix.ts
// the model-effort truth matrix.
//
//  THE LAW: every surface that claims an effort level reports the effort the
//  selected model will actually run, and that agrees with the outgoing
//  provider request — resolved by ONE typed owner (utils/effort.ts
//  resolveEffortTruth). Operator intent stays distinct (requested/
//  adjustedFrom); raw intent is never labelled as the applied value; controls
//  offer only the selected model's resolved vocabulary.
//
//  RED evidence:
//    · env=auto on Sol w/ intent max: displayed 'high' · wire 'max' (H3)
//    · env=medium on Sol w/ intent max: displayed 'medium' · wire 'max' (H3)
//    · out-of-ladder live default: displayed 'medium' · wire 'minimal' (H4)
//    · stated-empty vocabulary: display claimed max · wire sent the default;
//      bare row: display claimed max · wire omitted (H2)
//    · catalogue unavailable: displayed 'max' · wire omitted
//    · Sonnet 4.6: slider/picker offered xhigh, dispatch ran high (H1)
//    · glm-5.2: displayed 'high' while the wire honored 'max' (GLM sibling)
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-calibre-effort-matrix.ts
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
console.log(' calibre — the model-effort truth matrix (one typed owner)')
console.log('============================================================')

const ROOT = join(import.meta.dir, '..', '..')
// FIXTURE ISOLATION (the ambient-state law): env, config home, catalogue
// cache — nothing reads the operator's machine; accidental fetches die on an
// unroutable port.
const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_OPENAI_API_BASE',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-calibre-effort-'))
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const { resolveGptReasoningProfile, refreshOpenaiCatalogue, __resetOpenaiCatalogueForTest } = catalogue
const capabilities = await import('../../src/utils/model/capabilities.js')
const effort = await import('../../src/utils/effort.js')
const effortCmd = await import('../../src/commands/effort/effort.js')
const glmPins = await import('../../src/services/providers/zai/glmPins.js')

type LiveModel = Parameters<typeof resolveGptReasoningProfile>[1]

// The live-shaped catalogue: three current-fixture vocabularies (max-top ·
// xhigh-top · high-top), an out-of-ladder-default model, a stated-empty
// model, a bare (vocabulary-unstated) model, and a deep-only floor model.
const CATALOGUE_ROWS = [
  { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'], default_reasoning_level: 'low' },
  { id: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'], default_reasoning_level: 'medium' },
  { id: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list', priority: 3, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium' },
  { id: 'gpt-5.6-nox', display_name: 'GPT-5.6 Nox', visibility: 'list', priority: 4, supported_reasoning_levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_reasoning_level: 'minimal' },
  { id: 'gpt-5.6-void', display_name: 'GPT-5.6 Void', visibility: 'list', priority: 5, supported_reasoning_levels: [], default_reasoning_level: 'medium' },
  { id: 'gpt-5.6-bare', display_name: 'GPT-5.6 Bare', visibility: 'list', priority: 6 },
  { id: 'gpt-5.6-deep', display_name: 'GPT-5.6 Deep', visibility: 'list', priority: 7, supported_reasoning_levels: ['high', 'xhigh'], default_reasoning_level: 'high' },
]
const fixtureFetch: typeof fetch = (async () =>
  new Response(JSON.stringify({ data: CATALOGUE_ROWS }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch

async function armWithCatalogue(): Promise<void> {
  process.env.OPENAI_API_KEY = 'prover-key'
  __resetOpenaiCatalogueForTest()
  await refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fixtureFetch })
}
function liveRow(id: string): LiveModel {
  const snap = catalogue.getCachedOpenaiCatalogue('api-key')
  const row = snap?.models.find(m => m.id === id)
  if (!row) throw new Error(`fixture row missing: ${id}`)
  return row
}
function clearEffortEnv(): void {
  delete process.env.MERCURY_EFFORT_LEVEL
}

// ── 1 · OWNER ≡ WIRE across the request grid (every vocabulary) ─────────────
{
  console.log('\n— 1 · owner.wire ≡ resolveGptReasoningProfile across the grid —')
  await armWithCatalogue()
  clearEffortEnv()
  const MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-nox', 'gpt-5.6-void', 'gpt-5.6-bare', 'gpt-5.6-deep']
  const REQUESTS: Array<string | undefined> = [undefined, 'low', 'medium', 'high', 'xhigh', 'max']
  let mismatches = 0
  for (const model of MODELS) {
    for (const requested of REQUESTS) {
      const truth = effort.resolveEffortTruth(model, requested as never)
      const projected = effort.resolveWireRequestedEffort(model, requested as never)
      const profile = resolveGptReasoningProfile(projected, liveRow(model))
      if (truth.wire !== profile.wireEffort) {
        mismatches++
        console.log(`    MISMATCH ${model} req=${String(requested)}: owner=${String(truth.wire)} profile=${String(profile.wireEffort)}`)
      }
      // The truthful label: the wire tier verbatim; 'default' when a model
      // WITH a dial omits the key; the one absence word when the model has
      // no effort control at all (a stated-empty vocabulary).
      const expectedLabel =
        profile.wireEffort ?? (capabilities.modelSupportsEffort(model) ? 'default' : effort.NO_EFFORT_CONTROL_LABEL)
      if (truth.label !== expectedLabel) {
        mismatches++
        console.log(`    LABEL MISMATCH ${model} req=${String(requested)}: label=${truth.label} wire=${String(profile.wireEffort)}`)
      }
    }
  }
  check('owner wire + label ≡ the wire profile for every (model × request) cell', mismatches === 0, `${mismatches} mismatches`)

  const t = effort.resolveEffortTruth('gpt-5.6-terra', 'max')
  check("unsupported-above: max on Terra steps to xhigh with adjustedFrom='max'", t.wire === 'xhigh' && t.adjustedFrom === 'max' && t.label === 'xhigh')
  const d = effort.resolveEffortTruth('gpt-5.6-deep', 'low')
  check("below the vocabulary floor: low on a high…xhigh vocabulary RISES to 'high' (display AND wire)", d.wire === 'high' && d.label === 'high' && d.adjustedFrom === 'low')
  check('display level agrees (deep, low → high)', effort.getDisplayedEffortLevel('gpt-5.6-deep', 'low') === 'high')
  const abs = effort.resolveEffortTruth('gpt-5.6-sol', undefined)
  check("absent request: Sol runs the LIVE default 'low' — displayed, labelled, wired", abs.wire === 'low' && abs.label === 'low' && effort.getDisplayedEffortLabel('gpt-5.6-sol', undefined) === 'low')
}

// ── 2 · env spellings: auto/unset/explicit — one documented meaning ─────────
{
  console.log('\n— 2 · env MERCURY_EFFORT_LEVEL: auto · unset · explicit —')
  await armWithCatalogue()
  for (const spelling of ['auto', 'unset']) {
    process.env.MERCURY_EFFORT_LEVEL = spelling
    const truth = effort.resolveEffortTruth('gpt-5.6-sol', 'max')
    check(
      `env=${spelling} on Sol (intent max): defer to the model default — wire 'low', label 'low', source env-suppressed`,
      truth.wire === 'low' && truth.label === 'low' && truth.requestedSource === 'env-suppressed',
      JSON.stringify({ wire: truth.wire, label: truth.label, src: truth.requestedSource }),
    )
    check(
      `env=${spelling}: the wire request projection is undefined (model default)`,
      effort.resolveWireRequestedEffort('gpt-5.6-sol', 'max') === undefined,
    )
    const anth = effort.resolveEffortTruth('claude-opus-4-8', 'max')
    check(
      `env=${spelling} on Anthropic: the param is OMITTED and the display says the documented API default 'high'`,
      anth.wire === undefined && anth.label === 'high',
    )
    clearEffortEnv()
  }
  process.env.MERCURY_EFFORT_LEVEL = 'medium'
  const pinned = effort.resolveEffortTruth('gpt-5.6-sol', 'max')
  check("env=medium beats the session value on the GPT wire (was: env never consulted)", pinned.wire === 'medium' && pinned.requestedSource === 'env')
  check('env=medium reaches the wire request projection', effort.resolveWireRequestedEffort('gpt-5.6-sol', 'max') === 'medium')
  clearEffortEnv()
}

// ── 3 · H4: an out-of-ladder provider default is NAMED, never relabelled ────
{
  console.log('\n— 3 · out-of-ladder default (Nox: minimal) —')
  await armWithCatalogue()
  clearEffortEnv()
  const truth = effort.resolveEffortTruth('gpt-5.6-nox', undefined)
  check("Nox absent request: wire 'minimal' and the LABEL names it (was: display claimed 'medium')", truth.wire === 'minimal' && truth.label === 'minimal')
  check("getDisplayedEffortLabel names 'minimal'", effort.getDisplayedEffortLabel('gpt-5.6-nox', undefined) === 'minimal')
  check('getDefaultEffortForModel never invents a ladder default for an armed gpt id', effort.getDefaultEffortForModel('gpt-5.6-nox') === undefined)
  check('the ladder-typed level projection stays in-ladder (symbols)', effort.getDisplayedEffortLevel('gpt-5.6-nox', undefined) === 'high')
}

// ── 4 · H2: the four vocabulary states stay distinct ────────────────────────
{
  console.log('\n— 4 · vocabulary states: live · known-empty · unstated · unavailable —')
  await armWithCatalogue()
  clearEffortEnv()
  check('live (Sol): effort supported, selectable = the full stated ladder', capabilities.modelSupportsEffort('gpt-5.6-sol') && effort.selectableEffortLevels('gpt-5.6-sol').join(',') === 'low,medium,high,xhigh,max')
  check('known-empty (Void): effort NOT selectable — no control, no capability claim', !capabilities.modelSupportsEffort('gpt-5.6-void') && effort.selectableEffortLevels('gpt-5.6-void').length === 0)
  const voidTruth = effort.resolveEffortTruth('gpt-5.6-void', 'max')
  const voidProfile = resolveGptReasoningProfile('max', liveRow('gpt-5.6-void'))
  check("known-empty: the wire OMITS the key even with a stated default (the one absence word ≡ dispatch omit)", voidTruth.wire === undefined && voidTruth.label === effort.NO_EFFORT_CONTROL_LABEL && voidProfile.wireEffort === undefined)
  const bareTruth = effort.resolveEffortTruth('gpt-5.6-bare', 'max')
  const bareProfile = resolveGptReasoningProfile(effort.resolveWireRequestedEffort('gpt-5.6-bare', 'max'), liveRow('gpt-5.6-bare'))
  check("unstated (Bare): banked OFFERING but the wire omits and the label says 'default'", capabilities.modelSupportsEffort('gpt-5.6-bare') && bareTruth.wire === undefined && bareTruth.label === 'default' && bareProfile.wireEffort === undefined)
  check('unstated: catalogue state is named', bareTruth.catalogue === 'gpt-unstated')
  __resetOpenaiCatalogueForTest()
  const unavail = effort.resolveEffortTruth('gpt-5.6-sol', 'max')
  check("unavailable (unfetched): applied claim is honestly 'default' (was: banked 'max' while the degraded wire omitted)", unavail.wire === undefined && unavail.label === 'default' && unavail.catalogue === 'gpt-unavailable')
  check('unavailable: the full-ladder offering survives for controls', effort.selectableEffortLevels('gpt-5.6-sol').join(',') === 'low,medium,high,xhigh,max')
  // Every gpt id offers the full ladder while live truth is unavailable —
  // the wire re-validates at dispatch and names adjustments. (The old
  // per-generation cap here died with the ≥5.6 floor, it
  // restated a dated observation as a rule.)
  check('unavailable: any gpt id offers the same full ladder (dispatch re-validates live)', effort.selectableEffortLevels('gpt-5.5').join(',') === 'low,medium,high,xhigh,max')
}

// ── 5 · sequential model switching (intent survives, every claim resolved) ──
{
  console.log('\n— 5 · switching Sol → Terra → Luna → Terra → Sol at intent max —')
  await armWithCatalogue()
  clearEffortEnv()
  const intent = 'max'
  const expect: Array<[string, string]> = [
    ['gpt-5.6-sol', 'max'],
    ['gpt-5.6-terra', 'xhigh'],
    ['gpt-5.6-luna', 'high'],
    ['gpt-5.6-terra', 'xhigh'],
    ['gpt-5.6-sol', 'max'],
  ]
  let ok = true
  for (const [model, want] of expect) {
    const truth = effort.resolveEffortTruth(model, intent)
    const profile = resolveGptReasoningProfile(effort.resolveWireRequestedEffort(model, intent), liveRow(model))
    if (truth.label !== want || profile.wireEffort !== want || effort.getDisplayedEffortLabel(model, intent) !== want) {
      ok = false
      console.log(`    ${model}: label=${truth.label} wire=${String(profile.wireEffort)} want=${want}`)
    }
  }
  check('the persisted intent maps to the applied truth at every hop — display ≡ wire, and switching BACK restores max', ok)
  check('Anthropic hop keeps its law: xhigh on sonnet-4-6 steps to high (mid-ladder hole), max passes, back on opus-4-8 xhigh runs', effort.resolveAppliedEffort('claude-sonnet-4-6', 'xhigh') === 'high' && effort.resolveAppliedEffort('claude-sonnet-4-6', 'max') === 'max' && effort.resolveAppliedEffort('claude-opus-4-8', 'xhigh') === 'xhigh')
}

// ── 6 · controls derive their stops from the resolved vocabulary ────────────
{
  console.log('\n— 6 · controls: selectable stops · cycle · slider geometry —')
  await armWithCatalogue()
  clearEffortEnv()
  check('sonnet-4-6 selectable skips xhigh (max-yes/xhigh-no)', effort.selectableEffortLevels('claude-sonnet-4-6').join(',') === 'low,medium,high,max')
  check('opus-4-8 selectable is the full ladder', effort.selectableEffortLevels('claude-opus-4-8').join(',') === 'low,medium,high,xhigh,max')
  check('haiku selectable is empty (no effort axis)', effort.selectableEffortLevels('claude-haiku-4-5-20251001').length === 0)
  check('Terra selectable tops at xhigh', effort.selectableEffortLevels('gpt-5.6-terra').join(',') === 'low,medium,high,xhigh')
  check("cycle on sonnet-4-6 skips xhigh: high →right→ max", effort.cycleSelectableEffort('claude-sonnet-4-6', 'high', 'right') === 'max')
  check("cycle on sonnet-4-6: max →left→ high (never xhigh)", effort.cycleSelectableEffort('claude-sonnet-4-6', 'max', 'left') === 'high')
  check("cycle on Terra never lands on max: xhigh →right→ low (wrap)", effort.cycleSelectableEffort('gpt-5.6-terra', 'xhigh', 'right') === 'low')
  check("an out-of-vocabulary current ('max' on Terra) enters at its applied projection", effort.cycleSelectableEffort('gpt-5.6-terra', 'max', 'left') === 'high')

  // The slider geometry is a real-control derivation: unsupported stops are
  // absent + skipped (structural: the component consumes the owner).
  const sliderSrc = readFileSync(join(ROOT, 'src/commands/effort/EffortSlider.tsx'), 'utf8')
  check('EffortSlider stamps stops from selectableEffortLevels', sliderSrc.includes('selectableEffortLevels(model)') && sliderSrc.includes('supported: vocabulary.has'))
  check('EffortSlider navigation skips unsupported stops', sliderSrc.includes('const slide') && sliderSrc.includes('!geo.levels[next]?.supported'))
  const pickerSrc = readFileSync(join(ROOT, 'src/components/ModelPicker.tsx'), 'utf8')
  check('ModelPicker cycles through cycleSelectableEffort (the global full-axis cycle is dead)', pickerSrc.includes('cycleSelectableEffort(') && !pickerSrc.includes('function cycleEffortLevel('))
  check('ModelPicker row claims the owner label (no local max→high clamp)', pickerSrc.includes('resolveEffortTruth(') && !pickerSrc.includes('effort === "max" && !focusedSupportsMax'))
  const hermesModelSrc = readFileSync(join(ROOT, 'src/commands/model/mercuryModel.tsx'), 'utf8')
  check('/model efforts row derives from selectableEffortLevels', hermesModelSrc.includes('selectableEffortLevels(liveModel)'))
}

// ── 7 · /effort receipts: intent named, applied truth stated once ───────────
{
  console.log('\n— 7 · /effort confirmation + readout truth —')
  await armWithCatalogue()
  clearEffortEnv()
  // Receipt-copy pins re-cut onto the landed rewrite spellings ("Effort set
  // to max …" / "Effort is automatic — currently …") — same invariants: the
  // adjusted tier is stated exactly once, an exact application carries no
  // adjustment note, and the auto readout names the LIVE model default.
  const terra = effortCmd.executeEffort('max', 'gpt-5.6-terra')
  check("'/effort max' on Terra states the applied tier once", /Effort set to max/.test(terra.message) && terra.message.includes('runs xhigh'), terra.message)
  const sol = effortCmd.executeEffort('max', 'gpt-5.6-sol')
  check("'/effort max' on Sol carries NO adjustment note (applied = intent)", /Effort set to max/.test(sol.message) && !sol.message.includes('runs '), sol.message)
  const s46 = effortCmd.executeEffort('xhigh', 'claude-sonnet-4-6')
  check("'/effort xhigh' on sonnet-4-6 states it runs high", s46.message.includes('runs high'), s46.message)
  const current = effortCmd.showCurrentEffort('max', 'gpt-5.6-terra')
  check('the readout names intent AND the applied tier', current.message.includes('max') && current.message.includes('runs xhigh'), current.message)
  const auto = effortCmd.showCurrentEffort(undefined, 'gpt-5.6-sol')
  check("auto readout shows the LIVE default ('low'), not a hard-coded high", /automatic — currently low/.test(auto.message), auto.message)
  __resetOpenaiCatalogueForTest()
  const degraded = effortCmd.executeEffort('max', 'gpt-5.6-sol')
  check('an unavailable catalogue is stated honestly in the receipt', degraded.message.includes('provider default'), degraded.message)
}

// ── 8 · the wires consume the ONE resolution (structural + projection) ──────
{
  console.log('\n— 8 · wire consumption pins —')
  const openaiSrc = readFileSync(join(ROOT, 'src/services/providers/openai/openaiCallModel.ts'), 'utf8')
  check('openaiCallModel requests through resolveWireRequestedEffort (env supremacy + auto/unset)', openaiSrc.includes('resolveWireRequestedEffort(modelId, options.effortValue)'))
  check('the adjustment note stays a VISIBLE settlement note', openaiSrc.includes("profile.source === 'unsupported-fallback' && profile.adjustedFrom"))
  const zaiSrc = readFileSync(join(ROOT, 'src/services/providers/zai/zaiCallModel.ts'), 'utf8')
  check('zaiCallModel requests through resolveWireRequestedEffort', zaiSrc.includes('resolveWireRequestedEffort(modelId, options.effortValue)'))
  check('zai vocabulary rides the shared glmPins module', zaiSrc.includes("from './glmPins.js'"))
  const streamSrc = readFileSync(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'), 'utf8')
  check('the Anthropic wire resolves through resolveAppliedEffort (unchanged)', streamSrc.includes('resolveAppliedEffort(options.model, options.effortValue)'))
  // Display surfaces print the truthful LABEL.
  for (const [file, needle] of [
    ['src/components/mercury-ui/EffortChip.tsx', 'getDisplayedEffortLabel'],
    ['src/components/MercuryFrame.tsx', 'getDisplayedEffortLabel'],
    ['src/components/DeckPane.tsx', 'getDisplayedEffortLabel'],
    ['src/components/EffortIndicator.ts', 'getDisplayedEffortLabel'],
  ] as const) {
    check(`${file.split('/').pop()} prints the label channel`, readFileSync(join(ROOT, file), 'utf8').includes(needle))
  }
}

// ── 9 · GLM sibling: display ≡ dispatch + env supremacy ─────────────────────
{
  console.log('\n— 9 · GLM (glm-5.2) —')
  clearEffortEnv()
  check('glm-5.2 capability now matches the wire vocabulary (max supported)', capabilities.modelSupportsMaxEffort('glm-5.2') && capabilities.modelSupportsXHighEffort('glm-5.2'))
  const truth = effort.resolveEffortTruth('glm-5.2', 'max')
  check("display 'max' ≡ wire 'max' (was: display clamped to high)", truth.wire === 'max' && truth.label === 'max' && effort.getDisplayedEffortLabel('glm-5.2', 'max') === 'max')
  check('the wire send condition is the shared vocabulary test', glmPins.glmAcceptsEffort('glm-5.2', 'max') && !glmPins.glmAcceptsEffort('glm-4', 'max'))
  process.env.MERCURY_EFFORT_LEVEL = 'low'
  check('env=low beats the session value on the glm wire projection', effort.resolveWireRequestedEffort('glm-5.2', 'max') === 'low')
  process.env.MERCURY_EFFORT_LEVEL = 'auto'
  const deferred = effort.resolveEffortTruth('glm-5.2', 'max')
  check("env=auto on glm: the key is omitted and the label says 'default'", effort.resolveWireRequestedEffort('glm-5.2', 'max') === undefined && deferred.wire === undefined && deferred.label === 'default')
  clearEffortEnv()
  const unset = effort.resolveEffortTruth('glm-5.2', undefined)
  check("nothing set on glm: omit + 'default' (no invented ladder default)", unset.wire === undefined && unset.label === 'default' && effort.getDefaultEffortForModel('glm-5.2') === undefined)
  check('a non-vocabulary glm id has no effort control', !capabilities.modelSupportsEffort('glm-4') && effort.selectableEffortLevels('glm-4').length === 0)
}

// ── 10 · uncredentialed engine states + Anthropic regression floors ─────────
{
  console.log('\n— 10 · uncredentialed engines + ladder floors —')
  delete process.env.OPENAI_API_KEY
  __resetOpenaiCatalogueForTest()
  clearEffortEnv()
  // Engines are default-on: an UNFETCHED gpt id serves the
  // full-ladder OFFERING (control OFFERED; the wire re-validates live at
  // dispatch), and the ladder never invents a gpt default.
  check('unfetched gpt: full offering (max/xhigh offered)', capabilities.modelSupportsMaxEffort('gpt-5.6-sol') && capabilities.modelSupportsXHighEffort('gpt-5.6-sol') && capabilities.modelSupportsEffort('gpt-5.6-sol'))
  check('glm: the documented vocabulary stands without credentials', capabilities.modelSupportsEffort('glm-5.2') && capabilities.modelSupportsMaxEffort('glm-5.2'))
  check('unfetched gpt default: undefined (no invented ladder default)', effort.getDefaultEffortForModel('gpt-5.6-sol') === undefined)
  // Unfetched: the wire OMITS the key (nothing fabricated), so display ≡
  // wire — the label says 'default' and the level falls to the 1P default
  // word; 'max' stays OFFERED (selectable) without being claimed applied.
  {
    const truth = effort.resolveEffortTruth('gpt-5.6-sol', 'max')
    check("unfetched request 'max': wire omitted + label 'default' (display ≡ wire)", truth.wire === undefined && truth.label === 'default' && effort.getDisplayedEffortLabel('gpt-5.6-sol', 'max') === 'default')
    check("unfetched request 'max': 'max' stays OFFERED in selectable (full offering)", truth.selectable.includes('max'))
  }
  // Anthropic floors:
  check('opus-4-8 max passes through', effort.resolveAppliedEffort('claude-opus-4-8', 'max') === 'max')
  check('sonnet-4-6 xhigh steps to high', effort.resolveAppliedEffort('claude-sonnet-4-6', 'xhigh') === 'high')
  check('haiku has no effort axis', !capabilities.modelSupportsEffort('claude-haiku-4-5-20251001'))
  check('numeric (ant) values pass through resolveAppliedEffort', effort.resolveAppliedEffort('claude-opus-4-8', 7 as never) === 7)
  check("numeric display label stays 'high' (the omitted-param API default)", effort.getDisplayedEffortLabel('claude-opus-4-8', 7 as never) === 'high')
  check("numeric suffix keeps ' with high effort'", effort.getEffortSuffix('claude-opus-4-8', 7 as never) === ' with high effort')
  process.env.MERCURY_EFFORT_LEVEL = 'unset'
  check('env=unset on Anthropic: no suffix (nothing sent)', effort.getEffortSuffix('claude-opus-4-8', 'max') === '')
  clearEffortEnv()
  check("adjustedFrom rides the ladder step-down (sonnet-4-6 xhigh→high names intent 'xhigh')", effort.resolveEffortTruth('claude-sonnet-4-6', 'xhigh').adjustedFrom === 'xhigh')
}

// ── 11 · H6: reasoning-record replay compatibility (deterministic) ──────────
{
  console.log('\n— 11 · replay compatibility: same-model rides · cross-model derives —')
  const bridge = await import('../../src/services/providers/openai/openaiCallModel.js')
  const mkAssistant = (model: string, opts: { record?: boolean; settled?: boolean; id?: string }) => ({
    type: 'assistant' as const,
    uuid: `u-${Math.abs(Math.random() * 1e9) | 0}`,
    message: {
      id: opts.id ?? `msg-${model}`,
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: opts.settled === false ? null : 'end_turn',
    },
    ...(opts.record
      ? {
          apexProviderTurn: {
            provider: 'openai',
            items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
          },
        }
      : {}),
  })
  const same = bridge.toBridgeMessages([mkAssistant('gpt-5.6-sol', { record: true })] as never, 'repl_main_thread', 'gpt-5.6-sol')
  check('same-model record replays (turnRecord present)', same.rows[0]?.turnRecord !== undefined && same.reconstructedGptTurns === 0)
  const spelled = bridge.toBridgeMessages([mkAssistant(' GPT-5.6-SOL ', { record: true })] as never, 'repl_main_thread', 'gpt-5.6-sol')
  check('case/whitespace spellings of the SAME model share the record', spelled.rows[0]?.turnRecord !== undefined && spelled.reconstructedGptTurns === 0)
  const cross = bridge.toBridgeMessages([mkAssistant('gpt-5.6-luna', { record: true })] as never, 'repl_main_thread', 'gpt-5.6-sol')
  check('a DIFFERENT model’s record is dropped (content derivation) with NO reconstruction receipt', cross.rows[0]?.turnRecord === undefined && cross.reconstructedGptTurns === 0)
  const legacy = bridge.toBridgeMessages([mkAssistant('gpt-5.6-sol', { record: false, settled: true })] as never, 'repl_main_thread', 'gpt-5.6-sol')
  check('a settled recordless GPT turn counts as reconstruction (once per turn)', legacy.reconstructedGptTurns === 1)
  const interrupted = bridge.toBridgeMessages([mkAssistant('gpt-5.6-sol', { record: false, settled: false })] as never, 'repl_main_thread', 'gpt-5.6-sol')
  check('an interrupted partial derives silently (no receipt)', interrupted.reconstructedGptTurns === 0)
  const anthropic = bridge.toBridgeMessages([mkAssistant('claude-opus-4-8', { record: false })] as never, 'repl_main_thread', 'gpt-5.6-sol')
  check('Anthropic turns never count', anthropic.reconstructedGptTurns === 0)
}

// ── Effort-less models send NO effort param ──────
// requestParams drops the param entirely when !modelSupportsEffort — the
// ladder branch would otherwise return wire:<resolved> anyway whenever an env/session
// effort was set, so the display suffix claimed "with low effort" while the
// request omitted the key (label ≠ wire, the headline law).
{
  const effortless = 'claude-sonnet-4-5-20250929'
  const t = effort.resolveEffortTruth(effortless, 'low')
  check('effort-less model + session effort: wire is UNDEFINED (no param sent)', t.wire === undefined, String(t.wire))
  check('… label is the one absence word (no effort control), never the dropped request nor a borrowed tier word', t.label === effort.NO_EFFORT_CONTROL_LABEL && !t.supportsEffort, String(t.label))
  check('… while the operator intent stays visible as requested', t.requested === 'low', String(t.requested))
}

// Restore the ambient env exactly.
for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
__resetOpenaiCatalogueForTest()

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('ALL calibre EFFORT-MATRIX PROOFS PASS')
else console.log(`${failures} calibre EFFORT-MATRIX PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
