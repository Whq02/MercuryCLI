import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { AssistantMessage, Message } from '../../src/types/message.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'openai-refusal-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.OPENAI_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_EFFORT_LEVEL
let mode = 'refusal'
const requests: Record<string, unknown>[] = []
const refusal = 'I cannot carry out that request.'
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  if (req.method !== 'POST') return Response.json({ data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'high', 'max'], visibility: 'list', supported_in_api: true }] })
  requests.push(await req.json() as Record<string, unknown>)
  const refused = mode === 'refusal' || mode === 'done-only'
  const events = [
    { type: 'response.created', response: { id: `fixture-${mode}` } },
    ...(refused ? [
      ...(mode === 'refusal' ? [{ type: 'response.refusal.delta', delta: refusal }] : []),
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal }] } },
    ] : [{ type: 'response.output_text.delta', delta: mode === 'served' ? 'The next request was served.' : 'partial policy response' }]),
    mode === 'filter' ? { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' }, usage: { input_tokens: 8, output_tokens: 4 } } } : { type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 4 } } },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${server.port}/v1`
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { requestConversationPlan } = await import('../../src/utils/messages/apiPlan.ts')
const { createUserMessage, createAssistantMessage, createAssistantAPIErrorMessage } = await import('../../src/utils/messages/factories.ts')
const tool = { name: 'fixture_tool', description: async () => 'fixture', inputSchema: z.object({}), isEnabled: async () => true, isReadOnly: () => true, prompt: async () => 'fixture', userFacingName: () => 'fixture' } as never
async function call(messages: Message[]): Promise<AssistantMessage[]> {
  const rows: AssistantMessage[] = []
  for await (const row of routedCallModel({ messages, systemPrompt: asSystemPrompt(['A fixture.']), thinkingConfig: { type: 'enabled', budgetTokens: 1024 }, tools: [tool], signal: new AbortController().signal, options: { model: 'gpt-5.6-sol', effortValue: 'max', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } as never })) if (row.type === 'assistant') rows.push(row as AssistantMessage)
  return rows
}
let failures = 0
const check = (label: string, ok: boolean): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++ }
try {
  for (const scenario of ['refusal', 'done-only', 'filter']) {
    mode = scenario
    const user = createUserMessage({ content: 'The original request stays in the conversation.' })
    const rows = await call([user])
    check(`${scenario}: the provider outcome settles as refusal`, rows.at(-1)?.message.stop_reason === 'refusal')
    check(`${scenario}: usage still settles`, rows.at(-1)?.message.usage.input_tokens === 8 && rows.at(-1)?.message.usage.output_tokens === 4)
    if (scenario !== 'filter') check(`${scenario}: refusal words remain visible exactly once`, rows.flatMap(row => row.message.content).filter(block => block.type === 'text' && block.text === refusal).length === 1)
    const earlier = createAssistantMessage({ content: [{ type: 'tool_use', id: 'call_fixture', name: 'fixture_tool', input: {} }] })
    earlier.message.model = 'gpt-5.6-sol'
    earlier.apexProviderTurn = { provider: 'openai', items: [
      { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'fixture-sealed-reasoning' },
      { type: 'function_call', call_id: 'call_fixture', name: 'fixture_tool', arguments: '{}' },
    ] }
    const transcript: Message[] = [
      createUserMessage({ content: 'Do the earlier work.' }), earlier,
      createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'Earlier work complete.' }] }),
      user, ...rows,
      createAssistantAPIErrorMessage({ content: 'API Error: a prior rate limit', error: 'rate_limit' }),
      createUserMessage({ content: 'A harmless next request.' }),
    ]
    const before = JSON.stringify(transcript)
    const plan = requestConversationPlan(transcript, [tool], 'family')
    const wire = JSON.stringify(plan.messages)
    const noRefusal = (bytes: string): boolean => !bytes.includes(refusal) && !bytes.includes('partial policy response') && !bytes.includes('content filter') && !bytes.includes('prior rate limit')
    check(`${scenario}: refused assistant words and synthetic errors leave the family wire`, noRefusal(wire))
    check(`${scenario}: original and new user prompts remain`, wire.includes('original request stays') && wire.includes('harmless next request'))
    check(`${scenario}: visible transcript is unchanged by planning`, JSON.stringify(transcript) === before)
    mode = 'served'
    const served = await call(transcript)
    const input = requests.at(-1)?.input as Array<Record<string, unknown>>
    const serialized = JSON.stringify(input)
    check(`${scenario}: the next request reaches the provider and is served`, served.at(-1)?.message.stop_reason === 'end_turn' && JSON.stringify(served).includes('The next request was served.'))
    check(`${scenario}: captured next-request bytes omit the refusal and errors`, noRefusal(serialized) && serialized.includes('harmless next request') && serialized.includes('original request stays'))
    const callIndex = input.findIndex(item => item.type === 'function_call' && item.call_id === 'call_fixture')
    const resultIndex = input.findIndex(item => item.type === 'function_call_output' && item.call_id === 'call_fixture')
    const paired = callIndex > 0 && resultIndex > callIndex && input[callIndex - 1]?.encrypted_content === 'fixture-sealed-reasoning'
    check(`${scenario}: earlier tool call, result and encrypted reasoning keep their replay order`, paired)
    if (!paired) console.log(serialized)
  }
  check('all six requests reach the selected OpenAI fixture model at max effort', requests.length === 6 && requests.every(request => request.model === 'gpt-5.6-sol' && (request.reasoning as { effort?: string }).effort === 'max'))
} finally {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} OpenAI provider refusal`)
process.exit(failures ? 1 : 0)
