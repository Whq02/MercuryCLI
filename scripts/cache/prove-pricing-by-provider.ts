#!/usr/bin/env bun
// ============================================================================
//  scripts/cache/prove-pricing-by-provider.ts — the ledger prices every
//  request at its own provider's rates from ONE pricing owner per provider
//  (the usage-neutrality law; FN-018 rank 3's remainder).
//
//  Before this owner table, modelCost consulted the GPT, DeepSeek and Kimi
//  pins and priced every other id — GLM, Gemini, Hugging Face, a custom
//  endpoint, an unpinned GPT id — at the first-party default tier under the
//  unknown-cost flag: another vendor's rate dressed as a price, and the
//  caveat printed on the /cost headline alone. Now the routing law names the
//  family, the family's own owner answers (its published-rate table, the
//  OpenRouter catalogue row, the Hugging Face listed floor, the local zero),
//  and a turn on an id with no rate on file lands UNPRICED: its tokens are
//  counted, the ledger counts the turn (never sums a zero as its price), the
//  flag is raised, and every spend readout says "unpriced" — a lane that
//  priced nothing never reads "$0.00", a figure that includes such turns
//  says "+ N unpriced turns" beside itself (the ruling: honest absence,
//  never a foreign rate, never printed as free).
//
//   §1 one owner per route — each family prices at its own recorded rates
//   §2 no owner prices another family's turn — unpriced is a zero tier under
//      the flag, never another vendor's tier
//   §3 the ledger counts the turns it could not price, and every spend view
//      spells them beside the figure — "unpriced", never "$0.00"
//   §4 the display string follows the same owner
//   §5 the shape
//
//  Run:  ~/.bun/bin/bun run scripts/cache/prove-pricing-by-provider.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'prove-pricing-by-provider-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_HOME = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.ANTHROPIC_MODEL
// The OpenRouter fixture: a credential (so the catalogue gate opens) and a
// non-resolvable base — the fetch below is a fixture, no network.
process.env.OPENROUTER_API_KEY = 'sk-or-fixture000'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9
const perM = (tokens: number, rate: number): number => (tokens * rate) / 1e6

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const cost = await import('../../src/utils/modelCost.ts')
const state = await import('../../src/bootstrap/state.ts')
const { glmPricePin } = await import('../../src/services/providers/zai/glmPins.ts')
const { geminiPricePin, geminiPriceTierFor } = await import('../../src/services/providers/gemini/geminiPins.ts')
const { gptDisplayPin } = await import('../../src/services/providers/openai/gptPins.ts')
const { deepseekDisplayPin } = await import('../../src/services/providers/deepseek/deepseekPins.ts')
const { kimiDisplayPin } = await import('../../src/services/providers/moonshot/kimiPins.ts')
const { huggingfaceDisplayPin } = await import('../../src/services/providers/huggingface/huggingfacePins.ts')
const orCatalogue = await import('../../src/services/providers/openrouter/openrouterCatalogue.ts')
// The usage owner and the cost tracker load HERE, by import, before §2's
// first-party estimate walks the computed default (which require()s the
// owner lazily): when the owner first enters this process through
// that require, a later import() can see one of its exports undefined — the
// owner prover, which imports first, never does. Load order is the law.
const owner = await import('../../src/services/providers/providerUsage.ts')
const tracker = await import('../../src/cost-tracker.ts')

type Usage = Parameters<typeof cost.calculateUSDCost>[1]
const usage = (input: number, output: number, cacheRead = 0): Usage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: 0,
})
const flagReset = (): void => state.setHasUnknownModelCost(false)
const zeroTier = (t: ReturnType<typeof cost.getModelCosts>): boolean =>
  t.inputTokens === 0 && t.outputTokens === 0 && t.promptCacheReadTokens === 0 && t.promptCacheWriteTokens === 0 && t.webSearchRequests === 0

console.log('the ledger prices every request at its own provider\'s rates from one owner per provider')

