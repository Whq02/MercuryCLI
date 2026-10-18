#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const home = mkdtempSync(join(tmpdir(), 'window-result-budgets-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
for (const key of ['MERCURY_HOME', 'MERCURY_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_BARE', 'NODE_ENV']) delete process.env[key]
const load = (file: string): Promise<any> => import(join(root, file))
const storage = await load('src/utils/toolResultStorage.ts')
const { enableConfigs } = await load('src/utils/config/globalConfig.ts')
enableConfigs()
const { refreshLocalDiscovery } = await load('src/services/providers/local/localDiscovery.ts')
const { resolveContextWindow, getModelMaxOutputTokens } = await load('src/utils/model/capabilities.ts')
const { createUserMessage, createAssistantMessage } = await load('src/utils/messages.ts')
const { buildRequestContextPlan } = await load('src/services/run/requestContextPlan.ts')
const { processMainOwner } = await load('src/services/run/resolveOwner.ts')
const { Conversation } = await load('src/rows/turn.ts')
const { runToolUse } = await load('src/services/tools/toolExecution.ts')
const { getDefaultAppState } = await load('src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await load('src/utils/fileStateCache.ts')
const { z } = await import('zod')
let failed = 0
let checks = 0
function check(label: string, yes: boolean, detail = ''): void {
  checks++
  if (!yes) failed++
  console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const windows = new Map([['room-32k', 32_000], ['room-64k', 64_000], ['room-tiny', 1_000], ['room-zero', 0]])
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/api/tags') return Response.json({ models: [...windows.keys()].map(name => ({ name })) })
    if (path === '/api/ps') return Response.json({ models: [...windows].map(([name, context_length]) => ({ name, model: name, context_length })) })
    if (path === '/api/show') return Response.json({ capabilities: ['tools'] })
    if (path === '/api/version') return Response.json({ version: 'fixture' })
    return new Response('fixture refuses other paths', { status: 404 })
  },
})
const block = (text: string, id = randomUUID()): any => ({ type: 'tool_result', tool_use_id: id, content: text })
const payload = (length: number): string => 'first\n' + 'ordinary result line\n'.repeat(Math.ceil(length / 21)).slice(0, length - 11) + '\nlast'
function wholePointer(result: any, expected: string): boolean {
  const path = typeof result.content === 'string' ? /Full output saved to: ([^\n]+)/.exec(result.content)?.[1] : undefined
  return path !== undefined && readFileSync(path, 'utf8') === expected
}
try {
  await refreshLocalDiscovery({ force: true, env: { MERCURY_LOCAL_PROBE_TARGETS: `ollama=http://127.0.0.1:${server.port}` } })
  console.log('\nwindow-scaled results')
  for (const [model, threshold] of [['local/room-32k', 19_200], ['local/room-64k', 38_400], ['local/room-tiny', 8_000]] as const) {
    const beforeOutput = getModelMaxOutputTokens(model)
    const text = payload(threshold + 1)
    const result = await storage.processPreMappedToolResultBlock(block(text), 'Fixture', 100_000, undefined, model)
    check(`${model} spills above ${threshold} chars`, String(result.content).startsWith(storage.PERSISTED_OUTPUT_TAG), `window ${resolveContextWindow(model).effectiveWindow}; inline ${String(result.content).length}`)
    check(`${model} pointer reads back the whole result`, wholePointer(result, text))
    check(`${model} output-token capability unchanged`, JSON.stringify(getModelMaxOutputTokens(model)) === JSON.stringify(beforeOutput))
  }
  console.log('\nshared request planning')
  for (const model of ['local/room-32k', 'local/room-64k']) {
    const text = payload(model.endsWith('32k') ? 14_000 : 30_000)
    const originals = [block(text), block(text), block(text)]
    const messages = [createUserMessage({ content: originals })]
    const state = storage.createContentReplacementState()
    const recorded: any[] = []
    const plan = await buildRequestContextPlan({ messages, owner: processMainOwner(), querySource: 'sdk', contentReplacementState: state, skipToolNames: new Set(), preserveBodies: true, engineModel: model, persistReplacements: (rows: any[]) => { recorded.push(...rows) } }, 'apply')
    const landed = plan.messages[0].message.content
    check(`${model} aggregate budget applies on an ordinary turn`, landed.some((b: any) => b.content.startsWith(storage.PERSISTED_OUTPUT_TAG)))
    check(`${model} aggregate decisions are recorded for resume`, recorded.length > 0 && recorded.length === state.replacements.size)
    for (let i = 0; i < landed.length; i++) if (landed[i].content !== originals[i].content) check(`${model} aggregate pointer keeps full output`, wholePointer(landed[i], text))
    const again = await buildRequestContextPlan({ messages, owner: processMainOwner(), querySource: 'sdk', contentReplacementState: state, skipToolNames: new Set(), preserveBodies: true, engineModel: 'local/room-tiny' }, 'apply')
    check(`${model} decided prefixes survive a smaller-window switch unchanged`, JSON.stringify(again.messages) === JSON.stringify(plan.messages))
  }
  console.log('\nreal tool transaction')
  const text = payload(24_000)
  const tool = { name: 'FixtureResult', inputSchema: z.object({}), maxResultSizeChars: 100_000, isReadOnly: () => true, isConcurrencySafe: () => true, isEnabled: () => true, call: async () => ({ data: text }), mapToolResultToToolResultBlockParam: (data: string, id: string) => block(data, id) }
  let app = getDefaultAppState()
  const ctx = { options: { engineModel: 'local/room-32k', tools: [tool], mcpClients: [], mcpResources: {}, commands: [], agentDefinitions: { activeAgents: [], allAgents: [] }, isNonInteractiveSession: true }, abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(100), contentReplacementState: storage.createContentReplacementState(), messages: [], getAppState: () => app, setAppState: (updater: any) => { app = updater(app) }, setResponseLength: () => {}, setInProgressToolUseIDs: () => {} }
  const id = randomUUID()
  const assistant = createAssistantMessage({ content: [{ type: 'tool_use', id, name: tool.name, input: {} }] })
  const updates: any[] = []
  for await (const update of runToolUse({ id, name: tool.name, input: {} }, assistant, async (_tool: any, input: any) => ({ behavior: 'allow', updatedInput: input }), ctx)) updates.push(update)
  const result = updates.flatMap(update => update.message?.message?.content ?? []).find(b => b.tool_use_id === id)
  check('tool execution uses its own active model window', result !== undefined && wholePointer(result, text), String(result?.content).slice(0, 100))
  const conversation = new Conversation({ ...ctx, tools: [tool], initialMessages: [], contentReplacementState: undefined, readFileState: ctx.readFileState })
  check('headless Conversation uses the interactive aggregate default', conversation.contentReplacementState.budgetChars !== Infinity)
  check('headless cold and warm-resume boots do not disable the budget', !/budgetChars:\s*Infinity/.test(readFileSync(join(root, 'src/cli/run.ts'), 'utf8')))

  console.log('\nrequest loop')
  const { queryEvents } = await load('src/query.ts')
  const bootstrap = await load('src/bootstrap/state.ts')
  bootstrap.setIsInteractive(false)
  bootstrap.setAskChannel('none')
  const chunkTool = { ...tool, name: 'WindowChunk', inputSchema: z.object({ piece: z.number() }), prompt: async () => 'Return one fixture chunk.', call: async (input: { piece: number }) => ({ data: `${input.piece}\n${payload(14_000)}` }) }
  const loopContext = { ...ctx, abortController: new AbortController(), contentReplacementState: storage.createContentReplacementState(), options: { ...ctx.options, tools: [chunkTool], thinkingConfig: { type: 'disabled' } }, updateFileHistoryState: () => {}, updateAttributionState: () => {} }
  const requests: any[] = []
  const loop = queryEvents({
    messages: [createUserMessage({ content: 'Return four chunks and report.' })], systemPrompt: ['fixture'], userContext: {}, systemContext: {},
    toolUseContext: loopContext, querySource: 'sdk', canUseTool: async (_tool: any, input: any) => ({ behavior: 'allow', updatedInput: input }),
    deps: {
      uuid: randomUUID,
      autocompact: async () => ({ wasCompacted: false }),
      callModel: async function* (request: any) {
        requests.push(request)
        const first = requests.length === 1
        const answer = createAssistantMessage({ content: first ? [0, 1, 2, 3].map(piece => ({ type: 'tool_use', id: `window-${piece}`, name: chunkTool.name, input: { piece } })) : [{ type: 'text', text: 'all chunks received' }] })
        answer.message.model = 'local/room-32k'
        answer.message.stop_reason = first ? 'tool_use' : 'end_turn'
        answer.message.usage = { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        yield answer
      },
    },
  })
  let step = await loop.next()
  while (!step.done) step = await loop.next()
  const delivered = requests[1]?.messages.flatMap((m: any) => m.type === 'user' && Array.isArray(m.message.content) ? m.message.content.filter((b: any) => b.type === 'tool_result') : []) ?? []
  check('the real request loop completes after four tool calls', step.value?.reason === 'completed' && requests.length === 2 && delivered.length === 4, JSON.stringify(step.value))
  check('the next request receives the active-model aggregate budget', delivered.some((b: any) => b.content.startsWith(storage.PERSISTED_OUTPUT_TAG)) && loopContext.contentReplacementState.replacements.size > 0)
  for (const part of delivered) {
    if (part.content.startsWith(storage.PERSISTED_OUTPUT_TAG)) check('request-loop pointer keeps every chunk byte', wholePointer(part, `${part.tool_use_id.slice(-1)}\n${payload(14_000)}`))
  }

  console.log('\nrefusals')
  for (const [model, size] of [['local/room-32k', 19_200], ['local/room-64k', 38_400], ['local/room-tiny', 8_000], ['local/room-zero', 50_000], ['local/not-listed', 50_000], [undefined, 50_000]] as const) {
    const original = block(payload(size))
    const result = await storage.processPreMappedToolResultBlock(original, 'Fixture', 100_000, undefined, model)
    check(`${model ?? 'unknown'} result at threshold stays inline byte for byte`, result === original)
  }
  const selfBounded = block(payload(90_000))
  check('self-bounded Read is not recursively persisted', await storage.processPreMappedToolResultBlock(selfBounded, 'Read', Infinity, undefined, 'local/room-tiny') === selfBounded)
  const image = block('unused')
  image.content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } }]
  check('images reach the model unchanged', await storage.processPreMappedToolResultBlock(image, 'Fixture', 1, undefined, 'local/room-tiny') === image)
  const assistantText = createAssistantMessage({ content: [{ type: 'text', text: payload(90_000) }] })
  const untouched = await storage.enforceToolResultBudget([assistantText], storage.createContentReplacementState(), new Set(), 'local/room-tiny')
  check('model output is not cut by a tool budget', untouched.messages[0] === assistantText)
  const bounded = await storage.processPreMappedToolResultBlock(block(payload(10_001)), 'Fixture', 10_000, undefined, 'local/room-64k')
  check('a tool-specific lower threshold still applies with whole storage', wholePointer(bounded, payload(10_001)))
  const same = await storage.processPreMappedToolResultBlock(bounded, 'Fixture', 100, undefined, 'local/room-tiny')
  check('an existing pointer is never persisted again', same === bounded)
  const small = [createUserMessage({ content: [block('short result')] })]
  const pass = await storage.enforceToolResultBudget(small, storage.createContentReplacementState(), new Set(), 'local/room-32k')
  check('under-budget messages retain their original object and bytes', pass.messages === small)
} finally {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} window-result-budgets: ${checks - failed}/${checks} checks; ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
