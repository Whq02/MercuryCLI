#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'small-fast-family-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const srcText = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf-8')

async function main(): Promise<void> {
  console.log('============================================================')
  console.log(' the small-fast tier follows the session family — proof')
  console.log('============================================================')

  delete process.env.MERCURY_SMALL_FAST_MODEL
  delete process.env.MERCURY_MODEL

  const { openaiLightChoice, openaiSmallFastChoice, providerSmallFastFact, smallFastModelFor, sessionLightModel, sessionSmallFastModel } =
    await import('../../src/utils/model/providerFrontier.js')
  const { __resetOpenaiCatalogueForTest, refreshOpenaiCatalogue } = await import('../../src/services/providers/openai/openaiCatalogue.js')
  const { parseGptModelId } = await import('../../src/services/providers/openai/gptPins.js')
  for (const key of ['OPENAI_API_KEY', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
  process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
  process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
  process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'
  const OWNER_LIST = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']
  const fixtureFetch = (ids: readonly string[]): typeof fetch =>
    (async () => new Response(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const serveList = async (ids: readonly string[] | null): Promise<void> => {
    __resetOpenaiCatalogueForTest()
    if (ids === null) {
      delete process.env.OPENAI_API_KEY
      return
    }
    process.env.OPENAI_API_KEY = 'fixture-openai-key'
    const snapshot = await refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fixtureFetch(ids) })
    if (!snapshot || snapshot.models.length !== ids.length) throw new Error(`the fixture list did not seed: ${JSON.stringify(snapshot)}`)
  }
  const { getCanonicalName } = await import('../../src/utils/model/model.js')
  const { getDefaultSonnetModel } = await import('../../src/utils/model/model.js')
  const { settleAssistantTurn } = await import('../../src/services/providers/callModelRouter.js')
  const { APIUserAbortError } = await import('../../src/services/api/sdkErrors.js')

  section('§1 the per-family small-fast fact')
  {
    const anthropic = providerSmallFastFact('anthropic')
    check(
      'anthropic: the ratified small tier (haiku default)',
      anthropic !== undefined && anthropic.modelId.toLowerCase().includes('haiku'),
      anthropic?.modelId,
    )
    process.env.MERCURY_SMALL_FAST_MODEL = 'claude-pin-test'
    check(
      'anthropic: MERCURY_SMALL_FAST_MODEL honoured',
      providerSmallFastFact('anthropic')?.modelId === 'claude-pin-test',
    )
    delete process.env.MERCURY_SMALL_FAST_MODEL
    await serveList(null)
    check('openai with no account and no live list: silence — never a row of the typed table', providerSmallFastFact('openai') === undefined, JSON.stringify(providerSmallFastFact('openai')))
    await serveList(OWNER_LIST)
    const openai = providerSmallFastFact('openai')
    check(
      "openai on the list the owner's account serves: the cheapest served row by the pins' prices (gpt-5.6-luna), never the typed gpt-5.4-mini",
      openai?.modelId === 'gpt-5.6-luna' && openai.displayName === 'GPT-5.6 Luna',
      JSON.stringify(openai),
    )
    await serveList([...OWNER_LIST, 'gpt-6-mini'])
    check('openai on a list that serves a mini row: that row (the provider names its small tier)', providerSmallFastFact('openai')?.modelId === 'gpt-6-mini', JSON.stringify(providerSmallFastFact('openai')))
    await serveList(['gpt-5.5'])
    check('openai on a list with no priced row and no mini: silence, so the session model rides', providerSmallFastFact('openai') === undefined, JSON.stringify(providerSmallFastFact('openai')))
    await serveList(['gpt-5.4-mini', 'gpt-5.6-luna'])
    check('openai on a list that still serves gpt-5.4-mini: that row (served, and named small by the provider)', providerSmallFastFact('openai')?.modelId === 'gpt-5.4-mini', JSON.stringify(providerSmallFastFact('openai')))
    await serveList(null)
    for (const route of ['zai', 'moonshot', 'deepseek', 'gemini', 'openrouter', 'openai-compat', 'huggingface', 'local'] as const) {
      check(`${route}: silence (no owner records a small tier)`, providerSmallFastFact(route) === undefined)
    }
  }

  section('§1b the openai choosers are pure over the served ids and the pins')
  check('the two pure choosers exist', typeof openaiSmallFastChoice === 'function' && typeof openaiLightChoice === 'function')
  if (typeof openaiSmallFastChoice === 'function' && typeof openaiLightChoice === 'function') {
    const pins = [
      { id: 'gpt-5.6-luna', displayName: 'L', observedAt: '2026-09-05', costInPerMtok: 0.2, costOutPerMtok: 1.2 },
      { id: 'gpt-5.6-sol', displayName: 'S', observedAt: '2026-09-05', costInPerMtok: 4, costOutPerMtok: 20 },
      { id: 'gpt-5.4-mini', displayName: 'M', observedAt: '2026-07-17' },
      { id: 'gpt-5.5-mini', displayName: 'M2', observedAt: '2026-07-17', costInPerMtok: 0.5, costOutPerMtok: 2 },
    ]
    check('the cheapest priced served row wins', openaiSmallFastChoice(['gpt-5.6-sol', 'gpt-5.6-luna'], pins) === 'gpt-5.6-luna')
    check('a typed id the list lacks is never chosen', openaiSmallFastChoice(['gpt-5.6-sol'], pins) === 'gpt-5.6-sol' && openaiSmallFastChoice([], pins) === undefined)
    check('an unpriced served mini row outranks a priced row (the provider names it small)', openaiSmallFastChoice(['gpt-5.6-luna', 'gpt-5.4-mini'], pins) === 'gpt-5.4-mini')
    check('a priced mini row dearer than a served row loses to it', openaiSmallFastChoice(['gpt-5.6-luna', 'gpt-5.5-mini'], pins) === 'gpt-5.6-luna')
    check('an unpriced served row that is not mini or nano is never chosen', openaiSmallFastChoice(['gpt-5.5', 'gpt-5.4'], pins) === undefined)
    check('two unpriced small rows: the newest by the grammar', openaiSmallFastChoice(['gpt-5.4-mini', 'gpt-6-nano', 'gpt-5.9-mini'], pins) === 'gpt-6-nano')
    check('the served spelling is read through the grammar (a window annotation, upper case)', openaiSmallFastChoice(['GPT-5.6-Luna[served]'], pins) === 'gpt-5.6-luna')
    const ceiling = parseGptModelId('gpt-6-astra')
    check('the light tier: the newest served plain row below the frontier', openaiLightChoice(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4'], ceiling) === 'gpt-5.5')
    check('the light tier falls to the next served plain row when gpt-5.5 is not served', openaiLightChoice(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4'], ceiling) === 'gpt-5.4')
    check('the light tier answers nothing with no served plain row below the frontier', openaiLightChoice(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6'], ceiling) === undefined && openaiLightChoice(['gpt-5.5'], undefined) === undefined)
  }

  section('§2 smallFastModelFor — all ten routing-law families')
  {
    const small = smallFastModelFor('claude-opus-5')
    check('anthropic session → the small tier', small.toLowerCase().includes('haiku'), small)
    const viaDefault = sessionSmallFastModel()
    check(
      'sessionSmallFastModel: the pinned-home default session rides the small tier (main-loop convenience)',
      viaDefault.toLowerCase().includes('haiku'),
      viaDefault,
    )
    await serveList(null)
    check("openai session with no live list → follows the session's own model (never the typed table)", smallFastModelFor('gpt-5.6-sol') === 'gpt-5.6-sol', smallFastModelFor('gpt-5.6-sol'))
    await serveList(OWNER_LIST)
    const gpt = smallFastModelFor('gpt-5.6-sol')
    check('openai session on the served list → the cheapest served row (gpt-5.6-luna)', gpt === 'gpt-5.6-luna', gpt)
    process.env.MERCURY_SMALL_FAST_MODEL = 'claude-pin-test'
    check(
      'the MERCURY_SMALL_FAST_MODEL pin does NOT leak onto an openai session',
      smallFastModelFor('gpt-5.6-sol') !== 'claude-pin-test',
    )
    check(
      'the MERCURY_SMALL_FAST_MODEL pin does apply on an anthropic session',
      smallFastModelFor('claude-opus-5') === 'claude-pin-test',
    )
    delete process.env.MERCURY_SMALL_FAST_MODEL
    const FOLLOW_SELF = [
      'glm-5.3',
      'kimi-k3',
      'deepseek-chat',
      'gemini-2.5-pro',
      'openrouter/qwen/qwen3-coder',
      'compat/local-vendor-model',
      'huggingface/org/model',
      'local/llama-3.3-70b',
    ]
    for (const model of FOLLOW_SELF) {
      check(`${model} → follows the session's own model (honest absence)`, smallFastModelFor(model) === model)
    }
    check(
      'no cross-family hop anywhere: a non-anthropic session never answers a claude id',
      FOLLOW_SELF.every(model => !smallFastModelFor(model).startsWith('claude-')),
    )
  }

  await serveList(null)
  section('§3 sessionLightModel — the hook-agent tier')
  {
    delete process.env.MERCURY_MODEL
    const anthropicLight = sessionLightModel()
    check(
      'anthropic session: the mid-class owner (execAgentHook default unchanged)',
      getCanonicalName(anthropicLight) === getCanonicalName(getDefaultSonnetModel()),
      `${anthropicLight} vs ${getDefaultSonnetModel()}`,
    )
    process.env.MERCURY_MODEL = 'gpt-5.6-sol'
    await serveList(null)
    check('openai session with no live list: follows the session model (no typed row)', sessionLightModel() === 'gpt-5.6-sol', sessionLightModel())
    await serveList(OWNER_LIST)
    const gptLight = sessionLightModel()
    check('openai session on the served list: the newest served plain row below the frontier (gpt-5.5)', gptLight === 'gpt-5.5', gptLight)
    await serveList(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4'])
    check('openai session on a list without gpt-5.5: the next served plain row (gpt-5.4)', sessionLightModel() === 'gpt-5.4', sessionLightModel())
    await serveList(['gpt-6-astra', 'gpt-5.6-sol'])
    check('openai session on a list with no plain row: the session model', sessionLightModel() === 'gpt-5.6-sol', sessionLightModel())
    await serveList(null)
    process.env.MERCURY_MODEL = 'glm-5.3'
    check('zai session: follows the session model (no light fact recorded)', sessionLightModel() === 'glm-5.3')
    delete process.env.MERCURY_MODEL
  }

  section('§4 the paid + standing debt sites (the census register stays honest)')
  {
    const away = srcText('services', 'awaySummary.ts')
    check('awaySummary rides the routed seam', away.includes('routedCallModelSettled'))
    check('awaySummary rides the family resolver', away.includes('sessionSmallFastModel()'))
    check('awaySummary carries no getSmallFastModel residue', !away.includes('getSmallFastModel'))
    const classifier = srcText('services', 'agentStateClassifier.ts')
    check('agentStateClassifier rides the routed seam', classifier.includes('routedCallModelSettled'))
    check('agentStateClassifier rides the family resolver', classifier.includes('sessionSmallFastModel()'))
    check('agentStateClassifier carries no getSmallFastModel residue', !classifier.includes('getSmallFastModel'))
    const feedback = srcText('components', 'Feedback.tsx')
    check('Feedback title rides the routed seam', feedback.includes('routedCallModelSettled'))
    check('Feedback title rides the family resolver', feedback.includes('sessionSmallFastModel()'))
    check('Feedback carries no getSmallFastModel / sideQuery residue', !feedback.includes('getSmallFastModel') && !feedback.includes('sideQuery'))
    const agentHook = srcText('utils', 'hooks', 'execAgentHook.ts')
    check(
      'execAgentHook defaults to sessionLightModel, the hook\'s own model first',
      /const model = hook\.model \?\? sessionLightModel\(\)/.test(agentHook),
    )
    const evalBridge = srcText('services', 'eval', 'evalBridge.ts')
    check(
      "evalBridge tier 'fast' rides smallFastModelFor(session model)",
      evalBridge.includes('smallFastModelFor(context.options.mainLoopModel)'),
    )
    const streamCoreSeam = srcText('services', 'providers', 'anthropic', 'streamCore.ts')
    check(
      'querySmallFast rides the session family (sessionSmallFastModel)',
      streamCoreSeam.includes('model: sessionSmallFastModel()'),
    )
    check(
      'querySmallFast delegates to the ROUTED one-shot (queryWithModel), never the unrouted engine',
      /export async function querySmallFast[\s\S]{0,600}return queryWithModel\(/.test(streamCoreSeam),
    )
    for (const [label, ...path] of [
      ['sessionTitle', 'utils', 'sessionTitle.ts'],
      ['generateSessionName', 'commands', 'rename', 'generateSessionName.ts'],
      ['WebFetch summary', 'tools', 'WebFetchTool', 'utils.ts'],
      ['MCP datetime parser', 'utils', 'mcp', 'dateTimeParser.ts'],
    ] as const) {
      check(
        `${label} rides the querySmallFast seam (family-following by construction)`,
        srcText(...path).includes('querySmallFast'),
      )
    }
    const promptHook = srcText('utils', 'hooks', 'execPromptHook.ts')
    check(
      'execPromptHook paid its debt: the hook default rides sessionSmallFastModel (no getSmallFastModel residue)',
      promptHook.includes('sessionSmallFastModel()') && !promptHook.includes('getSmallFastModel'),
    )
    const tokenEstimation = srcText('services', 'tokenEstimation.ts')
    check(
      'tokenEstimation STILL carries its family-correct pin (Anthropic-wire counting capability)',
      tokenEstimation.includes('getSmallFastModel'),
    )
  }

  section('§5 the settlement fold — settleAssistantTurn (the one owner)')
  {
    type Msg = { type: 'assistant'; isApiErrorMessage?: boolean; message: { role: 'assistant'; content: unknown[] }; uuid?: string }
    const msg = (blocks: unknown[], apiError = false): Msg => ({
      type: 'assistant',
      ...(apiError ? { isApiErrorMessage: true } : {}),
      message: { role: 'assistant', content: blocks },
    })
    const single = msg([{ type: 'text', text: 'whole turn' }])
    check('single settle passes through by identity', settleAssistantTurn([single] as never, false) === (single as never))
    const reasoning = msg([{ type: 'thinking', thinking: 'because' }])
    const text = msg([{ type: 'text', text: 'answer' }])
    const widened = settleAssistantTurn([reasoning, text] as never, false) as unknown as Msg
    check(
      'multi-block routed turn widens to the whole turn in yield order',
      JSON.stringify(widened.message.content) ===
        JSON.stringify([{ type: 'thinking', thinking: 'because' }, { type: 'text', text: 'answer' }]),
    )
    check('the widened settle keeps the LAST envelope', widened !== (reasoning as never) && !widened.isApiErrorMessage)
    const apiErr = msg([{ type: 'text', text: 'API Error: x' }], true)
    const contentWins = settleAssistantTurn([apiErr, text] as never, false) as unknown as Msg
    check('content beats API-error yields', JSON.stringify(contentWins.message.content) === JSON.stringify([{ type: 'text', text: 'answer' }]))
    const errOnly = settleAssistantTurn([apiErr] as never, false) as unknown as Msg
    check('an error-only turn surfaces the error settle', errOnly.isApiErrorMessage === true)
    let threwAbort = false
    try {
      settleAssistantTurn([] as never, true)
    } catch (e) {
      threwAbort = e instanceof APIUserAbortError
    }
    check('empty + aborted throws APIUserAbortError', threwAbort)
    let threwEmpty = false
    try {
      settleAssistantTurn([] as never, false)
    } catch (e) {
      threwEmpty = e instanceof Error && !(e instanceof APIUserAbortError)
    }
    check('empty without abort throws the honest error', threwEmpty)
    const streamCore = srcText('services', 'providers', 'anthropic', 'streamCore.ts')
    check(
      'queryWithModel delegates to settleAssistantTurn (one fold, one owner)',
      streamCore.includes('settleAssistantTurn(settled, signal.aborted)'),
    )
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ THE SMALL-FAST TIER FOLLOWS THE SESSION FAMILY')
}

void main()
