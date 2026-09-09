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

  const { providerSmallFastFact, smallFastModelFor, sessionLightModel, sessionSmallFastModel } =
    await import('../../src/utils/model/providerFrontier.js')
  const { getCanonicalName } = await import('../../src/utils/model/model.js')
  const { NEVER_HAIKU_FALLBACK } = await import('../../src/utils/model/modelFloor.js')
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
    const openai = providerSmallFastFact('openai')
    check(
      'openai: the recorded mini/nano tier, grammar-derived and dated',
      openai !== undefined && /-(mini|nano)$/.test(openai.modelId) && typeof openai.observedAt === 'string',
      JSON.stringify(openai),
    )
    for (const route of ['zai', 'moonshot', 'deepseek', 'gemini', 'openrouter', 'openai-compat', 'huggingface', 'local'] as const) {
      check(`${route}: silence (no owner records a small tier)`, providerSmallFastFact(route) === undefined)
    }
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
    const gpt = smallFastModelFor('gpt-5.6-sol')
    check('openai session → the recorded mini tier', /-(mini|nano)$/.test(gpt), gpt)
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

  section('§3 sessionLightModel — the hook-agent tier')
  {
    delete process.env.MERCURY_MODEL
    const anthropicLight = sessionLightModel()
    check(
      'anthropic session: the SAME canonical the never-Haiku floor names (execAgentHook default unchanged)',
      getCanonicalName(anthropicLight) === getCanonicalName(NEVER_HAIKU_FALLBACK),
      `${anthropicLight} vs ${NEVER_HAIKU_FALLBACK}`,
    )
    process.env.MERCURY_MODEL = 'gpt-5.6-sol'
    const gptLight = sessionLightModel()
    check(
      'openai session: the recorded light fact (sub-frontier base row)',
      /^gpt-\d/.test(gptLight) && !/-(sol|terra|luna)$/.test(gptLight),
      gptLight,
    )
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
      'execAgentHook defaults to sessionLightModel UNDER the floor',
      /enforceSubagentModelFloor\(hook\.model \?\? sessionLightModel\(\), 'hook-agent'\)/.test(agentHook),
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
