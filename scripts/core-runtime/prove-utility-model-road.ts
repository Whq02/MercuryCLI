#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'GOOGLE_API_KEY', 'MERCURY_HOME',
  'MERCURY_THINKING_BINDING', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_AGENT_NEEDS_YOU', 'MERCURY_PROMPT_CACHING', 'MERCURY_WIRE_DUMP',
]) {
  delete process.env[ambient]
}
const HOMES = [
  (process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'utility-model-road-home-'))),
  (process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'utility-model-road-daemon-'))),
]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_EFFORT_LEVEL = 'max'
process.env.MERCURY_AGENT_NEEDS_YOU_LLM = '1'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the utility model road prover exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

const { startOverflowFixture } = await import('../compact/overflowFixture.ts')
type Captured = Awaited<ReturnType<typeof startOverflowFixture>>['captured'][number]
const SOL_LIST = { models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 272_000, input_modalities: ['text', 'image'], supported_in_api: true }] }
const probeAnswer = (request: Captured, response: import('node:http').ServerResponse): boolean => {
  if (request.dialect !== 'anthropic' || request.body.stream === true) return false
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ id: 'msg_probe', type: 'message', role: 'assistant', model: request.body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 7, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }))
  return true
}
const fixture = await startOverflowFixture({ openaiModels: SOL_LIST, stream: probeAnswer })
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getEngineModel } = await import('../../src/utils/model/model.ts')
const { resolveEffortTruth } = await import('../../src/utils/effort.ts')
const { generateSessionTitle } = await import('../../src/utils/sessionTitle.ts')
const { generateSessionName } = await import('../../src/commands/rename/generateSessionName.ts')
const { generateToolUseSummary } = await import('../../src/services/toolUseSummary/toolUseSummaryGenerator.ts')
const { classifyAgentState } = await import('../../src/services/agentNeedsYou.ts')
const { applyPromptToMarkdown } = await import('../../src/tools/WebFetchTool/utils.ts')
const { runQuestionHook } = await import('../../src/utils/hooks/questionRunner.ts')
const { parseNaturalLanguageDateTime } = await import('../../src/utils/mcp/dateTimeParser.ts')
const { verifyApiKey } = await import('../../src/services/providers/anthropic/requestParams.ts')
const { countTokensViaHaikuFallback } = await import('../../src/services/tokenEstimation.ts')
const { getDefaultSonnetModel, normalizeModelStringForAPI } = await import('../../src/utils/model/model.ts')
const { __resetOpenaiCatalogueForTest } = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const { runCrewmateHook } = await import('../../src/utils/hooks/crewmateRunner.ts')
const { hookAnswerSchema } = await import('../../src/utils/hooks/contract.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { createServer } = await import('node:http')
const { modelThinkingAlwaysOn } = await import('../../src/utils/model/capabilities.ts')
const { z } = await import('zod/v4')

const ROADS = [
  { road: 'anthropic', model: 'claude-fable-5-1', floor: 'low', serves: 'the first-party ladder low … max' },
  { road: 'openai', model: 'gpt-5.6-sol', floor: 'low', serves: 'the live list serves low and high, default high' },
  { road: 'gemini', model: 'gemini-3-pro', floor: undefined, serves: 'no effort control' },
  { road: 'local', model: 'local/fixture-local', floor: undefined, serves: 'no effort control' },
  { road: 'zai', model: 'glm-5.2', floor: 'none', serves: 'GLM-5.2 serves none … max' },
] as const

const wireModelOf = (entry: Captured): string | undefined => {
  if (entry.dialect === 'gemini') return entry.path.match(/\/models\/([^:/]+):/)?.[1]
  return typeof entry.body.model === 'string' ? entry.body.model : undefined
}
const wireEffortOf = (entry: Captured): string | undefined => {
  const body = entry.body as { output_config?: { effort?: string }; reasoning?: { effort?: string }; reasoning_effort?: string; generationConfig?: { thinkingConfig?: { thinkingLevel?: string } } }
  if (entry.dialect === 'anthropic') return body.output_config?.effort
  if (entry.dialect === 'responses') return body.reasoning?.effort
  if (entry.dialect === 'gemini') return body.generationConfig?.thinkingConfig?.thinkingLevel
  return body.reasoning_effort
}

const appState = { toolPermissionContext: getEmptyToolPermissionContext() }
const toolUseContext = { agentId: 'utility-road-proof', getAppState: () => appState, setResponseLength: undefined } as never

const hookQuestion = (signal: AbortSignal, model?: string): Promise<unknown> =>
  runQuestionHook({ text: 'Is this fine?', name: 'fixture-hook', event: 'Stop', payloadJson: '{}', answerSchema: z.object({ note: z.string() }), timeoutMs: 30_000, signal, toolUseContext, ...(model !== undefined ? { model } : {}) })
const fallbackReading = (signal: AbortSignal): Promise<string> =>
  applyPromptToMarkdown('what does the page say?', 'PAGE', signal, true, false, { utility: async () => { throw new Error('the slot refused') }, utilityModelId: () => 'local/qwen3.5-2b' })

type Site = { name: string; reply: string; run: (signal: AbortSignal) => Promise<unknown>; landed: (result: unknown) => boolean }
const SITES: Site[] = [
  { name: 'session title', reply: '{"title":"Fix the parser"}', run: signal => generateSessionTitle('The parser drops quoted commas; fix it.', signal), landed: result => result === 'Fix the parser' },
  { name: 'tool-use summary', reply: 'Fixed parser commas', run: signal => generateToolUseSummary({ tools: [{ name: 'Edit', input: { file: 'parser.ts' }, output: 'ok' }], signal, isNonInteractiveSession: true }), landed: result => result === 'Fixed parser commas' },
  { name: 'needs-you classifier', reply: '{"state":"working","detail":"editing the parser"}', run: signal => classifyAgentState([], 'Editing the parser now and running the checks again', signal), landed: result => (result as { source?: string } | null)?.source === 'llm' },
  { name: 'WebFetch page reading', reply: 'The page says the parser accepts quoted commas.', run: signal => applyPromptToMarkdown('what does the page say?', 'PAGE', signal, true, false), landed: result => typeof result === 'string' && result.includes('[Model reading of the extracted page') && result.includes('accepts quoted commas') },
  { name: 'hook question', reply: '{"note":"fine"}', run: signal => hookQuestion(signal), landed: result => (result as { kind?: string }).kind === 'answered' },
  { name: 'WebFetch fallback leg (the slot refused; the seat is the second road at its own floor)', reply: 'The second road read the page.', run: fallbackReading, landed: result => typeof result === 'string' && result.includes('[Model reading of the extracted page') && result.includes('second road read') },
  { name: 'session rename', reply: '{"name":"fix-parser-commas"}', run: signal => generateSessionName([createUserMessage({ content: 'Fix the parser commas' })] as never, signal), landed: result => result === 'fix-parser-commas' },
  { name: 'date parser', reply: '2026-11-07', run: signal => parseNaturalLanguageDateTime('tomorrow', 'date', signal), landed: result => (result as { success?: boolean }).success === true },
]

const crewmateContext = (): unknown => {
  let state: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'max', toolPermissionContext: getEmptyToolPermissionContext() }
  return {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: 'claude-fable-5-1', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => state,
    setAppState: (next: (prev: never) => never): void => { state = next(state as never) as unknown as Record<string, unknown> },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

const meliousLane = await (async () => {
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'orion-2', _meta: { type: 'chat', reasoning_type: 'reasoning', reasoning_effort: 'medium', capabilities: { reasoning: true, function_calling: true }, context_length: 128_000, max_output_tokens: 8_192 } }] }))
        return
      }
      if (req.method === 'POST' && path.endsWith('/chat/completions')) {
        try { requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) } catch { requests.push({}) }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const usage = { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }
        res.end([
          `data: ${JSON.stringify({ id: 'chatcmpl-melious', object: 'chat.completion.chunk', created: 0, model: 'orion-2', choices: [{ index: 0, delta: { role: 'assistant', content: '{"note":"fine"}' }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: 'chatcmpl-melious', object: 'chat.completion.chunk', created: 0, model: 'orion-2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
          'data: [DONE]\n\n',
        ].join(''))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { requests, base: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
})()
process.env.MERCURY_MELIOUS_API_BASE = meliousLane.base
process.env.MELIOUS_API_KEY = 'fixture-melious-key'

section('the cold list: a GPT utility call and a GPT-named hook carry the floor before any list is cached (the list default is high, the dial max)')
{
  __resetOpenaiCatalogueForTest()
  process.env.MERCURY_MODEL = 'gpt-5.6-sol'
  const from = fixture.captured.length
  fixture.script(() => ({ text: '{"title":"Fix the parser"}' }))
  const title = await generateSessionTitle('The parser drops quoted commas; fix it.', new AbortController().signal)
  const first = fixture.captured.slice(from)
  check('cold list · session title: one request on the responses wire, the answer landed', first.length === 1 && first[0]?.dialect === 'responses' && title === 'Fix the parser', j({ title, requests: first.map(entry => `${entry.dialect} ${entry.path}`) }))
  check('cold list · session title: names the seat (gpt-5.6-sol) at low, the floor derived from the admitted list, not its default high', first[0] !== undefined && wireModelOf(first[0]) === 'gpt-5.6-sol' && wireEffortOf(first[0]) === 'low', j({ model: first[0] && wireModelOf(first[0]), effort: first[0] && wireEffortOf(first[0]) }))
  __resetOpenaiCatalogueForTest()
  process.env.MERCURY_MODEL = 'claude-fable-5-1'
  const hookFrom = fixture.captured.length
  fixture.script(() => ({ text: '{"note":"fine"}' }))
  const answered = await hookQuestion(new AbortController().signal, 'gpt-5.6-sol')
  const second = fixture.captured.slice(hookFrom)
  check('cold list · a hook naming gpt-5.6-sol on an Anthropic seat: one request on the responses wire, answered', second.length === 1 && second[0]?.dialect === 'responses' && (answered as { kind?: string }).kind === 'answered', j({ answered, requests: second.map(entry => `${entry.dialect} ${entry.path}`) }))
  check('cold list · the named model rides at low, the floor derived from the admitted list', second[0] !== undefined && wireModelOf(second[0]) === 'gpt-5.6-sol' && wireEffortOf(second[0]) === 'low', j({ model: second[0] && wireModelOf(second[0]), effort: second[0] && wireEffortOf(second[0]) }))
  __resetOpenaiCatalogueForTest()
  const crewFrom = fixture.captured.length
  fixture.script(() => ({ text: 'looked, nothing to say' }))
  const crewEnd = await runCrewmateHook({ text: 'Check the parser.', name: 'fixture-crewmate', event: 'turn.answer', payloadJson: '{}', answerSchema: hookAnswerSchema('turn.answer'), timeoutMs: 30_000, signal: new AbortController().signal, model: 'gpt-5.6-sol', toolUseContext: crewmateContext() as never })
  const crew = fixture.captured.slice(crewFrom)
  check('cold list · a crewmate hook naming gpt-5.6-sol on an Anthropic seat: its first request is on the responses wire', crew.length >= 1 && crew[0]?.dialect === 'responses', j({ end: crewEnd, requests: crew.map(entry => `${entry.dialect} ${entry.path}`) }))
  check('cold list · the crewmate hook rides the named model at low (the list read before the floor was noted as the child\'s own word)', crew[0] !== undefined && wireModelOf(crew[0]) === 'gpt-5.6-sol' && wireEffortOf(crew[0]) === 'low', j({ model: crew[0] && wireModelOf(crew[0]), effort: crew[0] && wireEffortOf(crew[0]) }))
}

section('the cold compat list: a question hook naming a list-only Melious model on an Anthropic seat rides its lowest served word, not the row\'s default')
{
  process.env.MERCURY_MODEL = 'claude-fable-5-1'
  const before = meliousLane.requests.length
  const answered = await hookQuestion(new AbortController().signal, 'melious/orion-2')
  const request = meliousLane.requests[before]
  check('cold compat · the hook answered through one request on the Melious chat wire', (answered as { kind?: string }).kind === 'answered' && meliousLane.requests.length === before + 1, j({ answered, requests: meliousLane.requests.length - before }))
  check('cold compat · the request names orion-2 at reasoning_effort none (the lowest word the admitted row serves; the row default is medium)', request?.model === 'orion-2' && request.reasoning_effort === 'none', j({ model: request?.model, reasoning_effort: request?.reasoning_effort }))
}

for (const { road, model, floor, serves } of ROADS) {
  section(`${road}: the main seat is ${model}; every utility call rides it at the lowest effort the road serves (${serves})`)
  process.env.MERCURY_MODEL = model
  check(`${road}: the engine model is ${model}`, getEngineModel() === model, getEngineModel())
  const referenceAt = fixture.captured.length
  fixture.script(() => ({ text: 'the turn' }))
  const control = new AbortController()
  const turn = routedCallModel({
    messages: [createUserMessage({ content: 'the turn' })] as never,
    systemPrompt: asSystemPrompt(['fixture system prompt']),
    thinkingConfig: { type: 'disabled' },
    tools: [] as never,
    signal: control.signal,
    options: { model, querySource: 'sdk', agents: [], isNonInteractiveSession: true, hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false, async getToolPermissionContext() { return getEmptyToolPermissionContext() } } as never,
  })
  for await (const _ of turn) {}
  const reference = fixture.captured[referenceAt]
  check(`${road}: the main seat's own turn reached its wire`, reference !== undefined && fixture.captured.length === referenceAt + 1, j(fixture.captured.slice(referenceAt).map(entry => entry.path)))
  if (reference === undefined) continue
  const seatModel = wireModelOf(reference)
  const seatEffort = wireEffortOf(reference)
  const lowest: string | undefined = floor
  console.log(`  the seat's wire: ${reference.dialect} ${reference.path} model=${seatModel} effort=${seatEffort ?? 'none'}; the lowest tier the road serves: ${lowest ?? 'none (no effort control)'}; the ladder words the road selects from: ${j(resolveEffortTruth(model, undefined).selectable)}`)
  check(`${road}: the seat's wire names its model`, typeof seatModel === 'string' && seatModel !== '', j(reference.body))
  if (lowest !== undefined) check(`${road}: the session dial (max) rides the turn above the lowest tier, so a utility call at the lowest tier is told apart`, seatEffort !== undefined && seatEffort !== lowest, j({ seatEffort, lowest }))
  for (const site of SITES) {
    const from = fixture.captured.length
    fixture.script(() => ({ text: site.reply }))
    let result: unknown
    let thrown: unknown
    try {
      result = await site.run(new AbortController().signal)
    } catch (error) {
      thrown = error
    }
    const requests = fixture.captured.slice(from)
    const request = requests[0]
    check(`${road} · ${site.name}: one request on the seat's wire`, requests.length === 1 && request?.dialect === reference.dialect, j({ thrown: thrown === undefined ? undefined : String(thrown), requests: requests.map(entry => `${entry.dialect} ${entry.path}`) }))
    check(`${road} · ${site.name}: the answer landed`, site.landed(result), j({ result, thrown: thrown === undefined ? undefined : String(thrown) }))
    if (request === undefined) continue
    check(`${road} · ${site.name}: requests the main seat's model (${seatModel})`, wireModelOf(request) === seatModel, j({ requested: wireModelOf(request), seat: seatModel }))
    check(`${road} · ${site.name}: at the lowest tier the road serves (${lowest ?? 'none'})`, wireEffortOf(request) === lowest, j({ requested: wireEffortOf(request) ?? null, lowest: lowest ?? null, seat: seatEffort ?? null }))
  }
}

section('the two Anthropic-wire probes: the seat\'s model at its floor on an Anthropic seat, the Sonnet family default at its floor elsewhere, the count endpoint off-road null')
{
  type ProbeBody = { model?: string; max_tokens?: number; thinking?: { type?: string }; output_config?: { effort?: string }; stream?: boolean }
  const probeOf = (from: number): ProbeBody | undefined => fixture.captured.slice(from).find(entry => entry.dialect === 'anthropic')?.body as ProbeBody | undefined
  const thinkingOff = (probe: ProbeBody | undefined): boolean => probe !== undefined && typeof probe.model === 'string' && (probe.thinking === undefined ? modelThinkingAlwaysOn(probe.model) : probe.thinking.type === 'disabled')
  process.env.MERCURY_MODEL = 'claude-fable-5-1'
  let from = fixture.captured.length
  const keyVerdict = await verifyApiKey('fixture-key-not-real', false).catch((error: unknown) => `threw ${String(error)}`)
  let probe = probeOf(from)
  check('anthropic seat · the key probe names the seat at max_tokens 1, thinking off (or absent on an always-on family), effort low', keyVerdict === true && probe?.model === 'claude-fable-5-1' && probe.max_tokens === 1 && thinkingOff(probe) && probe.output_config?.effort === 'low', j({ keyVerdict, probe }))
  from = fixture.captured.length
  const counted = await countTokensViaHaikuFallback([{ role: 'user', content: 'hello there' }] as never, [])
  probe = probeOf(from)
  check('anthropic seat · the count create probe names the seat at max_tokens 1, thinking off (or absent on an always-on family), effort low, and counts', counted === 7 && probe?.model === 'claude-fable-5-1' && probe.max_tokens === 1 && thinkingOff(probe) && probe.output_config?.effort === 'low', j({ counted, probe }))
  from = fixture.captured.length
  const history = [{ role: 'user', content: 'Say OK.' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'A short plan.', signature: 'fixture-signature' }, { type: 'text', text: 'OK' }] }, { role: 'user', content: 'Continue.' }]
  await countTokensViaHaikuFallback(history as never, [])
  probe = probeOf(from)
  check('anthropic seat · a history with thinking keeps the thinking requirement and the floor', probe?.model === 'claude-fable-5-1' && probe.thinking?.type !== 'disabled' && probe.output_config?.effort === 'low', j(probe))
  process.env.MERCURY_MODEL = 'gpt-5.6-sol'
  from = fixture.captured.length
  const sonnet = normalizeModelStringForAPI(getDefaultSonnetModel())
  const offRoadKey = await verifyApiKey('fixture-key-not-real', false).catch((error: unknown) => `threw ${String(error)}`)
  probe = probeOf(from)
  check(`openai seat · the key probe names the Sonnet family default (${sonnet}) at its floor`, offRoadKey === true && probe?.model === sonnet && probe.max_tokens === 1 && thinkingOff(probe) && probe.output_config?.effort === 'low', j({ offRoadKey, probe }))
  from = fixture.captured.length
  const offRoad = await countTokensViaHaikuFallback([{ role: 'user', content: 'hello there' }] as never, [])
  check('openai seat · the count create probe answers null off its road and sends nothing', offRoad === null && fixture.captured.length === from, j({ offRoad, sent: fixture.captured.length - from }))
}

