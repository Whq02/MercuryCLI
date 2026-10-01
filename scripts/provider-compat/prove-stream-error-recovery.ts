import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Message } from '../../src/types/message.ts'
import type { CompatCallModelParams, CompatLaneProfile } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_BUSY_RETRY_SCALE = '0.001'
process.env.OPENAI_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1/v1'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { xaiResponsesTransport } = await import('../../src/services/providers/xai/xaiResponsesTransport.ts')
const { streamOpenrouterResponses } = await import('../../src/services/providers/openrouter/openrouterResponsesTransport.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { deepseekLaneProfile } = await import('../../src/services/providers/deepseek/deepseekCallModel.ts')
const { moonshotLaneProfile } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')

let failures = 0
function check(label: string, value: boolean, detail = ''): void {
  console.log(`[${value ? 'PASS' : 'FAIL'}] ${label}${value ? '' : ` — ${detail}`}`)
  if (!value) failures++
}
const tool = { name: 'fixture_tool', description: async () => 'fixture', inputSchema: z.object({}), isEnabled: async () => true, isReadOnly: () => true, prompt: async () => 'fixture', userFacingName: () => 'fixture' } as never
const params = (model: string, signal = new AbortController().signal): CompatCallModelParams => ({
  messages: [{ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'Answer the fixture.' } } as Message],
  systemPrompt: asSystemPrompt(['Answer the fixture.']), thinkingConfig: { type: 'disabled' }, tools: [tool], signal,
  options: { model, querySource: 'repl_main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64 } as never,
})
const credential = async () => ({ apiKey: 'proof-key-ci-gate-not-a-real-key' })
const fixtureProfile = (profile: CompatLaneProfile): CompatLaneProfile => ({ ...profile, resolveCredential: credential, requestUrl: () => 'http://127.0.0.1:1/chat/completions', buildExtras: () => ({}), toolCapabilityRefusal: () => undefined })
const baseProfile = fixtureProfile(deepseekLaneProfile)
const roads = [
  { name: 'deepseek', call: () => compatChatCallModel(baseProfile, params('deepseek-chat')), responses: false },
  { name: 'moonshot', call: () => compatChatCallModel(fixtureProfile(moonshotLaneProfile), params('kimi-k3')), responses: false },
  { name: 'xai-responses', call: () => compatChatCallModel({ ...baseProfile, lane: 'xai', providerLabel: 'xAI', streamTransport: xaiResponsesTransport }, params('grok-fixture')), responses: true },
  { name: 'openrouter-responses', call: () => compatChatCallModel({ ...baseProfile, lane: 'openrouter', providerLabel: 'OpenRouter', streamTransport: options => ({ events: streamOpenrouterResponses(options, JSON.stringify(options.request), { model: options.request.model, items: [] }) }) }, params('openrouter/fixture/model')), responses: true },
  { name: 'openai-responses', call: () => openaiCallModel(params('gpt-5.6-sol') as never), responses: true },
]
const group = process.argv[2] ?? 'responses'
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
let hits = 0
let mode = 'recover'
let partial = false
let responseRoad = false
const originalFetch = globalThis.fetch
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  if (init?.method !== 'POST') return Response.json({ data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] })
  hits++
  const failed = mode !== 'recover' || hits === 1
  if (responseRoad) {
    const events: unknown[] = [{ type: 'response.created', response: { id: `fixture-${hits}` } }]
    if (partial || !failed) events.push({ type: 'response.output_text.delta', delta: failed ? 'partial fixture answer' : 'completed fixture answer' })
    if (mode === 'tools') events.push({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fixture-item', call_id: 'fixture-call', name: 'fixture_tool', arguments: '{}' } })
    events.push(failed ? { type: 'response.failed', response: { error: mode === 'permanent' ? { code: 'insufficient_quota', message: 'Insufficient credits. Try again later.' } : { message: 'Temporarily at capacity. Try again later.' } } } : { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 4 } } })
    return sse(events)
  }
  const events: unknown[] = []
  if (partial || !failed) events.push({ choices: [{ delta: { content: failed ? 'partial fixture answer' : 'completed fixture answer' } }] })
  if (mode === 'tools' || mode === 'unknown-tools') events.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture-call', function: { name: 'fixture_tool', arguments: '{}' } }] } }] })
  events.push({ choices: [{ delta: {}, finish_reason: !failed ? 'stop' : mode === 'permanent' ? 'content_filter' : mode === 'unknown-tools' ? 'vendor_new_word' : mode === 'resources' ? 'insufficient_system_resource' : 'network_error' }], usage: { prompt_tokens: 5, completion_tokens: 4 } })
  return sse(events)
}) as typeof fetch
try {
  for (const road of roads.filter(road => group === 'responses' ? road.responses : group === 'compat' ? !road.responses : true)) {
    responseRoad = road.responses
    for (const scenario of ['recover', 'exhaust', 'permanent', 'tools', ...(!road.responses ? ['unknown-tools', 'resources'] : [])]) {
      for (const afterContent of scenario === 'recover' ? [false, true] : [true]) {
        hits = 0
        mode = scenario
        partial = afterContent
        const items: any[] = []
        for await (const item of road.call()) items.push(JSON.parse(JSON.stringify(item)))
        const assistants = items.filter(item => item.type === 'assistant')
        const completed = assistants.some(item => item.message.content.some((block: any) => block.text === 'completed fixture answer'))
        const tools = assistants.flatMap(item => item.message.content).filter((block: any) => block.type === 'tool_use')
        const expected = scenario === 'recover' ? 2 : scenario === 'exhaust' || scenario === 'resources' ? 7 : 1
        check(`${road.name} ${scenario} ${afterContent ? 'after content' : 'before content'}: ${expected} requests`, hits === expected, `${hits} requests`)
        if (scenario === 'recover') check(`${road.name} recovers without a terminal error row`, completed && !assistants.some(item => item.isApiErrorMessage), JSON.stringify(assistants.map(item => item.message.content)))
        if (scenario === 'tools' || scenario === 'unknown-tools') check(`${road.name} keeps its tool call exactly once and continues`, tools.length === 1 && items.some(item => item.type === 'stream_event' && item.event?.type === 'message_delta' && item.event.delta.stop_reason === 'tool_use'), JSON.stringify(assistants.map(item => item.message)))
        check(`${road.name} yields every settled block at most once`, new Set(assistants.map(item => item.uuid)).size === assistants.length)
        if (scenario === 'recover' && afterContent) {
          check(`${road.name} keeps the interrupted text once beside the completed reply`, assistants.flatMap(item => item.message.content).filter((block: any) => block.text === 'partial fixture answer').length === 1)
          if (!road.responses) check(`${road.name} yields both attempts with their final usage already attached`, assistants.filter(item => !item.isApiErrorMessage).reduce((sum, item) => sum + item.message.usage.input_tokens, 0) === 10)
        }
      }
    }
  }
} finally {
  globalThis.fetch = originalFetch
}
console.log(`${failures ? 'FAIL' : 'PASS'} stream recovery: ${failures} failures`)
process.exitCode = failures ? 1 : 0
