import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateEngineRequest } from '../provider-compat/fixtures/engineRules.mjs'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const model = 'compat/parent/Fixture/Reasoner'
const thinking = { type: 'enabled' as const, budgetTokens: 4096 }
const spec = { schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, mode: 'strict' as const, source: 'dispatch' as const }
const childAt = process.argv.indexOf('--child')
if (childAt !== -1) {
  const mode = process.argv[childAt + 1]
  const dialect = process.argv[childAt + 2]!
  const agentId = `compat-contract-${dialect}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.hostname, '127.0.0.1', 'all provider traffic stays on loopback')
    if (url.pathname === '/v1/chat/completions' && dialect !== 'lmstudio') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : await (input as Request).clone().text())
      assert.equal(validateEngineRequest(dialect, body), undefined)
    }
    return originalFetch(input, init)
  }, originalFetch)
  const config = await import('../../src/utils/config.ts')
  config.enableConfigs()
  config.saveGlobalConfig(current => ({ ...current, agents: { ...current.agents, defaultEffort: mode === 'launch' ? 'max' : 'low' } }))
  const bootstrap = await import('../../src/bootstrap/state.ts')
  bootstrap.setIsInteractive(false)
  bootstrap.setOriginalCwd(process.cwd())
  bootstrap.setCwdState(process.cwd())
  bootstrap.switchSession('00000000-0000-4000-8000-000000000047' as never)
  const { runAgent } = await import('../../src/tools/AgentTool/runAgent.ts')
  const { resumeAgentBackground } = await import('../../src/tools/AgentTool/resumeAgent.ts')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
  const { readAgentMetadata, flushSessionStorage, getAgentTranscript } = await import('../../src/utils/sessionStorage.ts')
  await import('../../src/tasks.ts')
  let state: any = { ...getDefaultAppState(), effortValue: 'low' }
  const setState = (update: any) => { state = update(state) }
  const context: any = { abortController: new AbortController(), options: { commands: [], tools: [], engineModel: mode === 'launch' ? model : 'compat/other/Wrong/Other', thinkingConfig: mode === 'launch' ? thinking : { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } }, getAppState: () => state, setAppState: setState, setAppStateForTasks: setState, messages: [], readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {} }
  const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
  if (mode === 'launch') {
    const definition = { agentType: 'mercury-crew', whenToUse: 'compat continuation fixture', source: 'projectSettings', getSystemPrompt: () => 'Submit the final answer through StructuredOutput.' } as never
    for await (const _row of runAgent({ agentDefinition: definition, promptMessages: [createUserMessage({ content: 'CONTRACT-FIRST' })], toolUseContext: context, canUseTool: allow, isAsync: true, canShowPermissionPrompts: false, querySource: 'agent:custom:compat-contract' as never, availableTools: [] as never, override: { agentId }, description: 'compat contract continuation', cwd: process.cwd(), structuredOutputSpec: spec })) {}
  } else {
    await resumeAgentBackground({ agentId, prompt: 'CONTRACT-SECOND', toolUseContext: context, canUseTool: allow })
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && state.tasks[agentId]?.status === 'running') await new Promise(resolve => setTimeout(resolve, 25))
  }
  await flushSessionStorage()
  const metadata = await readAgentMetadata(agentId as never)
  const transcript = await getAgentTranscript(agentId as never)
  console.log(JSON.stringify({ metadata, status: state.tasks[agentId]?.status, error: state.tasks[agentId]?.error, hasFirst: JSON.stringify(transcript?.messages).includes('CONTRACT-FIRST'), hasSecond: JSON.stringify(transcript?.messages).includes('CONTRACT-SECOND') }))
  process.exit(0)
} else {
  const { llmhostFixture } = await import('../providers/lib/llmhostFixture.ts')
  const f = await llmhostFixture()
  let checks = 0
  let failures = 0
  let dialect = ''
  const check = (label: string, truth: unknown, detail?: unknown) => { checks++; if (!truth) failures++; console.log(`${truth ? 'PASS' : 'FAIL'} ${dialect}: ${label}${!truth && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`) }
  const child = async (mode: string) => {
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', mode, dialect], { cwd: f.home, env: { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.home, MERCURY_CONFIG_DIR: f.home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', MERCURY_LOCAL_PROBE_TARGETS: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    for (dialect of ['llamacpp', 'vllm', 'sglang', 'ollama', 'lmstudio']) {
      f.state.dialect = dialect
      f.state.thinkingValues = ['low', 'medium', 'high', 'max']
      writeFileSync(join(f.home, 'settings.json'), JSON.stringify({ compatProvider: { parent: { baseUrl: f.baseUrl, dialect, models: [f.model] }, other: { baseUrl: f.baseUrl, dialect, models: ['Wrong/Other'] } } }))
      const before = f.captures.length
      const launch = await child('launch')
      const resumed = await child('resume')
      const bodies = f.captures.slice(before).map(row => row.body)
      check('launch and fresh-process resume use the inherited endpoint and exact model', bodies.length === 2 && bodies.every(body => body.model === f.model) && launch.metadata?.model === model && resumed.metadata?.model === model)
      check('enabled thinking and the exact budget survive a parent that now disables it', JSON.stringify(launch.metadata?.thinkingConfig) === JSON.stringify(thinking) && JSON.stringify(resumed.metadata?.thinkingConfig) === JSON.stringify(thinking))
      check('the original resolved max effort survives the new low default', launch.metadata?.effort === 'max' && resumed.metadata?.effort === 'max')
      check('every served effort remains max, never none or low', dialect === 'lmstudio' || bodies.every(body => (body.reasoning_effort ?? body.chat_template_kwargs?.reasoning_effort) === 'max'), bodies.map(body => body.reasoning_effort ?? body.chat_template_kwargs?.reasoning_effort))
      check('the exact strict schema and source survive the process boundary', JSON.stringify(launch.metadata?.structuredOutputSpec) === JSON.stringify(spec) && JSON.stringify(resumed.metadata?.structuredOutputSpec) === JSON.stringify(spec))
      check('the strict continuation rejects the fixture prose instead of reporting completion', resumed.status === 'failed' && resumed.error?.includes('no structured yield'), { status: resumed.status, error: resumed.error })
      check('the same schema-bound StructuredOutput tool remains on the wire', bodies.every(body => JSON.stringify(body.tools.find((tool: any) => tool.function?.name === 'StructuredOutput')?.function?.parameters) === JSON.stringify(spec.schema)))
      check('both user turns survive and reasoning replays only on the dialects that carry it', resumed.hasFirst && resumed.hasSecond && (!['llamacpp', 'vllm', 'sglang'].includes(dialect) || bodies[1]?.messages.some((row: any) => row.role === 'assistant' && row.reasoning_content === 'reasoning-0')))
    }
  } finally { f.close() }
  console.log(`COMPAT CREWMATE CONTINUATION ${failures ? 'RED' : 'GREEN'} — ${checks - failures}/${checks}; ten real worker processes, five fixture dialects and engine-rule validation`)
  process.exit(failures ? 1 : 0)
}