section('the helper: the main seat\'s model at the lowest tier, read directly')
{
  const helper = await import('../../src/utils/model/utilityModel.ts').catch((error: unknown) => ({ error }))
  check('src/utils/model/utilityModel.ts exists and loads', !('error' in helper), 'error' in helper ? String(helper.error) : '')
  if (!('error' in helper)) {
    const exported = helper as Record<string, unknown>
    const names = Object.keys(exported).filter(name => typeof exported[name] === 'function')
    check('the helper exports a function', names.length > 0, j(Object.keys(exported)))
    console.log(`  exports: ${names.join(', ')}`)
  }
}

section('the census: the small-fast spellings are gone from src')
{
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(entry)) files.push(path)
    }
  }
  walk(join(ROOT, 'src'))
  const spell = (...parts: string[]): string => parts.join('')
  const RETIRED = new RegExp([spell('Small', 'Fast'), spell('SMALL', '_FAST'), spell('sessionLight', 'Model'), spell('PROMPT_CACHING_', 'HAIKU')].join('|'))
  const CATALOGUE_REMNANTS = new Set(['src/utils/model/model.ts', 'src/services/providers/typedModelIds.ts'])
  const retired = files.filter(file => RETIRED.test(readFileSync(file, 'utf8'))).map(file => relative(ROOT, file))
  check('no src file spells the small-fast road, the light tier, the Haiku caching switch or the shell prefix flag', retired.length === 0, j(retired))
  const haikuCalls = files.filter(file => /getDefaultHaikuModel\(\)/.test(readFileSync(file, 'utf8'))).map(file => relative(ROOT, file))
  check('getDefaultHaikuModel() is called only by the model catalogue (the haiku alias and the typed-id list)', haikuCalls.every(file => CATALOGUE_REMNANTS.has(file)), j(haikuCalls))
  const registry = readFileSync(join(ROOT, 'src/substrate/flagRegistry.ts'), 'utf8')
  const managed = readFileSync(join(ROOT, 'src/utils/managedEnvConstants.ts'), 'utf8')
  const idSpaces = readFileSync(join(ROOT, 'src/services/providers/idSpaces.ts'), 'utf8')
  check('the flag registry, the managed-env list and the id spaces no longer name the small-fast flag', ![registry, managed, idSpaces].some(text => text.includes(spell('MERCURY_', 'SMALL_', 'FAST_MODEL'))))
}

await fixture.close()
await meliousLane.close()
for (const home of HOMES) rmSync(home, { recursive: true, force: true })
console.log(`\nprove-utility-model-road: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
