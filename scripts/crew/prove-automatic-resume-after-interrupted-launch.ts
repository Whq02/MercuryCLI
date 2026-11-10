#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
const root = join(proofHome, 'work')
mkdirSync(root, { recursive: true })
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(root)
bootstrap.setProjectRoot(root)
bootstrap.setCwdState(root)
bootstrap.switchSession('00000000-0000-4000-8000-000000000923' as never, root)
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
await import('../../src/tasks.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { getCommandQueue, resetCommandQueue } = await import('../../src/input-core/command-queue.ts')
const { registerAsyncAgent, failAgentTask } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { writeAgentMetadata } = await import('../../src/utils/sessionStorage/paths.ts')
const { recordSidechainTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage/writer.ts')
const { readAgentPauseRecord } = await import('../../src/tasks/LocalAgentTask/pauseCarry.ts')
const { armBudgetCutResume, armOverloadProbe, automaticResumePending, closeOverloadEpisode } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
type AppState = ReturnType<typeof getDefaultAppState>

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(holds: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (holds()) return true
    await settle(20)
  }
  return holds()
}
const MODEL = 'claude-opus-4-8'
const receipts = (id: string): string[] => getCommandQueue().filter(command => command.mode === 'task-notification').map(command => String(command.value)).filter(text => text.includes(`<task-id>${id}</task-id>`) && text.includes('<status>resumed</status>'))

async function pausedCrewmate(id: string, description: string): Promise<{ store: { get: () => AppState; set: (update: (before: AppState) => AppState) => void }; launch: Record<string, unknown>; registration: AbortController }> {
  let state = { ...getDefaultAppState(), effortValue: 'high' } as AppState
  const store = { get: () => state, set: (update: (before: AppState) => AppState) => { state = update(state) } }
  await writeAgentMetadata(id as never, { agentType: 'mercury-crew', description, launchedAt: Date.now() - 60_000, model: MODEL })
  await recordSidechainTranscript([createUserMessage({ content: 'carry the brief to its end' }), createAssistantMessage({ content: 'Working on it.' })] as never, id)
  await flushSessionStorage()
  const task = registerAsyncAgent({ agentId: id, description, prompt: 'work', setAppState: store.set as never })
  failAgentTask(id, 'API Error: the window is spent', store.set as never, task.abortController)
  const launch: Record<string, unknown> = {
    abortController: new AbortController(),
    getAppState: store.get,
    setAppState: store.set,
    setAppStateForTasks: store.set,
    options: { commands: [], tools: [], engineModel: MODEL, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    toolUseId: `toolu_${id}`,
  }
  return { store, launch, registration: task.abortController! }
}
type Row = { status?: string; paused?: unknown }

console.log('── a crewmate paused on a usage window, its launching turn interrupted since: the retry still starts ──')
for (const interrupted of [false, true]) {
  resetCommandQueue()
  const id = interrupted ? 'aresume0cut' : 'aresume0whole'
  const { store, launch, registration } = await pausedCrewmate(id, interrupted ? 'cut launch' : 'whole launch')
  if (interrupted) (launch.abortController as AbortController).abort()
  armBudgetCutResume({ taskId: id, description: id, registration, toolUseContext: launch as never, rootSetAppState: store.set as never, delayMs: 60, pause: { why: 'usage limit', words: 'the window is spent', resumesAtMs: Date.now() + 60 } })
  const fired = await until(() => !automaticResumePending(id), 3_000)
  const started = await until(() => receipts(id).length > 0, 6_000)
  const row = store.get().tasks[id] as Row | undefined
  check(`${interrupted ? 'the launching turn was interrupted' : 'the launching turn ended whole'}: the timer fires and the crewmate is resumed by itself (a receipt row says so)`, fired && started, { fired, started, row: { status: row?.status, paused: row?.paused !== undefined } })
  check(`${interrupted ? 'interrupted' : 'whole'}: the row no longer claims a retry that nothing holds`, row?.paused === undefined || automaticResumePending(id), { status: row?.status, paused: row?.paused !== undefined, armed: automaticResumePending(id), record: (await readAgentPauseRecord(id)) !== null })
}

console.log('── the same for a crewmate paused on an overloaded provider ──')
{
  resetCommandQueue()
  process.env.MERCURY_OVERLOAD_PROBE_SCALE = '0.001'
  const id = 'aresume0probe'
  const { store, launch, registration } = await pausedCrewmate(id, 'cut launch, overloaded')
  ;(launch.abortController as AbortController).abort()
  armOverloadProbe({ taskId: id, description: id, registration, toolUseContext: launch as never, rootSetAppState: store.set as never, model: MODEL, pause: { why: 'provider overloaded', words: 'the provider is overloaded' }, afterDeath: true, probe: async () => true })
  const again = await until(() => (store.get().tasks[id] as (Row & { registration?: AbortController }) | undefined)?.registration !== registration, 6_000)
  const row = store.get().tasks[id] as Row | undefined
  check('the provider answers: the crewmate is registered to run again, not left failed with its pause lifted', again, { status: row?.status, paused: row?.paused !== undefined })
  closeOverloadEpisode(id)
  delete process.env.MERCURY_OVERLOAD_PROBE_SCALE
}

console.log('── a retry that cannot start stops being claimed ──')
{
  resetCommandQueue()
  const id = 'aresume0none'
  let state = { ...getDefaultAppState(), effortValue: 'high' } as AppState
  const set = (update: (before: AppState) => AppState): void => { state = update(state) }
  const task = registerAsyncAgent({ agentId: id, description: 'no transcript', prompt: 'work', setAppState: set as never })
  failAgentTask(id, 'API Error: the window is spent', set as never, task.abortController)
  armBudgetCutResume({ taskId: id, description: id, registration: task.abortController!, toolUseContext: { abortController: new AbortController(), getAppState: () => state, setAppState: set, setAppStateForTasks: set, options: { tools: [] }, messages: [] } as never, rootSetAppState: set as never, delayMs: 60, pause: { why: 'usage limit', words: 'the window is spent', resumesAtMs: Date.now() + 60 } })
  check('armed, the row wears its pause', (state.tasks[id] as Row | undefined)?.paused !== undefined && automaticResumePending(id))
  const lifted = await until(() => (state.tasks[id] as Row | undefined)?.paused === undefined, 4_000)
  check('the resume could not start (no transcript to resume from): the row no longer says it will retry by itself', lifted && !automaticResumePending(id) && receipts(id).length === 0, { paused: (state.tasks[id] as Row | undefined)?.paused !== undefined, armed: automaticResumePending(id) })
}

await settle(300)
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
