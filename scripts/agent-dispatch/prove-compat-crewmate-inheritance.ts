import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { validateEngineRequest } from '../provider-compat/fixtures/engineRules.mjs'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.equal(url.hostname, '127.0.0.1', 'all provider requests stay on loopback')
  if (url.pathname === '/v1/chat/completions') {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : await (input as Request).clone().text())
    assert.equal(validateEngineRequest('vllm', body), undefined)
  }
  return originalFetch(input, init)
}, originalFetch)
writeFileSync(join(f.home, 'settings.json'), JSON.stringify({ compatProvider: {
  first: { baseUrl: f.baseUrl, dialect: 'vllm', models: ['Wrong/First'] },
  parent: { baseUrl: f.baseUrl, dialect: 'vllm', models: [f.model] },
} }))
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
resetSettingsCache()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
bootstrap.setOriginalCwd(f.home)
bootstrap.setCwdState(f.home)
const model = `compat/parent/${f.model}`
bootstrap.setEngineModelOverride('compat/first/Wrong/First')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { turnDoor: startTurn } = await import('../../src/engine/turnDoor.ts')
const { runCrewmate } = await import('../../src/tools/crewmate/runCrewmate.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { getCrewmateModel } = await import('../../src/models/catalogue/crewmateModel.ts')
const { resolveEngineDispatch } = await import('../../src/crew/crewmates/engineDispatch.ts')
const { flushSessionStorage, readCrewmateMetadata } = await import('../../src/sessions/transcripts/sessionStorage.ts')
await import('../../src/engine/tasks/tasks.ts')
const previousCwd = process.cwd()
process.chdir(f.home)
let state: any = getDefaultAppState()
const setState = (update: any) => { state = update(state) }
const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: setState, setAppStateForTasks: setState, startTurn, readFileState: createFileStateCacheWithSizeLimit(100), messages: [], options: { engineModel: model, thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, tools: [], commands: [], mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } }, setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {} }
const definition = { agentType: 'mercury-crew', whenToUse: 'compat inheritance fixture', source: 'projectSettings', getSystemPrompt: () => 'Answer without tools.' } as never
const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
const launched: string[] = []
const crewmate = async (prompt: string, opts: { model?: string; effort: string }): Promise<string> => {
  const agentId = `compat-inherit-${launched.length}`
  launched.push(agentId)
  let answer = ''
  for await (const row of runCrewmate({ agentDefinition: definition, promptMessages: [createUserMessage({ content: prompt })], toolUseContext: context, canUseTool: allow, isAsync: true, canShowPermissionPrompts: false, querySource: 'agent:custom:compat-inherit' as never, availableTools: [] as never, override: { agentId }, description: prompt, cwd: process.cwd(), model: opts.model, effortOverride: opts.effort } as never) as AsyncIterable<any>) {
    if (row?.type !== 'assistant') continue
    for (const block of row.message?.content ?? []) if (block?.type === 'text') answer = block.text
  }
  return answer
}
let checks = 0
let failures = 0
const inheritanceHint = 'change how a crewmate inherits the parent model and effort: getAgentModel in src/models/catalogue/crewmateModel.ts, resolveEngineDispatch in src/crew/crewmates/engineDispatch.ts, and the model, effort and thinking handling in runAgent in src/tools/crewmate/runCrewmate.ts'
const check = (label: string, truth: unknown, detail?: unknown) => { checks++; if (!truth) failures++; console.log(`${truth ? 'PASS' : 'FAIL'} ${label}${!truth ? ' — ' + (detail !== undefined ? JSON.stringify(detail) + '; ' : '') + inheritanceHint : ''}`) }
try {
  const resolved = await resolveEngineDispatch(getCrewmateModel(undefined, model, 'compat'))
  check('the Crewmate resolver keeps the context parent endpoint rather than global state', resolved?.model === model, resolved)
  const one = await crewmate('INHERIT-ONE: answer without tools', { effort: 'max' })
  const two = await crewmate('INHERIT-TWO: answer without tools', { model: 'compat', effort: 'high' })
  const three = await crewmate('EXPLICIT-OTHER: answer without tools', { model: 'compat/first/Wrong/First', effort: 'max' })
  await flushSessionStorage()
  check('the three crewmates all finish their requests', [one, two, three].every(answer => answer === 'LLMHOST-READY'), [one, two, three])
  check('omitted model follows the parent', f.captures[0]?.body.model === f.model, f.captures[0]?.body.model)
  check('the compat family word follows the same parent, not the first configured endpoint', f.captures[1]?.body.model === f.model, f.captures[1]?.body.model)
  check('an exact other endpoint remains an explicit override', f.captures[2]?.body.model === 'Wrong/First')
  check('each crewmate keeps its own effort', f.captures.map(row => row.body.reasoning_effort).join(',') === 'max,high,max', f.captures.map(row => row.body.reasoning_effort))
  const metadata = await Promise.all(launched.map(agentId => readCrewmateMetadata(agentId as never)))
  check('each crewmate\'s record carries the same exact model identity as its request', metadata[0]?.model === model && metadata[1]?.model === model && metadata[2]?.model === 'compat/first/Wrong/First', metadata.map(row => row?.model))
  check('all three crewmates retain enabled thinking and its original budget', metadata.length === 3 && metadata.every(row => row?.thinkingConfig?.type === 'enabled' && row.thinkingConfig.budgetTokens === 4096), metadata.map(row => row?.thinkingConfig))
} finally {
  context.abortController.abort()
  globalThis.fetch = originalFetch
  process.chdir(previousCwd)
  f.close()
}
console.log(`COMPAT CREWMATE INHERITANCE ${failures ? 'RED' : 'GREEN'} — ${checks - failures}/${checks}; the real crewmate runner, three model requests and the engine rule fixture`)
process.exit(failures ? 1 : 0)
