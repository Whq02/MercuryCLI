import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const childAt = process.argv.indexOf('--child')
const model = 'claude-fable-5-1'
const agentId = 'boundary-schema-agent'
const spec = { schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, mode: 'strict' as const, source: 'dispatch' as const }
if (childAt !== -1) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.hostname, '127.0.0.1', 'all provider calls stay on loopback')
    return originalFetch(input, init)
  }, originalFetch)
  const mode = process.argv[childAt + 1]
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const bootstrap = await import('../../src/bootstrap/state.ts')
  bootstrap.setIsInteractive(false)
  bootstrap.setOriginalCwd(process.cwd())
  bootstrap.setCwdState(process.cwd())
  bootstrap.switchSession('00000000-0000-4000-8000-000000000044' as never)
  const { runAgent } = await import('../../src/tools/AgentTool/runAgent.ts')
  const { resumeAgentBackground } = await import('../../src/tools/AgentTool/resumeAgent.ts')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
  const { readAgentMetadata, flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
  await import('../../src/tasks.ts')
  type AppState = import('../../src/state/AppStateStore.ts').AppState
  let state = getDefaultAppState()
  const setState = (update: (previous: AppState) => AppState) => { state = update(state) }
  const context = {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: model, thinkingConfig: { type: 'adaptive' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => state, setAppState: setState, setAppStateForTasks: setState, messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
  } as never
  const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
  if (mode === 'launch') {
    const definition = { agentType: 'mercury-crew', whenToUse: 'schema boundary fixture', source: 'projectSettings', getSystemPrompt: () => 'Return the required structured answer.' } as never
    for await (const _row of runAgent({ agentDefinition: definition, promptMessages: [createUserMessage({ content: 'SCHEMA-LAUNCH' })], toolUseContext: context, canUseTool: allow, isAsync: true, canShowPermissionPrompts: false, querySource: 'agent:custom:schema-boundary' as never, availableTools: [] as never, model, override: { agentId }, description: 'schema continuation', cwd: process.cwd(), structuredOutputSpec: spec })) {}
  } else {
    await resumeAgentBackground({ agentId, prompt: 'SCHEMA-' + mode.toUpperCase(), toolUseContext: context, canUseTool: allow })
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && state.tasks[agentId]?.status === 'running') await new Promise(resolve => setTimeout(resolve, 25))
  }
  await flushSessionStorage()
  const task = state.tasks[agentId] as any
  console.log(JSON.stringify({ metadata: await readAgentMetadata(agentId as never), status: task?.status, error: task?.error, result: task?.result }))
  process.exit(0)
} else {
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const fixture = await startFixtureApi([
    { kind: 'text', text: 'first answer without payload', model, whenBody: 'SCHEMA-LAUNCH' },
    { kind: 'text', text: 'resumed answer without payload', model, whenBody: 'SCHEMA-RESUME' },
    { kind: 'tool_use', name: 'StructuredOutput', input: { answer: 'validated payload' }, id: 'schema-valid', model, whenBody: 'SCHEMA-VALID' },
    { kind: 'text', text: 'valid done', model, whenBody: 'SCHEMA-VALID' },
  ])
  mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
  const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'schema-'))
  let checks = 0
  let failures = 0
  const check = (name: string, truth: unknown, detail?: unknown) => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name + (!truth && detail ? ' — ' + JSON.stringify(detail) : '')) }
  const child = async (mode: string) => {
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', mode], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: 'proof-key-boundary-not-a-real-key' },
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
    const launched = await child('launch')
    check('the exact schema, strict requirement and source are durable launch facts', isDeepStrictEqual(launched.metadata?.structuredOutputSpec, spec))
    const resumed = await child('resume')
    check('a prose-only continuation fails the original strict contract', resumed.status === 'failed', resumed)
    check('the resumed metadata still carries the strict contract', isDeepStrictEqual(resumed.metadata?.structuredOutputSpec, spec))
    const first = fixture.messageRequests()[0]?.body as any
    const second = fixture.messageRequests()[1]?.body as any
    check('the same structured-output schema remains available in the fresh process', isDeepStrictEqual(first?.tools.find((row: any) => row.name === 'StructuredOutput')?.input_schema, second?.tools.find((row: any) => row.name === 'StructuredOutput')?.input_schema))
    const valid = await child('valid')
    check('the same strict continuation accepts a newly validated payload', valid.status === 'completed', valid)
    check('the conforming StructuredOutput call was actually executed', fixture.messageRequests().some(row => JSON.stringify(row.body).includes('Structured output provided successfully')))
    console.log('BOUNDARY SCHEMA ' + (failures ? 'RED' : 'GREEN') + ' — ' + (checks - failures) + '/' + checks + '; real launch/resume processes and validated tool execution')
  } finally { await fixture.close(); rmSync(home, { recursive: true, force: true }) }
  process.exitCode = failures ? 1 : 0
}
