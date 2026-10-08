import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EXTRA_BODY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT']) delete process.env[key]
const home = mkdtempSync(join(tmpdir(), 'summary-request-roads-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { startOverflowFixture, OVERFLOW_LANES } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { recordSentRequest } = await import('../../src/utils/forkedAgent.ts')
const { rosterOwnerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { compactConversation, partialCompactConversation } = await import('../../src/services/compact/compact.ts')
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
let failures = 0
let checks = 0
const check = (name: string, ok: boolean, details: unknown = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(details)}`}`)
}
const forbidden = /<analysis\b|(?:show|reveal|expose|wrap)[^.\n]{0,100}(?:reasoning|thinking)|produce the analysis/i
const summary = 'The synthetic parser accepts quoted commas and its 14 checks passed. Preserve the test command and continue with CLI verification.'
const custom = 'Preserve the test command exactly.'
try {
  const roads = [...OVERFLOW_LANES, { lane: 'anthropic-adaptive', model: 'claude-fable-5-1', dialect: 'anthropic' }, { lane: 'anthropic-budget', model: 'claude-sonnet-4-5', dialect: 'anthropic' }, { lane: 'openrouter-responses', model: OVERFLOW_LANES.find(road => road.lane === 'openrouter')!.model, dialect: 'responses' }]
  for (const road of roads) {
    for (const direction of ['full', 'from', 'up_to'] as const) {
      const tools = road.lane === 'openrouter-responses' ? [ToolSearchTool, FileReadTool, { ...FileReadTool, name: 'mcp__fold_fixture__read', isMcp: true }] : []
      const context: any = { agentId: `summary-${road.lane}-${direction}`, abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024), options: { tools, commands: [], mcpClients: [], engineModel: road.model, maxThinkingTokens: 0, thinkingConfig: { type: 'adaptive' }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
      const messages = [createUserMessage({ content: 'The synthetic parser accepts quoted commas and all 14 checks passed.' })]
      const cache = { systemPrompt: ['Synthetic fold request proof.'] } as never
      const before = fixture.captured.length
      fixture.script(request => forbidden.test(JSON.stringify(request.body)) ? { refusal: true } : { text: summary })
      let result: Awaited<ReturnType<typeof compactConversation>> | undefined
      let error: unknown
      try {
        result = direction === 'full'
          ? await compactConversation(messages, context, cache, false, custom)
          : await partialCompactConversation(messages, direction === 'from' ? 0 : messages.length, context, cache, custom, direction)
      } catch (caught) { error = String(caught) }
      const requests = fixture.captured.slice(before)
      const wire = JSON.stringify(requests.map(request => request.body))
      const label = `${road.lane} ${direction}`
      check(`${label}: one request on its declared wire`, requests.length === 1 && requests[0]?.dialect === road.dialect, requests.map(request => ({ dialect: request.dialect, path: request.path })))
      check(`${label}: built request never demands exposed reasoning`, requests.length > 0 && !forbidden.test(wire), error)
      check(`${label}: the requested summary and custom instructions survive`, result?.summaryMessages.some(message => String(message.message.content).includes(summary)) === true && wire.includes(custom), error)
    }
    for (const thinkingConfig of [{ type: 'adaptive' }, { type: 'enabled', budgetTokens: 8192 }] as const) {
      for (const continued of [false, true]) {
        const tools = [FileReadTool]
        const owner = `posture-${road.lane}-${thinkingConfig.type}-${continued}`
        const context: any = { agentId: owner, abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024), options: { tools, commands: [], mcpClients: [], engineModel: road.model, maxThinkingTokens: 8192, thinkingConfig, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
        if (road.lane === 'openrouter-responses') tools.push(ToolSearchTool as never, { ...FileReadTool, name: 'mcp__fold_fixture__read', isMcp: true } as never)
        const signed = { type: 'thinking', thinking: 'Preserved fixture reasoning.', signature: 'fixture-signature-byte-exact' }
        const assistant: any = createAssistantMessage({ content: [signed, { type: 'text', text: 'The parser checks passed.' }] as never })
        assistant.message.model = road.model
        const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: signed.thinking }], encrypted_content: 'fixture-encrypted-byte-exact' }
        const answer = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'The parser checks passed.' }] }
        if (road.lane === 'openai') assistant.apexProviderTurn = { provider: 'openai', model: road.model, items: [reasoning, answer] }
        if (road.lane === 'openrouter-responses') assistant.openrouterProviderTurn = { model: road.model.slice('openrouter/'.length), items: [reasoning, answer] }
        const messages = [createUserMessage({ content: 'Check the parser.' }), assistant, createUserMessage({ content: 'Preserve the result.' })]
        const systemPrompt = asSystemPrompt(['Synthetic fold request proof.'])
        const ceiling = getModelMaxOutputTokens(road.model).upperLimit
        fixture.script([{ text: summary }])
        const referenceAt = fixture.captured.length
        for await (const _ of routedCallModel({ messages, systemPrompt, thinkingConfig, tools, signal: context.abortController.signal, options: { model: road.model, getToolPermissionContext: async () => state.toolPermissionContext, isNonInteractiveSession: true, hasAppendSystemPrompt: false, maxOutputTokensOverride: ceiling, querySource: 'compact' as never, agents: [], mcpTools: [], effortValue: state.effortValue as never, ownerKey: String(rosterOwnerFromToolUseContext(context)) } })) {}
        const reference = fixture.captured[referenceAt]?.body as any
        if (continued) recordSentRequest(String(rosterOwnerFromToolUseContext(context)), messages)
        fixture.script([{ text: summary }])
        const before = fixture.captured.length
        let error: unknown
        try {
          await compactConversation(messages, context, { systemPrompt, userContext: {}, systemContext: {}, toolUseContext: { ...context, options: { ...context.options, thinkingConfig: { type: 'disabled' } } }, forkContextMessages: messages } as never, false, custom)
        } catch (caught) { error = String(caught) }
        const requests = fixture.captured.slice(before)
        const body = requests.at(-1)?.body as any
        const posture = (row: any): unknown => row && ({ effort: row.reasoning_effort, reasoning: row.reasoning, thinking: row.thinking, output: row.output_config, max: row.max_tokens, completion: row.max_completion_tokens, outputTokens: row.max_output_tokens })
        const label = `${road.lane} ${thinkingConfig.type} ${continued ? 'continued' : 'fresh'}`
        check(`${label}: summary request resolves once on its declared wire`, requests.length === 1 && requests[0]?.dialect === road.dialect && fixture.captured[referenceAt]?.dialect === road.dialect && error === undefined, { error, actual: requests[0]?.dialect, expected: road.dialect })
        if (road.lane === 'anthropic-budget' && thinkingConfig.type === 'enabled') check(`${label}: the fixed thinking budget stays exact`, body?.thinking?.type === 'enabled' && body.thinking.budget_tokens === thinkingConfig.budgetTokens, body?.thinking)
        check(`${label}: effort, thinking and ceiling are the session request's`, JSON.stringify(posture(body)) === JSON.stringify(posture(reference)), { actual: posture(body), expected: posture(reference) })
        check(`${label}: no per-message effort row`, Array.isArray(body?.messages) ? body.messages.every((row: any) => row.output_config === undefined) : Array.isArray(body?.input), body?.messages)
        const preserved = (row: any): unknown[] => {
          if (Array.isArray(row?.input)) return row.input.filter((item: any) => item.type === 'reasoning')
          return (row?.messages ?? []).filter((item: any) => item.role === 'assistant').map((item: any) => ({ content: Array.isArray(item.content) ? item.content.filter((block: any) => block.type === 'thinking' || block.type === 'redacted_thinking') : undefined, reasoning_content: item.reasoning_content, reasoning_details: item.reasoning_details, provider_specific_fields: item.provider_specific_fields }))
        }
        check(`${label}: route-preserved thinking rides byte-identically`, JSON.stringify(preserved(body)) === JSON.stringify(preserved(reference)), { actual: preserved(body), expected: preserved(reference) })
        if (road.dialect === 'anthropic') check(`${label}: the signed block is present and unchanged`, JSON.stringify(preserved(body)).includes(JSON.stringify(signed)), preserved(body))
        if (road.lane === 'openai') check(`${label}: encrypted reasoning stays ahead of its answer`, body?.input?.some((item: any, index: number) => JSON.stringify(item) === JSON.stringify(reasoning) && body.input[index + 1]?.type === 'message'), body?.input)
      }
    }
  }
} finally {
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} summary-request-roads: ${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
