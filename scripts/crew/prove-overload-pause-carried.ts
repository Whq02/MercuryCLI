#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'bun:test'
import type { Message } from '../../src/types/message.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OVERLOAD_PROBE_SCALE = '0.001'
const root = join(proofHome, 'work')
mkdirSync(root, { recursive: true })
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(root)
bootstrap.setProjectRoot(root)
bootstrap.setCwdState(root)
bootstrap.switchSession('00000000-0000-4000-8000-000000000529' as never, root)
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { resetCommandQueue } = await import('../../src/input-core/command-queue.ts')
const { registerAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { AGENT_OVERLOAD_RESUME_NOTE } = await import('../../src/tasks/LocalAgentTask/agentOverload.ts')
const { decodeAgentPause } = await import('../../src/tasks/LocalAgentTask/agentPause.ts')
const { createAssistantAPIErrorMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { readAgentPauseRecord, agentPauseRecordPath, carryPausedCrewmatesOnResume, writeAgentPauseRecord } = await import('../../src/tasks/LocalAgentTask/pauseCarry.ts')
const { TaskStopTool } = await import('../../src/tools/TaskStopTool/TaskStopTool.ts')
const { writeAgentMetadata } = await import('../../src/utils/sessionStorage/paths.ts')
type AppState = ReturnType<typeof getDefaultAppState>

const resumes: Array<{ agentId: string; prompt: string; automatic?: boolean }> = []
const resumeModule = await import('../../src/tools/AgentTool/resumeAgent.ts')
mock.module('../../src/tools/AgentTool/resumeAgent.ts', () => ({
  ...resumeModule,
  resumeAgentBackground: async (args: { agentId: string; prompt: string; automatic?: boolean }) => {
    resumes.push(args)
    return {}
  },
}))
let providerAnswers = false
const probed: string[] = []
const routerModule = await import('../../src/services/providers/callModelRouter.ts')
mock.module('../../src/services/providers/callModelRouter.ts', () => ({
  ...routerModule,
  routedCallModel: async function* (request: { options: { model: string } }) {
    probed.push(request.options.model)
    if (providerAnswers) yield { type: 'stream_event', event: { type: 'message_start' } }
  },
}))
const { runAsyncAgentLifecycle, automaticResumePending, armedAutomaticResumeCount, closeOverloadEpisode } = await import('../../src/tools/AgentTool/agentToolUtils.ts')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const makeStore = () => {
  let state = getDefaultAppState()
  return { get: () => state, set: (update: (before: AppState) => AppState) => { state = update(state) } }
}
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(holds: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await holds()) return true
    await settle(10)
  }
  return false
}
const MODEL = 'claude-fable-5-1'
const OVERLOADED_ROW = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CfHZrdNJLUZnN5a6wrGCM"}'
const overloaded = (): Message => createAssistantAPIErrorMessage({ content: OVERLOADED_ROW, error: 'unknown' }) as Message
const contextOf = (store: ReturnType<typeof makeStore>, toolUseId: string): never => ({ getAppState: store.get, setAppState: store.set, setAppStateForTasks: store.set, options: { tools: [] }, abortController: new AbortController(), messages: [], toolUseId }) as never
type Row = { status?: string; paused?: { why?: string; words?: string; resumesAtMs?: number }; description?: string; agentType?: string }

async function pauseOnOverload(store: ReturnType<typeof makeStore>, taskId: string, description: string, toolUseId: string): Promise<void> {
  const task = registerAsyncAgent({ agentId: taskId, description, prompt: 'work', setAppState: store.set })
  async function* stream() {
    yield createAssistantMessage({ content: 'Working on the launcher.' })
    yield overloaded()
  }
  await runAsyncAgentLifecycle({ taskId, abortController: task.abortController!, makeStream: stream, metadata: { prompt: 'work', resolvedAgentModel: MODEL, isBuiltInAgent: false, startTime: Date.now(), agentType: 'mercury-crew', isAsync: true }, description, toolUseContext: contextOf(store, toolUseId), rootSetAppState: store.set, agentIdForCleanup: taskId, enableSummarization: false, getWorktreeResult: async () => ({}) } as never)
}