// ── §1 one owner per route ──────────────────────────────────────────────────
section('§1 one owner per route — each family prices at its own recorded rates')
{
  flagReset()
  const sonnet = cost.resolveModelPricing('claude-sonnet-5')
  check('first-party: claude-sonnet-5 at the 3/15 tier, basis recorded', sonnet.basis === 'recorded' && sonnet.costs.inputTokens === 3 && sonnet.costs.outputTokens === 15)

  const gpt = gptDisplayPin('gpt-5.6-sol')!
  const gptPricing = cost.resolveModelPricing('gpt-5.6-sol')
  check('openai: gpt-5.6-sol at its pin, basis recorded', gptPricing.basis === 'recorded' && gptPricing.costs.inputTokens === gpt.costInPerMtok && gptPricing.costs.outputTokens === gpt.costOutPerMtok)

  const glm = glmPricePin('glm-5.3')!
  const glmPricing = cost.resolveModelPricing('glm-5.3')
  check('zai: the GLM price pin exists for glm-5.3 (docs.z.ai pricing, dated)', glm.observedAt >= '2026-09-01' && glm.costInPerMtok === 1.4 && glm.costOutPerMtok === 4.4 && glm.cachedInPerMtok === 0.26)
  check('zai: glm-5.3 prices at the GLM pin, basis recorded (the base flagged it at the first-party tier)', glmPricing.basis === 'recorded' && glmPricing.costs.inputTokens === 1.4 && glmPricing.costs.outputTokens === 4.4 && glmPricing.costs.promptCacheReadTokens === 0.26)
  check('zai: cache write at the input rate (cache storage is stated free)', glmPricing.costs.promptCacheWriteTokens === 1.4)
  check('zai: a turn prices at the pin arithmetic', near(cost.calculateUSDCost('glm-5.3', usage(100_000, 10_000, 20_000)), perM(100_000, 1.4) + perM(10_000, 4.4) + perM(20_000, 0.26)))
  const freeGlm = cost.resolveModelPricing('glm-4.5-flash')
  check('zai: a FREE row is a recorded zero, not an unpriced one', freeGlm.basis === 'recorded' && zeroTier(freeGlm.costs))
  check('zai: an id the page does not state is unpriced', cost.resolveModelPricing('glm-9.9-nonesuch').basis === 'unpriced')
  check('zai: the recorded lanes never raise the unknown-cost flag', (cost.getModelCosts('glm-5.3'), state.hasUnknownModelCost() === false))

  const kimi = kimiDisplayPin('kimi-k3')!
  const kimiPricing = cost.resolveModelPricing('kimi-k3')
  check('moonshot: kimi-k3 at its pin, basis recorded', kimiPricing.basis === 'recorded' && kimiPricing.costs.inputTokens === kimi.costInPerMtok && kimiPricing.costs.promptCacheReadTokens === kimi.cachedInPerMtok)
  check('moonshot: an unpriced pin row (kimi-k2.6 states no price) is unpriced, never a tier', cost.resolveModelPricing('kimi-k2.6').basis === 'unpriced')

  const flash = deepseekDisplayPin('deepseek-v4-flash')!
  const dsPricing = cost.resolveModelPricing('deepseek-v4-flash')
  check('deepseek: deepseek-v4-flash at its pin, basis recorded', dsPricing.basis === 'recorded' && dsPricing.costs.inputTokens === flash.costInPerMtok && dsPricing.costs.outputTokens === flash.costOutPerMtok)

  const pro = geminiPricePin('gemini-2.5-pro')!
  const proBase = cost.resolveModelPricing('gemini-2.5-pro', { promptTokens: 150_000 })
  const proLong = cost.resolveModelPricing('gemini-2.5-pro', { promptTokens: 250_000 })
  check('gemini: the price pin exists for gemini-2.5-pro (ai.google.dev pricing, dated)', pro.observedAt >= '2026-09-01' && pro.costInPerMtok === 1.25 && pro.costOutPerMtok === 10 && pro.longPrompt?.promptTokensAbove === 200_000)
  check('gemini: a 150k prompt prices at the base tier, basis recorded', proBase.basis === 'recorded' && proBase.costs.inputTokens === 1.25 && proBase.costs.outputTokens === 10 && proBase.costs.promptCacheReadTokens === 0.125)
  check('gemini: a 250k prompt prices at the stated longer-prompt tier', proLong.basis === 'recorded' && proLong.costs.inputTokens === 2.5 && proLong.costs.outputTokens === 15 && proLong.costs.promptCacheReadTokens === 0.25)
  const longTurn = cost.calculateUSDCost('gemini-2.5-pro', usage(230_000, 1_000, 30_000))
  check('gemini: calculateUSDCost counts every input-side token toward the threshold (230k uncached + 30k cached = the long tier)', near(longTurn, perM(230_000, 2.5) + perM(1_000, 15) + perM(30_000, 0.25)), String(longTurn))
  const shortTurn = cost.calculateUSDCost('gemini-2.5-pro', usage(100_000, 1_000, 50_000))
  check('gemini: a 150k prompt stays on the base tier', near(shortTurn, perM(100_000, 1.25) + perM(1_000, 10) + perM(50_000, 0.125)), String(shortTurn))
  const flashLite = cost.resolveModelPricing('gemini-2.5-flash-lite')
  check('gemini: a flat row prices flat (gemini-2.5-flash-lite $0.10/$0.40, cache $0.01)', flashLite.basis === 'recorded' && flashLite.costs.inputTokens === 0.1 && flashLite.costs.outputTokens === 0.4 && flashLite.costs.promptCacheReadTokens === 0.01)
  const f37 = geminiPricePin('gemini-3.7-flash')!
  const today = geminiPriceTierFor(f37, undefined, '2026-09-01')
  const later = geminiPriceTierFor(f37, undefined, '2027-01-01')
  check('gemini: an announced price change is carried and applies on its date, not before', today.costInPerMtok === 0.75 && today.costOutPerMtok === 3.75 && later.costInPerMtok === 1.5 && later.costOutPerMtok === 7.5)
  check('gemini: an id the page does not state is unpriced (never a neighbour\'s rate)', cost.resolveModelPricing('gemini-2.5-pro-preview-05-06').basis === 'unpriced')

  // OpenRouter: the ACTIVE credential's cached catalogue row is the owner.
  orCatalogue.__resetOpenrouterCatalogueForTest()
  check('openrouter: unfetched catalogue ⇒ unpriced (the wire-stated cost is the lane\'s own business)', cost.resolveModelPricing('openrouter/qwen/qwen3-coder').basis === 'unpriced')
  const fixtureFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 'qwen/qwen3-coder',
            name: 'Qwen3 Coder',
            context_length: 262_144,
            pricing: { prompt: '0.0000003', completion: '0.0000012', request: '0', input_cache_read: '0.00000006' },
          },
          { id: 'fixture/priceless', name: 'Priceless', context_length: 8_192 },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  const snapshot = await orCatalogue.refreshOpenrouterCatalogue('env', { force: true, fetchImpl: fixtureFetch })
  check('openrouter: the fixture catalogue landed (fixture is meaningful)', (snapshot?.models.length ?? 0) === 2 && snapshot?.models[0]?.pricing?.inputCacheRead === '0.00000006', JSON.stringify(snapshot?.models))
  const orPricing = cost.resolveModelPricing('openrouter/qwen/qwen3-coder')
  check('openrouter: a listed row prices at ITS stated per-token figures ×1e6, basis recorded', orPricing.basis === 'recorded' && near(orPricing.costs.inputTokens, 0.3) && near(orPricing.costs.outputTokens, 1.2), JSON.stringify(orPricing))
  check('openrouter: the stated cache-read rate rides; an unstated cache-write rate is the input rate', near(orPricing.costs.promptCacheReadTokens, 0.06) && near(orPricing.costs.promptCacheWriteTokens, 0.3))
  check('openrouter: a listed row WITHOUT pricing is unpriced', cost.resolveModelPricing('openrouter/fixture/priceless').basis === 'unpriced')
  check('openrouter: an unlisted slug is unpriced', cost.resolveModelPricing('openrouter/nobody/nothing').basis === 'unpriced')

  const hfPin = huggingfaceDisplayPin('huggingface/deepseek-ai/DeepSeek-V4-Pro-0813')!
  const hf = cost.resolveModelPricing('huggingface/deepseek-ai/DeepSeek-V4-Pro-0813')
  check('huggingface: a pinned slug prices at its listed FLOOR, basis floor (an estimate at or below the bill)', hf.basis === 'floor' && hf.costs.inputTokens === hfPin.priceFloorInPerMtok && hf.costs.outputTokens === hfPin.priceFloorOutPerMtok)
  flagReset()
  cost.getModelCosts('huggingface/deepseek-ai/DeepSeek-V4-Pro-0813')
  check('huggingface: the floor raises the unknown-cost flag (the caveat prints)', state.hasUnknownModelCost() === true)
  check('huggingface: an unpinned slug is unpriced', cost.resolveModelPricing('huggingface/nobody/nothing').basis === 'unpriced')

  flagReset()
  const local = cost.resolveModelPricing('local/llama3.1:8b')
  cost.getModelCosts('local/llama3.1:8b')
  check('local: a recorded zero on every axis, no flag', local.basis === 'recorded' && zeroTier(local.costs) && state.hasUnknownModelCost() === false)
}

