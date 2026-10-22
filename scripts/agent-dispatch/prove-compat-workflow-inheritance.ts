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
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
resetSettingsCache()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
bootstrap.setOriginalCwd(f.home)
bootstrap.setCwdState(f.home)
const model = `compat/parent/${f.model}`
bootstrap.setEngineModelOverride('compat/first/Wrong/First')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.ts')
const { getAgentModel } = await import('../../src/utils/model/agent.ts')
const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
const { flushSessionStorage, readAgentMetadata } = await import('../../src/utils/sessionStorage.ts')
await import('../../src/tasks.ts')
const previousCwd = process.cwd()
process.chdir(f.home)
let state: any = getDefaultAppState()
const setState = (update: any) => { state = update(state) }
const progress: any[] = []
const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: setState, setAppStateForTasks: setState, readFileState: createFileStateCacheWithSizeLimit(100), messages: [], options: { engineModel: model, thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, tools: [], commands: [], mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } } }
const hooks = makeWorkflowHooks({ toolUseContext: context, canUseTool: async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }), emitProgress: event => progress.push(event), onAgentController: () => {}, seedPhaseTitles: [] } as never)
let checks = 0
let failures = 0
const check = (label: string, truth: unknown, detail?: unknown) => { checks++; if (!truth) failures++; console.log(`${truth ? 'PASS' : 'FAIL'} ${label}${!truth && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`) }
try {
  const crewmate = await resolveEngineDispatch(getAgentModel(undefined, model, 'compat'))
  check('the Crewmate resolver keeps the context parent endpoint rather than global state', crewmate?.model === model, crewmate)
  const one = await hooks.agent('INHERIT-ONE: answer without tools', { effort: 'max' })
  const two = await hooks.agent('INHERIT-TWO: answer without tools', { model: 'compat', effort: 'high' })
  const three = await hooks.agent('EXPLICIT-OTHER: answer without tools', { model: 'compat/first/Wrong/First', effort: 'max' })
  await flushSessionStorage()
  check('the three workflow crewmates all finish their requests', [one, two, three].every(answer => answer === 'LLMHOST-READY'), [one, two, three])
  check('omitted model follows the workflow parent', f.captures[0]?.body.model === f.model, f.captures[0]?.body.model)
  check('the compat family word follows the same parent, not the first configured endpoint', f.captures[1]?.body.model === f.model, f.captures[1]?.body.model)
  check('an exact other endpoint remains an explicit override', f.captures[2]?.body.model === 'Wrong/First')
  check('each workflow crewmate keeps its own effort', f.captures.map(row => row.body.reasoning_effort).join(',') === 'max,high,max', f.captures.map(row => row.body.reasoning_effort))
  const done = progress.map(row => row.data).filter(row => row?.type === 'workflow_agent' && row.state === 'done')
  check('the workflow records the same exact model identity as the requests', done[0]?.model === model && done[1]?.model === model && done[2]?.model === 'compat/first/Wrong/First', done.map(row => row.model))
  const metadata = await Promise.all(done.map(row => readAgentMetadata(row.agentId)))
  check('all workflow children retain enabled thinking and its original budget', metadata.length === 3 && metadata.every(row => row?.thinkingConfig?.type === 'enabled' && row.thinkingConfig.budgetTokens === 4096), metadata.map(row => row?.thinkingConfig))
} finally {
  context.abortController.abort()
  globalThis.fetch = originalFetch
  process.chdir(previousCwd)
  f.close()
}
console.log(`COMPAT WORKFLOW INHERITANCE ${failures ? 'RED' : 'GREEN'} — ${checks - failures}/${checks}; real workflow agent hooks, three model requests and the engine rule fixture`)
process.exit(failures ? 1 : 0)
