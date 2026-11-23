#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mock } from 'bun:test'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { utilityCallFor } = await import('../../src/models/catalogue/utilityModel.ts')
type CallModelParams = import('../../src/models/roads/callModelContract.ts').CallModelParams
type AssistantMessage = import('../../src/engine/message-shapes/message.ts').AssistantMessage

const streamCalls: CallModelParams[] = []
const settledCalls: CallModelParams[] = []
let nextReplyText = 'ok'

function fakeAssistant(text: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000001' as never,
    timestamp: '2026-01-01T00:00:00.000Z',
    requestId: 'req-fixture',
    message: {
      id: 'msg-fixture',
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as unknown as AssistantMessage
}

const realRouter = { ...(await import('../../src/models/roads/callModelRouter.ts')) }
mock.module('../../src/models/roads/callModelRouter.ts', () => ({
  ...realRouter,
  routedCallModel: async function* (params: CallModelParams) {
    streamCalls.push(params)
    yield fakeAssistant(nextReplyText)
  },
  routedCallModelSettled: async (params: CallModelParams) => {
    settledCalls.push(params)
    return fakeAssistant(nextReplyText)
  },
}))
const realCatalogueOnDemand = { ...(await import('../../src/models/roads/catalogueOnDemand.ts')) }
mock.module('../../src/models/roads/catalogueOnDemand.ts', () => ({
  ...realCatalogueOnDemand,
  readCatalogueIfPending: async () => undefined,
}))

const { queryUtility } = await import('../../src/models/roads/anthropic/streamCore.ts')
const { nativeSearch } = await import('../../src/tools/engines/web-search/nativeSearch.ts')
const { nativeSearchFamilyOf, resolveSearchDoorPlan } = await import('../../src/tools/engines/web-search/searchDoor.ts')
const { runQuestionHook } = await import('../../src/integrations/event-hook-runners/questionRunner.ts')
const { generateAgent } = await import('../../src/screen/agents/generateCrewmate.ts')

const makeToolContext = (engineModel: string): never =>
  ({
    abortController: new AbortController(),
    agentId: 'agent-fixture',
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), effortValue: 'high' }),
    options: {
      engineModel,
      thinkingConfig: { type: 'disabled' },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
      appendSystemPrompt: undefined,
    },
  }) as never