// ── §2 no owner prices another family's turn ────────────────────────────────
section('§2 no owner prices another family\'s turn — unpriced is zero, never a tier')
{
  for (const id of ['compat/fixture-model', 'glm-9.9-nonesuch', 'gemini-2.5-pro-preview-05-06', 'gpt-5.5', 'huggingface/nobody/nothing', 'openrouter/nobody/nothing', 'no-family-declares-this']) {
    flagReset()
    const resolved = cost.resolveModelPricing(id)
    const priced = cost.calculateUSDCost(id, usage(100_000, 10_000))
    check(`${id}: unpriced ⇒ zero on every axis (the base charged $0.635 at the first-party tier)`, resolved.basis === 'unpriced' && zeroTier(resolved.costs) && priced === 0, `${resolved.basis} ${JSON.stringify(resolved.costs)} ${priced}`)
    check(`${id}: …and the unknown-cost flag is raised (never a silent zero)`, state.hasUnknownModelCost() === true)
  }
  flagReset()
  const unknownFirstParty = cost.resolveModelPricing('claude-nonesuch-9')
  cost.getModelCosts('claude-nonesuch-9')
  check('an unrecorded FIRST-PARTY id is a same-family estimate (a first-party tier), flagged', unknownFirstParty.basis === 'family-estimate' && unknownFirstParty.costs.inputTokens > 0 && state.hasUnknownModelCost() === true, JSON.stringify(unknownFirstParty))
  const strangerRoute = (await import('../../src/services/providers/routeLaw.ts')).declaredRouteOf('no-family-declares-this')
  check('an id no family declares has no owner (route null) and is unpriced', strangerRoute === null && cost.resolveModelPricing('no-family-declares-this').basis === 'unpriced')
}

