import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function imageWindowFixture() {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const home = mkdtempSync(join(tmpdir(), 'image-window-'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  for (const name of ['MERCURY_HOME', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_LOCAL_API_KEY', 'MERCURY_SCRIPTED_STREAM']) delete process.env[name]
  const state = { window: 8500, vision: true, reply: '<summary>The page has nine screenshot artifacts. Continue from the latest capture; all source edits and file paths remain in the transcript.</summary>' }
  const requests: Array<Record<string, any>> = []
  const model = 'local/vision-fixture'
  process.env.MERCURY_MODEL = model
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += String(chunk)
    const url = req.url ?? ''
    const json = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url === '/props') return json({ modalities: { vision: state.vision }, default_generation_settings: { n_ctx: state.window } })
    if (url === '/v1/models') return json({ data: [{ id: 'vision-fixture', meta: { n_ctx_train: 262144 } }] })
    if (url === '/v1/chat/completions') {
      const body = JSON.parse(raw)
      requests.push(body)
      const { estimateRequestTokens } = await import('../../src/services/tokenEstimation.ts')
      if (estimateRequestTokens(body, model) > state.window) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'maximum context length exceeded' } }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
      event({ id: 'fixture-answer', choices: [{ index: 0, delta: { role: 'assistant', content: state.reply }, finish_reason: 'stop' }] })
      event({ id: 'fixture-answer', choices: [], usage: { prompt_tokens: estimateRequestTokens(body, model), completion_tokens: 32 } })
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `llamacpp=${root}`
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const permission = getEmptyToolPermissionContext()
  const messages: import('../../src/types/message.ts').Message[] = [createUserMessage({ content: 'Review this page without losing the artifact paths.' })]
  for (let i = 0; i < 9; i++) {
    messages.push(createAssistantMessage({ content: [{ type: 'tool_use', id: `shot-${i}`, name: 'Browser', input: { op: 'screenshot' } }] }))
    messages.push(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: `shot-${i}`, content: [{ type: 'text', text: `screenshot: /captures/${i}.png (https://example.test, 1280x800)` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: String(i).repeat(170_000) } }] }] }))
  }
  messages.push(createUserMessage({ content: 'Continue from the latest screenshot.' }))
  const params = {
    messages,
    systemPrompt: asSystemPrompt(['You are a fixture assistant.']),
    tools: [],
    thinkingConfig: { type: 'disabled' as const },
    signal: new AbortController().signal,
    options: { model, querySource: 'main_thread', getToolPermissionContext: async () => permission, agents: [], isNonInteractiveSession: true, mcpTools: [] },
  }
  await refreshLocalDiscovery({ force: true })
  return {
    home, model, state, requests, messages, params, permission,
    refresh: () => refreshLocalDiscovery({ force: true }),
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(home, { recursive: true, force: true })
    },
  }
}
