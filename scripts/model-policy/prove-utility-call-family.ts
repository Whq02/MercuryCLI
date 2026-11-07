#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'utility-call-family-'))

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
  console.log(' every utility call rides the main seat at low — proof')
  console.log('============================================================')

  delete process.env.MERCURY_MODEL
  delete process.env.MERCURY_EFFORT_LEVEL

  const { floorEffort, utilityCallFor } = await import('../../src/utils/model/utilityModel.js')
  const { openaiLightChoice } = await import('../../src/utils/model/providerFrontier.js')
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
  const { settleAssistantTurn } = await import('../../src/services/providers/callModelRouter.js')
  const { APIUserAbortError } = await import('../../src/services/api/sdkErrors.js')

  section('§1 utilityCallFor — the seat\'s own model on all ten routing-law families, never a second id')
  {
    const anthropic = utilityCallFor('claude-opus-5')
    check('anthropic seat → its own model at the lowest ladder word, thinking off', anthropic.model === 'claude-opus-5' && anthropic.effortValue === 'low' && anthropic.thinkingConfig.type === 'disabled', JSON.stringify(anthropic))
    check('an anthropic seat never hops to a haiku id', !anthropic.model.includes('haiku'))
    process.env.MERCURY_MODEL = 'claude-opus-5'
    const viaDefault = utilityCallFor()
    check('the default argument is the engine model', viaDefault.model === 'claude-opus-5', viaDefault.model)
    process.env.MERCURY_EFFORT_LEVEL = 'max'
    check('the env dial never moves the floor (the floor is the road\'s, the dial is the turn\'s)', utilityCallFor().effortValue === 'low', String(utilityCallFor().effortValue))
    delete process.env.MERCURY_EFFORT_LEVEL
    delete process.env.MERCURY_MODEL
    await serveList(null)
    check("openai seat with no live list → its own model (never the typed table)", utilityCallFor('gpt-5.6-sol').model === 'gpt-5.6-sol', utilityCallFor('gpt-5.6-sol').model)
    await serveList(OWNER_LIST)
    check('openai seat on the served list → still its own model (no cheaper served row is chosen)', utilityCallFor('gpt-5.6-sol').model === 'gpt-5.6-sol', utilityCallFor('gpt-5.6-sol').model)
    check('a non-anthropic seat keeps adaptive thinking so the smallest level still thinks', utilityCallFor('gpt-5.6-sol').thinkingConfig.type === 'adaptive')
    await serveList(null)
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
      check(`${model} → its own model`, utilityCallFor(model).model === model, utilityCallFor(model).model)
    }
    check(
      'no cross-family hop anywhere: a non-anthropic seat never answers a claude id',
      FOLLOW_SELF.every(model => !utilityCallFor(model).model.startsWith('claude-')),
    )
    check('a model without effort control carries no floor', utilityCallFor('local/llama-3.3-70b').effortValue === undefined)
  }

  section('§1b the floor is low — the lowest served word at or above it; below low only when nothing at or above it is served — and the light chooser stays pure for the refusal hint')
  {
    check('low when the list serves it, whatever the order', floorEffort(['high', 'low', 'medium']) === 'low' && floorEffort(['max', 'low']) === 'low')
    check('the words below the ladder (minimal, none) never become the floor when low is served', floorEffort(['low', 'minimal']) === 'low' && floorEffort(['none', 'low']) === 'low' && floorEffort(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']) === 'low')
    check('a list without low takes the lowest word above it, never one below', floorEffort(['xhigh', 'max']) === 'xhigh' && floorEffort(['none', 'minimal', 'medium', 'high']) === 'medium')
    check('a list with nothing at or above low takes the word nearest low from below (a model that barely reasons), its only word when there is one', floorEffort(['none']) === 'none' && floorEffort(['minimal', 'none']) === 'minimal' && floorEffort(['none', 'minimal']) === 'minimal')
    check('an empty vocabulary has no floor', floorEffort([]) === undefined)
    const glm = utilityCallFor('glm-5.2')
    check('a GLM-5.2 seat (none … max served) rides at low, never none', glm.model === 'glm-5.2' && glm.effortValue === 'low', JSON.stringify(glm))
    const ceiling = parseGptModelId('gpt-6-astra')
    check('the light tier: the newest served plain row below the frontier', openaiLightChoice(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4'], ceiling) === 'gpt-5.5')
    check('the light tier falls to the next served plain row when gpt-5.5 is not served', openaiLightChoice(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4'], ceiling) === 'gpt-5.4')
    check('the light tier answers nothing with no served plain row below the frontier', openaiLightChoice(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6'], ceiling) === undefined && openaiLightChoice(['gpt-5.5'], undefined) === undefined)
  }

  section('§2 a hook names its own model or rides the seat')
  {
    process.env.MERCURY_MODEL = 'claude-opus-5'
    check('no model named → the seat\'s model', utilityCallFor(undefined).model === 'claude-opus-5', utilityCallFor(undefined).model)
    check('a hook that names a model → that model at its own floor', utilityCallFor('gpt-5.6-sol', { named: true }).model === 'gpt-5.6-sol')
    check('a hook that names a local model → that model itself, never the slot (the slot substitutes only for the seat\'s default selection)', utilityCallFor('local/qwen3.8-27b', { named: true }).model === 'local/qwen3.8-27b')
    process.env.MERCURY_MODEL = 'glm-5.3'
    check('zai seat: a hook with no model rides glm', utilityCallFor(undefined).model === 'glm-5.3')
    delete process.env.MERCURY_MODEL
  }

  section('§3 the sites: every utility call reads the helper and pins its floor')
  {
    const classifier = srcText('services', 'agentNeedsYou.ts')
    check('agentNeedsYou rides the routed seam', classifier.includes('routedCallModelSettled'))
    check('agentNeedsYou rides the helper with a pinned floor', classifier.includes('utilityCallFor()') && classifier.includes('effortPinned: true'))
    const feedback = srcText('components', 'Feedback.tsx')
    check('Feedback title rides the routed seam', feedback.includes('routedCallModelSettled'))
    check('Feedback title rides the helper with a pinned floor', feedback.includes('utilityCallFor()') && feedback.includes('effortPinned: true'))
    check('Feedback carries no sideQuery residue', !feedback.includes('sideQuery'))
    const crewmateRunner = srcText('utils', 'hooks', 'crewmateRunner.ts')
    check('the crewmate hook runner rides the helper: the seat by default, a named model as itself at its own floor, the floor as the seat\'s own word', crewmateRunner.includes("run.model === undefined ? utilityCallFor() : utilityCallFor(run.model, { named: true })") && crewmateRunner.includes('noteAgentEffortWord(hookAgentId, call.effortValue)') && crewmateRunner.includes('engineModel: call.model'))
    const questionRunner = srcText('utils', 'hooks', 'questionRunner.ts')
    check('the question hook runner rides the helper: the seat by default, a named model as itself at its own floor, pinned', questionRunner.includes("run.model === undefined ? utilityCallFor() : utilityCallFor(run.model, { named: true })") && questionRunner.includes('effortPinned: true'))
    const evalBridge = srcText('services', 'eval', 'evalBridge.ts')
    check("evalBridge tier 'fast' rides the helper over the session model with a pinned floor", evalBridge.includes('utilityCallFor(context.options.engineModel)') && evalBridge.includes('effortPinned: true'))
    const streamCoreSeam = srcText('services', 'providers', 'anthropic', 'streamCore.ts')
    check('queryUtility reads the helper and pins the floor', /export async function queryUtility[\s\S]{0,700}utilityCallFor\(\)[\s\S]{0,400}effortPinned: true/.test(streamCoreSeam))
    check('queryUtility delegates to the ROUTED one-shot (queryWithModel), never the unrouted engine', /export async function queryUtility[\s\S]{0,700}return queryWithModel\(/.test(streamCoreSeam))
    check('a pinned effort rides the Anthropic wire even on a side question', streamCoreSeam.includes('const effortRides = effortPinned || options.ridesSessionEffort !== false'))
    const webFetch = srcText('tools', 'WebFetchTool', 'utils.ts')
    check('the WebFetch fallback leg rides the fallback model as itself at its own floor, pinned through the helper, never the slot', webFetch.includes('utilityCallFor(fallbackModel, { named: true })') && webFetch.includes('options: { ...baseOptions, ...call }'))
    const openaiTurn = srcText('services', 'providers', 'openai', 'openaiCallModel.ts')
    check('the OpenAI road derives a wanted-but-unknown floor from the admitted list before the wire (a pinned value is never lowered)', openaiTurn.includes("const floorWanted = options.effortPinned === true && options.effortValue === undefined && servedEfforts.length > 0") && openaiTurn.includes('floorEffort(servedEfforts)'))
    const compatChat = srcText('services', 'providers', 'openaicompat', 'compatChatCallModel.ts')
    check('the shared compat road derives a wanted-but-unknown floor from the vocabulary admitted before its resolution (the lanes that read their list before the request: Melious, xAI, Mistral, Gemini\'s plan road, local and the others that qualify first; OpenRouter, Nous and Gemini\'s key roads read nothing there, so a hook reads their list up front)', compatChat.includes("const floorWanted = options.effortPinned === true && options.effortValue === undefined && servedEfforts.length > 0") && compatChat.includes('floorEffort(servedEfforts)') && compatChat.includes('const floorWanted') && compatChat.includes('resolveWireRequestedEffort(modelId, askedEffort') && compatChat.indexOf('const floorWanted') < compatChat.indexOf('resolveWireRequestedEffort(modelId, askedEffort'))
    check('the crewmate hook reads the named road\'s catalogue before noting the floor as the child\'s own word', crewmateRunner.includes('await readCatalogueIfPending(declaredRouteOf(run.model ?? getEngineModel())') && crewmateRunner.includes('readCatalogueIfPending(') && crewmateRunner.includes('utilityCallFor(run.model, { named: true })') && crewmateRunner.indexOf('readCatalogueIfPending(') < crewmateRunner.indexOf('utilityCallFor(run.model, { named: true })'))
    check('the hook answer schema is emitted as draft-07, the dialect the verdict tool\'s engine compiles, and carries no $schema meta-reference onto any wire', questionRunner.includes("target: 'draft-07'") && questionRunner.includes('const { $schema: _dialect, ...shape } = toJSONSchema('))
    check('the question hook reads the named road\'s catalogue before computing the floor (a bounded read; OpenRouter, Nous and Gemini\'s key roads read nothing before the request themselves)', questionRunner.includes('await readCatalogueIfPending(declaredRouteOf(run.model ?? getEngineModel())') && questionRunner.includes('readCatalogueIfPending(') && questionRunner.includes('utilityCallFor(run.model, { named: true })') && questionRunner.indexOf('readCatalogueIfPending(') < questionRunner.indexOf('utilityCallFor(run.model, { named: true })'))
    for (const [label, ...path] of [
      ['sessionTitle', 'utils', 'sessionTitle.ts'],
      ['generateSessionName', 'commands', 'rename', 'generateSessionName.ts'],
      ['tool-use summary', 'services', 'toolUseSummary', 'toolUseSummaryGenerator.ts'],
      ['WebFetch reading', 'tools', 'WebFetchTool', 'utils.ts'],
      ['MCP datetime parser', 'utils', 'mcp', 'dateTimeParser.ts'],
    ] as const) {
      check(`${label} rides the queryUtility seam (the helper by construction)`, srcText(...path).includes('queryUtility'))
    }
    const probeBranch = "=== 'anthropic' ? "
    const tokenEstimation = srcText('services', 'tokenEstimation.ts')
    const requestParams = srcText('services', 'providers', 'anthropic', 'requestParams.ts')
    check('the count-tokens create probe names the helper\'s model on the Anthropic road, else the family default, at that model\'s floor with thinking off unless the history thinks', tokenEstimation.includes(probeBranch) && tokenEstimation.includes('getDefaultSonnetModel()') && tokenEstimation.includes('thinking: thinking ? THINKING_BUDGET_TOKENS : false') && tokenEstimation.includes("...(effort !== undefined ? { effort } : {})"))
    check('the key probe names the helper\'s model on the Anthropic road, else the family default, at that model\'s floor with thinking off', requestParams.includes(probeBranch) && requestParams.includes('getDefaultSonnetModel()') && requestParams.includes("if (!modelThinkingAlwaysOn(model)) body.thinking = { type: 'disabled' }") && requestParams.includes("if (effort !== undefined && !('effort' in outputConfig)) outputConfig.effort = effort") && requestParams.includes('Object.assign(body, extraBody)') && !requestParams.includes('export function keyProbeModel'))
  }

  section('§4 the settlement fold — settleAssistantTurn (the one owner)')
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
      /settleAssistantTurn\(\w+, (?:question\.)?signal\.aborted\)/.test(streamCore),
    )
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ EVERY UTILITY CALL RIDES THE MAIN SEAT AT LOW')
}

void main()