// ── §3 the spend views ──────────────────────────────────────────────────────
section('§3 the ledger counts the turns it could not price, and every spend view says "unpriced" — never "$0.00"')
{
  const { addToTotalSessionCost, resetCostState, formatLaneSpend, formatSessionCost, formatTotalCost, getTotalUnpricedTurns, getUnpricedTurns } = tracker
  const { providerSessionSpend } = owner
  resetCostState()
  const ledgerUsage = { ...usage(1_000, 100), cache_creation_input_tokens: 0 } as Parameters<typeof addToTotalSessionCost>[1]
  const settle = (model: string, pricing?: { basis: 'wire-stated' }, wireCost?: number): void => {
    addToTotalSessionCost(wireCost ?? cost.calculateUSDCost(model, ledgerUsage), ledgerUsage, model, pricing)
  }
  settle('compat/fixture-model')
  settle('compat/fixture-model')
  settle('huggingface/deepseek-ai/DeepSeek-V4-Pro-0813')
  settle('glm-5.3')
  check('the ledger counted the two unpriced turns on the custom endpoint and none elsewhere', getUnpricedTurns()['compat/fixture-model'] === 2 && Object.keys(getUnpricedTurns()).length === 1 && getTotalUnpricedTurns() === 2, JSON.stringify(getUnpricedTurns()))
  const compat = providerSessionSpend('openai-compat')
  const hf = providerSessionSpend('huggingface')
  const zai = providerSessionSpend('zai')
  check('compat lane: the tokens landed (two turns) and no USD was summed', compat.models === 1 && compat.inputTokens === 2_000 && compat.costUSD === 0, JSON.stringify(compat))
  check("compat lane: the spend view carries the ledger's count (one model, two turns)", compat.pricing?.unpricedModels === 1 && compat.pricing?.unpricedTurns === 2 && compat.pricing?.estimatedModels === 0, JSON.stringify(compat.pricing))
  check('compat lane: the figure reads "unpriced", never "$0.00"', formatLaneSpend(compat) === 'unpriced (2 unpriced turns — no rate on file, tokens counted)', formatLaneSpend(compat))
  check('huggingface lane: the floor is marked as an estimate beside its figure', hf.pricing?.estimatedModels === 1 && hf.pricing?.unpricedTurns === 0 && /^\$[\d.]+ \(one model at an estimated rate\)$/.test(formatLaneSpend(hf)), formatLaneSpend(hf))
  check('zai lane: wholly at recorded rates ⇒ a plain figure', zai.pricing === undefined && /^\$[\d.]+$/.test(formatLaneSpend(zai)), formatLaneSpend(zai))
  // A wire-stated cost is a price whatever the owner holds for the id.
  orCatalogue.__resetOpenrouterCatalogueForTest()
  check('openrouter (catalogue unfetched): the owner holds no rate', cost.resolveModelPricing('openrouter/nobody/nothing').basis === 'unpriced')
  settle('openrouter/nobody/nothing', { basis: 'wire-stated' }, 0.01)
  const orPriced = providerSessionSpend('openrouter')
  check('a wire-stated turn is NOT counted unpriced', orPriced.pricing === undefined && Math.abs(orPriced.costUSD - 0.01) < 1e-12 && getUnpricedTurns()['openrouter/nobody/nothing'] === undefined, JSON.stringify(orPriced))
  settle('openrouter/nobody/nothing')
  const orMixed = providerSessionSpend('openrouter')
  check('a mixed lane says "+ N unpriced turns" beside its figure', orMixed.pricing?.unpricedTurns === 1 && formatLaneSpend(orMixed) === '$0.0100 + 1 unpriced turn', formatLaneSpend(orMixed))
  // The spelling law itself.
  check('formatSessionCost: no unpriced turns ⇒ the plain figure', formatSessionCost(0.25, 0) === '$0.2500' && formatSessionCost(0, 0) === '$0.0000')
  check('formatSessionCost: unpriced turns beside a figure', formatSessionCost(1.5, 3) === '$1.50 + 3 unpriced turns')
  check('formatSessionCost: nothing priced ⇒ "unpriced", never a zero', formatSessionCost(0, 1) === 'unpriced (1 unpriced turn — no rate on file, tokens counted)')
  // The /cost headline and its rows.
  const total = formatTotalCost().replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
  check('/cost headline: the total says "+ 3 unpriced turns" beside its figure', /Total cost:\s+\$[\d.]+ \+ 3 unpriced turns/.test(total), total.split('\n')[0])
  check('/cost rows: the unpriced model row reads unpriced', total.includes('(unpriced (2 unpriced turns — no rate on file, tokens counted))'), total)
  check('/cost rows: no $0.0000 row for the unpriced model', !/compat[^\n]*\$0\.0000/.test(total), total)
  const { nonAnthropicLaneLines } = await import('../../src/commands/cost/cost.ts')
  const { getModelUsage } = await import('../../src/bootstrap/state.ts')
  const lines = nonAnthropicLaneLines({
    usage: () => getModelUsage(),
    unpricedTurns: () => getUnpricedTurns(),
    openaiView: () => ({ provider: 'openai', entries: [], sessionSpend: { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }, limits: { kind: 'openai-observed', window: { state: 'clear' } } }),
  })
  const compatLine = lines.find(l => l.startsWith('Custom endpoint'))
  const hfLine = lines.find(l => l.startsWith('Hugging Face'))
  const orLine = lines.find(l => l.startsWith('OpenRouter'))
  check('/cost lane row: the custom-endpoint lane reads unpriced', compatLine !== undefined && compatLine.endsWith('— unpriced (2 unpriced turns — no rate on file, tokens counted)'), JSON.stringify(lines))
  check('/cost lane row: the Hugging Face lane carries the estimate mark beside its figure', hfLine !== undefined && /— \$[\d.]+ \(one model at an estimated rate\)$/.test(hfLine), hfLine)
  check('/cost lane row: the mixed OpenRouter lane says "+ 1 unpriced turn"', orLine !== undefined && orLine.endsWith('— $0.0100 + 1 unpriced turn'), orLine)
  check('/cost lane row: the GLM lane is a plain figure', lines.some(l => l.startsWith('Z.AI') && /— \$[\d.]+$/.test(l)), JSON.stringify(lines))
  // The count persists with the cost row and restores with it (a resume
  // never turns an unpriced session into a free one).
  const { getSessionId } = await import('../../src/bootstrap/state.ts')
  let persisted = false
  try {
    tracker.saveCurrentSessionCosts()
    const stored = tracker.getStoredSessionCosts(getSessionId())
    persisted = stored?.unpricedTurns?.['compat/fixture-model'] === 2 && stored?.unpricedTurns?.['openrouter/nobody/nothing'] === 1
    resetCostState()
    check('resetCostState clears the count', getTotalUnpricedTurns() === 0)
    tracker.restoreCostStateForSession(getSessionId())
  } catch (error) {
    console.log(`  (persistence leg threw: ${String(error)})`)
  }
  check('the unpriced-turn counts persist with the cost row and restore with it', persisted && getTotalUnpricedTurns() === 3, `persisted=${persisted} restored=${getTotalUnpricedTurns()}`)
  resetCostState()
}

