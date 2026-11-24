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

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.js')
const { gptDisplayPin, GPT_DISPLAY_PINS } = await import('../../src/models/facts/pins/gptPins.js')
const { ZEN_DISPLAY_PINS, zenDisplayPin } = await import('../../src/models/facts/pins/zenPins.js')
const catalogue = await import('../../src/models/roads/openai/openaiCatalogue.js')
const nous = await import('../../src/models/roads/nous/nousCatalogue.js')
const { getContextWindowForModel } = await import('../../src/engine/compaction-window/contextFill.js')
const { getModelInputCeiling, resolveContextWindow } = await import('../../src/models/facts/capabilities.js')
const { getAutoFoldThreshold, getBlockingLimit, calculateTokenWarningState } = await import('../../src/engine/compaction/autoFold.js')
const { contextFillView } = await import('../../src/engine/context-window/contextFill.js')
const { contextLeftText } = await import('../../src/tools/context-left/ContextLeftTool.js')
const { requestSizeWarning, measureOverflow, overflowMeasuredClause } = await import('../../src/engine/compaction/overflowRecovery.js')
const { buildTransitionPlan, transitionPlanSummary } = await import('../../src/models/roads/transitionPreview.js')

const stated = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
const smallStated = ['gpt-5.6-cyber', 'gpt-5.4-mini', 'gpt-5.4-nano']
const zenStated = ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4']
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
  const left = Math.max(0, getAutoFoldThreshold(model) - tokens)
  const share = Math.round((left / view.window) * 100)
  assert.equal(view.leftUntilCompactPct, share, `${model} at ${tokens}: ${left} of ${view.window} is ${share}%, the gauge says ${view.leftUntilCompactPct}%`)
  assert.equal(calculateTokenWarningState(tokens, model).pctLeft, share, `${model} at ${tokens}: the warning line`)
  assert.ok(contextLeftText(view).includes(`${left.toLocaleString('en-US')} tokens (${share}% of the window)`), contextLeftText(view))
  assert.equal(Math.round(view.usedPct ?? -1), Math.round((tokens / view.window) * 100), `${model} at ${tokens}: used`)
}
const sizeWarningAt = (model: string, tokens: number): string | null => requestSizeWarning(turn(model, tokens) as never, model)
const switchCardAt = (model: string, tokens: number): string => transitionPlanSummary(buildTransitionPlan({ messages: turn('gpt-6.1-sol', tokens) as never, from: 'gpt-6.1-sol', to: model }))
try {
  check('the ten rows whose pages state "Maximum input tokens: 922,000" carry it, the three whose pages state 272,000 carry that, and the five whose page states none, or that have no page, carry none', () => {
    assert.deepEqual(GPT_DISPLAY_PINS.filter(pin => pin.maxInputTokens === 922_000).map(pin => pin.id), stated)
    assert.deepEqual(GPT_DISPLAY_PINS.filter(pin => pin.maxInputTokens === 272_000).map(pin => pin.id), smallStated)
    assert.deepEqual(GPT_DISPLAY_PINS.filter(pin => pin.maxInputTokens === undefined).map(pin => pin.id), ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.5-cyber-preview', 'gpt-5.4', 'gpt-5.4-pro'])
  })
  for (const id of smallStated) check(`${id}, whose page states "400,000 context window" and "Maximum input tokens: 272,000" (read 2026-11-18), carries the maximum and cites that page: the window still reads 400,000 and the session compacts at 229,000, before the maximum`, () => {
    const pin = gptDisplayPin(id)!
    assert.equal(pin.maxInputTokens, 272_000)
    assert.equal(pin.source, `https://developers.openai.com/api/docs/models/${id}.md`)
    assert.equal(pin.observedAt, '2026-11-18')
    assert.equal(getContextWindowForModel(id), 400_000)
    assert.equal(getModelInputCeiling(id), 272_000)
    assert.equal(getAutoFoldThreshold(id), 229_000)
    assert.equal(getBlockingLimit(id), 249_000)
    gaugeSpeaksInOneUnit(id, 150_000)
    assert.ok(sizeWarningAt(id, 240_000)?.includes("of the model's 272,000-token input limit"), String(sizeWarningAt(id, 240_000)))
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
    assert.equal(getAutoFoldThreshold(id), 879_000)
    assert.equal(getBlockingLimit(id), 899_000)
  })
  check('a row whose page states no maximum keeps the window as its budget: GPT-5.5 (page read 2026-11-18) compacts at 1,007,000', () => {
    assert.equal(getAutoFoldThreshold('gpt-5.5'), 1_007_000)
  })
  check("the ceiling has one reader that takes the model alone and decides by where the window in force comes from: the row's stated maximum where the row's window is in force, the window itself where the row states none", () => {
    for (const id of ['gpt-6.2-sol', 'gpt-5.6-sol', 'zen/gpt-6.2-astra']) {
      assert.equal(resolveContextWindow(id).source, 'static-pin', id)
      assert.equal(getModelInputCeiling(id), 922_000, id)
    }
    for (const id of ['gpt-5.5', 'zen/gpt-5.5-pro']) assert.equal(getModelInputCeiling(id), 1_050_000, id)
  })
  for (const id of ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-5.6-terra']) check(`the gauge speaks in one unit on ${id}: the share it prints as left until the fold is the tokens left over the window it names, at five sizes`, () => {
    for (const tokens of [50_000, 300_000, 500_000, 860_000, 900_000]) gaugeSpeaksInOneUnit(id, tokens)
    assert.equal(contextFillView(turn(id, 500_000) as never, id).leftUntilCompactPct, 36)
  })
  check('the gauge on a row with no maximum is where it was: GPT-5.5 at 500,000 reads 48% left', () => {
    gaugeSpeaksInOneUnit('gpt-5.5', 500_000)
    assert.equal(contextFillView(turn('gpt-5.5', 500_000) as never, 'gpt-5.5').leftUntilCompactPct, 48)
  })
  check('the size warning says what its number is: "input limit" on GPT-6.2 Sol, whose 922,000 is the maximum input, and "window" on GPT-5.5, whose two numbers are equal', () => {
    assert.equal(sizeWarningAt('gpt-6.2-sol', 900_000), "the request failed and this conversation is near the window (about 900,000 of the model's 922,000-token input limit by Mercury's count) — a request this size can be refused; Mercury folds it before the next request")
    assert.equal(sizeWarningAt('gpt-5.5', 1_010_000), "the request failed and this conversation is near the window (about 1,010,000 of the model's 1,050,000-token window by Mercury's count) — a request this size can be refused; Mercury folds it before the next request")
  })
  check('the switch card says what its number is: "input limit" on GPT-6.2 Sol and "window" on GPT-5.5', () => {
    assert.equal(switchCardAt('gpt-6.2-sol', 900_000), " · this switch: about 900,000 tokens by Mercury's count against the 922,000-token input limit — the conversation folds before the first request — text and tool results carry over unchanged")
    assert.equal(switchCardAt('gpt-5.5', 1_030_000), " · this switch: about 1,030,000 tokens by Mercury's count against the 1,050,000-token window — the conversation folds before the first request — text and tool results carry over unchanged")
  })
  check('the overflow line says what its number is: "input limit" where Mercury measured against the maximum input (GPT-6.2 Sol), "window" where the two numbers are equal (GPT-5.5) and where a road measured against the window itself', () => {
    const refused = { source: 'provider', family: 'openai', shape: 'context-size' }
    assert.equal(overflowMeasuredClause(measureOverflow(refused as never, turn('gpt-6.2-sol', 900_000) as never, 'gpt-6.2-sol')), "about 900,000 tokens by Mercury's count against the 922,000-token input limit")
    assert.equal(overflowMeasuredClause(measureOverflow(refused as never, turn('gpt-5.5', 1_010_000) as never, 'gpt-5.5')), "about 1,010,000 tokens by Mercury's count against the 1,050,000-token window")
    assert.equal(overflowMeasuredClause(measureOverflow({ ...refused, measuredTokens: 102_400, measuredWindow: 128_000 } as never, turn('gpt-6.2-sol', 900_000) as never, 'gpt-6.2-sol')), "about 102,400 tokens by Mercury's count against the 128,000-token window")
  })
  check('the same model on OpenCode Zen: the eleven rows carry the maximum their source states and compact at 879,000 of the 1,050,000 window they name', () => {
    assert.deepEqual(ZEN_DISPLAY_PINS.filter(pin => pin.maxInputTokens !== undefined).map(pin => pin.id), zenStated)
    for (const id of zenStated) {
      assert.equal(zenDisplayPin(`zen/${id}`)?.maxInputTokens, 922_000, id)
      assert.equal(getContextWindowForModel(`zen/${id}`), 1_050_000, id)
      assert.equal(getAutoFoldThreshold(`zen/${id}`), 879_000, id)
    }
    gaugeSpeaksInOneUnit('zen/gpt-6.2-astra', 500_000)
  })
  check('Zen GPT 5.5 and GPT 5.4 carry the 922,000 models.dev states for them and compact at 879,000; the same two models with an OpenAI API key, whose own pages state no maximum, keep 1,007,000, and so does a Zen row with none', () => {
    for (const id of ['gpt-5.5', 'gpt-5.4']) {
      assert.equal(zenDisplayPin(`zen/${id}`)?.maxInputTokens, 922_000, id)
      assert.equal(getAutoFoldThreshold(`zen/${id}`), 879_000, id)
      assert.equal(gptDisplayPin(id)?.maxInputTokens, undefined, id)
      assert.equal(getAutoFoldThreshold(id), 1_007_000, id)
    }
    assert.equal(getAutoFoldThreshold('zen/gpt-5.5-pro'), 1_007_000)
  })
  check('a row cites the page that states each of its numbers: the eleven Zen rows name the Zen page for their prices and the models.dev file of the model for their window, maximum input and output ceiling', () => {
    assert.deepEqual(ZEN_DISPLAY_PINS.filter(pin => pin.limitsSource !== undefined).map(pin => pin.id), zenStated)
    for (const id of zenStated) {
      const pin = zenDisplayPin(`zen/${id}`)!
      assert.equal(pin.source, 'https://opencode.ai/docs/console/models/', id)
      assert.equal(pin.limitsSource, `https://raw.githubusercontent.com/sst/models.dev/dev/models/openai/${id}.toml`, id)
      assert.ok((pin.observedAt ?? '') >= '2026-11-17', `${id}: ${pin.observedAt}`)
    }
  })
  check("the five GPT rows whose model page prints no cache-write price, or no long-context price, name OpenAI's pricing page for it beside the model page, both read 2026-11-18", () => {
    assert.deepEqual(GPT_DISPLAY_PINS.filter(pin => pin.priceSource !== undefined).map(pin => pin.id), ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-cyber', 'gpt-5.5-pro'])
    for (const pin of GPT_DISPLAY_PINS.filter(row => row.priceSource !== undefined)) {
      assert.equal(pin.priceSource, 'https://developers.openai.com/api/docs/pricing', pin.id)
      assert.ok(pin.source?.startsWith(`https://developers.openai.com/api/docs/models/${pin.id}`), `${pin.id}: ${pin.source}`)
      assert.equal(pin.observedAt, '2026-11-18', pin.id)
    }
  })
  process.env.NOUS_API_KEY = 'fixture-key-not-real'
  nous.__resetNousCatalogueForTest()
  const portal = ['openai/gpt-6.2-astra', 'openai/gpt-6.2-sol', 'openai/gpt-6.1-sol', 'openai/gpt-6.2-astra-pro', 'openai/gpt-5.5'].map(id => ({ id, context_length: 1_050_000, top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000 }, pricing: { prompt: '0.000002', completion: '0.00001' } }))
  const portalRead = await nous.refreshNousCatalogue({ force: true, fetchImpl: (async () => new Response(JSON.stringify({ data: [...portal, ...['openai/gpt-5.4-mini', 'openai/gpt-5.4-nano'].map(id => ({ id, context_length: 400_000, top_provider: { context_length: 400_000, max_completion_tokens: 128_000 }, pricing: { prompt: '0.00000075', completion: '0.0000045' } })), { id: 'anthropic/claude-sonnet-5.5', context_length: 1_000_000, pricing: { prompt: '0.000002', completion: '0.00001' } }] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
  check("a Nous row of an OpenAI id takes the maximum of the GPT row of the same model: the Portal's own 1,050,000 window, compaction at 879,000", () => {
    assert.ok(portalRead, 'the fixture list was not read')
    for (const id of ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-sol']) {
      assert.equal(getContextWindowForModel(`nous/openai/${id}`), 1_050_000, id)
      assert.equal(resolveContextWindow(`nous/openai/${id}`).source, 'live-current', id)
      assert.equal(getAutoFoldThreshold(`nous/openai/${id}`), 879_000, id)
      assert.equal(getModelInputCeiling(`nous/openai/${id}`), gptDisplayPin(id)!.maxInputTokens, id)
    }
    gaugeSpeaksInOneUnit('nous/openai/gpt-6.2-astra', 500_000)
  })
  check("the Nous rows of GPT-5.4 mini and GPT-5.4 nano, which the Portal lists at 400,000, take the 272,000 of their GPT rows: the Portal's window still reads 400,000 and compaction starts at 229,000", () => {
    for (const id of ['gpt-5.4-mini', 'gpt-5.4-nano']) {
      assert.equal(getContextWindowForModel(`nous/openai/${id}`), 400_000, id)
      assert.equal(getAutoFoldThreshold(`nous/openai/${id}`), 229_000, id)
    }
  })
  check('a Nous row with no GPT row of the same model, or whose GPT row states no maximum, keeps the window its list states', () => {
    assert.equal(getAutoFoldThreshold('nous/openai/gpt-6.2-astra-pro'), 1_007_000)
    assert.equal(getAutoFoldThreshold('nous/openai/gpt-5.5'), 1_007_000)
    assert.equal(getAutoFoldThreshold('nous/anthropic/claude-sonnet-5.5'), 957_000)
  })
  nous.__resetNousCatalogueForTest()
  delete process.env.NOUS_API_KEY
  process.env.OPENAI_API_KEY = 'fixture-key-not-real'
  await seed({ data: [...stated, ...smallStated].map(id => ({ id })) })
  for (const id of smallStated) check(`${id} on a bare API list: the window comes from the row, 400,000, and compaction starts at 229,000`, () => {
    assert.equal(getContextWindowForModel(id), 400_000)
    assert.equal(resolveContextWindow(id).source, 'static-pin')
    assert.equal(getAutoFoldThreshold(id), 229_000)
  })
  for (const id of stated) check(`${id} on a bare API list: the window comes from the row, compaction at 879,000`, () => {
    assert.equal(getContextWindowForModel(id), 1_050_000)
    assert.equal(resolveContextWindow(id).source, 'static-pin')
    assert.equal(getAutoFoldThreshold(id), 879_000)
  })
  const sixWords = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) check(`${id} on a bare API list: the six effort words its page states, none among them, each sent as asked, and medium when none is chosen`, () => {
    assert.deepEqual(gptDisplayPin(id)?.supportedReasoningEfforts, sixWords)
    assert.equal(gptDisplayPin(id)?.defaultReasoningEffort, 'medium')
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok, `src/models/roads/openai/openaiCatalogue.ts evaluateGptCandidate(${id}, api-key) failed: ${JSON.stringify(row).slice(0, 140)}`)
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
    assert.equal(getAutoFoldThreshold(id), 829_000)
    assert.equal(getContextWindowForModel(`${id}[served]`), 272_000)
    assert.equal(getAutoFoldThreshold(`${id}[served]`), 229_000)
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok, `src/models/roads/openai/openaiCatalogue.ts evaluateGptCandidate(${id}, api-key) failed on codexList: ${JSON.stringify(row).slice(0, 140)}`)
    assert.deepEqual(row.candidate.live.supportedReasoningEfforts, ['low', 'medium'])
    assert.equal(catalogue.resolveGptReasoningProfile('max', row.candidate.live).wireEffort, 'medium')
  })
  await seed(codexList(1_050_000, 272_000))
  for (const id of ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-5.6-luna']) check(`${id} on a list that states 1,050,000 itself: the ceiling is by source, not by number, and the list's window decides, compaction at 1,007,000`, () => {
    assert.equal(getContextWindowForModel(id), 1_050_000)
    assert.equal(resolveContextWindow(id).source, 'live-current')
    assert.equal(getAutoFoldThreshold(id), 1_007_000)
  })
  operatorStates({ 'gpt-6.2-sol': { contextWindow: 500_000 } })
  check("a window the operator states below a list's own is not the window in force, and the list still decides for its own door: 1,050,000 from the list, compaction at 1,007,000", () => {
    assert.equal(getContextWindowForModel('gpt-6.2-sol'), 1_050_000)
    assert.equal(getAutoFoldThreshold('gpt-6.2-sol'), 1_007_000)
  })
  await seed(codexList(872_000, 272_000))
  operatorStates({ 'gpt-6.2-sol': { contextWindow: 1_050_000 } })
  check("a window the operator states above a list's own is the window in force and stays under the row's maximum input: 1,050,000 stated over the list's 872,000, compaction at 879,000", () => {
    assert.equal(getContextWindowForModel('gpt-6.2-sol'), 1_050_000)
    assert.equal(getAutoFoldThreshold('gpt-6.2-sol'), 879_000)
  })
  operatorStates({})
  catalogue.__resetOpenaiCatalogueForTest()
  delete process.env.OPENAI_API_KEY
  for (const [how, statedWindow] of [['at', 1_050_000], ['above', 2_000_000], ['below', 500_000]] as Array<[string, number]>) {
    operatorStates({ 'gpt-6.2-sol': { contextWindow: statedWindow }, 'zen/gpt-6.2-astra': { contextWindow: statedWindow } })
    for (const id of ['gpt-6.2-sol', 'zen/gpt-6.2-astra']) check(`a window the operator states ${how} the row's for ${id} (${statedWindow.toLocaleString('en-US')}) never lifts compaction above the row's maximum input: the window reads ${Math.max(statedWindow, 1_050_000).toLocaleString('en-US')} and compaction stays at 879,000`, () => {
      assert.equal(resolveContextWindow(id).source, 'operator')
      assert.equal(getContextWindowForModel(id), Math.max(statedWindow, 1_050_000))
      assert.equal(getModelInputCeiling(id), 922_000)
      assert.equal(getAutoFoldThreshold(id), 879_000)
    })
  }
  operatorStates({ 'gpt-5.5': { contextWindow: 2_000_000 } })
  check('a window the operator states for a row with no maximum input is its budget as before: 2,000,000 stated on gpt-5.5, compaction at 1,957,000', () => {
    assert.equal(getAutoFoldThreshold('gpt-5.5'), 1_957_000)
  })
  operatorStates({})
  check('with the operator fact gone the row decides again: 879,000', () => {
    assert.equal(getAutoFoldThreshold('gpt-6.2-sol'), 879_000)
    assert.equal(getAutoFoldThreshold('zen/gpt-6.2-astra'), 879_000)
  })
  process.env.MERCURY_DISABLE_1M_CONTEXT = '1'
  check('the 1M kill-switch still decides: 200,000 with compaction at 157,000', () => {
    assert.equal(getContextWindowForModel('gpt-6.2-astra'), 200_000)
    assert.equal(getAutoFoldThreshold('gpt-6.2-astra'), 157_000)
  })
  delete process.env.MERCURY_DISABLE_1M_CONTEXT
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${checks - failures.length}/${checks} passed; "Maximum input tokens: 922,000" read 2026-11-17 and 2026-11-18 on the ten model pages under https://developers.openai.com/api/docs/models/; "input = 922_000" read 2026-11-18 in the eleven files under https://raw.githubusercontent.com/sst/models.dev/dev/models/openai/`)
process.exit(failures.length ? 1 : 0)
