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
const thinking = { type: 'enabled' as const, budgetTokens: 4096 }
const agentId = 'boundary-thinking-agent'
if (childAt !== -1) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.hostname, '127.0.0.1', 'all provider calls stay on loopback')
    return originalFetch(input, init)
  }, originalFetch)
  const mode = process.argv[childAt + 1]
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  const bootstrap = await import('../../src/boot/process-state/processState.ts')
  bootstrap.setIsInteractive(false)
  bootstrap.setOriginalCwd(process.cwd())
  bootstrap.setCwdState(process.cwd())
  bootstrap.switchSession('00000000-0000-4000-8000-000000000043' as never)
  const { runAgent } = await import('../../src/tools/crewmate/runCrewmate.ts')
  const { resumeAgentBackground } = await import('../../src/tools/crewmate/resumeCrewmate.ts')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
  const { query: startTurn } = await import('../../src/engine/turnDoor.ts')
  const { readAgentMetadata, flushSessionStorage } = await import('../../src/sessions/transcripts/sessionStorage.ts')
  await import('../../src/engine/tasks/tasks.ts')
  type AppState = import('../../src/screen/app-state/AppStateStore.ts').AppState
  let state = getDefaultAppState()
  const setState = (update: (previous: AppState) => AppState) => { state = update(state) }
  const context = {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: model, ...(mode === 'default' ? {} : { thinkingConfig: mode === 'launch' ? thinking : { type: 'disabled' } }), mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => state, setAppState: setState, setAppStateForTasks: setState, messages: [],
    startTurn,
    readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
  } as never
  const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
  if (mode === 'resume') {
    await resumeAgentBackground({ agentId, prompt: 'THINKING-SECOND', toolUseContext: context, canUseTool: allow })
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && state.tasks[agentId]?.status === 'running') await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(state.tasks[agentId]?.status, 'completed', JSON.stringify(state.tasks[agentId]))
  } else {
    const definition = { agentType: 'mercury-crew', whenToUse: 'thinking boundary fixture', source: 'projectSettings', getSystemPrompt: () => 'Answer with one line. Do not call tools.' } as never
    for await (const _row of runAgent({ agentDefinition: definition, promptMessages: [createUserMessage({ content: 'THINKING-' + mode.toUpperCase() })], toolUseContext: context, canUseTool: allow, isAsync: true, canShowPermissionPrompts: false, querySource: 'agent:custom:thinking-boundary' as never, availableTools: [] as never, model, override: { agentId: mode === 'launch' ? agentId : agentId + '-' + mode }, description: 'thinking continuation', cwd: process.cwd() })) {}
  }
  await flushSessionStorage()
  console.log(JSON.stringify({ metadata: await readAgentMetadata((mode === 'launch' || mode === 'resume' ? agentId : agentId + '-' + mode) as never) }))
  process.exit(0)
} else {
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const fixture = await startFixtureApi([
    { kind: 'text', text: 'first answer', thinking: 'kept signed thought', signature: 'fixture-signed-thinking', model, whenBody: 'THINKING-LAUNCH' },
    { kind: 'text', text: 'second answer', model, whenBody: 'THINKING-SECOND' },
    { kind: 'text', text: 'default answer', model, whenBody: 'THINKING-DEFAULT' },
    { kind: 'text', text: 'disabled answer', model, whenBody: 'THINKING-DISABLED' },
  ])
  mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
  const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'thinking-'))
  let checks = 0
  let failures = 0
  const check = (name: string, truth: unknown, detail?: unknown, hint?: string) => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name + (!truth && detail ? ' — ' + JSON.stringify(detail) : '') + (!truth && hint ? ' — to fix: ' + hint : '')) }
  const child = async (mode: string) => {
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', mode], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: 'proof-key-boundary-not-a-real-key', ...(process.env.BUN_OPTIONS ? { BUN_OPTIONS: process.env.BUN_OPTIONS } : {}) },
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
  const bodyAt = (index: number) => fixture.messageRequests()[index]?.body as any
  try {
    const launched = await child('launch')
    check('an ordinary crewmate keeps enabled thinking without requiring an effort override', bodyAt(0)?.thinking?.type === 'adaptive' || bodyAt(0)?.thinking?.type === 'enabled', bodyAt(0)?.thinking, 'the launched crewmate request must carry a thinking block of type adaptive or enabled; look at how runAgent in src/tools/crewmate/runCrewmate.ts resolves thinkingConfig from the parent options')
    check('launch persists the exact enabled thinking configuration and token budget', isDeepStrictEqual(launched.metadata?.thinkingConfig, thinking), launched.metadata, 'the agent metadata written at launch must record the parent thinkingConfig unchanged (field thinkingConfig in src/sessions/transcripts/paths.ts)')
    const resumed = await child('resume')
    check('a fresh resumed process retains thinking despite its parent now disabling it', bodyAt(1)?.thinking?.type === bodyAt(0)?.thinking?.type && bodyAt(1)?.thinking?.type !== undefined && bodyAt(1)?.thinking?.type !== 'disabled', bodyAt(1)?.thinking, 'resumeAgentBackground in src/tools/crewmate/resumeCrewmate.ts must pass the stored meta.thinkingConfig as thinkingConfigOverride, not the resuming parent option')
    check('the continuation retains the original thinking budget in its metadata', isDeepStrictEqual(resumed.metadata?.thinkingConfig, thinking), resumed.metadata, 'resumeAgentBackground in src/tools/crewmate/resumeCrewmate.ts must keep meta.thinkingConfig in the metadata it writes back')
    check('the earlier signed thinking block reaches the continuation unchanged', bodyAt(1)?.messages.some((row: any) => Array.isArray(row.content) && row.content.some((block: any) => block.type === 'thinking' && block.thinking === 'kept signed thought' && block.signature === 'fixture-signed-thinking')), bodyAt(1)?.messages, 'the resumed request must replay the first turn thinking block with its text and signature unchanged; the resume path is resumeAgentBackground in src/tools/crewmate/resumeCrewmate.ts')
    await child('default')
    check('an absent parent option follows the established thinking-on default', bodyAt(2)?.thinking?.type === 'adaptive' || bodyAt(2)?.thinking?.type === 'enabled', bodyAt(2)?.thinking, 'when the parent options carry no thinkingConfig, the crewmate request must still send thinking adaptive or enabled')
    await child('disabled')
    check('an explicitly disabled new launch remains disabled', bodyAt(3)?.thinking === undefined || bodyAt(3)?.thinking?.type === 'disabled', bodyAt(3)?.thinking, 'a launch whose parent thinkingConfig is disabled must send no thinking block or type disabled')
    check('all four turns settle through the selected Messages route', fixture.messageRequests().length === 4 && fixture.messageRequests().every(row => (row.body as any).model === model), fixture.messageRequests().map(row => (row.body as any).model), 'expected exactly four Messages requests, all on the fixture model; a missing or extra request means a child run did not reach the fixture or retried')
    console.log('BOUNDARY THINKING ' + (failures ? 'RED' : 'GREEN') + ' — ' + (checks - failures) + '/' + checks + '; actual worker requests, synthetic signed reasoning, loopback only')
  } finally { await fixture.close(); rmSync(home, { recursive: true, force: true }) }
  process.exitCode = failures ? 1 : 0
}