// ── §4 the display string ───────────────────────────────────────────────────
section('§4 the display string follows the same owner')
{
  check('glm-5.3 displays its recorded rate', cost.getModelPricingString('glm-5.3') === '$1.40/$4.40 per Mtok', String(cost.getModelPricingString('glm-5.3')))
  check('gemini-2.5-flash displays its recorded rate', cost.getModelPricingString('gemini-2.5-flash') === '$0.30/$2.50 per Mtok', String(cost.getModelPricingString('gemini-2.5-flash')))
  check('a Hugging Face floor displays (it is a published figure)', cost.getModelPricingString('huggingface/deepseek-ai/DeepSeek-V4-Pro-0813') === '$1.32/$3.96 per Mtok')
  check('an unpriced id displays nothing', cost.getModelPricingString('compat/fixture-model') === undefined)
  check('a same-family estimate displays nothing (the display never shows a guessed figure)', cost.getModelPricingString('claude-nonesuch-9') === undefined)
  check('the first-party rows still display', cost.getModelPricingString('claude-sonnet-5') === '$3/$15 per Mtok')
}

// ── §5 the shape ────────────────────────────────────────────────────────────
section('§5 the shape')
{
  const src = readFileSync(join(ROOT, 'src/utils/modelCost.ts'), 'utf8')
  for (const route of ['anthropic', 'openai', 'zai', 'moonshot', 'deepseek', 'gemini', 'openrouter', 'huggingface', 'local', "'openai-compat'"]) {
    check(`the owner table carries a row for ${route}`, new RegExp(`^\\s+${route}: `, 'm').test(src))
  }
  check('the owner table is typed over every route (a new family without a row is a type error)', src.includes('Record<CallModelRoute, PricingOwner>'))
  check('the unpriced basis is a zero tier under the flag, spelled once', src.includes("resolved ?? { costs: COST_UNPRICED, basis: 'unpriced' }") && src.includes("if (resolved.basis !== 'recorded') setHasUnknownModelCost()"))
  // The reachability pin, read from the owners table itself: the first-party
  // owner is named on the anthropic row alone, and no other row (the gemini
  // row spans lines) touches the first-party table, a first-party tier
  // constant or the first-party fallback; the fallback constant is spent
  // inside firstPartyPricing and nowhere else. (An identifier count was the
  // first cut of this pin — the first-party TABLE rows legitimately spell
  // the Opus tier constant, which is a recorded first-party rate, not a
  // fallback; an identifier count miscounts those rows.)
  const ownersStart = src.indexOf('const PRICING_OWNERS')
  const ownersTable = src.slice(ownersStart, src.indexOf('\n}\n', ownersStart))
  const ownerRows = ownersTable.split('\n').filter(l => /^\s+[a-z'-]+: /.test(l))
  const offFirstParty = ownersTable.split('\n').filter(l => !/^\s+anthropic: /.test(l))
  check('the owners table has one row per route (ten), the first-party owner on its anthropic row alone', ownerRows.length === 10 && ownerRows.filter(l => l.includes('firstPartyPricing')).length === 1 && /^\s+anthropic: model => firstPartyPricing\(model\),$/m.test(ownersTable), ownerRows.join(' | '))
  check('no first-party tier is reachable for a non-first-party route: no other line of the owners table touches the first-party table, a first-party tier constant or the first-party fallback', offFirstParty.every(l => !/firstPartyPricing|COST_TIER_|MODEL_COSTS|FIRST_PARTY_FALLBACK_TIER|COST_FABLE|COST_HAIKU/.test(l)), offFirstParty.filter(l => /firstPartyPricing|COST_TIER_|MODEL_COSTS|FIRST_PARTY_FALLBACK_TIER|COST_FABLE|COST_HAIKU/.test(l)).join(' | '))
  const fpStart = src.indexOf('function firstPartyPricing')
  const fpBody = src.slice(fpStart, src.indexOf('\n}\n', fpStart))
  // The shape, not an occurrence total (a doc line naming the constant is
  // not a spend): among the non-comment lines, exactly one declaration and
  // exactly one spend site, and that site sits inside firstPartyPricing.
  const codeLines = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  const declarationLines = codeLines.filter(l => /^const FIRST_PARTY_FALLBACK_TIER: ModelCosts = COST_TIER_5_25$/.test(l))
  const spendLines = codeLines.filter(l => l.includes('FIRST_PARTY_FALLBACK_TIER') && !/^const FIRST_PARTY_FALLBACK_TIER/.test(l))
  check('the first-party fallback tier is declared once and spent at one site, inside firstPartyPricing', declarationLines.length === 1 && spendLines.length === 1 && spendLines[0]?.trim() === "return { costs: FIRST_PARTY_FALLBACK_TIER, basis: 'family-estimate' }" && fpBody.includes("return { costs: FIRST_PARTY_FALLBACK_TIER, basis: 'family-estimate' }"), `declarations=${declarationLines.length} spends=${JSON.stringify(spendLines)}`)
  check("the 'family-estimate' basis is minted inside firstPartyPricing alone", (src.match(/basis: 'family-estimate'/g) ?? []).length === 2 && (fpBody.match(/basis: 'family-estimate'/g) ?? []).length === 2)
  const compat = readFileSync(join(ROOT, 'src/services/providers/openaicompat/compatChatCallModel.ts'), 'utf8')
  check('the compat lane still lets the wire-stated OpenRouter cost win at settlement', compat.includes('usageSeen.statedCostUSD ?? calculateUSDCost(modelId, finalUsage as never)'))
  const catalogue = readFileSync(join(ROOT, 'src/services/providers/openrouter/openrouterCatalogue.ts'), 'utf8')
  check('the OpenRouter catalogue decodes the stated cache-read and cache-write rates', catalogue.includes('input_cache_read') && catalogue.includes('input_cache_write'))
  const glm = readFileSync(join(ROOT, 'src/services/providers/zai/glmPins.ts'), 'utf8')
  const gemini = readFileSync(join(ROOT, 'src/services/providers/gemini/geminiPins.ts'), 'utf8')
  check('both new price tables are zero-import (bun-loadable pins)', !/^import /m.test(glm) && !/^import /m.test(gemini))
  check('both new price tables name their source and date', glm.includes('docs.z.ai/guides/overview/pricing') && gemini.includes('ai.google.dev/gemini-api/docs/pricing') && glm.includes("observedAt: '2026-09-01'") && gemini.includes("observedAt: '2026-09-01'"))
  const tab = readFileSync(join(ROOT, 'src/components/Settings/Usage.tsx'), 'utf8')
  check('the Usage tab spells its spend line through the one law (formatLaneSpend)', tab.includes('formatLaneSpend(spend)') && !tab.includes('spendPricingNote'))
  const tracker = readFileSync(join(ROOT, 'src/cost-tracker.ts'), 'utf8')
  check('the ledger counts an unpriced turn at the one settlement door, and a wire-stated cost is exempt', tracker.includes("if (pricing?.basis !== 'wire-stated' && modelPricingBasis(model) === 'unpriced') {") && tracker.includes('recordUnpricedTurn(model)'))
  check('the ledger persists and restores the count with the cost row', tracker.includes('lastUnpricedTurns: { ...getUnpricedTurns() }') && tracker.includes('unpricedTurns: config.lastUnpricedTurns'))
  check('the compat lane names its wire-stated cost as a price', compat.includes("usageSeen.statedCostUSD !== undefined ? { basis: 'wire-stated' } : undefined"))
  const facts = readFileSync(join(ROOT, 'src/services/engine-connector/types.ts'), 'utf8')
  const runner = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')
  check("the session's usage facts carry the count (additive) and the runner fills it", facts.includes('unpricedTurns?: number') && runner.includes('unpricedTurns: getTotalUnpricedTurns(),'))
  for (const [file, needle] of [
    ['src/components/HelmTelemetryRail.tsx', 'formatLaneSpend(usage.spend)'],
    ['src/components/Deck.tsx', 'formatSessionCost(cost, unpricedTurns)'],
    ['src/components/DeckPane.tsx', 'formatSessionCost(cost, unpricedTurns)'],
    ['src/components/MercuryFrame.tsx', 'formatSessionCost(cost, unpricedTurns)'],
    ['src/components/HelmLanesRail.tsx', 'formatSessionCost(focusedSpendUSD, focusedUnpriced)'],
    ['src/commands/cost/cost.ts', 'formatLaneSpend(spend)'],
  ] as const) {
    check(`${file} spells its figure through the one law`, readFileSync(join(ROOT, file), 'utf8').includes(needle))
  }
  // glm and gemini are the pin sources read above in this block.
  check('every price pin cites its page beside its date', (glm.match(/source: GLM_PRICING_PAGE/g) ?? []).length === (glm.match(/observedAt: '2026-09-01'/g) ?? []).length && (gemini.match(/source: GEMINI_PRICING_PAGE/g) ?? []).length === (gemini.match(/observedAt: '2026-09-01'/g) ?? []).length)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-pricing-by-provider${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
