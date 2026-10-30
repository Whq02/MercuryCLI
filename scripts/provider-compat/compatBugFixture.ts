import '../lib/hermetic.ts'
import { randomUUID } from 'node:crypto'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.2' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.DEEPSEEK_API_KEY = 'fixture-key-not-real'
process.env.MERCURY_BUSY_RETRY_SCALE = '0.001'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { deepseekLaneProfile } = await import('../../src/services/providers/deepseek/deepseekCallModel.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
;(await import('../../src/bootstrap/state.ts')).setIsInteractive(false)
export function sse(chunks: unknown[]): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}
export const answer = () => sse([{ model: 'deepseek-chat', choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }])
export async function turn(reply: (attempt: number) => Response | Promise<Response>) {
  const requests: Record<string, any>[] = []
  const times: number[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request: Request) {
    if (!new URL(request.url).pathname.endsWith('/chat/completions')) return Response.json({ data: [] })
    requests.push(await request.json())
    times.push(performance.now())
    return reply(requests.length)
  } })
  const events: any[] = []
  try {
    process.env.MERCURY_DEEPSEEK_API_BASE = `http://127.0.0.1:${server.port}`
    for await (const event of compatChatCallModel(deepseekLaneProfile, {
      messages: [{ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'Say hello.' } }],
      systemPrompt: asSystemPrompt(['Be helpful.']), thinkingConfig: { type: 'disabled' }, tools: [], signal: new AbortController().signal,
      options: { model: 'deepseek-chat', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [] },
    })) events.push(event)
    return { events, requests, times }
  } finally { server.stop(true) }
}
