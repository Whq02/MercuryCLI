import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(process.env.PLUMBING_PROOF_ROOT ?? join(import.meta.dir, '../..'))
const parent = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(parent, { recursive: true })
const home = mkdtempSync(join(parent, 'model-facts-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import(`${root}/src/platform/settings/config.ts`)
enableConfigs()
const { resetSettingsCache } = await import(`${root}/src/platform/settings/settingsCache.ts`)
const { SettingsSchema } = await import(`${root}/src/platform/settings/settingsSchema.ts`)
const capabilities = await import(`${root}/src/models/facts/capabilities.ts`)
const pricing = await import(`${root}/src/models/usage/modelCost.ts`)
const { isModelAllowed } = await import(`${root}/src/models/catalogue/modelAllowlist.ts`)
const factsOwner = existsSync(`${root}/src/models/catalogue/modelOverrides.ts`) ? await import(`${root}/src/models/catalogue/modelOverrides.ts`) : undefined
let checks = 0
let failures = 0
function check(name: string, pass: boolean, detail?: string) { checks++; if (!pass) failures++; console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${!pass && detail ? ` -- ${detail}` : ''}`) }
const set = (models: unknown, extra = {}) => { writeFileSync(join(home, 'settings.json'), JSON.stringify({ models, ...extra })); resetSettingsCache() }
const effortWords = (id: string) => {
  const view = capabilities.effortVocabularyFor(id)
  return 'vocabulary' in view ? view.vocabulary : []
}
try {
  const pinTables: Array<[string, string, string?]> = [
    ['gptPins', 'GPT_DISPLAY_PINS'], ['glmPins', 'GLM_DISPLAY_PINS'],
    ['kimiPins', 'KIMI_DISPLAY_PINS'], ['deepseekPins', 'DEEPSEEK_DISPLAY_PINS'],
    ['xaiPins', 'XAI_DISPLAY_PINS'], ['metaPins', 'META_DISPLAY_PINS'],
    ['mistralPins', 'MISTRAL_DISPLAY_PINS'], ['geminiPins', 'GEMINI_PRICE_PINS'],
    ['huggingfacePins', 'HUGGINGFACE_DISPLAY_PINS', 'huggingface/'],
    ['zenPins', 'ZEN_DISPLAY_PINS', 'zen/'], ['minimaxPins', 'MINIMAX_DISPLAY_PINS'],
    ['togetherPins', 'TOGETHER_DISPLAY_PINS', 'together/'], ['coherePins', 'COHERE_DISPLAY_PINS'],
    ['groqPins', 'GROQ_DISPLAY_PINS', 'groq/'], ['cerebrasPins', 'CEREBRAS_DISPLAY_PINS', 'cerebras/'],
    ['fireworksPins', 'FIREWORKS_DISPLAY_PINS', 'fireworks/'],
  ]
  const pinnedIds = ['claude-opus-5-5']
  for (const [module, table, prefix = ''] of pinTables) {
    const owner = await import(`${root}/src/models/facts/pins/${module}.ts`)
    for (const row of owner[table]) pinnedIds.push(prefix + row.id)
  }
  const recorded = pinnedIds.filter(id => factsOwner?.modelHasRecordedFacts(id))
  check('every recorded family pin is recognised by the capability-floor owner', recorded.length === pinnedIds.length, 'add the unlisted ids printed below to the recorded-facts table read by modelHasRecordedFacts in src/models/catalogue/modelOverrides.ts')
  if (recorded.length !== pinnedIds.length) console.log(`unrecognised pins: ${pinnedIds.filter(id => !recorded.includes(id)).join(', ')}`)
  const annotated = pinnedIds.filter(id => factsOwner?.modelHasRecordedFacts(`${id}[served]`))
  check('window annotations never turn a recorded pin into an unknown model', annotated.length === pinnedIds.length, 'modelHasRecordedFacts in src/models/catalogue/modelOverrides.ts must strip the [served] annotation before looking the id up')
  if (annotated.length !== pinnedIds.length) console.log(`unrecognised annotated pins: ${pinnedIds.filter(id => !annotated.includes(id)).join(', ')}`)
  for (const [family, id] of [['groq', 'groq/llama-3.3-70b-versatile'], ['cerebras', 'cerebras/gpt-oss-120b'], ['fireworks', 'fireworks/accounts/fireworks/models/gpt-oss-120b']]) {
    set({})
    const pinned = capabilities.resolveModelCapabilities(id!)
    set({ [id!]: { contextWindow: pinned.context.window * 2, maxOutputTokens: pinned.context.outputMax * 2, prices: { input: 5, output: 15 } }, _default: { [family!]: { contextWindow: 7, maxOutputTokens: 7 } } })
    const stated = capabilities.resolveModelCapabilities(id!)
    check(`${family}: a stated fact for a pinned id merges over the pin — the window and ceiling rise, the prices land, the family default is not consulted`, stated.context.window === pinned.context.window * 2 && stated.context.outputMax === pinned.context.outputMax * 2 && pricing.resolveModelPricing(id!).costs.inputTokens === 5 && pricing.resolveModelPricing(id!).costs.outputTokens === 15, 'a stated fact must raise the pinned window and ceiling and set prices; see operatorModelFacts in src/models/catalogue/modelOverrides.ts, resolveModelCapabilities in src/models/facts/capabilities.ts and resolveModelPricing in src/models/usage/modelCost.ts')
    set({ [id!]: { contextWindow: 1, maxOutputTokens: 1, efforts: [], images: false, reasoning: false } })
    const smaller = capabilities.resolveModelCapabilities(id!)
    check(`${family}: a smaller stated fact never lowers the pinned window, ceiling, reasoning or images`, smaller.context.window === pinned.context.window && smaller.context.outputMax === pinned.context.outputMax && smaller.thinking.supported === pinned.thinking.supported && smaller.media.images === pinned.media.images, 'a stated smaller fact must be ignored in favour of the pin; see resolveModelCapabilities in src/models/facts/capabilities.ts and operatorModelFacts in src/models/catalogue/modelOverrides.ts')
  }
  set({})
  for (const [id, input, output, cached] of [
    ['gpt-6.1-sol', 2, 10, 0.1], ['gpt-6-sol', 2, 10, 0.2], ['gpt-6-luna', 0.1, 0.5, 0.01],
    ['gpt-5.4-mini', 0.75, 4.5, 0.075], ['gpt-5.4-nano', 0.2, 1.25, 0.02],
  ] as const) {
    const rate = pricing.resolveModelPricing(id)
    check(`${id} records the OpenAI rates (developers.openai.com/api/docs/pricing, read 2026-10-25)`, rate.basis === 'recorded' && rate.costs.inputTokens === input && rate.costs.outputTokens === output && rate.costs.promptCacheReadTokens === cached, 'fix the recorded rate for this id in src/models/usage/modelCost.ts (resolveModelPricing)')
  }
  check('MiniMax GA records $0.15/$0.60/$0.015 (platform.minimax.io/docs/pricing/overview.md, read 2026-10-25)', pricing.resolveModelPricing('minimax-m3.1-flash').costs.promptCacheReadTokens === 0.015 && pricing.resolveModelPricing('minimax-m3.1-flash').costs.outputTokens === 0.6, 'fix the recorded minimax-m3.1-flash rate in src/models/usage/modelCost.ts (resolveModelPricing)')
  for (const id of ['zai-org/GLM-5.3-Flash', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'Qwen/Qwen3.5-9B', 'meta-models/Muse-Spark-Open-816B-A42B', 'thinkingmachines/Inkling']) {
    check(`${id} receives images on Together (together.ai/pricing, read 2026-10-25)`, capabilities.modelReceivesImageBlocks(`together/${id}`), 'modelReceivesImageBlocks in src/models/facts/capabilities.ts must report images for this Together id')
  }
  for (const id of ['tiny-aya-global', 'tiny-aya-earth', 'tiny-aya-fire', 'tiny-aya-water']) {
    check(`${id} has 8K context and output (docs.cohere.com/docs/tiny-aya, read 2026-10-25)`, capabilities.getContextWindowForModel(id) === 8_000 && capabilities.getModelMaxOutputTokens(id).upperLimit === 8_000, 'fix the recorded tiny-aya window and ceiling; see getContextWindowForModel and getModelMaxOutputTokens in src/models/facts/capabilities.ts')
  }
  const known = 'claude-opus-5-5'
  const fresh = 'deepseek-fixture-new'
  const before = capabilities.resolveModelCapabilities(known)
  const basePrices = pricing.resolveModelPricing(known)
  set({ [fresh]: { contextWindow: 1_500_000, maxOutputTokens: 240_000, prices: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 }, efforts: ['low', 'high', 'max'], images: true, reasoning: true } })
  check('a new model uses the operator-stated context window', capabilities.getContextWindowForModel(fresh) === 1_500_000, 'getContextWindowForModel in src/models/facts/capabilities.ts must return the models entry window for an unknown id')
  const output = capabilities.getModelMaxOutputTokens(fresh)
  check('a stated output ceiling is requested whole, never capped by a fallback or 128k', output.default === 240_000 && output.upperLimit === 240_000, 'getModelMaxOutputTokens in src/models/facts/capabilities.ts must return the stated 240000 as both default and upperLimit')
  check('the effort and media facts are available through the capability owner', effortWords(fresh).join(',') === 'low,high,max' && capabilities.modelReceivesImageBlocks(fresh) && capabilities.modelSupportsThinking(fresh), 'effortVocabularyFor, modelReceivesImageBlocks and modelSupportsThinking in src/models/facts/capabilities.ts must read the stated efforts, images and reasoning')
  const price = pricing.resolveModelPricing(fresh)
  check('all four stated rates reach the pricing owner', price.costs.inputTokens === 2 && price.costs.outputTokens === 8 && price.costs.promptCacheReadTokens === 0.5 && price.costs.promptCacheWriteTokens === 3, 'resolveModelPricing in src/models/usage/modelCost.ts must carry all four stated rates')
  check('the session-cost computation uses those rates', pricing.calculateUSDCost(fresh, { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }) === 13.5, 'calculateUSDCost in src/models/usage/modelCost.ts must price with the stated rates (13.5 expected)')
  check('unrelated model capabilities stay byte-identical while an override is active', JSON.stringify(capabilities.resolveModelCapabilities(known)) === JSON.stringify(before), 'an override for one id changed another id; see resolveModelCapabilities in src/models/facts/capabilities.ts and operatorModelFacts in src/models/catalogue/modelOverrides.ts')
  check('unrelated model prices stay byte-identical while an override is active', JSON.stringify(pricing.resolveModelPricing(known)) === JSON.stringify(basePrices), 'an override for one id changed another id price; see resolveModelPricing in src/models/usage/modelCost.ts')
  check('an explicitly stated cache-write price applies to one-hour cache creation too', pricing.calculateUSDCost(fresh, { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 } }) === 13.5, 'calculateUSDCost in src/models/usage/modelCost.ts must use the stated cacheWrite for ephemeral 1h creation too (13.5 expected)')
  set({ _default: { deepseek: { contextWindow: 750_000, maxOutputTokens: 180_000, prices: { input: 1, output: 3 }, images: true } } })
  check('a family default fills an unknown id', capabilities.getContextWindowForModel(fresh) === 750_000 && capabilities.getModelMaxOutputTokens(fresh).default === 180_000, 'the _default family entry must fill an unknown id; see operatorModelFacts in src/models/catalogue/modelOverrides.ts')
  const pinned = capabilities.getContextWindowForModel('deepseek-v4-pro')
  check('the family default does not replace a known model window', pinned !== 750_000, 'operatorModelFacts in src/models/catalogue/modelOverrides.ts must not apply _default to ids with recorded facts')
  set({ _default: { deepseek: { contextWindow: 750_000, maxOutputTokens: 180_000, efforts: ['low', 'max'], images: true, reasoning: true, prices: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 2 } } } })
  const live = { contextWindow: 800_000, efforts: [], images: false, reasoning: false, prices: { input: 0, cacheRead: 0 } }
  const gaps = factsOwner?.operatorModelFacts(fresh, live)
  check('family defaults leave every stated live fact alone, including false, empty and zero', gaps !== undefined && gaps.contextWindow === undefined && gaps.efforts === undefined && gaps.images === undefined && gaps.reasoning === undefined && gaps.prices?.input === undefined && gaps.prices?.cacheRead === undefined, 'operatorModelFacts(model, recorded) in src/models/catalogue/modelOverrides.ts must not override live facts, including false, empty and zero')
  check('family defaults still fill independent missing live facts', gaps?.maxOutputTokens === 180_000 && gaps?.prices?.output === 3 && gaps?.prices?.cacheWrite === 2, 'operatorModelFacts in src/models/catalogue/modelOverrides.ts must still fill facts the live record lacks')
  set({ _default: { deepseek: { prices: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 2 } } }, [fresh]: { contextWindow: 1_500_000, prices: { input: 7 } } })
  const explicit = factsOwner?.operatorModelFacts(fresh, live)
  check('explicit model facts win while family price defaults fill only remaining gaps', explicit?.contextWindow === 1_500_000 && explicit?.prices?.input === 7 && explicit?.prices?.output === 3 && explicit?.prices?.cacheRead === undefined && explicit?.prices?.cacheWrite === 2, 'operatorModelFacts in src/models/catalogue/modelOverrides.ts must let the explicit entry win and fill only remaining price gaps from _default')
  set({ [known]: { contextWindow: before.context.window * 2, maxOutputTokens: before.context.outputMax * 2, prices: { input: 9, output: 27 } } })
  check('explicit facts can raise a known model window and ceiling', capabilities.getContextWindowForModel(known) === before.context.window * 2 && capabilities.getModelMaxOutputTokens(known).default === before.context.outputMax * 2, 'a models entry larger than the table must raise the window and ceiling; see resolveModelCapabilities in src/models/facts/capabilities.ts')
  const openaiCat = await import(`${root}/src/models/roads/openai/openaiCatalogue.ts`)
  const freshGpt = 'gpt-9.9'
  openaiCat.primeOpenaiCatalogue({ sourceKind: 'api-key', models: [{ id: freshGpt, supportedReasoningEfforts: [], reasoningEffortsStated: false, contextWindow: 800_000, inputModalities: ['text'] }, { id: 'gpt-6-astra', supportedReasoningEfforts: ['low', 'high', 'max'], reasoningEffortsStated: true, contextWindow: 800_000, inputModalities: ['text', 'image'] }], fetchedAtMs: Date.now() })
  set({ [freshGpt]: { efforts: ['low', 'max'], images: true } })
  const cand1 = openaiCat.evaluateGptCandidate(freshGpt, 'api-key')
  check('the native OpenAI catalogue candidate uses explicit stated effort and image facts', cand1.ok && cand1.candidate.live.supportedReasoningEfforts.includes('max') && Boolean(cand1.candidate.live.inputModalities?.includes('image')), 'evaluateGptCandidate in src/models/roads/openai/openaiCatalogue.ts must apply the stated efforts and images')
  set({ _default: { openai: { efforts: ['max'], images: true } } })
  const cand2 = openaiCat.evaluateGptCandidate(freshGpt, 'api-key')
  check('a family default fills the native vocabulary missing from a live unknown row without overwriting its live media statement', cand2.ok && cand2.candidate.live.supportedReasoningEfforts.includes('max') && !cand2.candidate.live.inputModalities?.includes('image'), 'evaluateGptCandidate in src/models/roads/openai/openaiCatalogue.ts must apply the _default.openai efforts but keep the live media statement')
  set({ 'gpt-6-astra': { efforts: ['low'], images: false, reasoning: false } })
  const cand3 = openaiCat.evaluateGptCandidate('gpt-6-astra', 'api-key')
  check('smaller metadata keeps the native live effort and image capabilities', cand3.ok && cand3.candidate.live.supportedReasoningEfforts.includes('max') && Boolean(cand3.candidate.live.inputModalities?.includes('image')), 'evaluateGptCandidate in src/models/roads/openai/openaiCatalogue.ts must not let smaller metadata drop live efforts or images')

  console.log('refusals')
  set({})
  const estate = pinnedIds.map(id => ({ id, capabilities: capabilities.resolveModelCapabilities(id), efforts: effortWords(id) }))
  set(Object.fromEntries(pinnedIds.map(id => [id, { contextWindow: 1, maxOutputTokens: 1, efforts: [], images: false, reasoning: false, prices: { input: 0 } }])))
  const estateAfter = estate.map(row => ({ ...row, after: capabilities.resolveModelCapabilities(row.id) }))
  check('smaller facts preserve every recorded model window and output ceiling across families', estateAfter.every(row => row.after.context.window >= row.capabilities.context.window && row.after.context.outputMax >= row.capabilities.context.outputMax), 'a smaller stated window or ceiling lowered a recorded model; see resolveModelCapabilities in src/models/facts/capabilities.ts and operatorModelFacts in src/models/catalogue/modelOverrides.ts')
  check('an empty effort entry removes no recorded rung across families', estate.every(row => row.efforts.every(word => effortWords(row.id).includes(word))), 'an empty efforts list removed a recorded rung; see effortVocabularyFor in src/models/facts/capabilities.ts')
  check('false facts remove no recorded reasoning or image capability across families', estateAfter.every(row => (!row.capabilities.thinking.supported || row.after.thinking.supported) && (!row.capabilities.media.images || row.after.media.images)), 'false reasoning or images removed a recorded capability; see resolveModelCapabilities in src/models/facts/capabilities.ts')
  check('a zero price still applies beside all refused capability reductions', pinnedIds.every(id => pricing.resolveModelPricing(id).costs.inputTokens === 0), 'a stated zero input price was dropped; see resolveModelPricing in src/models/usage/modelCost.ts')
  set({ [known]: { contextWindow: 1024, maxOutputTokens: 32, efforts: ['low'], images: false, reasoning: false, prices: { input: 9, output: 27 } } })
  const after = capabilities.resolveModelCapabilities(known)
  check('a smaller operator window never lowers the table capability', after.context.window === before.context.window, 'resolveModelCapabilities in src/models/facts/capabilities.ts must keep the table window when the stated one is smaller')
  check('a smaller operator output never lowers the table capability', after.context.outputMax === before.context.outputMax && after.context.outputDefault >= before.context.outputDefault, 'resolveModelCapabilities in src/models/facts/capabilities.ts must keep the table output ceiling and default when the stated one is smaller')
  check('a stated effort list never removes max or another table-supported rung', effortWords(known).includes('max') && effortWords(known).includes('xhigh'), 'effortVocabularyFor in src/models/facts/capabilities.ts must keep table-supported rungs when a models entry lists fewer')
  check('false media and reasoning facts never remove known capabilities', after.media.images === before.media.images && after.thinking.supported === before.thinking.supported, 'resolveModelCapabilities in src/models/facts/capabilities.ts must keep table images and thinking when a models entry says false')
  check('other stated facts still apply beside a rejected capability reduction', pricing.resolveModelPricing(known).costs.inputTokens === 9 && pricing.resolveModelPricing(known).costs.outputTokens === 27, 'the stated prices must still apply when capability reductions are refused; see resolveModelPricing in src/models/usage/modelCost.ts')
  set({ [fresh]: { contextWindow: 1_500_000 } }, { engine: { roster: [known] } })
  check('metadata never bypasses the model admission allowlist', !isModelAllowed(fresh), 'isModelAllowed in src/models/catalogue/modelAllowlist.ts must refuse ids outside engine.roster even when a models entry exists')
  for (const bad of [{ contextWindow: -1 }, { maxOutputTokens: 0 }, { prices: { input: -1 } }, { prices: { output: 'cheap' } }, { efforts: ['unknown-effort'] }, { images: 'yes' }, { reasoning: null }]) {
    const verdict = SettingsSchema().safeParse({ models: { [fresh]: bad } })
    check(`malformed model facts are refused: ${JSON.stringify(bad)}`, !verdict.success, 'the models schema must reject this entry; see ModelFactsSchema in src/platform/settings/modelFacts.ts and its use in src/platform/settings/settingsSchema.ts')
  }
  set({})
  check('the ordinary model capability record is byte-identical with no overrides', JSON.stringify(capabilities.resolveModelCapabilities(known)) === JSON.stringify(before), 'clearing the models settings must restore the original record; see resolveModelCapabilities in src/models/facts/capabilities.ts and resetSettingsCache')
  check('the ordinary model prices are byte-identical with no overrides', JSON.stringify(pricing.resolveModelPricing(known)) === JSON.stringify(basePrices), 'clearing the models settings must restore the original prices; see resolveModelPricing in src/models/usage/modelCost.ts')
  console.log(`${failures ? 'MODEL FACTS RED' : 'MODEL FACTS GREEN'} (${checks} checks, ${failures} failures)`)
} finally { rmSync(home, { recursive: true, force: true }) }
process.exit(failures ? 1 : 0)
