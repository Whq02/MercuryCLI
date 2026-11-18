import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'gpt-input-budget-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'NOUS_API_KEY', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_BLOCKING_LIMIT_OVERRIDE']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { gptDisplayPin, GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.js')
const { ZEN_DISPLAY_PINS, zenDisplayPin } = await import('../../src/services/providers/zen/zenPins.js')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const nous = await import('../../src/services/providers/nous/nousCatalogue.js')
const { getContextWindowForModel } = await import('../../src/utils/context.js')
const { getModelInputCeiling, resolveContextWindow } = await import('../../src/utils/model/capabilities.js')
const { getAutoCompactThreshold, getBlockingLimit, calculateTokenWarningState } = await import('../../src/services/compact/autoCompact.js')
const { contextFillView } = await import('../../src/utils/contextFill.js')
const { contextLeftText } = await import('../../src/tools/ContextLeftTool/ContextLeftTool.js')

const stated = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
const zenStated = ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
const failures: string[] = []
let checks = 0
function check(label: string, run: () => void): void {
  checks++
  try { run(); console.log(`PASS ${label}`) } catch (e) { failures.push(label); console.error(`FAIL ${label}: ${String(e)}`) }
}
async function seed(body: Record<string, unknown>): Promise<void> {
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: (async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
}
const codexList = (maxWindow: number, window: number): Record<string, unknown> => ({ models: stated.map((id, index) => ({ slug: id, visibility: 'list', priority: index + 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], default_reasoning_level: 'medium', context_window: window, max_context_window: maxWindow, input_modalities: ['text', 'image'], supported_in_api: true })) })
const operatorStates = (models: Record<string, unknown>): void => { writeFileSync(join(home, 'settings.json'), JSON.stringify({ models })); resetSettingsCache() }
const turn = (model: string, tokens: number): unknown[] => [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'resp_1', role: 'assistant', model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
]
function gaugeSpeaksInOneUnit(model: string, tokens: number): void {
  const view = contextFillView(turn(model, tokens) as never, model)
  assert.equal(view.usedTokens, tokens, `${model} at ${tokens}`)
  const left = Math.max(0, getAutoCompactThreshold(model) - tokens)
  const share = Math.round((left / view.window) * 100)
  assert.equal(view.leftUntilCompactPct, share, `${model} at ${tokens}: ${left} of ${view.window} is ${share}%, the gauge says ${view.leftUntilCompactPct}%`)
  assert.equal(calculateTokenWarningState(tokens, model).pctLeft, share, `${model} at ${tokens}: the warning line`)
  assert.ok(contextLeftText(view).includes(`${left.toLocaleString('en-US')} tokens (${share}% of the window)`), contextLeftText(view))
  assert.equal(Math.round(view.usedPct ?? -1), Math.round((tokens / view.window) * 100), `${model} at ${tokens}: used`)
}
try {
  check('the ten rows whose pages state "Maximum input tokens: 922,000" carry it, and no other row carries one', () => {
    assert.deepEqual(GPT_DISPLAY_PINS.filter(pin => pin.maxInputTokens !== undefined).map(pin => pin.id), stated)
    for (const id of stated) assert.equal(gptDisplayPin(id)?.maxInputTokens, 922_000, id)
  })
  check("each of the ten rows says its source is OpenAI's page of that model, read on or after 17 November", () => {
    for (const id of stated) {
      const pin = gptDisplayPin(id)!
      assert.ok(pin.source === `https://developers.openai.com/api/docs/models/${id}` || pin.source === `https://developers.openai.com/api/docs/models/${id}.md`, `${id}: ${pin.source}`)
      assert.ok(pin.observedAt >= '2026-11-17', `${id}: ${pin.observedAt}`)
    }
  })
  for (const id of stated) check(`${id} signed out: the window still reads 1,050,000 and the session compacts at 879,000, before the 922,000 input maximum`, () => {
    assert.equal(getContextWindowForModel(id), 1_050_000)
    assert.equal(getAutoCompactThreshold(id), 879_000)
    assert.equal(getBlockingLimit(id), 899_000)
  })
  check('a row whose page states no maximum keeps the window as its budget: GPT-5.5 (page read 2026-11-18) compacts at 1,007,000', () => {
    assert.equal(getAutoCompactThreshold('gpt-5.5'), 1_007_000)
  })
  check("the ceiling has one reader that takes the model alone and decides by where the window in force comes from: the row's stated maximum where the row's window is in force, the window itself where the row states none", () => {
    for (const id of ['gpt-6.2-sol', 'gpt-5.6-sol', 'zen/gpt-6.2-astra']) {
      assert.equal(resolveContextWindow(id).source, 'static-pin', id)
      assert.equal(getModelInputCeiling(id), 922_000, id)
    }
    for (const id of ['gpt-5.5', 'zen/gpt-5.5']) assert.equal(getModelInputCeiling(id), 1_050_000, id)
  })
  for (const id of ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-5.6-terra']) check(`the gauge speaks in one unit on ${id}: the share it prints as left until the fold is the tokens left over the window it names, at five sizes`, () => {
    for (const tokens of [50_000, 300_000, 500_000, 860_000, 900_000]) gaugeSpeaksInOneUnit(id, tokens)
    assert.equal(contextFillView(turn(id, 500_000) as never, id).leftUntilCompactPct, 36)
  })
  check('the gauge on a row with no maximum is where it was: GPT-5.5 at 500,000 reads 48% left', () => {
    gaugeSpeaksInOneUnit('gpt-5.5', 500_000)
    assert.equal(contextFillView(turn('gpt-5.5', 500_000) as never, 'gpt-5.5').leftUntilCompactPct, 48)
  })
  check('the same model on OpenCode Zen: the nine rows carry the maximum their GPT row carries and compact at 879,000 of the 1,050,000 window they name', () => {
    assert.deepEqual(ZEN_DISPLAY_PINS.filter(pin => pin.maxInputTokens !== undefined).map(pin => pin.id), zenStated)
    for (const id of zenStated) {
      assert.equal(zenDisplayPin(`zen/${id}`)?.maxInputTokens, gptDisplayPin(id)?.maxInputTokens, id)
      assert.equal(getContextWindowForModel(`zen/${id}`), 1_050_000, id)
      assert.equal(getAutoCompactThreshold(`zen/${id}`), 879_000, id)
    }
    gaugeSpeaksInOneUnit('zen/gpt-6.2-astra', 500_000)
  })
  check('a Zen row of a model whose page states no maximum keeps its window: GPT 5.5 and GPT 5.4 compact at 1,007,000', () => {
    for (const id of ['zen/gpt-5.5', 'zen/gpt-5.4']) assert.equal(getAutoCompactThreshold(id), 1_007_000, id)
  })
  process.env.NOUS_API_KEY = 'fixture-key-not-real'
  nous.__resetNousCatalogueForTest()
  const portal = ['openai/gpt-6.2-astra', 'openai/gpt-6.2-sol', 'openai/gpt-6.1-sol', 'openai/gpt-6.2-astra-pro', 'openai/gpt-5.5'].map(id => ({ id, context_length: 1_050_000, top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000 }, pricing: { prompt: '0.000002', completion: '0.00001' } }))
  const portalRead = await nous.refreshNousCatalogue({ force: true, fetchImpl: (async () => new Response(JSON.stringify({ data: [...portal, { id: 'anthropic/claude-sonnet-5.5', context_length: 1_000_000, pricing: { prompt: '0.000002', completion: '0.00001' } }] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
  check("a Nous row of an OpenAI id takes the maximum of the GPT row of the same model: the Portal's own 1,050,000 window, compaction at 879,000", () => {
    assert.ok(portalRead, 'the fixture list was not read')
    for (const id of ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-sol']) {
      assert.equal(getContextWindowForModel(`nous/openai/${id}`), 1_050_000, id)
      assert.equal(resolveContextWindow(`nous/openai/${id}`).source, 'live-current', id)
      assert.equal(getAutoCompactThreshold(`nous/openai/${id}`), 879_000, id)
      assert.equal(getModelInputCeiling(`nous/openai/${id}`), gptDisplayPin(id)!.maxInputTokens, id)
    }
    gaugeSpeaksInOneUnit('nous/openai/gpt-6.2-astra', 500_000)
  })
  check('a Nous row with no GPT row of the same model, or whose GPT row states no maximum, keeps the window its list states', () => {
    assert.equal(getAutoCompactThreshold('nous/openai/gpt-6.2-astra-pro'), 1_007_000)
    assert.equal(getAutoCompactThreshold('nous/openai/gpt-5.5'), 1_007_000)
    assert.equal(getAutoCompactThreshold('nous/anthropic/claude-sonnet-5.5'), 957_000)
  })
  nous.__resetNousCatalogueForTest()
  delete process.env.NOUS_API_KEY
  process.env.OPENAI_API_KEY = 'fixture-key-not-real'
  await seed({ data: stated.map(id => ({ id })) })
  for (const id of stated) check(`${id} on a bare API list: the window comes from the row, compaction at 879,000`, () => {
    assert.equal(getContextWindowForModel(id), 1_050_000)
    assert.equal(resolveContextWindow(id).source, 'static-pin')
    assert.equal(getAutoCompactThreshold(id), 879_000)
  })
  const sixWords = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) check(`${id} on a bare API list: the six effort words its page states, none among them, each sent as asked, and medium when none is chosen`, () => {
    assert.deepEqual(gptDisplayPin(id)?.supportedReasoningEfforts, sixWords)
    assert.equal(gptDisplayPin(id)?.defaultReasoningEffort, 'medium')
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok)
    assert.deepEqual(row.candidate.live.supportedReasoningEfforts, sixWords)
    assert.equal(catalogue.resolveGptReasoningProfile(undefined, row.candidate.live).wireEffort, 'medium')
    for (const word of sixWords) {
      const profile = catalogue.resolveGptReasoningProfile(word, row.candidate.live)
      assert.deepEqual([profile.wireEffort, profile.source], [word, 'user'], word)
    }
  })
  await seed(codexList(872_000, 272_000))
  for (const id of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-5.6-sol']) check(`${id} on a list that states its own windows and levels: the list decides, 872,000 with compaction at 829,000, 272,000 with compaction at 229,000 on the served choice, and its own two effort words`, () => {
    assert.equal(getContextWindowForModel(id), 872_000)
    assert.equal(getAutoCompactThreshold(id), 829_000)
    assert.equal(getContextWindowForModel(`${id}[served]`), 272_000)
    assert.equal(getAutoCompactThreshold(`${id}[served]`), 229_000)
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok)
    assert.deepEqual(row.candidate.live.supportedReasoningEfforts, ['low', 'medium'])
    assert.equal(catalogue.resolveGptReasoningProfile('max', row.candidate.live).wireEffort, 'medium')
  })
  await seed(codexList(1_050_000, 272_000))
  for (const id of ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-5.6-luna']) check(`${id} on a list that states 1,050,000 itself: the ceiling is by source, not by number, and the list's window decides, compaction at 1,007,000`, () => {
    assert.equal(getContextWindowForModel(id), 1_050_000)
    assert.equal(resolveContextWindow(id).source, 'live-current')
    assert.equal(getAutoCompactThreshold(id), 1_007_000)
  })
  catalogue.__resetOpenaiCatalogueForTest()
  delete process.env.OPENAI_API_KEY
  operatorStates({ 'gpt-6.2-sol': { contextWindow: 1_050_000 }, 'zen/gpt-6.2-astra': { contextWindow: 1_050_000 } })
  for (const id of ['gpt-6.2-sol', 'zen/gpt-6.2-astra']) check(`a window the operator states for ${id} decides for itself, whatever its number: 1,050,000 stated, compaction at 1,007,000`, () => {
    assert.equal(resolveContextWindow(id).source, 'operator')
    assert.equal(getAutoCompactThreshold(id), 1_007_000)
  })
  operatorStates({ 'gpt-6.2-sol': { contextWindow: 500_000 }, 'zen/gpt-6.2-astra': { contextWindow: 922_000 } })
  for (const id of ['gpt-6.2-sol', 'zen/gpt-6.2-astra']) check(`a window the operator states for ${id} below the row's is not the window in force (the build keeps the row's 1,050,000), so the row's maximum applies: compaction at 879,000`, () => {
    assert.equal(getContextWindowForModel(id), 1_050_000)
    assert.equal(getAutoCompactThreshold(id), 879_000)
  })
  operatorStates({ 'gpt-6.2-sol': { contextWindow: 2_000_000 } })
  check("a window the operator states above the row's decides for itself: 2,000,000 stated on gpt-6.2-sol, compaction at 1,957,000", () => {
    assert.equal(getContextWindowForModel('gpt-6.2-sol'), 2_000_000)
    assert.equal(getAutoCompactThreshold('gpt-6.2-sol'), 1_957_000)
  })
  operatorStates({})
  check('with the operator fact gone the row decides again: 879,000', () => {
    assert.equal(getAutoCompactThreshold('gpt-6.2-sol'), 879_000)
    assert.equal(getAutoCompactThreshold('zen/gpt-6.2-astra'), 879_000)
  })
  process.env.MERCURY_DISABLE_1M_CONTEXT = '1'
  check('the 1M kill-switch still decides: 200,000 with compaction at 157,000', () => {
    assert.equal(getContextWindowForModel('gpt-6.2-astra'), 200_000)
    assert.equal(getAutoCompactThreshold('gpt-6.2-astra'), 157_000)
  })
  delete process.env.MERCURY_DISABLE_1M_CONTEXT
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${checks - failures.length}/${checks} passed; "Maximum input tokens: 922,000" read 2026-11-17 and 2026-11-18 on the ten model pages under https://developers.openai.com/api/docs/models/`)
process.exit(failures.length ? 1 : 0)