console.log('── §A a crewmate whose turn ends on an overloaded provider pauses, and the pause is recorded beside its transcript ──')
const storeA = makeStore()
const first = 'aovl0first'
{
  resetCommandQueue()
  await pauseOnOverload(storeA, first, 'core gap fixes', 'toolu_overload_1')
  const row = storeA.get().tasks[first] as Row | undefined
  check('the row wears the overload pause, with no reset to state', row?.status === 'failed' && row.paused?.why === 'provider overloaded' && row.paused.resumesAtMs === undefined, row)
  check('the probe is armed in this process', automaticResumePending(first) || armedAutomaticResumeCount() === 1, armedAutomaticResumeCount())
  const recorded = await until(async () => (await readAgentPauseRecord(first)) !== null, 2_000)
  const record = (await readAgentPauseRecord(first)) as { pause?: { why?: string; words?: string; resumesAtMs?: number }; model?: string; description?: string; toolUseId?: string } | null
  check('the pause is on disk: its reason and words, the model the probe asks, the description and the launch\'s tool-use id', recorded && record?.pause?.why === 'provider overloaded' && record.pause.words === row?.paused?.words && record.pause.resumesAtMs === undefined && record.model === MODEL && record.description === 'core gap fixes' && record.toolUseId === 'toolu_overload_1', record)
  const probing = await until(() => probed.length >= 2, 5_000)
  check('probes that get no answer leave the record standing and the crewmate counted', probing && (await readAgentPauseRecord(first)) !== null && armedAutomaticResumeCount() === 1 && resumes.length === 0, { probed: probed.length, count: armedAutomaticResumeCount(), resumes })
  providerAnswers = true
  const resumed = await until(() => resumes.length === 1, 5_000)
  check('the provider answers: the crewmate is resumed by itself with the overload note', resumed && resumes[0]!.agentId === first && resumes[0]!.automatic === true && resumes[0]!.prompt === AGENT_OVERLOAD_RESUME_NOTE, resumes)
  const cleared = await until(() => !existsSync(agentPauseRecordPath(first)), 2_000)
  check('and its record is cleared', cleared && (await readAgentPauseRecord(first)) === null)
  providerAnswers = false
  closeOverloadEpisode(first)
}

console.log('── §B a re-claimed session re-arms the probe from the record ──')
{
  const store = makeStore()
  const id = 'aovl0carry'
  resumes.length = 0
  probed.length = 0
  await writeAgentMetadata(id as never, { agentType: 'mercury-crew', description: 'bank sweep', launchedAt: Date.now() - 60 * 60_000, model: MODEL })
  const written = { pause: { why: 'provider overloaded', words: (storeA.get().tasks[first] as Row).paused!.words! }, model: MODEL, description: 'bank sweep', armedAt: Date.now() - 5 * 60_000, toolUseId: 'toolu_bank_1' }
  await writeAgentPauseRecord(id, written as never)
  const before = armedAutomaticResumeCount()
  const carried = await carryPausedCrewmatesOnResume({ getAppState: store.get, setAppState: store.set, relaunchContext: async () => contextOf(store, 'toolu_bank_1') })
  check('the claim finds the overload record and re-arms its probe', carried.length === 1 && carried[0] === id && automaticResumePending(id), carried)
  check('the carried crewmate counts as waiting from that moment', armedAutomaticResumeCount() === before + 1, { before, now: armedAutomaticResumeCount() })
  const row = store.get().tasks[id] as Row | undefined
  check('its row reads paused on the overloaded provider, from the record and the launch\'s own facts', row?.status === 'failed' && row.paused?.why === 'provider overloaded' && row.paused.words === written.pause.words && row.description === 'bank sweep' && row.agentType === 'mercury-crew', row)
  const probedAgain = await until(() => probed.includes(MODEL), 5_000)
  check('the probe asks the model the record names, and with no answer the record stands', probedAgain && resumes.length === 0 && (await readAgentPauseRecord(id)) !== null, { probed, resumes })
  providerAnswers = true
  const resumed = await until(() => resumes.some(r => r.agentId === id), 5_000)
  check('when the provider answers the carried crewmate is resumed by itself, and its record cleared', resumed && resumes.find(r => r.agentId === id)!.automatic === true && resumes.find(r => r.agentId === id)!.prompt === AGENT_OVERLOAD_RESUME_NOTE && (await until(async () => (await readAgentPauseRecord(id)) === null, 2_000)), resumes)
  providerAnswers = false
  closeOverloadEpisode(id)
}

