#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'bun:test'
import type { Message } from '../../src/types/message.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const root = join(proofHome, 'work')
mkdirSync(root, { recursive: true })
writeFileSync(join(root, 'launcher.ts'), 'export {}\n')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(root)
bootstrap.setProjectRoot(root)
bootstrap.setCwdState(root)
bootstrap.switchSession('00000000-0000-4000-8000-000000000462' as never, root)
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { getCommandQueue, resetCommandQueue } = await import('../../src/input-core/command-queue.ts')
const { registerAsyncAgent, AGENT_STOPPED_WHILE_PAUSED } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { createAssistantAPIErrorMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { stampProviderWait } = await import('../../src/services/api/recoveryBudget.ts')
const { projectLeaseHolder, takeProjectLeases, listProjectLeases } = await import('../../src/services/vulcan/engine/leases.ts')
const { readAgentPauseRecord, agentPauseRecordPath, carryPausedCrewmatesOnResume, writeAgentPauseRecord } = await import('../../src/tasks/LocalAgentTask/pauseCarry.ts')
const { TaskStopTool } = await import('../../src/tools/TaskStopTool/TaskStopTool.ts')
const { stopAgentByOperator } = await import('../../src/services/agents/operatorStop.ts')
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
const { runAsyncAgentLifecycle, automaticResumePending, windowPauseResumeDelayMs } = await import('../../src/tools/AgentTool/agentToolUtils.ts')

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
const notes = (): string[] => getCommandQueue().filter(command => command.mode === 'task-notification').map(command => String(command.value))
const pick = (text: string, tag: string): string | undefined => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim()
const MINUTE = 60_000
const MODEL = 'glm-5.3-flash'

function windowRefusal(resetAtMs: number): Message {
  return stampProviderWait(
    createAssistantAPIErrorMessage({ content: 'API Error: Z.AI is rate-limiting this account (zai-1308: Usage limit reached for 5 hour. Your limit will reset at 2026-10-27 20:34:34)', error: 'rate_limit' }),
    resetAtMs - Date.now(),
  ) as Message
}

console.log('── §A a crewmate that ends on a provider window pauses: the parent reads paused, the envelope says paused, the retry is armed and recorded ──')
const store = makeStore()
const context = { getAppState: store.get, setAppState: store.set, setAppStateForTasks: store.set, options: { tools: [] }, abortController: new AbortController(), messages: [], toolUseId: 'toolu_pause_1' } as never
const taskId = 'ayisyobgc'
const resetAt = Date.now() + 30 * MINUTE
{
  resetCommandQueue()
  const task = registerAsyncAgent({ agentId: taskId, description: 'GLM core/server gap fixes', prompt: 'work', setAppState: store.set })
  const lease = await takeProjectLeases(root, ['launcher.ts'], projectLeaseHolder(taskId))
  check('the crewmate holds a lease while it works', lease.ok, lease)
  async function* stream() {
    yield createAssistantMessage({ content: 'Working on the launcher.' })
    yield windowRefusal(resetAt)
  }
  await runAsyncAgentLifecycle({ taskId, abortController: task.abortController!, makeStream: stream, metadata: { prompt: 'work', resolvedAgentModel: MODEL, isBuiltInAgent: false, startTime: Date.now(), agentType: 'mercury-crew', isAsync: true }, description: 'GLM core/server gap fixes', toolUseContext: context, rootSetAppState: store.set, agentIdForCleanup: taskId, enableSummarization: false, getWorktreeResult: async () => ({}) })
  const note = notes().at(-1) ?? ''
  check('the parent\'s notification status word is paused, never failed', pick(note, 'status') === 'paused', note.slice(0, 400))
  check('the summary names the pause and the retry', (pick(note, 'summary') ?? '').startsWith('Crewmate "GLM core/server gap fixes" paused — ') && note.includes('retries by itself at'), pick(note, 'summary'))
  check('the result envelope carries status="paused"', /<envelope v="\d+" status="paused">/.test(note), note.match(/<envelope[^>]*>/)?.[0])
  const row = store.get().tasks[taskId] as { status?: string; paused?: { resumesAtMs?: number } } | undefined
  check('the task row wears the pause with the stated reset', row?.status === 'failed' && row.paused !== undefined && Math.abs((row.paused.resumesAtMs ?? 0) - resetAt) < 2_000, row)
  check('the retry is armed in this process', automaticResumePending(taskId))
  await new Promise(resolve => setTimeout(resolve, 50))
  const record = await readAgentPauseRecord(taskId)
  check('the pause is recorded on disk beside the transcript, with the reset and the launch\'s tool-use id', record !== null && record.pause.why === 'usage limit' && Math.abs(record.pause.resumesAtMs - resetAt) < 2_000 && record.description === 'GLM core/server gap fixes' && record.toolUseId === 'toolu_pause_1', record)
}

console.log('── §B TaskStop on the paused row stops it: the armed retry is cancelled, the leases released, the answer says so ──')
{
  const before = (await listProjectLeases(root)).length
  const output = await TaskStopTool.call({ task_id: taskId }, { getAppState: store.get, setAppState: store.set } as never)
  const data = (output as { data: { message: string; task_id: string; task_type: string } }).data
  check('the answer is a stop, not "nothing was stopped"', data.message.startsWith(`Stopped task ${taskId} (GLM core/server gap fixes) while it was paused:`) && !data.message.includes('nothing was stopped'), data.message)
  check('the answer names the cancelled retry, the released lease and the way back', data.message.includes(`the retry it had armed for ${new Date(resetAt).toISOString().slice(0, 16)}`) && data.message.includes('1 lease released') && data.message.includes('resume it from the crew view (r on its row) or by ResumeCrewmate to its id'), data.message)
  check('the retry is no longer armed', !automaticResumePending(taskId))
  const row = store.get().tasks[taskId] as { status?: string; paused?: unknown; stopReason?: string } | undefined
  check('the task row reads stopped with the door\'s words and no pause', row?.status === 'killed' && row.paused === undefined && row.stopReason === AGENT_STOPPED_WHILE_PAUSED, row)
  check('the crewmate\'s lease is gone', before === 1 && (await listProjectLeases(root)).length === 0, await listProjectLeases(root))
  await new Promise(resolve => setTimeout(resolve, 50))
  check('the pause record is cleared', !existsSync(agentPauseRecordPath(taskId)) && (await readAgentPauseRecord(taskId)) === null)
  check('the retry never fired', resumes.length === 0, resumes)
  const again = await TaskStopTool.call({ task_id: taskId }, { getAppState: store.get, setAppState: store.set } as never)
  check('a second stop answers that it had already been stopped', (again as { data: { message: string } }).data.message.includes('had already been stopped'), again)
}

console.log('── §C the operator\'s stop door (the crew view) stops a paused row the same way ──')
{
  const store2 = makeStore()
  const id = 'azde3yp3q'
  const task = registerAsyncAgent({ agentId: id, description: 'surface pass', prompt: 'work', setAppState: store2.set })
  async function* stream() {
    yield windowRefusal(Date.now() + 10 * MINUTE)
  }
  resetCommandQueue()
  await runAsyncAgentLifecycle({ taskId: id, abortController: task.abortController!, makeStream: stream, metadata: { prompt: 'work', resolvedAgentModel: MODEL, isBuiltInAgent: false, startTime: Date.now(), agentType: 'mercury-crew', isAsync: true }, description: 'surface pass', toolUseContext: { ...(context as object), getAppState: store2.get, setAppState: store2.set, setAppStateForTasks: store2.set } as never, rootSetAppState: store2.set, agentIdForCleanup: id, enableSummarization: false, getWorktreeResult: async () => ({}) })
  check('the second crewmate paused with its retry armed', automaticResumePending(id) && (store2.get().tasks[id] as { paused?: unknown } | undefined)?.paused !== undefined)
  const receipt = await stopAgentByOperator(id, { getAppState: store2.get, setAppState: store2.set }, { settleMs: 200, sleep: async () => undefined })
  check('the operator\'s stop applies to a paused row', receipt.outcome === 'applied' && receipt.kind === 'agent' && receipt.status === 'killed', receipt)
  check('its retry is cancelled', !automaticResumePending(id))
}

console.log('── §D a re-claimed session re-arms the pause from its record: the retry fires after the claim as it would have before ──')
{
  const store3 = makeStore()
  const id = 'a8vqymoua'
  const soon = Date.now() + 1_500
  await writeAgentMetadata(id as never, { agentType: 'mercury-crew', description: 'bank sweep', launchedAt: Date.now() - 60 * MINUTE, model: MODEL })
  await writeAgentPauseRecord(id, { pause: { why: 'usage limit', words: 'API Error: Z.AI is rate-limiting this account', resumesAtMs: soon }, description: 'bank sweep', armedAt: Date.now() - 5 * MINUTE, toolUseId: 'toolu_bank_1' })
  const carried = await carryPausedCrewmatesOnResume({ getAppState: store3.get, setAppState: store3.set, relaunchContext: async () => ({ ...(context as object), getAppState: store3.get, setAppState: store3.set, setAppStateForTasks: store3.set }) as never })
  check('the claim finds the record and re-arms the retry', carried.length === 1 && carried[0] === id && automaticResumePending(id), carried)
  const row = store3.get().tasks[id] as { status?: string; paused?: { resumesAtMs?: number }; description?: string; agentType?: string; notified?: boolean } | undefined
  check('the parent\'s task row reads paused with the stated reset, from the launch\'s own facts', row?.status === 'failed' && row.paused?.resumesAtMs === soon && row.description === 'bank sweep' && row.agentType === 'mercury-crew' && row.notified === true, row)
  check('the delay honours the stated reset with the floor', windowPauseResumeDelayMs(soon, Date.now()) > 1_000 && windowPauseResumeDelayMs(Date.now() - 5_000, Date.now()) === 1_000)
  await new Promise(resolve => setTimeout(resolve, 3_000))
  check('the retry fired after the claim, as the automatic resume, with the window note', resumes.length === 1 && resumes[0]!.agentId === id && resumes[0]!.automatic === true && resumes[0]!.prompt.includes('The usage window reset'), resumes)
  check('the fired retry cleared its record', (await readAgentPauseRecord(id)) === null)
  const receipt = notes().find(note => pick(note, 'task-id') === id && pick(note, 'status') === 'resumed')
  check('the parent gets the resume receipt row', receipt !== undefined && receipt.includes('resumed by itself — the usage window reset'), notes())

  const live = makeStore()
  const running = registerAsyncAgent({ agentId: 'a6t7470vs', description: 'live one', prompt: 'work', setAppState: live.set })
  await writeAgentPauseRecord('a6t7470vs', { pause: { why: 'usage limit', words: 'spent', resumesAtMs: Date.now() + MINUTE }, description: 'live one', armedAt: Date.now() })
  const skipped = await carryPausedCrewmatesOnResume({ getAppState: live.get, setAppState: live.set, relaunchContext: async () => context })
  check('a record whose crewmate already runs again is dropped, not re-armed', skipped.length === 0 && !automaticResumePending('a6t7470vs') && (await readAgentPauseRecord('a6t7470vs')) === null, skipped)
  running.abortController?.abort()
}

console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
