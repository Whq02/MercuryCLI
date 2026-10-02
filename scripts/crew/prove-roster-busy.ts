#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'roster-busy-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_CREWS_DIR', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'NODE_ENV']) delete process.env[key]

const CREW = 'roster-truth'
const LEAD = 'crew-lead'
const SEAT = 'mapper'
const MODEL = 'claude-opus-4-6'

let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(predicate: () => Promise<boolean>, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!(await predicate()) && Date.now() < deadline) await sleep(40)
  return predicate()
}
const deadline = setTimeout(() => { console.error('roster-busy exceeded its deadline'); process.exit(1) }, 90_000)
deadline.unref()

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const runAgentModule = (await import('../../src/tools/AgentTool/runAgent.ts')) as Record<string, unknown>
let releaseTurn: () => void = () => {}
const turnHeld = new Promise<void>(resolve => { releaseTurn = resolve })
let modelCalls = 0
async function* fixtureRunAgent(params: { onResolvedIdentity?: (identity: { model: string }) => void }): AsyncGenerator<unknown, void> {
  modelCalls++
  params.onResolvedIdentity?.({ model: MODEL })
  await turnHeld
  yield createAssistantMessage({ content: 'the map is drawn' })
}
mock.module('../../src/tools/AgentTool/runAgent.ts', () => ({ ...runAgentModule, runAgent: fixtureRunAgent }))

const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { spawnInProcessCrewmate } = await import('../../src/utils/swarm/spawnInProcess.ts')
const { runInProcessCrewmate } = await import('../../src/utils/swarm/inProcessRunner.ts')
const { isInProcessCrewmateTask } = await import('../../src/tasks/InProcessCrewmateTask/types.ts')
const { writeCrewFileAsync, readCrewFileAsync, getCrewFilePath } = await import('../../src/utils/swarm/crewHelpers.ts')
const { getAgentStatuses } = await import('../../src/utils/tasks.ts')
const { getRoomHealth } = await import('../../src/utils/swarm/roomHealth.ts')
const { crewBrief } = await import('../../src/services/coordination/coordinationService.ts')
const { formatAgentId } = await import('../../src/utils/agentId.ts')
type AppState = import('../../src/state/AppState.tsx').AppState
type InProcessCrewmateTaskState = import('../../src/tasks/InProcessCrewmateTask/types.ts').InProcessCrewmateTaskState

const LEAD_ID = formatAgentId(LEAD, CREW)
const SEAT_ID = formatAgentId(SEAT, CREW)
let state: AppState = {
  ...getDefaultAppState(),
  crewContext: { crewName: CREW, crewFilePath: getCrewFilePath(CREW), leadAgentId: LEAD_ID, crewmates: {} },
} as AppState
const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}
const member = (agentId: string, name: string, paneId: string): Record<string, unknown> => ({ agentId, name, agentType: 'mercury-general', model: MODEL, joinedAt: Date.now(), tmuxPaneId: paneId, cwd: process.cwd(), subscriptions: [], backendType: 'in-process' })
await writeCrewFileAsync(CREW, { name: CREW, createdAt: Date.now(), leadAgentId: LEAD_ID, leadSessionId: String(getSessionId()), members: [member(LEAD_ID, LEAD, 'leader'), member(SEAT_ID, SEAT, 'in-process')] } as never)

const context = {
  options: { tools: [], commands: [], mainLoopModel: MODEL, mcpClients: [], mcpResources: {}, debug: false, verbose: false, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: [] } },
  messages: [],
  abortController: new AbortController(),
  getAppState: () => state,
  setAppState,
  setAppStateForTasks: setAppState,
  readFileState: new Map(),
  toolUseId: 'toolu_fixture_spawn',
} as never

const taskOf = (taskId: string): InProcessCrewmateTaskState | undefined => {
  const task = state.tasks[taskId]
  return task !== undefined && isInProcessCrewmateTask(task) ? task : undefined
}
const statusOf = async (name: string): Promise<string | undefined> => (await getAgentStatuses(CREW))?.find(row => row.name === name)?.status
const flagOf = async (name: string): Promise<boolean | undefined> => ((await readCrewFileAsync(CREW))?.members.find(candidate => candidate.name === name) as { isActive?: boolean } | undefined)?.isActive
const ctx = { crew: CREW, agentId: LEAD_ID }

