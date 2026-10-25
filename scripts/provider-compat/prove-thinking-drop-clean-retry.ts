import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const bodies: any[] = []
let mode = 'thinking'
const sse = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req: Request) {
  if (req.method !== 'POST') return Response.json({ data: [{ id: 'glm-5.2' }, { id: 'fixture-thinking' }] })
  bodies.push(await req.json())
  const n = bodies.length
  const answer = mode !== 'always' && n > 1
  const delta = mode === 'tool' ? { tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'Read', arguments: '{' } }] } : mode === 'white' ? { content: ' \n\t' } : { reasoning_content: 'Think carefully before answering.' }
  return new Response(answer ? sse({ content: 'Recovered answer.' }, 'stop') + 'data: [DONE]\n\n' : sse(delta), { headers: { 'content-type': 'text/event-stream' } })
} })
const base = `http://127.0.0.1:${server.port}`
process.env.MERCURY_COMPAT_BASE_URL = base + '/v1'
process.env.MERCURY_COMPAT_MODELS = 'fixture-thinking'
process.env.MERCURY_ZAI_API_BASE = base + '/v4'
process.env.ZAI_API_KEY = 'fixture-thinking-key'
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.js')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { getUsageForModel, resetCostState } = await import('../../src/cost-tracker.js')
const failures: string[] = []
try {
  for (const model of ['compat/fixture-thinking', 'glm-5.2']) {
    for (mode of ['thinking', 'white', 'always', 'tool', 'cancel']) {
      bodies.length = 0
      resetCostState()
      const controller = new AbortController()
      const rows: any[] = []
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        for await (const event of routedCallModel({ messages: [createUserMessage({ content: 'Answer the question.' })], systemPrompt: asSystemPrompt(['Answer directly.']), thinkingConfig: { type: 'enabled', budgetTokens: 8192 }, tools: [], signal: controller.signal,
          options: { model, effortValue: 'max', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } } as never)) {
          rows.push(event)
          if (mode === 'cancel' && event.type === 'stream_event' && event.event.type === 'content_block_delta') controller.abort()
        }
      } finally { clearTimeout(timer) }
      const expected = mode === 'tool' || mode === 'cancel' ? 1 : 2
      if (bodies.length !== expected) failures.push(`${model}/${mode}: ${bodies.length} requests instead of ${expected}`)
      if (bodies.length > 1) assert.deepEqual(bodies[1], bodies[0], 'retry retains the original request, effort, thinking and tools, with no continuation nudge')
      if (mode === 'thinking' || mode === 'white') {
        if (!rows.some(row => row.type === 'assistant' && row.message.content.some((block: any) => block.text === 'Recovered answer.'))) failures.push(`${model}/${mode}: no recovered answer`)
        if (rows.some(row => row.isApiErrorMessage)) failures.push(`${model}/${mode}: unnecessary terminal fault`)
      }
      if (mode === 'always' && rows.some(row => JSON.stringify(row.message ?? {}).includes('after partial text'))) failures.push(`${model}: empty continuation nudge remains eligible`)
      if (mode === 'thinking' && !((getUsageForModel(model)?.outputTokens ?? 0) > 0)) failures.push(`${model}: interrupted thinking usage lost`)
    }
  }
  assert.deepEqual(failures, [])
  console.log('thinking-only stream drops retry clean once on compat and Z.AI: PASS')
} finally { server.stop(true) }
