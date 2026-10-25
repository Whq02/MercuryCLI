import { proofHome } from '../lib/hermetic.ts'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import type { Message } from '../../src/types/message.ts'
import type { Tool } from '../../src/Tool.ts'
import type { CallModelParams } from '../../src/services/providers/callModelContract.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of Object.keys(process.env)) {
  if (/(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|PROXY)$/.test(key) || ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_TOOL_DEFER', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC'].includes(key)) delete process.env[key]
}
process.env.DEEPSEEK_API_KEY = 'sk-deepseek-wire-fixture'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
const captures: Record<string, any>[] = []
let listing: unknown[] = []
let status = 200
let emittedTool: string | undefined
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/models') return Response.json({ data: listing })
    if (path === '/user/balance') return Response.json({ is_available: true, balance_infos: [] })
    if (path !== '/chat/completions') return new Response('wrong route', { status: 404 })
    captures.push(await request.json() as Record<string, any>)
    if (status !== 200) return Response.json({ error: { message: 'fixture refusal' } }, { status })
    const body = captures.at(-1)!
    const events = [
      { model: body.model, choices: [{ index: 0, delta: { reasoning_content: 'next reasoning', ...(emittedTool ? { tool_calls: [{ index: 0, id: 'admitted-call', type: 'function', function: { name: emittedTool, arguments: '{"path":"fixture"}' } }] } : { content: 'answered' }) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: emittedTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, prompt_cache_hit_tokens: 7 } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  },
})
process.env.MERCURY_DEEPSEEK_API_BASE = server.url.origin
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { routedCallModel, settleAssistantTurn } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getContextWindowForModel, getModelMaxOutputTokens, modelReceivesImageBlocks, resolveContextWindow } = await import('../../src/utils/model/capabilities.ts')
const { decodeDeepseekModel, refreshDeepseekCatalogue, deepseekCatalogueRows, __resetDeepseekCatalogueForTest } = await import('../../src/services/providers/deepseek/deepseekCatalogue.ts')
const { deepseekCatalogueEntry } = await import('../../src/services/providers/deepseek/deepseekAdapter.ts')
const { deferralWireFormFor } = await import('../../src/services/providers/deferralWire.ts')
const { mapMessagesToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(detail)}`}`)
}
const fixtureTool = (name: string, defer = false): Tool => ({
  name, shouldDefer: defer, inputSchema: z.object({ path: z.string() }),
  prompt: async () => `${name} fixture`, description: async () => `${name} fixture`,
  isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true,
  userFacingName: () => name, call: async () => ({ data: 'fixture' }),
}) as unknown as Tool
const tools = [fixtureTool('Read')]
const initial = () => [createUserMessage({ content: 'begin' })] as Message[]
const reasoning = (text: string, call?: string) => createAssistantMessage({ content: [
  { type: 'thinking', thinking: text, signature: '' },
  ...(call ? [{ type: 'tool_use', id: call, name: 'Read', input: { path: 'fixture' } }] : [{ type: 'text', text: 'prior answer' }]),
] as never }) as Message
const history = [...initial(), reasoning('older reasoning'), createUserMessage({ content: 'continue' }), reasoning('tool reasoning', 'read-1'), createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'result' }] })] as Message[]
async function run(model: string, messages: Message[], thinking = true, extra: Record<string, unknown> = {}, pool: Tool[] = tools) {
  const params = {
    messages, systemPrompt: asSystemPrompt(['wire fixture']), thinkingConfig: thinking ? { type: 'enabled', budgetTokens: 4096 } : { type: 'disabled' },
    tools: pool, signal: new AbortController().signal,
    options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'max', ...extra },
  } as CallModelParams
  const out = []
  for await (const event of routedCallModel(params)) if (event.type === 'assistant') out.push(event)
  return { request: captures.at(-1)!, answer: settleAssistantTurn(out, false) }
}
try {
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    clearToolRosterLatches()
    const on = await run(model, history)
    check(`D1 ${model}: all assistant reasoning replays with thinking on`, JSON.stringify(on.request.messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.reasoning_content)) === JSON.stringify(['older reasoning', 'tool reasoning']), on.request.messages)
    check(`D1 ${model}: tool identity and result order survive`, on.request.messages.some((m: any, i: number) => m.tool_calls?.[0]?.id === 'read-1' && on.request.messages[i + 1]?.tool_call_id === 'read-1'))
    check(`D1 ${model}: answer and disjoint usage settle`, !on.answer.isApiErrorMessage && on.answer.message.content.some((b: any) => b.text === 'answered') && on.answer.message.usage.input_tokens === 5 && on.answer.message.usage.cache_read_input_tokens === 7)
    const continued = [...history, on.answer, createUserMessage({ content: 'next question' })] as Message[]
    const replay = await run(model, continued)
    check(`D1 ${model}: settled stream reasoning survives the next user turn`, replay.request.messages.some((m: any) => m.role === 'assistant' && m.reasoning_content === 'next reasoning'))
    const off = await run(model, continued, false)
    check(`D1 ${model}: thinking off omits every reasoning_content`, off.request.thinking.type === 'disabled' && off.request.messages.every((m: any) => !('reasoning_content' in m)))
  }
  check('D1 Z.AI codec default remains reasoning-free', mapMessagesToZai(undefined, [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'zai', signature: '' }, { type: 'text', text: 'answer' }] }] as never).every(m => !('reasoning_content' in m)))
  const image = { type: 'image', source: { type: 'url', url: 'https://fixture.invalid/image.png' } }
  for (const [model, expected] of [['deepseek-flash', true], ['deepseek-v4-pro', false]] as const) {
    clearToolRosterLatches()
    const turn = await run(model, [createUserMessage({ content: [{ type: 'text', text: 'look' }, image] as never })] as Message[])
    check(`D2 ${model}: image capability is ${expected}`, modelReceivesImageBlocks(model) === expected)
    check(`D2 ${model}: wire image matches modality`, JSON.stringify(turn.request.messages).includes('image_url') === expected, turn.request.messages)
    check(`D3 ${model}: full context window`, getContextWindowForModel(model) === 1_048_576, getContextWindowForModel(model))
    check(`D3 ${model}: full output ceiling`, getModelMaxOutputTokens(model).upperLimit === 393_216, getModelMaxOutputTokens(model))
    const output = await run(model, initial(), true, { maxOutputTokensOverride: 393_216 })
    check(`D3 ${model}: override reaches wire without 64k clamp`, output.request.max_tokens === 393_216, output.request.max_tokens)
  }
  listing = [
    { id: 'deepseek-flash', name: 'Listed Flash', context_window: 1_200_000, max_output_tokens: 400_000, input_modalities: ['text'] },
    { id: 'deepseek-new-fixture', name: 'Listed New', context_window: 1_100_000, max_output_tokens: 300_000, input_modalities: ['text', 'image'] },
    { id: 'deepseek-text-fixture', input_modalities: ['text'] },
  ]
  await refreshDeepseekCatalogue({ force: true })
  const decoded = decodeDeepseekModel(listing[1]) as Record<string, unknown> | undefined
  check('D4 live fields decode', decoded?.displayName === 'Listed New' && decoded?.contextWindow === 1_100_000 && decoded?.outputMax === 300_000 && decoded?.images === true, decoded)
  for (const [model, window, output, images, name] of [['deepseek-flash', 1_200_000, 400_000, false, 'Listed Flash'], ['deepseek-new-fixture', 1_100_000, 300_000, true, 'Listed New']] as const) {
    check(`D4 ${model}: live capacity reaches consumers`, resolveContextWindow(model).source === 'live-current' && getContextWindowForModel(model) === window && getModelMaxOutputTokens(model).upperLimit === output, { context: resolveContextWindow(model), output: getModelMaxOutputTokens(model) })
    check(`D4 ${model}: live name and window reach catalogue`, deepseekCatalogueEntry(model)?.displayLabel === name && deepseekCatalogueEntry(model)?.contextWindow === window, deepseekCatalogueRows().rows)
    check(`D4 ${model}: live images win`, modelReceivesImageBlocks(model) === images)
  }
  check('D4 new text-only model is not image-capable', !modelReceivesImageBlocks('deepseek-text-fixture'))
  const invalid = decodeDeepseekModel({ id: 'deepseek-invalid', context_window: -1, max_output_tokens: 'huge', input_modalities: 'image', name: ' ' }) as Record<string, unknown> | undefined
  check('D4 malformed optional facts stay absent', invalid?.contextWindow === undefined && invalid?.outputMax === undefined && invalid?.images === undefined && invalid?.displayName === undefined, invalid)
  const unknown = decodeDeepseekModel({ id: 'deepseek-id-only' }) as Record<string, unknown> | undefined
  check('D4 missing facts stay absent', unknown?.contextWindow === undefined && unknown?.outputMax === undefined && unknown?.images === undefined)
  __resetDeepseekCatalogueForTest()
  listing = []
  clearToolRosterLatches()
  const pool = [...tools, ToolSearchTool as Tool, fixtureTool('DeferredRead', true)]
  const conversation = initial()
  const first = await run('deepseek-flash', conversation, true, {}, pool)
  const search = createAssistantMessage({ content: [{ type: 'thinking', thinking: 'find tool', signature: '' }, { type: 'tool_use', id: 'search-1', name: 'ToolSearch', input: { query: 'select:DeferredRead' } }] as never })
  const result = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'search-1', content: [{ type: 'tool_reference', tool_name: 'DeferredRead' }] }] as never })
  emittedTool = 'DeferredRead'
  const second = await run('deepseek-flash', [...conversation, search, result] as Message[], true, {}, pool)
  emittedTool = undefined
  check('D5 admitted tool call settles once with its identity and arguments', second.answer.message.stop_reason === 'tool_use' && second.answer.message.content.filter((block: any) => block.type === 'tool_use' && block.id === 'admitted-call' && block.name === 'DeferredRead' && block.input.path === 'fixture').length === 1)
  check('D5 Flash uses text-append', deferralWireFormFor('deepseek-flash').form === 'text-append')
  check('D5 V4 Pro remains leading-only', deferralWireFormFor('deepseek-v4-pro').form === 'text')
  check('D5 admission does not change tools or earlier messages', JSON.stringify(first.request.tools) === JSON.stringify(second.request.tools) && JSON.stringify(first.request.messages) === JSON.stringify(second.request.messages.slice(0, first.request.messages.length)))
  check('D5 admitted schema rides system message after its result', second.request.messages.some((m: any, i: number) => m.tool_call_id === 'search-1' && second.request.messages[i + 1]?.role === 'system' && second.request.messages[i + 1]?.content?.includes('DeferredRead')), second.request.messages)
  check('D5 deferred schema never rides the top-level tools', !second.request.tools.some((t: any) => t.function.name === 'DeferredRead'))
  for (const choice of [{ type: 'tool', name: 'Read' }, { type: 'any' }, { type: 'none' }]) {
    clearToolRosterLatches()
    const on = await run('deepseek-flash', initial(), true, { toolChoice: choice })
    check(`D6 thinking-on ${choice.type}: compatible choice`, on.request.tool_choice === (choice.type === 'none' ? 'none' : 'auto'), on.request.tool_choice)
    const off = await run('deepseek-flash', initial(), false, { toolChoice: choice })
    check(`D6 thinking-off ${choice.type}: current auto/none contract`, off.request.tool_choice === (choice.type === 'none' ? 'none' : 'auto'), off.request.tool_choice)
  }
  status = 402
  const refused = await run('deepseek-flash', initial())
  check('refusal surfaces', refused.answer.isApiErrorMessage === true)
  status = 200
  const resumed = await run('deepseek-flash', initial())
  check('served request after refusal still reaches provider', !resumed.answer.isApiErrorMessage && resumed.request.reasoning_effort === 'max')
} finally {
  server.stop(true)
  rmSync(proofHome, { recursive: true, force: true })
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
