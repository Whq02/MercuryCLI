import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { z } from 'zod/v4'
import { startEngineRules, validateEngineRequest, ENGINE_RULE_SOURCES } from './fixtures/engineRules.mjs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const home = mkdtempSync(resolve(process.env.MERCURY_CONFIG_DIR, 'engine-shapes-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_TOOL_DEFER = '0'
process.env.MERCURY_BUSY_RETRY_SCALE = '0.01'
for (const key of ['MERCURY_HOME', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_MODELS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key]
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.hostname !== '127.0.0.1') throw new Error(`Engine proof refused non-loopback fetch: ${url.origin}`)
  return realFetch(input, init)
}) as typeof fetch
const root = resolve(import.meta.dir, '../..')
const dialects = Object.keys(ENGINE_RULE_SOURCES)
const fixtures = await Promise.all(dialects.map(dialect => startEngineRules(dialect)))
writeFileSync(resolve(process.env.MERCURY_CONFIG_DIR, 'settings.json'), JSON.stringify({ compatProvider: Object.fromEntries(fixtures.map(fixture => [fixture.dialect, { baseUrl: fixture.baseUrl, dialect: fixture.dialect, models: [fixture.model] }])) }))
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail: unknown = '') {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { mapToolsToZai, mapMessagesToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { streamCompatChat, mapCompatHttpFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { compatTerminalFaultText, compatFaultToTypedError } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { buildHostedExtras, LOCAL_SERVER_EFFORTS } = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { inspectCompatServer } = await import('../../src/services/providers/openaicompat/compatProbe.ts')
const { rememberCompatCatalogue } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
const { configuredCompatEndpoints } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const options = { agents: [], getToolPermissionContext: async () => getEmptyToolPermissionContext() }
const roster = new Map(getAllBaseTools().map(tool => [tool.name, tool]))
const source = ts.createSourceFile('tools.ts', readFileSync(resolve(root, 'src/tools.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
for (const statement of source.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('./tools/')) continue
  const bindings = statement.importClause?.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) continue
  const modulePath = resolve(root, 'src', statement.moduleSpecifier.text.replace(/\.js$/, '.ts'))
  const module = await import(pathToFileURL(existsSync(modulePath) ? modulePath : `${modulePath}x`).href)
  for (const binding of bindings.elements) for (const value of [module[binding.propertyName?.text ?? binding.name.text]].flat()) {
    if (value && typeof value === 'object' && typeof value.name === 'string' && 'inputSchema' in value) roster.set(value.name, value)
  }
}
const tools = [...roster.values()].sort((a, b) => a.name.localeCompare(b.name))
const schemas = await Promise.all(tools.map(tool => toolToAPISchema(tool, { ...options, tools, model: 'compat/llamacpp/engine-fixture' })))
const apiTools = schemas.map(schema => ({ name: schema.name, description: schema.description, input_schema: schema.input_schema }))
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII='
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }
const params = [
  { role: 'user', content: [{ type: 'text', text: 'inspect' }, image] },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'keep this reasoning', signature: 'fixture' }, { type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: '/fixture' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: [{ type: 'text', text: 'file bytes' }, image] }] },
  { role: 'assistant', content: [] },
  { role: 'user', content: 'continue' },
]
const messages = mapMessagesToZai('engine rule fixture', params as never, { imagesSupported: true, keepReasoningHistory: true })
const plain = { model: 'engine-fixture', messages: [{ role: 'user', content: 'hello' }], stream: true }
const negativeRequests: Record<string, any[]> = {
  llamacpp: [
    { ...plain, tools: [{ type: 'function', function: { name: 'Remote', parameters: { $ref: 'https://example.invalid/schema' } } }] },
    { ...plain, tools: [{ type: 'function', function: { name: 'Missing', parameters: { $ref: '#/$defs/missing' } } }] },
  ],
  vllm: [{ ...plain, tool_choice: 'auto' }, { ...plain, tools: [], tool_choice: { type: 'function', function: { name: 'Missing' } } }],
  sglang: [{ ...plain, tools: [], tool_choice: 'required' }, { ...plain, reasoning_effort: true }],
  ollama: [
    { ...plain, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/picture.png' } }] }] },
    { ...plain, messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'Read', arguments: '{' } }] }] },
    { ...plain, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'not-an-image' } }] }] },
  ],
}
async function route(fixture: any, history: any[], owner: string, selectedTools = tools) {
  const out: any[] = []
  for await (const event of routedCallModel({ messages: history, systemPrompt: asSystemPrompt(['engine fixture']), thinkingConfig: { type: 'enabled', budgetTokens: 8192 }, tools: selectedTools, signal: AbortSignal.timeout(30000), options: { ...options, model: `compat/${fixture.dialect}/${fixture.model}`, effortValue: 'max', ownerKey: owner, querySource: 'sdk', isNonInteractiveSession: true, hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false } as never })) out.push(event)
  return out
}
try {
  check('live catalogue includes deferred tools and Computer', tools.some(tool => tool.name === 'Computer') && tools.some(tool => tool.shouldDefer), tools.map(tool => tool.name))
  for (const fixture of fixtures) {
    const dialect = fixture.dialect
    console.log(`CENSUS ${dialect} ${tools.length} tools: ${tools.map(tool => tool.name).join(', ')}`)
    for (const tool of apiTools) {
      const request = { ...plain, tools: mapToolsToZai([tool]) }
      const response = await fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
      check(`${dialect} tool ${tool.name} accepted without withholding`, response.ok, response.ok ? '' : await response.text())
      if (response.ok) await response.body?.cancel()
    }
    for (const effort of [undefined, ...new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', ...LOCAL_SERVER_EFFORTS[dialect as keyof typeof LOCAL_SERVER_EFFORTS]])]) {
      const extra = { ...buildHostedExtras({ wireModel: fixture.model, dialect: dialect as never, effortValue: effort, thinkingEnabled: true, maxOutputTokensOverride: 32768, vocabulary: LOCAL_SERVER_EFFORTS[dialect as keyof typeof LOCAL_SERVER_EFFORTS] }), ...(dialect === 'llamacpp' ? { reasoning_format: 'deepseek' } : {}), ...(dialect === 'sglang' ? { separate_reasoning: true } : {}) }
      const events = []
      const replayMessages = mapMessagesToZai('engine rule fixture', params as never, { imagesSupported: true, keepReasoningHistory: dialect !== 'ollama' })
      for await (const event of streamCompatChat({ url: `${fixture.baseUrl}/chat/completions`, request: { model: fixture.model, messages: replayMessages, tools: mapToolsToZai(apiTools.filter(tool => tool.name === 'Read')), extra }, signal: AbortSignal.timeout(10000) })) events.push(event)
      check(`${dialect} message shapes / effort ${effort ?? 'default'} accepted`, events.some(event => event.type === 'finish') && !events.some(event => event.type === 'stream-fault'), events)
      const sent = fixture.requests.at(-1)!.body
      check(`${dialect} ${effort ?? 'default'} output ceiling, images and replay identity survive`, sent.max_tokens === 32768 && sent.messages.some((row: any) => row.tool_call_id === 'call_read') && JSON.stringify(sent).includes('keep this reasoning') === (dialect !== 'ollama') && (JSON.stringify(sent.messages).match(/"type":"image_url"/g)?.length ?? 0) === 2 && sent.stream === true)
      if (effort === 'max') check(`${dialect} max stays max on the documented knob`, (sent.reasoning_effort ?? sent.chat_template_kwargs?.reasoning_effort) === 'max')
    }
    const chatHistory = [
      createUserMessage({ content: params[0]!.content as never }),
      createAssistantMessage({ content: params[1]!.content as never }),
      createUserMessage({ content: params[2]!.content as never }),
      createAssistantMessage({ content: [] }),
      createUserMessage({ content: 'continue' }),
    ]
    const replay = await route(fixture, chatHistory, `replay-${dialect}`, tools.filter(tool => tool.name === 'Read'))
    check(`${dialect} router preserves tool result pairing and completes image/reasoning history`, replay.some(row => row.type === 'assistant' && !row.isApiErrorMessage && row.message.stop_reason === 'end_turn') && fixture.requests.at(-1)!.body.messages.some((row: any) => row.role === 'tool' && row.tool_call_id === 'call_read'))
    const reading: any = await inspectCompatServer({ baseUrl: fixture.baseUrl, dialect: dialect as never })
    if (dialect === 'sglang' || dialect === 'ollama') check(`${dialect} reads images/tools/reasoning from server metadata`, reading.capabilities?.[fixture.model]?.images === true && reading.capabilities?.[fixture.model]?.tools === true && reading.capabilities?.[fixture.model]?.reasoning === true, reading)
    if (dialect === 'vllm') check('vLLM absent capabilities stay unknown', reading.capabilities?.[fixture.model]?.images === undefined && reading.capabilities?.[fixture.model]?.tools === undefined, reading)
    if (dialect === 'llamacpp') check('llama.cpp reads tool and reasoning support from template capabilities', reading.capabilities?.[fixture.model]?.tools === true && reading.capabilities?.[fixture.model]?.reasoning === true, reading)
    const endpoint = configuredCompatEndpoints().find(endpoint => endpoint.name === dialect)!
    rememberCompatCatalogue(endpoint, reading)
    const history = [createUserMessage({ content: 'hello' })]
    const first = await route(fixture, history, `shapes-${dialect}`)
    check(`${dialect} full router accepts the live roster and settles usage`, first.some(event => event.type === 'assistant' && !event.isApiErrorMessage && event.message.stop_reason === 'end_turn' && event.message.usage.output_tokens === 7), first.filter(event => event.type === 'assistant'))
    const firstBody = fixture.requests.at(-1)!.body
    check(`${dialect} no shipped tool is withheld from the routed request`, tools.filter(tool => tool.name !== 'ToolSearch').every(tool => firstBody.tools.some((wire: any) => wire.function.name === tool.name)))
    const second = await route(fixture, [...history, createAssistantMessage({ content: 'engine accepted' }), createUserMessage({ content: 'again' })], `shapes-${dialect}`)
    check(`${dialect} continuation keeps tools byte-identical`, JSON.stringify(firstBody.tools) === JSON.stringify(fixture.requests.at(-1)!.body.tools) && second.some(event => event.type === 'assistant' && !event.isApiErrorMessage))
    for (const request of negativeRequests[dialect]!) {
      const response = await fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
      const body = await response.json()
      const fault = mapCompatHttpFailure(response.status, body)
      const text = compatTerminalFaultText({ dialect, providerLabel: dialect, credentialHint: 'fixture' } as never, fault, compatFaultToTypedError(fault))
      check(`${dialect} refuses invalid shape with cause and remedy`, response.status === 400 && text.includes(' — ') && !text.includes('api-') && !text.includes('stream failed') && /retry|send|select|update|start|configure|use |include/i.test(text), text)
      fixture.script([{ error: { status: response.status, body } }])
      const rows = await route(fixture, history, `negative-${dialect}-${checks}`, tools.filter(tool => tool.name === 'Read'))
      const errors = rows.filter(row => row.type === 'assistant' && row.isApiErrorMessage)
      check(`${dialect} real HTTP refusal reaches user with remedy`, errors.length === 1 && !JSON.stringify(errors[0].message.content).includes('api-') && !JSON.stringify(errors[0].message.content).includes('stream failed'), errors)
      if (request.reasoning_effort !== undefined) check(`${dialect} a rejected effort value is not silently omitted`, fixture.requests.at(-1)!.body.reasoning_effort === 'max' && rows.every(row => !row.effortAdjusted), rows)
      const recovered = await route(fixture, history, `recover-${dialect}-${checks}`, tools.filter(tool => tool.name === 'Read'))
      check(`${dialect} next request after refusal reaches engine`, recovered.some(row => row.type === 'assistant' && !row.isApiErrorMessage && row.message.stop_reason === 'end_turn'))
    }
    fixture.script([{ call: { name: 'Read', arguments: '{"file_path":' } }])
    const cut = await route(fixture, history, `cut-${dialect}`, tools.filter(tool => tool.name === 'Read'))
    check(`${dialect} cut tool call never becomes executable`, cut.some(row => row.refusedToolCalls?.some((call: any) => call.code === 'invalid-json')) && !cut.some(row => row.type === 'assistant' && row.message.content.some((part: any) => part.type === 'tool_use')))
    fixture.script([{ empty: true }, { reasoning: 'still thinking' }])
    const beforeEmpty = fixture.requests.length
    const retried = await route(fixture, history, `empty-${dialect}`, tools.filter(tool => tool.name === 'Read'))
    check(`${dialect} empty stream retries with identical request and retained effort`, fixture.requests.length === beforeEmpty + 2 && JSON.stringify(fixture.requests[beforeEmpty]!.body) === JSON.stringify(fixture.requests[beforeEmpty + 1]!.body) && retried.some(row => row.type === 'assistant' && row.message.stop_reason === 'end_turn'))
    fixture.script([{ hold: true }])
    const controller = new AbortController()
    const cancelled = []
    for await (const event of streamCompatChat({ url: `${fixture.baseUrl}/chat/completions`, request: { model: fixture.model, messages: [{ role: 'user', content: 'cancel after first event' }] }, signal: controller.signal })) {
      cancelled.push(event)
      if (event.type === 'text-delta') controller.abort()
    }
    check(`${dialect} cancellation after content is not a successful finish`, cancelled.some(event => event.type === 'stream-fault' && event.fault.kind === 'cancelled') && !cancelled.some(event => event.type === 'finish'))
    process.env.MERCURY_TOOL_DEFER = '1'
    process.env.MERCURY_TOOL_SEARCH = 'tst'
    await route(fixture, history, `deferred-${dialect}`)
    const beforeAdmission = fixture.requests.at(-1)!.body
    check(`${dialect} nominally deferred Computer is fully declared on the chat road`, beforeAdmission.tools.some((tool: any) => tool.function.name === 'Computer' && tool.function.parameters.properties.steps))
    const admitted = [history[0]!, createAssistantMessage({ content: [{ type: 'tool_use', id: 'search_fixture', name: 'ToolSearch', input: { query: 'select:Computer' } }] as never }), createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'search_fixture', content: [{ type: 'tool_reference', tool_name: 'Computer' }] }] as never })]
    const deferred = await route(fixture, admitted, `deferred-${dialect}`)
    const deferredBody = fixture.requests.at(-1)!.body
    check(`${dialect} replayed admission stays text with complete schemas and a frozen tools array`, deferred.some(row => row.type === 'assistant' && !row.isApiErrorMessage && row.message.stop_reason === 'end_turn') && deferredBody.messages.some((row: any) => row.role === 'tool' && row.tool_call_id === 'search_fixture' && typeof row.content === 'string' && row.content.includes('Computer')) && !JSON.stringify(deferredBody).includes('"type":"tool_reference"') && JSON.stringify(beforeAdmission.tools) === JSON.stringify(deferredBody.tools))
    delete process.env.MERCURY_TOOL_SEARCH
    process.env.MERCURY_TOOL_DEFER = '0'
  }
  const goodUnion = { ...plain, tools: [{ type: 'function', function: { name: 'Union', parameters: { $defs: { value: { type: 'string' } }, type: 'object', properties: { value: { oneOf: [{ $ref: '#/$defs/value' }, { type: 'null' }] } } } } }] }
  check('llama.cpp accepts resolvable local refs / $defs / oneOf, not a blanket ban', validateEngineRequest('llamacpp', goodUnion) === undefined)
  const fixture = fixtures.find(fixture => fixture.dialect === 'llamacpp')!
  const invalid = { ...tools.find(tool => tool.name === 'Read')!, name: 'BadReference', inputSchema: z.object({}), inputJSONSchema: { type: 'object', properties: { child: { $ref: '#' } } } }
  const selected = [...tools.filter(tool => tool.name === 'Read'), invalid]
  const history = [createUserMessage({ content: 'schema isolation' })]
  const isolated = await route(fixture, history, 'schema-isolation', selected)
  const sent = fixture.requests.at(-1)!.body
  check('one unsupported schema does not poison or remove the other tools', sent.tools?.length === 1 && sent.tools[0].function.name === 'Read' && isolated.some(row => row.type === 'assistant' && !row.isApiErrorMessage && JSON.stringify(row.message.content).includes('BadReference') && JSON.stringify(row.message.content).includes('only this tool is left out')))
  const repeat = await route(fixture, [...history, createAssistantMessage({ content: 'accepted' }), createUserMessage({ content: 'again' })], 'schema-isolation', selected)
  check('schema omission notice is once per session; the wire prefix remains frozen', !repeat.some(row => row.type === 'assistant' && JSON.stringify(row.message.content).includes('only this tool is left out')) && JSON.stringify(sent.tools) === JSON.stringify(fixture.requests.at(-1)!.body.tools))
  fixture.script([{ call: { name: 'BadReference', arguments: '{}' } }])
  const refusedCall = await route(fixture, history, 'schema-gate', selected)
  check('a withheld tool cannot be executed if the server still calls it', refusedCall.some(row => row.refusedToolCalls?.some((call: any) => call.name === 'BadReference')) && !refusedCall.some(row => row.type === 'assistant' && row.message.content.some((part: any) => part.type === 'tool_use')))
  const projector = await startEngineRules('llamacpp', { images: false })
  try {
    const response = await fetch(`${projector.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...plain, messages }) })
    const fault = mapCompatHttpFailure(response.status, await response.json())
    const text = compatTerminalFaultText({ dialect: 'llamacpp', providerLabel: 'llama.cpp', credentialHint: 'fixture' }, fault, compatFaultToTypedError(fault))
    check('llama.cpp without its projector returns the real image refusal with a remedy', response.status === 400 && /mmproj/.test(text) && /projector/.test(text) && !text.includes('api-'), text)
  } finally { await projector.close() }
  for (const dialect of ['sglang', 'ollama']) {
    const fixture = await startEngineRules(dialect, { images: false, tools: false, reasoning: false })
    try {
      const reading: any = await inspectCompatServer({ baseUrl: fixture.baseUrl, dialect: dialect as never })
      check(`${dialect} explicit false capabilities stay false`, reading.capabilities?.[fixture.model]?.images === false && reading.capabilities?.[fixture.model]?.tools === false && reading.capabilities?.[fixture.model]?.reasoning === false, reading)
      const configured = fixtures.find(row => row.dialect === dialect)!
      const endpoint = configuredCompatEndpoints().find(endpoint => endpoint.name === dialect)!
      rememberCompatCatalogue(endpoint, reading)
      const before = configured.requests.length
      const unavailable = await route(configured, [createUserMessage({ content: 'tools unavailable' })], `unsupported-tools-${dialect}`)
      check(`${dialect} known unavailable tools refuse with parser remedy, never a stripped tool set`, configured.requests.length === before && unavailable.some(row => row.isApiErrorMessage && /tool-call support/.test(JSON.stringify(row.message.content)) && /parser/.test(JSON.stringify(row.message.content))))
      rememberCompatCatalogue(endpoint, await inspectCompatServer({ baseUrl: configured.baseUrl, dialect: dialect as never }))
      const resumed = await route(configured, [createUserMessage({ content: 'tools enabled again' })], `supported-again-${dialect}`)
      check(`${dialect} refreshed tool capability restores the complete roster`, configured.requests.length === before + 1 && resumed.some(row => row.type === 'assistant' && !row.isApiErrorMessage && row.message.stop_reason === 'end_turn') && configured.requests.at(-1)!.body.tools.some((tool: any) => tool.function.name === 'Computer'))
    } finally { await fixture.close() }
  }
} finally {
  await Promise.all(fixtures.map(fixture => fixture.close()))
  globalThis.fetch = realFetch
  rmSync(home, { recursive: true, force: true })
}
console.log(`prove-engine-shapes: ${checks} checks, ${failures} failed`)
process.exitCode = failures ? 1 : 0