section('§1 a crewmate whose turn is in flight reads busy on the roster — the brief, the statuses and the health agree; the lead reads idle')
const spawned = await spawnInProcessCrewmate({ name: SEAT, crewName: CREW, prompt: `${SEAT}: draw the map.`, model: MODEL }, { setAppState })
if (!spawned.success || spawned.taskId === undefined || spawned.crewmateContext === undefined || spawned.abortController === undefined) throw new Error(`spawn failed: ${spawned.error ?? 'no task'}`)
const done = runInProcessCrewmate({
  identity: { agentId: SEAT_ID, agentName: SEAT, crewName: CREW, parentSessionId: String(getSessionId()) },
  taskId: spawned.taskId,
  prompt: `${SEAT}: draw the map.`,
  crewmateContext: spawned.crewmateContext,
  abortController: spawned.abortController,
  toolUseContext: context,
  model: MODEL,
  systemPrompt: 'the fixture prompt',
  systemPromptMode: 'replace',
  ...(spawned.transcriptAgentId !== undefined ? { transcriptAgentId: spawned.transcriptAgentId } : {}),
})
const inFlight = await until(async () => modelCalls === 1 && (await flagOf(SEAT)) === true)
check('rig: the seat is mid-turn — its model call is in flight and the roster member reads isActive: true', inFlight && taskOf(spawned.taskId)?.isIdle === false, `calls=${modelCalls} isActive=${String(await flagOf(SEAT))} isIdle=${String(taskOf(spawned.taskId)?.isIdle)}`)
const busy = await until(async () => (await statusOf(SEAT)) === 'busy', 4000)
check('the agent statuses read the working seat busy (RED on the base: idle, because it owns no task-list item)', busy, `status=${String(await statusOf(SEAT))}`)
check('…and the lead, which never writes the live flag, reads idle', (await statusOf(LEAD)) === 'idle', `status=${String(await statusOf(LEAD))}`)
const brief = await crewBrief(ctx)
check('the brief\'s roster line reads the seat busy and the lead idle (RED on the base)', brief.roster.find(row => row.name === SEAT)?.status === 'busy' && brief.roster.find(row => row.name === LEAD)?.status === 'idle', JSON.stringify(brief.roster))
const health = await getRoomHealth(CREW)
const seatHealth = health.agents.find(row => row.name === SEAT)
check('the health reads the seat busy with the honest reason — its turn is in flight, no task-list item owned (RED on the base)', seatHealth?.state === 'busy' && seatHealth.why === 'working — its turn is in flight' && seatHealth.currentTasks.length === 0, JSON.stringify(seatHealth))

section('§2 the same seat, idle between turns, reads idle again — the flag the runner writes at the idle transition')
releaseTurn()
const wentIdle = await until(async () => taskOf(spawned.taskId)?.isIdle === true && (await flagOf(SEAT)) === false)
check('the seat delivered its turn and waits on its inbox (isIdle, isActive: false)', wentIdle, `isIdle=${String(taskOf(spawned.taskId)?.isIdle)} isActive=${String(await flagOf(SEAT))}`)
check('the agent statuses read the idle seat idle', (await statusOf(SEAT)) === 'idle', `status=${String(await statusOf(SEAT))}`)
check('the brief agrees', (await crewBrief(ctx)).roster.find(row => row.name === SEAT)?.status === 'idle')

section('§3 a member the file has never marked — a pane seat before its first turn ends — reads busy, as the crew roster already reads it (running unless explicitly deactivated)')
{
  const file = await readCrewFileAsync(CREW)
  await writeCrewFileAsync(CREW, { ...file, members: [...(file?.members ?? []), member(formatAgentId('fresh', CREW), 'fresh', '%9')] } as never)
  check('an unmarked member reads busy', (await statusOf('fresh')) === 'busy', `status=${String(await statusOf('fresh'))}`)
}

section('§4 the operator stops the seat: its roster record stays, marked stopped, and reads stopped on the statuses and the brief — over a stale busy word — until the crew view\'s clear removes it')
{
  const { stopAgentByOperator } = await import('../../src/services/agents/operatorStop.ts')
  const { setLiveBusy } = await import('../../src/services/crew/liveComms.ts')
  const { clearCrewmate, foldCrewLedger, seenCrewOf } = await import('../../src/state/crewLedger.ts')
  const memberOf = async (name: string): Promise<{ isActive?: boolean; stoppedAt?: number; cwd?: string } | undefined> => (await readCrewFileAsync(CREW))?.members.find(candidate => candidate.name === name) as { isActive?: boolean; stoppedAt?: number; cwd?: string } | undefined
  const stopped = await stopAgentByOperator(spawned.taskId, { getAppState: () => state, setAppState: setAppState as never }, { settleMs: 300, sleep: (ms: number) => sleep(Math.min(ms, 10)) })
  check('rig: the crew view\'s stop kills the seat', stopped.outcome === 'applied' && taskOf(spawned.taskId)?.status === 'killed', JSON.stringify(stopped))
  const marked = await until(async () => (await memberOf(SEAT))?.stoppedAt !== undefined, 4000)
  const record = await memberOf(SEAT)
  check('the roster record stays after the stop, marked stopped and not active (RED on the base: removed at the kill)', marked && record !== undefined && typeof record.stoppedAt === 'number' && record.isActive === false, JSON.stringify(record ?? null))
  check('the agent statuses read the stopped seat stopped (RED on the base: no row)', (await statusOf(SEAT)) === 'stopped', `status=${String(await statusOf(SEAT))}`)
  await setLiveBusy(CREW, SEAT, true, 'a stale word')
  const briefStopped = await crewBrief(ctx)
  check('the brief reads it stopped even over a stale busy word in the live store (RED on the base: no row)', briefStopped.roster.find(row => row.name === SEAT)?.status === 'stopped', JSON.stringify(briefStopped.roster))
  const stoppedHealth = (await getRoomHealth(CREW)).agents.find(row => row.name === SEAT)
  check('the health never counts a stopped seat as working', stoppedHealth?.state === 'idle' && /stopped/.test(stoppedHealth.why), JSON.stringify(stoppedHealth))
  const sessionId = String(getSessionId())
  const seen = seenCrewOf(state.tasks, { rows: [] }, sessionId)
  state = { ...state, crewLedger: foldCrewLedger(state.crewLedger ?? {}, seen, sessionId, false, Date.now()) } as AppState
  const cleared = clearCrewmate(spawned.taskId, setAppState)
  const removed = await until(async () => (await memberOf(SEAT)) === undefined, 4000)
  check('the crew view\'s clear (the operator\'s word) removes the record from the roster (RED on the base: nothing to remove)', cleared && removed, JSON.stringify(await memberOf(SEAT) ?? null))
}

await Promise.race([done, sleep(5000)])
rmSync(HOME, { recursive: true, force: true })
console.log(`\nroster-busy: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
