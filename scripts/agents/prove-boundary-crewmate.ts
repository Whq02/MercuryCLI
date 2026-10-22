import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname), 'all requests stay on loopback')
  return originalFetch(input, init)
}, originalFetch)
const childAt = process.argv.indexOf('--child')
const model = 'compat/boundary/Fixture/Reasoner'
const agentId = 'boundary-effort-agent'
if (childAt !== -1) {
  const mode = process.argv[childAt + 1]
  const config = await import('../../src/utils/config.ts')
  config.enableConfigs()
  config.saveGlobalConfig(current => ({ ...current, agents: { ...current.agents, defaultEffort: mode === 'launch' ? 'max' : 'low' } }))
  const bootstrap = await import('../../src/bootstrap/state.ts')
  bootstrap.setIsInteractive(false)
  bootstrap.setOriginalCwd(process.cwd())
  bootstrap.setCwdState(process.cwd())
  bootstrap.switchSession('00000000-0000-4000-8000-000000000042' as never)
  const { runAgent } = await import('../../src/tools/AgentTool/runAgent.ts')
  const { resumeAgentBackground } = await import('../../src/tools/AgentTool/resumeAgent.ts')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
  const { readAgentMetadata, flushSessionStorage, getAgentTranscript } = await import('../../src/utils/sessionStorage.ts')
  await import('../../src/tasks.ts')
  type AppState = import('../../src/state/AppStateStore.ts').AppState
  let state: AppState = { ...getDefaultAppState(), effortValue: 'low' } as AppState
  const setState = (update: (previous: AppState) => AppState) => { state = update(state) }
  const context = {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: model, thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => state, setAppState: setState, setAppStateForTasks: setState, messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
  } as never
  const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
  if (mode === 'launch') {
    const definition = { agentType: 'mercury-crew', whenToUse: 'boundary fixture', source: 'projectSettings', getSystemPrompt: () => 'Answer with one line. Do not call tools.' } as never
    for await (const _row of runAgent({ agentDefinition: definition, promptMessages: [createUserMessage({ content: 'First boundary turn' })], toolUseContext: context, canUseTool: allow, isAsync: true, canShowPermissionPrompts: false, querySource: 'agent:custom:boundary' as never, availableTools: [] as never, model, override: { agentId }, description: 'boundary continuation', cwd: process.cwd() })) {}
  } else {
    await resumeAgentBackground({ agentId, prompt: 'Second boundary turn', toolUseContext: context, canUseTool: allow, ...(mode === 'override' ? { effort: 'medium' as const } : {}) })
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && state.tasks[agentId]?.status === 'running') await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(state.tasks[agentId]?.status, 'completed', JSON.stringify(state.tasks[agentId]))
  }
  await flushSessionStorage()
  let metadata = await readAgentMetadata(agentId as never)
  for (let attempt = 0; attempt < 100 && !metadata?.effort; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    metadata = await readAgentMetadata(agentId as never)
  }
  const transcript = await getAgentTranscript(agentId as never)
  console.log(JSON.stringify({ metadata, hasFirst: JSON.stringify(transcript?.messages).includes('First boundary turn'), hasSecond: JSON.stringify(transcript?.messages).includes('Second boundary turn') }))
  process.exit(0)
} else {
  const { llmhostFixture } = await import('../providers/lib/llmhostFixture.ts')
  const f = await llmhostFixture()
  f.state.dialect = 'vllm'
  writeFileSync(join(f.home, 'settings.json'), JSON.stringify({ compatProvider: { boundary: { baseUrl: f.baseUrl, dialect: 'vllm', models: [f.model] } } }))
  let checks = 0
  let failures = 0
  const check = (name: string, truth: unknown, detail?: unknown) => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name + (!truth && detail ? ' — ' + JSON.stringify(detail) : '')) }
  const child = async (mode: string) => {
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', mode], {
      cwd: f.home,
      env: { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.home, MERCURY_CONFIG_DIR: f.home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', MERCURY_LOCAL_PROBE_TARGETS: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let errors = ''
    worker.stdout.on('data', chunk => { output += chunk })
    worker.stderr.on('data', chunk => { errors += chunk })
    const timer = setTimeout(() => worker.kill('SIGTERM'), 60000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => { worker.once('error', reject); worker.once('close', resolve) })
      assert.equal(code, 0, output + errors)
      return JSON.parse(output.trim().split('\n').at(-1)!)
    } finally { clearTimeout(timer) }
  }
  try {
    const launch = await child('launch')
    check('the original process dispatches the configured max effort without a per-call override', f.captures[0]?.body.reasoning_effort === 'max' && launch.metadata?.effort === 'max' && launch.metadata.effortOverride === undefined, launch)
    const resumed = await child('resume')
    check('a fresh process resumes the same endpoint and wire model', f.captures.length === 2 && f.captures[1]?.body.model === f.model)
    check('the resumed request retains its recorded max effort despite a new low default', f.captures[1]?.body.reasoning_effort === 'max', f.captures[1]?.body.reasoning_effort)
    check('the resumed metadata records max instead of silently replacing it', resumed.metadata?.effort === 'max', resumed.metadata)
    check('both turns and the earlier reasoning text survive the process boundary', resumed.hasFirst && resumed.hasSecond && f.captures[1]?.body.messages.some((row: any) => row.role === 'assistant' && row.reasoning_content === 'reasoning-0'))
    const overridden = await child('override')
    check('an explicit resume effort still overrides the retained tier', f.captures[2]?.body.reasoning_effort === 'medium' && overridden.metadata?.effort === 'medium')
    console.log('BOUNDARY CREWMATE ' + (failures ? 'RED' : 'GREEN') + ' — ' + (checks - failures) + '/' + checks + '; actual launch and resumes in separate processes, loopback model only')
  } finally { f.close() }
  process.exitCode = failures ? 1 : 0
}
