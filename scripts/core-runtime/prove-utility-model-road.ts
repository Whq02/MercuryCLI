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
const fixture = await startOverflowFixture()
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
const { z } = await import('zod/v4')

const ROADS = [
  { road: 'anthropic', model: 'claude-fable-5-1' },
  { road: 'openai', model: 'gpt-5.6-sol' },
  { road: 'gemini', model: 'gemini-3-pro' },
  { road: 'local', model: 'local/fixture-local' },
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
const lowestServed = (model: string): string | undefined => resolveEffortTruth(model, undefined).selectable[0]

const appState = { toolPermissionContext: getEmptyToolPermissionContext() }
const toolUseContext = { agentId: 'utility-road-proof', getAppState: () => appState, setResponseLength: undefined } as never

type Site = { name: string; reply: string; run: (signal: AbortSignal) => Promise<unknown>; landed: (result: unknown) => boolean }
const SITES: Site[] = [
  { name: 'session title', reply: '{"title":"Fix the parser"}', run: signal => generateSessionTitle('The parser drops quoted commas; fix it.', signal), landed: result => result === 'Fix the parser' },
  { name: 'tool-use summary', reply: 'Fixed parser commas', run: signal => generateToolUseSummary({ tools: [{ name: 'Edit', input: { file: 'parser.ts' }, output: 'ok' }], signal, isNonInteractiveSession: true }), landed: result => result === 'Fixed parser commas' },
  { name: 'needs-you classifier', reply: '{"state":"working","detail":"editing the parser"}', run: signal => classifyAgentState([], 'Editing the parser now and running the checks again', signal), landed: result => (result as { source?: string } | null)?.source === 'llm' },
  { name: 'WebFetch page reading', reply: 'The page says the parser accepts quoted commas.', run: signal => applyPromptToMarkdown('what does the page say?', 'PAGE', signal, true, false), landed: result => typeof result === 'string' && result.includes('[Model reading of the extracted page') && result.includes('accepts quoted commas') },
  { name: 'hook question', reply: '{"note":"fine"}', run: signal => runQuestionHook({ text: 'Is this fine?', name: 'fixture-hook', event: 'Stop', payloadJson: '{}', answerSchema: z.object({ note: z.string() }), timeoutMs: 30_000, signal, toolUseContext }), landed: result => (result as { kind?: string }).kind === 'answered' },
  { name: 'session rename', reply: '{"name":"fix-parser-commas"}', run: signal => generateSessionName([createUserMessage({ content: 'Fix the parser commas' })] as never, signal), landed: result => result === 'fix-parser-commas' },
  { name: 'date parser', reply: '2026-11-07', run: signal => parseNaturalLanguageDateTime('tomorrow', 'date', signal), landed: result => (result as { success?: boolean }).success === true },
]

for (const { road, model } of ROADS) {
  section(`${road}: the main seat is ${model}; every utility call rides it at the lowest effort the road serves`)
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
  const lowest = lowestServed(model)
  console.log(`  the seat's wire: ${reference.dialect} ${reference.path} model=${seatModel} effort=${seatEffort ?? 'none'}; the lowest tier the road serves: ${lowest ?? 'none (no effort control)'}`)
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
for (const home of HOMES) rmSync(home, { recursive: true, force: true })
console.log(`\nprove-utility-model-road: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
