#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'crewmate-idle-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_CREWS_DIR', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'NODE_ENV']) delete process.env[key]

const CREW = 'idle-truth'
const LEAD = 'crew-lead'
const SEAT = 'deep'
const SECOND_SEAT = 'quiet'
const MODEL = 'claude-opus-4-6'
const ANSWER = 'SEAT-HANDOFF-DELIVERED'
const REQUEST_ID = 'shutdown-deep-1'

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
async function until(predicate: () => boolean, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await sleep(20)
  return predicate()
}
const deadline = setTimeout(() => { console.error('crewmate-idle exceeded its deadline'); process.exit(1) }, 120_000)
deadline.unref()

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const runAgentModule = (await import('../../src/tools/AgentTool/runAgent.ts')) as Record<string, unknown>
const modelCalls: string[] = []
let modelFault: string | null = null
async function* fixtureRunAgent(params: { agentDefinition: { agentType: string }; onResolvedIdentity?: (identity: { model: string; effort?: string }) => void; promptMessages: unknown[] }): AsyncGenerator<unknown, void> {
  const seatName = JSON.stringify(params.promptMessages).includes(`${SECOND_SEAT}:`) ? SECOND_SEAT : SEAT
  modelCalls.push(seatName)
  if (modelCalls.filter(name => name === seatName).length > 1) {
    modelFault = `the model was called again for ${seatName} (${modelCalls.length} calls) — an idle crewmate's shutdown must never reach the model`
    throw new Error(modelFault)
  }
  params.onResolvedIdentity?.({ model: MODEL, effort: 'max' })
  yield createAssistantMessage({ content: `${ANSWER} — the notes name six boundaries.` })
}
mock.module('../../src/tools/AgentTool/runAgent.ts', () => ({ ...runAgentModule, runAgent: fixtureRunAgent }))

const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { spawnInProcessCrewmate } = await import('../../src/utils/crew/spawnInProcess.ts')
const { runInProcessCrewmate } = await import('../../src/utils/crew/inProcessRunner.ts')
const { isInProcessCrewmateTask } = await import('../../src/tasks/InProcessCrewmateTask/types.ts')
const { projectWorkRoster } = await import('../../src/utils/task/workRoster.ts')
const { crewAgentFactsOf, crewStateLabel, crewStatusWords } = await import('../../src/services/engine-connector/crewFacts.ts')
const { writeCrewFileAsync, readCrewFileAsync, getCrewFilePath } = await import('../../src/utils/crew/crewHelpers.ts')
const { sendLiveMessage, liveMessagesFor } = await import('../../src/services/crew/liveComms.ts')
const { createShutdownRequestMessage, isShutdownApproved } = await import('../../src/services/crew/liveMessages.ts')
const { hasActiveInProcessCrewmates, hasWorkingInProcessCrewmates } = await import('../../src/utils/crewmate.ts')
const { formatAgentId } = await import('../../src/utils/agentId.ts')
type AppState = import('../../src/state/AppState.tsx').AppState
type TaskState = import('../../src/tasks/types.ts').TaskState
type InProcessCrewmateTaskState = import('../../src/tasks/InProcessCrewmateTask/types.ts').InProcessCrewmateTaskState
type WorkRow = import('../../src/services/engine-connector/types.ts').WorkRowV1

const LEAD_ID = formatAgentId(LEAD, CREW)
const SEAT_ID = formatAgentId(SEAT, CREW)
const SECOND_ID = formatAgentId(SECOND_SEAT, CREW)
let state: AppState = {
  ...getDefaultAppState(),
  crewContext: { crewName: CREW, crewFilePath: getCrewFilePath(CREW), leadAgentId: LEAD_ID, crewmates: {} },
} as AppState
const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}
const member = (agentId: string, name: string): Record<string, unknown> => ({ agentId, name, agentType: 'mercury-crew', model: MODEL, joinedAt: Date.now(), tmuxPaneId: 'in-process', cwd: process.cwd(), subscriptions: [], backendType: 'in-process' })
await writeCrewFileAsync(CREW, { name: CREW, createdAt: Date.now(), leadAgentId: LEAD_ID, leadSessionId: String(getSessionId()), members: [member(LEAD_ID, LEAD), member(SEAT_ID, SEAT), member(SECOND_ID, SECOND_SEAT)] } as never)

const context = {
  options: { tools: [], commands: [], engineModel: MODEL, mcpClients: [], mcpResources: {}, debug: false, verbose: false, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: [] } },
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
async function startSeat(name: string): Promise<{ taskId: string; done: Promise<{ success: boolean; error?: Error }> }> {
  const spawned = await spawnInProcessCrewmate({ name, crewName: CREW, prompt: `${name}: research only, then hand off.`, model: MODEL }, { setAppState })
  if (!spawned.success || spawned.taskId === undefined || spawned.crewmateContext === undefined || spawned.abortController === undefined) throw new Error(`spawn failed: ${spawned.error ?? 'no task'}`)
  const done = runInProcessCrewmate({
    identity: { agentId: formatAgentId(name, CREW), agentName: name, crewName: CREW, parentSessionId: String(getSessionId()) },
    taskId: spawned.taskId,
    prompt: `${name}: research only, then hand off.`,
    crewmateContext: spawned.crewmateContext,
    abortController: spawned.abortController,
    toolUseContext: context,
    model: MODEL,
    systemPrompt: 'the fixture prompt',
    systemPromptMode: 'replace',
    ...(spawned.transcriptAgentId !== undefined ? { transcriptAgentId: spawned.transcriptAgentId } : {}),
  })
  return { taskId: spawned.taskId, done }
}
const memberFlag = async (name: string): Promise<boolean | undefined> => ((await readCrewFileAsync(CREW))?.members.find(candidate => candidate.name === name) as { isActive?: boolean } | undefined)?.isActive