console.log('── §C the roads that end the wait leave no record behind ──')
{
  const store = makeStore()
  const id = 'aovl0stop'
  resetCommandQueue()
  await pauseOnOverload(store, id, 'surface pass', 'toolu_stop_1')
  await until(async () => (await readAgentPauseRecord(id)) !== null, 2_000)
  const output = await TaskStopTool.call({ task_id: id }, { getAppState: store.get, setAppState: store.set } as never)
  const message = (output as { data: { message: string } }).data.message
  check('a stop on the paused row is a stop', message.startsWith(`Stopped task ${id} (surface pass) while it was paused:`), message)
  const cleared = await until(() => !existsSync(agentPauseRecordPath(id)), 2_000)
  check('the stop clears the record and disarms the probe', cleared && !automaticResumePending(id), { armed: automaticResumePending(id) })
  closeOverloadEpisode(id)

  const spent = makeStore()
  const late = 'aovl0spent'
  resumes.length = 0
  await pauseOnOverload(spent, late, 'long outage', 'toolu_spent_1')
  await until(async () => (await readAgentPauseRecord(late)) !== null, 2_000)
  const lifted = await until(() => (spent.get().tasks[late] as Row | undefined)?.paused === undefined, 15_000)
  check('an episode that runs out with no answer lifts the pause, resumes nothing and clears the record', lifted && !resumes.some(r => r.agentId === late) && (await until(async () => (await readAgentPauseRecord(late)) === null, 2_000)) && !automaticResumePending(late), { lifted, resumes })
  closeOverloadEpisode(late)
}

console.log('── §D the reader 1.0.8 shipped skips the new record and still reads its own ──')
{
  const shipped = (raw: unknown): unknown => {
    if (raw === null || typeof raw !== 'object') return null
    const record = raw as Record<string, unknown>
    const pause = decodeAgentPause(record.pause)
    if (pause === null || pause.resumesAtMs === undefined || typeof record.description !== 'string' || typeof record.armedAt !== 'number' || !Number.isFinite(record.armedAt)) return null
    return { pause: { ...pause, resumesAtMs: pause.resumesAtMs }, description: record.description, armedAt: record.armedAt }
  }
  const store = makeStore()
  const id = 'aovl0old'
  await pauseOnOverload(store, id, 'old reader', 'toolu_old_1')
  await until(async () => (await readAgentPauseRecord(id)) !== null, 2_000)
  const bytes = existsSync(agentPauseRecordPath(id)) ? JSON.parse(readFileSync(agentPauseRecordPath(id), 'utf8')) : null
  check('the shipped decoder answers null for an overload record, so that runner leaves the crewmate as it does today', bytes !== null && shipped(bytes) === null, bytes)
  const windowRecord = { pause: { why: 'usage limit', words: 'spent', resumesAtMs: Date.now() + 60_000 }, description: 'window', armedAt: Date.now() }
  await writeAgentPauseRecord('aovl0window', windowRecord as never)
  const reread = await readAgentPauseRecord('aovl0window')
  check('a window record reads the same through both', shipped(windowRecord) !== null && reread !== null && (reread as { pause: { resumesAtMs?: number } }).pause.resumesAtMs === windowRecord.pause.resumesAtMs, reread)
  await writeAgentPauseRecord('aovl0nomodel', { pause: { why: 'provider overloaded', words: 'overloaded' }, description: 'no model', armedAt: Date.now() } as never)
  check('an overload record with no model to probe is not carried', (await readAgentPauseRecord('aovl0nomodel')) === null)
  await TaskStopTool.call({ task_id: id }, { getAppState: store.get, setAppState: store.set } as never)
  closeOverloadEpisode(id)
}

resetCommandQueue()
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
