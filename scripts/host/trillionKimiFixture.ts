import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'

export async function trillionKimiFixture() {
  const base = await llmhostFixture()
  const model = 'moonshotai/Kimi-K3'
  const captures: any[] = []
  const state = { mode: 'reply' }
  const reasoning = '  preserved α\r\nsecond fragment  '
  const rawArguments = '{\n  "text" : "hel\\u006co"\n}'
  const call = { id: 'kimi-fixture-call', type: 'function', function: { name: 'FixtureEcho', arguments: rawArguments } }
  const assistant = { role: 'assistant', content: 'before after', reasoning_content: reasoning, tool_calls: [call] }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/v1/models') return Response.json({ data: [{ id: model, owned_by: 'sglang', context_length: 1048576 }] })
    if (path === '/get_model_info') return Response.json({ model_path: model, context_length: 1048576 })
    if (path !== '/v1/chat/completions') return new Response('not found', { status: 404 })
    const body = await req.json() as any
    captures.push(body)
    if (state.mode === 'refuse') return Response.json({ error: { message: 'fixture refused' } }, { status: 401 })
    const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => 'data: ' + JSON.stringify({ model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n'
    const usage = { prompt_tokens: 20, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 10 } }
    const tools = state.mode === 'tools' && !body.messages.some((row: any) => row.role === 'tool')
    const output = tools
      ? chunk({ reasoning_content: '  preserved α\r\n' }) + chunk({ content: 'before ' }) + chunk({ reasoning_content: 'second fragment  ' }) + chunk({ content: 'after' }) + chunk({ tool_calls: [{ ...call, index: 0 }] }) + chunk({}, 'tool_calls', usage)
      : chunk({ reasoning_content: 'final reasoning' }) + chunk({ content: 'KIMI-READY' }) + (state.mode === 'truncated' ? '' : chunk({}, 'stop', usage))
    return new Response(output + (state.mode === 'truncated' ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } })
  } })
  return { ...base, model, baseUrl: 'http://127.0.0.1:' + server.port + '/v1', captures, state, assistant, close: () => { server.stop(true); base.close() } }
}

export async function proveKimiReplay(f: Awaited<ReturnType<typeof trillionKimiFixture>>, check: (name: string, truth: unknown) => void) {
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  const { refreshCompatCatalogues } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
  const id = 'compat/kimi/' + f.model
  writeFileSync(join(f.home, 'settings.json'), JSON.stringify({ compatProvider: { kimi: { baseUrl: f.baseUrl, dialect: 'sglang' } } }))
  resetSettingsCache()
  await refreshCompatCatalogues({ force: true })
  f.state.mode = 'tools'
  const messages: any[] = [f.createUserMessage({ content: 'call the fixture' })]
  const first = await f.run(id, messages)
  check('K3 routed tool turn settles without provider error', first.length > 0 && first.every(row => !row.isApiErrorMessage))
  check('K3 request retains max effort and the full fixture tool set', f.captures.at(-1).reasoning_effort === 'max' && f.captures.at(-1).tools.some((tool: any) => tool.function.name === 'FixtureEcho'))
  messages.push(...JSON.parse(JSON.stringify(first)), f.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'kimi-fixture-call', content: 'hello' }] }))
  const second = await f.run(id, messages)
  check('K3 second turn settles', second.every(row => !row.isApiErrorMessage))
  const replay = f.captures.at(-1).messages.find((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'kimi-fixture-call')
  assert.deepEqual(replay, f.assistant, 'K3 assistant content, reasoning_content and tool_calls replay as-is, including whitespace and escaped argument bytes')
  check('K3 complete assistant is replayed byte-for-byte after transcript serialization', true)
  messages.push(...second, f.createUserMessage({ content: 'another user turn' }))
  await f.run(id, messages)
  assert.deepEqual(f.captures.at(-1).messages.find((row: any) => row.tool_calls?.[0]?.id === 'kimi-fixture-call'), f.assistant)
  check('K3 reasoning also survives the next user turn', true)
  const controller = new AbortController(); controller.abort()
  const before = f.captures.length
  await f.run(id, messages, controller.signal)
  check('cancelled K3 turn sends nothing', f.captures.length === before)
  f.state.mode = 'refuse'
  check('provider refusal remains a failure', (await f.run(id)).some(row => row.isApiErrorMessage))
  f.state.mode = 'reply'
  check('resume asks the fixture again and settles measured usage', (await f.run(id)).some(row => row.message.usage.input_tokens === 10 && !row.isApiErrorMessage))
  f.state.mode = 'truncated'
  check('a stream without terminal settlement is not success', (await f.run(id)).some(row => row.isApiErrorMessage))
  f.state.mode = 'reply'
}