section('§1 a crewmate that delivered its turn and waits on its inbox reads idle — on the task, the row, the facts and the words')
const seat = await startSeat(SEAT)
const wentIdle = await until(() => taskOf(seat.taskId)?.isIdle === true)
check('the seat ran one turn and went idle (the task says isIdle)', wentIdle && modelCalls.length === 1, `isIdle=${String(taskOf(seat.taskId)?.isIdle)} · model calls ${modelCalls.length}`)
{
  const row = projectWorkRoster(state.tasks).find(candidate => candidate.id === seat.taskId) as (WorkRow & { idle?: boolean }) | undefined
  check('the roster row carries the idle fact (idle: true) while its status stays running', row?.idle === true && row?.status === 'running', JSON.stringify(row))
  const facts = row === undefined ? null : crewAgentFactsOf(row, 'lead')
  check("the crew state reads 'idle' (never 'running' for a seat waiting on its inbox)", facts?.state === 'idle' && facts.running === true, JSON.stringify({ state: facts?.state, running: facts?.running }))
  check("the status words and the state label read 'idle' (the rail's word), not the last tool's activity", facts !== null && crewStatusWords(facts, Date.now()) === 'idle' && crewStateLabel(facts) === 'idle', facts === null ? 'no facts' : `${crewStatusWords(facts, Date.now())} · ${crewStateLabel(facts)}`)
  const working = { ...(taskOf(seat.taskId) as TaskState), id: 't9working0', isIdle: false } as TaskState
  const workingRow = projectWorkRoster({ t9working0: working })[0] as (WorkRow & { idle?: boolean }) | undefined
  check("a seat mid-turn carries no idle fact and reads 'running'", workingRow?.idle === undefined && crewAgentFactsOf(workingRow as WorkRow, 'lead')?.state === 'running', JSON.stringify(workingRow))
  let flag: boolean | undefined
  const deadlineAt = Date.now() + 4000
  while ((flag = await memberFlag(SEAT)) !== false && Date.now() < deadlineAt) await sleep(50)
  check("the crew file's member reads isActive: false at the idle transition (the delete's own flag)", flag === false, `isActive=${String(flag)}`)
}

section('§2 a shutdown request to an idle crewmate ends it at once: the approval reaches the lead, no model turn, the task settles completed')
{
  const request = createShutdownRequestMessage({ requestId: REQUEST_ID, from: LEAD, reason: 'the swarm is complete' })
  const delivered = await sendLiveMessage(CREW, { to: SEAT, from: LEAD, text: JSON.stringify(request), timestamp: new Date().toISOString() })
  check('rig: the shutdown request landed in the seat\'s inbox', delivered)
  const outcome = await Promise.race([seat.done, sleep(8000).then(() => null)])
  check('the runner ended within its next wake (the run settled, success)', outcome !== null && outcome.success === true, outcome === null ? 'the runner is still waiting after 8 s' : `success=${String(outcome.success)} error=${outcome.error?.message ?? ''}`)
  check('no model call was made for the shutdown (the fixture would have failed the run)', modelCalls.length === 1 && modelFault === null, `${modelCalls.length} calls · ${modelFault ?? ''}`)
  const leadInbox = await liveMessagesFor(CREW, LEAD)
  const approval = leadInbox.map(row => ({ from: row.from, approved: isShutdownApproved(row.text) })).find(row => row.approved !== null)
  check('the shutdown-approved message reached the lead from the seat, carrying the request id (as the model\'s tool would have sent it)', approval !== undefined && approval.from === SEAT && approval.approved?.requestId === REQUEST_ID && approval.approved.from === SEAT, JSON.stringify(leadInbox.map(row => row.text.slice(0, 120))))
  check("the seat's task settled completed (not failed, not still running)", taskOf(seat.taskId)?.status === 'completed', String(taskOf(seat.taskId)?.status))
}

section('§3 an idle crewmate counts as done: the session\'s wait laws read it active but not working, and ending it settles its loop without a model call')
{
  const second = await startSeat(SECOND_SEAT)
  const idle = await until(() => taskOf(second.taskId)?.isIdle === true)
  check('rig: a second seat ran its turn and waits idle on its inbox', idle && modelCalls.length === 2, `isIdle=${String(taskOf(second.taskId)?.isIdle)} · model calls ${modelCalls.length}`)
  check('the idle seat is active but not working — the close law never waits on it (idle counts as done)', hasActiveInProcessCrewmates(context.getAppState() as never) && !hasWorkingInProcessCrewmates(context.getAppState() as never), `active=${String(hasActiveInProcessCrewmates(context.getAppState() as never))} working=${String(hasWorkingInProcessCrewmates(context.getAppState() as never))}`)
  taskOf(second.taskId)?.abortController?.abort()
  const ended = await Promise.race([second.done, sleep(8000).then(() => null)])
  check('the idle seat ends when its crew ends it (its loop settled completed) — no zombie waiting on its inbox', ended !== null && ended.success === true && taskOf(second.taskId)?.status === 'completed', `${ended === null ? 'still running' : `success=${String(ended.success)}`} · status ${String(taskOf(second.taskId)?.status)}`)
  check('no model call was made for the end either', modelCalls.length === 2 && modelFault === null, `${modelCalls.length} calls`)
}

clearTimeout(deadline)
rmSync(HOME, { recursive: true, force: true })
console.log(`\ncrewmate-idle: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