section('§2 the routed helpers stay routed — queryWithModel / queryUtility')
{
  streamCalls.length = 0
  settledCalls.length = 0
  nextReplyText = 'utility-answer'
  const expected = utilityCallFor()
  const reply = await queryUtility({
    systemPrompt: asSystemPrompt(['Be brief.']),
    userPrompt: 'ping',
    signal: new AbortController().signal,
    options: {
      querySource: 'test_utility' as never,
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })
  const call = streamCalls[0]
  check(
    'queryUtility rides queryWithModel through routedCallModel',
    streamCalls.length === 1 && reply.message.content[0]?.type === 'text' && reply.message.content[0].text === 'utility-answer',
    JSON.stringify({ calls: streamCalls.length, content: reply.message.content }) + ' — queryUtility in src/models/roads/anthropic/streamCore.ts must send its one call through routedCallModel (src/models/roads/callModelRouter.ts), not a direct client'
  )
  check(
    "queryUtility's model and floor are the helper's (utilityCallFor), the floor pinned",
    call !== undefined &&
      call.options.model === expected.model &&
      call.options.effortValue === expected.effortValue &&
      call.options.effortPinned === true &&
      call.options.ridesSessionEffort === false &&
      call.thinkingConfig.type === expected.thinkingConfig.type,
    JSON.stringify({ got: call?.options, expected }) + ' — queryUtility in src/models/roads/anthropic/streamCore.ts must take model, effort and thinking from utilityCallFor (src/models/catalogue/utilityModel.ts) and pin the effort'
  )
}

section('§3 the rewritten sites reach the wire through the router')
{
  streamCalls.length = 0
  settledCalls.length = 0
  nextReplyText = 'search summary'
  const searchOutcome = await nativeSearch('openai', { query: 'mercury router test' }, { context: makeToolContext('gpt-5.4') })
  const searchCall = streamCalls[0]
  check(
    'nativeSearch calls routedCallModel once with the main model and nativeWebSearch options',
    searchOutcome.ok &&
      streamCalls.length === 1 &&
      searchCall !== undefined &&
      searchCall.options.model === 'gpt-5.4' &&
      searchCall.options.querySource === 'web_search_tool' &&
      searchCall.options.nativeWebSearch?.maxUses === 8,
    JSON.stringify({ ok: searchOutcome.ok, calls: streamCalls.length, model: searchCall?.options.model, nativeWebSearch: searchCall?.options.nativeWebSearch }) + ' — nativeSearch in src/tools/engines/web-search/nativeSearch.ts must call routedCallModel once with the main model, querySource web_search_tool and nativeWebSearch.maxUses 8'
  )

  const anthropicPlan = resolveSearchDoorPlan({ mainModel: 'claude-sonnet-5', keylessAllowed: false })
  const openaiPlan = resolveSearchDoorPlan({ mainModel: 'gpt-5.4', keylessAllowed: false })
  const deepseekPlan = resolveSearchDoorPlan({ mainModel: 'deepseek-chat', keylessAllowed: false })
  check(
    "the search door opens the native door only for the main model's own family by the routing law",
    nativeSearchFamilyOf('claude-sonnet-5') === 'anthropic' &&
      nativeSearchFamilyOf('gpt-5.4') === 'openai' &&
      nativeSearchFamilyOf('deepseek-chat') === undefined &&
      nativeSearchFamilyOf('gemini-2.5-pro') === undefined &&
      anthropicPlan.doors[0]?.kind === 'native' &&
      anthropicPlan.doors[0].family === 'anthropic' &&
      openaiPlan.doors[0]?.kind === 'native' &&
      openaiPlan.doors[0].family === 'openai' &&
      !deepseekPlan.doors.some(door => door.kind === 'native'),
    JSON.stringify({ anthropic: anthropicPlan.doors, openai: openaiPlan.doors, deepseek: deepseekPlan.doors }) + ' — nativeSearchFamilyOf and resolveSearchDoorPlan in src/tools/engines/web-search/searchDoor.ts must open the native door only for the main model own family'
  )

  settledCalls.length = 0
  nextReplyText = '{"allow":true}'
  const expectedHookDefault = utilityCallFor()
  const hookDefaultEnd = await runQuestionHook({
    text: 'Allow this?',
    name: 'test-hook',
    event: 'tool.before',
    payloadJson: '{}',
    answerSchema: z.object({ allow: z.boolean() }),
    timeoutMs: 5_000,
    toolUseContext: makeToolContext('claude-sonnet-5'),
  })
  const hookDefaultCall = settledCalls[0]
  check(
    'questionRunner settles through routedCallModelSettled once and defaults to utilityCallFor() with a pinned floor',
    hookDefaultEnd.kind === 'answered' &&
      settledCalls.length === 1 &&
      hookDefaultCall !== undefined &&
      hookDefaultCall.options.model === expectedHookDefault.model &&
      hookDefaultCall.options.effortValue === expectedHookDefault.effortValue &&
      hookDefaultCall.options.effortPinned === true &&
      hookDefaultCall.options.querySource === 'hook_prompt',
    JSON.stringify({ end: hookDefaultEnd, calls: settledCalls.length, got: hookDefaultCall?.options, expected: expectedHookDefault }) + ' — runQuestionHook in src/integrations/event-hook-runners/questionRunner.ts must call routedCallModelSettled once with the utilityCallFor() model and pinned effort, querySource hook_prompt'
  )

  settledCalls.length = 0
  nextReplyText = '{"allow":false}'
  const expectedHookNamed = utilityCallFor('gpt-5.4', { named: true })
  const hookNamedEnd = await runQuestionHook({
    text: 'Allow this?',
    name: 'test-hook-named',
    event: 'tool.before',
    payloadJson: '{}',
    answerSchema: z.object({ allow: z.boolean() }),
    model: 'gpt-5.4',
    timeoutMs: 5_000,
    toolUseContext: makeToolContext('claude-sonnet-5'),
  })
  const hookNamedCall = settledCalls[0]
  check(
    'questionRunner routes a named hook model via utilityCallFor(model, { named: true }) with a pinned floor',
    hookNamedEnd.kind === 'answered' &&
      settledCalls.length === 1 &&
      hookNamedCall !== undefined &&
      hookNamedCall.options.model === expectedHookNamed.model &&
      hookNamedCall.options.effortValue === expectedHookNamed.effortValue &&
      hookNamedCall.options.effortPinned === true,
    JSON.stringify({ end: hookNamedEnd, calls: settledCalls.length, got: hookNamedCall?.options, expected: expectedHookNamed }) + ' — runQuestionHook in src/integrations/event-hook-runners/questionRunner.ts must route a hook model through utilityCallFor(model, { named: true }) with a pinned effort'
  )

  settledCalls.length = 0
  nextReplyText = JSON.stringify({ identifier: 'router-agent', whenToUse: 'when testing routing', systemPrompt: 'Test routing.' })
  const draft = await generateAgent('design a router tester', 'gpt-5.4', ['existing-agent'], new AbortController().signal)
  const agentCall = settledCalls[0]
  check(
    'generateAgent settles through routedCallModelSettled once with the requested model',
    settledCalls.length === 1 &&
      agentCall !== undefined &&
      agentCall.options.model === 'gpt-5.4' &&
      agentCall.options.querySource === 'agent_creation' &&
      draft.identifier === 'router-agent',
    JSON.stringify({ calls: settledCalls.length, model: agentCall?.options.model, draft }) + ' — generateAgent in src/screen/agents/generateCrewmate.ts must call routedCallModelSettled once with the requested model and querySource agent_creation'
  )
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ TRANSPORT REACHED VIA ROUTER GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} TRANSPORT-VIA-ROUTER FAILURE(S)`)
process.exit(1)
