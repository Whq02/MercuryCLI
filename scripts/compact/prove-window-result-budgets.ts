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
const limits = await load('src/constants/toolLimits.ts')
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
const windows = new Map([
  ['room-8k', 8_000],
  ['room-32k', 32_000],
  ['room-100k', 100_000],
  ['room-128k', 128_000],
  ['room-200k', 200_000],
  ['room-zero', 0],
])
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
  console.log('\nwindow-scaled floor and raising law')
  const fn = limits.toolResultBudgetsForWindow
  const b8k = typeof fn === 'function' ? fn(8_000) : null
  const b128k = typeof fn === 'function' ? fn(128_000) : null
  const b200k = typeof fn === 'function' ? fn(200_000) : null
  check('an 8k window gets no less than today (50,000 persist / 200,000 message)', b8k !== null && b8k.resultChars === 50_000 && b8k.messageChars === 200_000, JSON.stringify(b8k))
  check('a 128k window gets no less than today (76,800 persist / 200,000 message)', b128k !== null && b128k.resultChars === 76_800 && b128k.messageChars === 200_000, JSON.stringify(b128k))
  check('a 200k window raises both budgets (120,000 persist / 240,000 message)', b200k !== null && b200k.resultChars === 120_000 && b200k.messageChars === 240_000, JSON.stringify(b200k))

  for (const [model, threshold] of [['local/room-8k', 50_000], ['local/room-32k', 50_000], ['local/room-100k', 60_000], ['local/room-128k', 76_800], ['local/room-200k', 120_000]] as const) {
    const beforeOutput = getModelMaxOutputTokens(model)
    const inlineBlock = block(payload(threshold))
    const inlineResult = await storage.processPreMappedToolResultBlock(inlineBlock, 'Fixture', 150_000, undefined, model)
    check(`${model} keeps ${threshold} chars inline without lowering below base`, inlineResult === inlineBlock)
    const spillText = payload(threshold + 1)
    const spillResult = await storage.processPreMappedToolResultBlock(block(spillText), 'Fixture', 150_000, undefined, model)
    check(`${model} spills above its ${threshold} threshold`, String(spillResult.content).startsWith(storage.PERSISTED_OUTPUT_TAG), `window ${resolveContextWindow(model).effectiveWindow}; inline ${String(spillResult.content).length}`)
    check(`${model} pointer reads back the whole result`, wholePointer(spillResult, spillText))
    check(`${model} output-token capability unchanged`, JSON.stringify(getModelMaxOutputTokens(model)) === JSON.stringify(beforeOutput))
  }

  console.log('\nshared request planning and aggregate budget')
  {
    const chunk80k = payload(80_000)
    const under200k = [createUserMessage({ content: [block(chunk80k), block(chunk80k)] })]
    for (const model of ['local/room-8k', 'local/room-128k'] as const) {
      const state = storage.createContentReplacementState()
      const res = await storage.enforceToolResultBudget(under200k, state, new Set(), model)
      check(`${model} keeps 160,000 aggregate chars inline (no less than today's 200,000)`, res.messages === under200k && res.replacements.length === 0)
    }
    const over200k = [createUserMessage({ content: [block(chunk80k), block(chunk80k), block(chunk80k)] })]
    const state200k = storage.createContentReplacementState()
    const res200k = await storage.enforceToolResultBudget(over200k, state200k, new Set(), 'local/room-200k')
    check('local/room-200k raises message budget to 240,000 and keeps 240,000 chars inline', res200k.messages === over200k && res200k.replacements.length === 0)

    const chunk90k = payload(90_000)
    const over240k = [createUserMessage({ content: [block(chunk90k), block(chunk90k), block(chunk90k)] })]
    const statePrune = storage.createContentReplacementState()
    const recorded: any[] = []
    const preserved = await buildRequestContextPlan({ messages: over240k, owner: processMainOwner(), querySource: 'sdk', contentReplacementState: statePrune, skipToolNames: new Set(), preserveBodies: true, engineModel: 'local/room-200k', persistReplacements: (rows: any[]) => { recorded.push(...rows) } }, 'apply')
    check('preserveBodies bypasses aggregate replacement so a fold sees the full request', JSON.stringify(preserved.messages) === JSON.stringify(over240k) && statePrune.replacements.size === 0 && statePrune.seenIds.size === 0)
    const pruned = await buildRequestContextPlan({ messages: over240k, owner: processMainOwner(), querySource: 'sdk', contentReplacementState: statePrune, skipToolNames: new Set(), preserveBodies: false, engineModel: 'local/room-200k', persistReplacements: (rows: any[]) => { recorded.push(...rows) } }, 'apply')
    const landed = pruned.messages[0].message.content
    check('when preserveBodies is false, aggregate budget replaces above 240,000 chars', landed.some((b: any) => b.content.startsWith(storage.PERSISTED_OUTPUT_TAG)) && recorded.length === 1)
    for (const b of landed) if (b.content !== chunk90k) check('aggregate pointer keeps full 90,000-char output', wholePointer(b, chunk90k))
    const again = await buildRequestContextPlan({ messages: over240k, owner: processMainOwner(), querySource: 'sdk', contentReplacementState: statePrune, skipToolNames: new Set(), preserveBodies: false, engineModel: 'local/room-8k' }, 'apply')
    check('decided prefixes survive a smaller-window switch unchanged', JSON.stringify(again.messages) === JSON.stringify(pruned.messages))
  }

  console.log('\nreal tool transaction')
  const text = payload(60_000)
  const tool = { name: 'FixtureResult', inputSchema: z.object({}), maxResultSizeChars: 100_000, isReadOnly: () => true, isConcurrencySafe: () => true, isEnabled: () => true, call: async () => ({ data: text }), mapToolResultToToolResultBlockParam: (data: string, id: string) => block(data, id) }
  let app = getDefaultAppState()
  const ctx = { options: { engineModel: 'local/room-128k', tools: [tool], mcpClients: [], mcpResources: {}, commands: [], agentDefinitions: { activeAgents: [], allAgents: [] }, isNonInteractiveSession: true }, abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(100), contentReplacementState: storage.createContentReplacementState(), messages: [], getAppState: () => app, setAppState: (updater: any) => { app = updater(app) }, setResponseLength: () => {}, setInProgressToolUseIDs: () => {} }
  const id = randomUUID()
  const assistant = createAssistantMessage({ content: [{ type: 'tool_use', id, name: tool.name, input: {} }] })
  const updates: any[] = []
  for await (const update of runToolUse({ id, name: tool.name, input: {} }, assistant, async (_tool: any, input: any) => ({ behavior: 'allow', updatedInput: input }), ctx)) updates.push(update)
  const result = updates.flatMap(update => update.message?.message?.content ?? []).find(b => b.tool_use_id === id)
  check('tool execution on 128k window keeps 60,000-char result inline (raised to 76,800)', result !== undefined && result.content === text, String(result?.content).slice(0, 80))
  const conversation = new Conversation({ ...ctx, tools: [tool], initialMessages: [], contentReplacementState: undefined, readFileState: ctx.readFileState })
  check('headless Conversation uses the interactive aggregate default', conversation.contentReplacementState.budgetChars !== Infinity)
  check('headless cold and warm-resume boots do not disable the budget', !/budgetChars:\s*Infinity/.test(readFileSync(join(root, 'src/cli/run.ts'), 'utf8')))

  console.log('\nrefusals')
  for (const [model, size] of [['local/room-8k', 50_000], ['local/room-32k', 50_000], ['local/room-128k', 76_800], ['local/room-200k', 120_000], ['local/room-zero', 50_000], ['local/not-listed', 50_000], [undefined, 50_000]] as const) {
    const original = block(payload(size))
    const res = await storage.processPreMappedToolResultBlock(original, 'Fixture', 150_000, undefined, model)
    check(`${model ?? 'unknown'} result at threshold stays inline byte for byte`, res === original)
  }
  const selfBounded = block(payload(90_000))
  check('self-bounded Read is not recursively persisted', await storage.processPreMappedToolResultBlock(selfBounded, 'Read', Infinity, undefined, 'local/room-8k') === selfBounded)
  const image = block('unused')
  image.content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } }]
  check('images reach the model unchanged', await storage.processPreMappedToolResultBlock(image, 'Fixture', 1, undefined, 'local/room-8k') === image)
  const assistantText = createAssistantMessage({ content: [{ type: 'text', text: payload(90_000) }] })
  const untouched = await storage.enforceToolResultBudget([assistantText], storage.createContentReplacementState(), new Set(), 'local/room-8k')
  check('model output is not cut by a tool budget', untouched.messages[0] === assistantText)
  const bounded = await storage.processPreMappedToolResultBlock(block(payload(10_001)), 'Fixture', 10_000, undefined, 'local/room-200k')
  check('a tool-specific lower threshold still applies with whole storage', wholePointer(bounded, payload(10_001)))
  const same = await storage.processPreMappedToolResultBlock(bounded, 'Fixture', 100, undefined, 'local/room-8k')
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
