#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const at = (rel: string): string => join(ROOT, rel)

let failures = 0
let ownerHint = ''
const ownerHintOf = (title: string): string => {
  if (title.startsWith('§4b')) return 'change the project/query arm in src/daemon/runner/runnerArms.ts or projectQuery in src/daemon/runner/projectQuery.ts'
  if (title.startsWith('§5')) return 'change the session/send_now arm in src/daemon/runner/runnerArms.ts or sendQueuedWordsNow in src/daemon/runner/sendNow.ts'
  if (title.startsWith('§6')) return 'change setSessionKit in src/daemon/runner/mcpArms.ts or the session/set_kit arm in src/daemon/runner/runnerArms.ts'
  if (title.startsWith('§8b')) return 'change runnerParkRefusal in src/daemon/runner/parkRefusal.ts'
  if (title.startsWith('§8c')) return 'change landSpawnSwitch in src/daemon/runner/spawnSwitchLanding.ts'
  if (title.startsWith('§8')) return 'change answerSessionFacts in src/daemon/runner/sessionFactsArm.ts'
  if (title.startsWith('§9')) return 'change claimSession in src/daemon/runner/claimSession.ts'
  return 'change the arm this section names in runnerArmsOf in src/daemon/runner/runnerArms.ts, or the owner that arm calls'
}
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  const failureText = [detail, ownerHint].filter(part => part !== '').join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && failureText ? ` — ${failureText}` : ''}`)
}
const section = (t: string): void => {
  ownerHint = ownerHintOf(t)
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (value: unknown): string => JSON.stringify(value)
const UNSETTLED = Symbol('unsettled')
const within = <T,>(work: Promise<T> | T, ms = 3_000): Promise<T | typeof UNSETTLED> => Promise.race([Promise.resolve(work), new Promise<typeof UNSETTLED>(done => setTimeout(() => done(UNSETTLED), ms))])
setTimeout(() => {
  console.log('  [FAIL] the proof ended within its two minutes')
  console.log('  a step is still waiting: the last section header printed above names the arm; look there in src/daemon/runner/runnerArms.ts for a request that never answers')
  process.exit(1)
}, 120_000).unref()

type Call = { name: string; args: unknown[] }
const seen: Call[] = []
const answers = new Map<string, (...args: unknown[]) => unknown>()
const said = (name: string): Call[] => seen.filter(call => call.name === name)
const forget = (): void => {
  seen.length = 0
  answers.clear()
}

async function spied(rel: string, names: string[]): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const real = (await import(at(rel))) as Record<string, (...args: unknown[]) => unknown>
  const wrapped = Object.fromEntries(
    names.map(name => [
      name,
      (...args: unknown[]): unknown => {
        seen.push({ name, args })
        const answer = answers.get(name)
        return answer ? answer(...args) : undefined
      },
    ]),
  )
  mock.module(at(rel), () => ({ ...real, ...wrapped }))
  return real
}

await spied('src/crew/agents/operatorStop.ts', ['stopCrewmateByOperator'])
await spied('src/tools/crewmate/resumeCrewmate.ts', ['resumeCrewmateBackground'])
const sendNowReal = await spied('src/daemon/runner/sendNow.ts', ['sendQueuedWordsNow'])
await spied('src/commands/catalogue/commands.ts', ['clearCommandMemoizationCaches', 'getCommands'])
await spied('src/integrations/mcp/kitCompletion.ts', ['completeSessionKitFromRoster'])
await spied('src/platform/settings/config.ts', ['readGlobalConfigAgain'])
await spied('src/models/roads/anthropic/anthropicLimits.ts', ['resetLimitsForCredentialSwitch', 'anthropicObservedUsage', 'anthropicWindowFact'])
await spied('src/models/sign-in/lifecycle/oauthLifecycle.ts', ['dropCredentialMemos'])
await spied('src/models/roads/openai/openaiCatalogue.ts', ['readOpenaiAccountAgain', 'primeOpenaiCatalogue', 'openaiCatalogueFact'])
await spied('src/crew/crewmates/crewAccountChange.ts', ['noteCrewAccountChange'])
await spied('src/platform/processes/gracefulShutdown.ts', ['gracefulShutdownSync', 'gracefulShutdown'])
await spied('src/integrations/event-hooks/sessionHooks.ts', ['pruneSkillSessionHooks'])
await spied('src/integrations/mcp/serverConfigs.ts', ['setMcpServerEnabled'])
await spied('src/sessions/notices/unreadLedger.ts', ['noticeRows'])
await spied('src/models/roads/limitWarning.ts', ['providerLimitWarning'])
await spied('src/models/roads/openai/openaiLimitState.ts', ['openaiObservedUsage'])
await spied('src/engine/task-framework/tasks.ts', ['listSessionMission'])
await spied('src/integrations/samples/facts.ts', ['sampleRowsOf'])
await spied('src/models/roads/providerUsage.ts', ['anthropicSignInEmail'])
await spied('src/engine/connector/seatProjections.ts', ['effortSentOf'])
await spied('src/engine/connector/rosterTerms.ts', ['skillsRosterOf'])
await spied('src/integrations/skills/kitGovernance.ts', ['offSkillNamesOf'])
await spied('src/daemon/runner/model.ts', ['resolveHeadlessModel'])
await spied('src/sessions/transcripts/sessionHomePin.ts', ['consumeSessionHomePin'])
await spied('src/sessions/transcripts/sessionWriter.ts', ['claimSessionWriter'])
await spied('src/engine/system-prompt/systemPromptSections.ts', ['clearSystemPromptSections'])
await spied('src/sessions/resume/conversationRecovery.ts', ['loadConversationForResume'])
await spied('src/sessions/resume/sessionRestore.ts', ['restoreConversationModel', 'restoreSessionStateFromListing'])
await spied('src/boot/process-state/processState.ts', ['switchSession', 'setEngineModelOverride'])
await spied('src/sessions/transcripts/sessionStorage.ts', ['resetSessionFilePointer', 'restoreSessionMetadata', 'saveSessionModel'])
await spied('src/screen/cockpit/runtimePosture.ts', ['markSessionPermissionModeAtClaim'])
await spied('src/sessions/transcripts/sessionListings.ts', ['saveCustomTitle'])
await spied('src/daemon/runner/resume.ts', ['emitLoadError'])
let trusted: boolean | null = null
{
  const real = { ...((await import(at('src/platform/config/trust.ts'))) as { isPathTrusted: (path: string) => boolean }) }
  mock.module(at('src/platform/config/trust.ts'), () => ({ ...real, isPathTrusted: (path: string): boolean => (trusted === null ? real.isPathTrusted(path) : trusted) }))
}
async function lent(rel: string, names: string[]): Promise<void> {
  const real = { ...((await import(at(rel))) as Record<string, (...args: unknown[]) => unknown>) }
  mock.module(at(rel), () => ({ ...real, ...Object.fromEntries(names.map(name => [name, (...args: unknown[]): unknown => (answers.has(name) ? answers.get(name)!(...args) : real[name]!(...args))])) }))
}
await lent('src/sessions/transcripts/paths.ts', ['getProjectDir'])
await lent('src/daemon/concourse-workers/concourseWorkers.ts', ['readSessionWorkers', 'sessionOwnedByLiveWorker'])
await lent('src/daemon/control/controlSocket.ts', ['daemonControlRpc'])
await lent('src/permissions/rules/filesystem.ts', ['checkReadPermissionForTool'])

const { runnerArmsOf } = await import('../../src/daemon/runner/runnerArms.ts')
const { createRunnerState } = await import('../../src/daemon/runner/runnerPorts.ts')
const { RUNNER_NOTIFICATION_METHODS, RUNNER_REQUEST_METHODS } = await import('../../src/daemon/runner/runnerMethods.ts')
const { RPC_INVALID_PARAMS, RPC_REFUSED } = await import('../../src/daemon/runner-wire/errors.ts')
const { isLocalShellTask } = await import('../../src/engine/tasks/local-shell/shellTaskState.ts')
const { CREWMATE_INTERRUPT_BY_OPERATOR, CREWMATE_RESUME_NOTE, peekOperatorMessages } = await import('../../src/engine/tasks/local-agent/crewmateTask.tsx')
const { drainRows } = await import('../../src/daemon/runner/sdkEventQueue.ts')
const { dequeue, enqueue } = await import('../../src/daemon/runner/messageQueueManager.ts')
const { runnerParkRefusal } = await import('../../src/daemon/runner/parkRefusal.ts')
const { landSpawnSwitch } = await import('../../src/daemon/runner/spawnSwitchLanding.ts')
const lawful = await import('../../src/models/roads/lawfulPrefixChange.ts')
const switches = await import('../../src/daemon/switchboard/spawnSwitches.ts')
const { capabilityHoldWords, runnerCapabilityHolds } = await import('../../src/daemon/runner-link/runnerCapabilityCensus.ts')
const { sessionKitOf, setProcessSessionKit } = await import('../../src/integrations/mcp/sessionKitPin.ts')
const { answerSessionFacts } = await import('../../src/daemon/runner/sessionFactsArm.ts')
const { sessionFactsFromWire, sessionFactsToWire } = await import('../../src/engine/connector/seatWire.ts')
const { getOriginalCwd, getSessionId } = await import('../../src/boot/process-state/processState.ts')
const { getEngineModel } = await import('../../src/models/catalogue/engineModel.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { claimSession } = await import('../../src/daemon/runner/claimSession.ts')
const { clearModeTransitions, modeTransitions } = await import('../../src/permissions/rules/modeTransitions.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { openaiCatalogueFromWire } = await import('../../src/engine/connector/seatWire.ts')

type Ports = Parameters<typeof runnerArmsOf>[0]
type Refusal = { code?: number; message?: string; data?: { kind?: string } }

function stubPorts(given: Record<string, unknown> = {}): { ports: Ports; live: Ports['live']; used: Call[] } {
  const used: Call[] = []
  const recorder = (name: string): unknown =>
    new Proxy(function () {}, {
      apply: (_target, _self, args: unknown[]) => {
        used.push({ name, args })
        seen.push({ name: `port:${name}`, args })
        return undefined
      },
      get: (_target, key) => (typeof key === 'symbol' || key === 'then' ? undefined : recorder(`${name}.${key}`)),
    })
  const held: Record<string, unknown> = { live: createRunnerState(), interruptOutcomes: new Map<string, boolean>(), ...given }
  const made = new Map<string, unknown>()
  const ports = new Proxy(held, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      if (!made.has(key)) made.set(key, recorder(key))
      return made.get(key)
    },
  })
  return { ports: ports as never, live: held.live as Ports['live'], used }
}

type Store = { state: { tasks: Record<string, Record<string, unknown>> }; get: () => never; set: (updater: (previous: never) => never) => void; sets: number }
function storeOf(tasks: Record<string, Record<string, unknown>>): Store {
  const store: Store = {
    state: { tasks },
    get: () => store.state as never,
    set: updater => {
      store.sets++
      store.state = (updater as (previous: unknown) => Store['state'])(store.state)
    },
    sets: 0,
  }
  return store
}
const agentTask = (id: string, status = 'running'): Record<string, unknown> => ({ id, type: 'local_agent', status, description: `Lane ${id}`, agentId: id, agentType: 'mercury-crew', prompt: '', startTime: Date.now(), isBackgrounded: true, outputFile: '', outputOffset: 0, notified: false, abortController: new AbortController() })
const shellTask = (id: string, status = 'running'): Record<string, unknown> => ({ id, type: 'local_bash', status, description: `Shell ${id}`, command: 'sleep 60', startTime: Date.now(), outputFile: '', outputOffset: 0, notified: false })
const ref = { id: 7 }
const signalOf = (): AbortSignal => new AbortController().signal
const refusalOf = async (answer: unknown): Promise<Refusal | null> => {
  try {
    await answer
    return null
  } catch (error) {
    return error as Refusal
  }
}
const usedNames = (used: Call[]): string => used.map(call => call.name).join(' ')

section('§1 the table: every method a host sends has an arm')
{
  const arms = runnerArmsOf(stubPorts().ports)
  const wanted = [...RUNNER_REQUEST_METHODS, ...RUNNER_NOTIFICATION_METHODS].sort()
  check(`runnerArmsOf answers one arm for each of the ${wanted.length} host methods but initialize and $/cancel_request, each a function, and no other`, j(Object.keys(arms).sort()) === j(wanted) && Object.values(arms).every(arm => typeof arm === 'function'), j(Object.keys(arms).sort()))
}

section('§2 turn/interrupt: the in-flight request and the note being left are aborted, the hold is released, and only a hard one kills shells')
{
  const scene = (): { store: Store; flight: AbortController; leave: AbortController; kills: unknown[][]; arms: ReturnType<typeof runnerArmsOf>; live: Ports['live']; used: Call[] } => {
    const store = storeOf({ a1: agentTask('a1'), s1: shellTask('s1'), s2: shellTask('s2', 'completed') })
    const kills: unknown[][] = []
    const { ports, live, used } = stubPorts({ getAppState: store.get, setAppState: store.set, isLocalShellTask, killTask: (...args: unknown[]) => (kills.push(args), Promise.resolve()) })
    const flight = new AbortController()
    const leave = new AbortController()
    live.inFlightAbort = flight
    live.leaveAbort = leave
    return { store, flight, leave, kills, arms: runnerArmsOf(ports), live, used }
  }
  forget()
  const soft = scene()
  const answer = await soft.arms['turn/interrupt']({}, ref, signalOf())
  const agent = soft.store.state.tasks.a1!.abortController as AbortController
  check(
    "the runner's interrupt aborts the in-flight request and the note being left at exit, and releases the driver's hold — and leaves the running agents alone (the controller law: they run on under their own controllers)",
    j(answer) === j({ interrupted: true }) && soft.flight.signal.aborted && soft.leave.signal.aborted && (soft.leave.signal.reason as Error).message === 'the handoff was skipped by ctrl-c' && usedNames(soft.used) === 'driver.releaseHold' && !agent.signal.aborted && soft.store.sets === 0,
    `${j(answer)} · flight ${soft.flight.signal.aborted} · leave ${soft.leave.signal.aborted} · ports ${usedNames(soft.used)} · agent ${agent.signal.aborted} · writes ${soft.store.sets}`,
  )
  check("the runner's interrupt releases the driver's hold and stops no task", soft.used.filter(call => call.name === 'driver.releaseHold').length === 1 && soft.kills.length === 0 && soft.store.sets === 0 && said('stopCrewmateByOperator').length === 0, `${usedNames(soft.used)} · kills ${soft.kills.length}`)
  check('…and never ends the process: no shutdown, no exit, no end-session signal in the handler', said('gracefulShutdownSync').length === 0 && said('gracefulShutdown').length === 0 && !soft.live.inputClosed)
  const hard = scene()
  await hard.arms['turn/interrupt']({ hard: true }, ref, signalOf())
  check("a HARD interrupt is the one that kills the shells the turn left running (the shell task owner's kill road)", hard.kills.length === 1 && hard.kills[0]![0] === 's1' && hard.kills[0]![1] === hard.store.set && soft.kills.length === 0, j(hard.kills.map(args => args[0])))
  const idle = scene()
  idle.live.inFlightAbort = null
  idle.live.leaveAbort = null
  const none = await idle.arms['turn/interrupt']({}, ref, signalOf())
  check('with nothing in flight the interrupt answers false and still releases the hold', j(none) === j({ interrupted: false }) && usedNames(idle.used) === 'driver.releaseHold', `${j(none)} · ${usedNames(idle.used)}`)
  const other = scene()
  other.live.currentTurnId = 'turn-now'
  const missed = await other.arms['turn/interrupt']({ turn_id: 'turn-before' }, ref, signalOf())
  check('an interrupt aimed at another turn aborts nothing and releases nothing', j(missed) === j({ interrupted: false }) && !other.flight.signal.aborted && other.used.length === 0, `${j(missed)} · ${usedNames(other.used)}`)
  const twice = scene()
  const first = await twice.arms['turn/interrupt']({ op_id: 'op-1' }, ref, signalOf())
  twice.live.inFlightAbort = new AbortController()
  const again = await twice.arms['turn/interrupt']({ op_id: 'op-1' }, ref, signalOf())
  check('the same operation sent twice is answered from the first and interrupts nothing new', j(first) === j({ interrupted: true }) && j(again) === j({ interrupted: true }) && !twice.live.inFlightAbort.signal.aborted && twice.used.length === 1, `${j(first)} ${j(again)} · ${usedNames(twice.used)}`)
}

section('§3 agent/stop: the one operator-stop owner, its reason, and its answer either way')
{
  const store = storeOf({ a1: agentTask('a1') })
  const rows: unknown[] = []
  const { ports } = stubPorts({ getAppState: store.get, setAppState: store.set, enqueueRow: (row: unknown) => rows.push(row) })
  const arms = runnerArmsOf(ports)
  forget()
  answers.set('stopCrewmateByOperator', async () => ({ outcome: 'applied', kind: 'agent', status: 'killed' }))
  const applied = await arms['agent/stop']({ agent_id: 'a1' }, ref, signalOf())
  const plain = said('stopCrewmateByOperator')[0]
  const context = plain?.args[1] as { getAppState?: unknown; setAppState?: unknown } | undefined
  await arms['agent/stop']({ agent_id: 'a1', note: CREWMATE_INTERRUPT_BY_OPERATOR }, ref, signalOf())
  await arms['agent/stop']({ agent_id: 'a1', note: 'some other words' }, ref, signalOf())
  const reasons = said('stopCrewmateByOperator').map(call => j(call.args[2]))
  answers.set('stopCrewmateByOperator', async () => ({ outcome: 'refused', reason: 'Lane a1 is not running (status: completed) — nothing to stop' }))
  const refusedStop = await refusalOf(arms['agent/stop']({ agent_id: 'a1' }, ref, signalOf()))
  check(
    "the runner's stop_task rides the one operator-stop owner and answers applied or refused with its reason",
    j(applied) === j({ receipt: 'applied', kind: 'agent', status: 'killed' }) && plain?.args[0] === 'a1' && context?.getAppState === store.get && context.setAppState === store.set && refusedStop?.code === RPC_REFUSED && refusedStop.data?.kind === 'agent' && refusedStop.message === 'Lane a1 is not running (status: completed) — nothing to stop',
    `${j(applied)} · ${j(refusedStop)}`,
  )
  check('the typed note rides the stop verb into the runner as the operator-interrupt reason, and no other note does', j(reasons) === j([j({}), j({ reason: CREWMATE_INTERRUPT_BY_OPERATOR }), j({})]), j(reasons))
  drainRows()
}

section('§4 agent/resume: a running crewmate is told, a stopped one rides the one resume owner')
{
  const store = storeOf({ a1: agentTask('a1'), s1: shellTask('s1') })
  const standing = { toolUseId: 'stale-call', marker: 'the relaunch context' }
  const canUseTool = (): void => {}
  const order: string[] = []
  const { ports, live } = stubPorts({
    getAppState: store.get,
    setAppState: store.set,
    canUseTool,
    options: { initializeMcp: async () => void order.push('initializeMcp') },
    relaunchContext: async () => (order.push('relaunchContext'), standing),
  })
  const arms = runnerArmsOf(ports)
  forget()
  const queued = await arms['agent/resume']({ agent_id: 'a1', note: '  look at the parser  ' }, ref, signalOf())
  check("the runner's resume_task queues a note for a RUNNING agent into the operator lane and answers queued", j(queued) === j({ queued: true, agent_id: 'a1' }) && j(peekOperatorMessages(store.state.tasks.a1)) === j(['look at the parser']) && said('resumeCrewmateBackground').length === 0, `${j(queued)} · ${j(peekOperatorMessages(store.state.tasks.a1))}`)
  const noNote = await refusalOf(arms['agent/resume']({ agent_id: 'a1' }, ref, signalOf()))
  const notAgent = await refusalOf(arms['agent/resume']({ agent_id: 's1', note: 'words' }, ref, signalOf()))
  check('a running agent with no note still answers the old refusal', noNote?.code === RPC_REFUSED && noNote.data?.kind === 'agent' && noNote.message === 'the crewmate is running — nothing to resume' && notAgent?.message === noNote.message, `${j(noNote)} · ${j(notAgent)}`)
  live.awaitingSessionClaim = true
  const early = await refusalOf(arms['agent/resume']({ agent_id: 'gone' }, ref, signalOf()))
  live.awaitingSessionClaim = false
  check('before the claim there is nothing to resume from, and the owner is not reached', early?.code === RPC_REFUSED && early.data?.kind === 'nothing-to-resume' && said('resumeCrewmateBackground').length === 0 && order.length === 0, j(early))
  answers.set('resumeCrewmateBackground', async () => ({ agentId: 'gone', outputFile: '/out/gone.md', description: 'Lane gone', note: ' (in the session folder)', cwdFallback: '/session', recordedCwd: '/recorded' }))
  const resumed = await arms['agent/resume']({ agent_id: 'gone' }, ref, signalOf())
  const asked = said('resumeCrewmateBackground')[0]?.args[0] as { agentId?: string; prompt?: string; replyTarget?: string; canUseTool?: unknown; toolUseContext?: Record<string, unknown> } | undefined
  check(
    "the runner's resume_task rides the one resume owner with the resume note and the runner's own permission road",
    asked?.agentId === 'gone' && asked.prompt === CREWMATE_RESUME_NOTE && asked.replyTarget === 'parent' && asked.canUseTool === canUseTool && asked.toolUseContext?.marker === 'the relaunch context' && !('toolUseId' in (asked.toolUseContext ?? {})) && asked.toolUseContext?.abortController instanceof AbortController && j(order) === j(['initializeMcp', 'relaunchContext']),
    `${j({ ...asked, canUseTool: asked?.canUseTool === canUseTool })} · ${j(order)}`,
  )
  check('the crew resume answer carries the note and recorded directory', j(resumed) === j({ agent_id: 'gone', output_file: '/out/gone.md', cwd_fallback: '/session', recorded_cwd: '/recorded', note: ' (in the session folder)' }), j(resumed))
  const receipt = dequeue(command => typeof command.value === 'string' && command.value.includes('<task-id>gone</task-id>'))
  await arms['agent/resume']({ agent_id: 'gone', note: 'carry on with the tests' }, ref, signalOf())
  const withNote = said('resumeCrewmateBackground')[1]?.args[0] as { prompt?: string; replyTarget?: string } | undefined
  const second = dequeue(command => typeof command.value === 'string' && command.value.includes('<task-id>gone</task-id>'))
  check("a resume with the operator's own words sends those words, answers to the operator, and leaves no receipt row of its own", withNote?.prompt === 'carry on with the tests' && withNote.replyTarget === 'operator' && receipt !== undefined && String(receipt.value).includes('(in the session folder)') && second === undefined, `${j(withNote)} · receipt ${receipt !== undefined} · second ${second !== undefined}`)
  const owner = (await import('../../src/tools/crewmate/resumeCrewmate.ts')) as { CrewmateNotRecorded?: new (message: string) => Error }
  const NotRecorded = owner.CrewmateNotRecorded ?? Error
  answers.set('resumeCrewmateBackground', async () => Promise.reject(new NotRecorded('No transcript found for crewmate a-none')))
  const unrecorded = await refusalOf(arms['agent/resume']({ agent_id: 'a-none' }, ref, signalOf()))
  answers.set('resumeCrewmateBackground', async () => Promise.reject(new Error('the resume owner broke')))
  const broken = await refusalOf(arms['agent/resume']({ agent_id: 'a-none' }, ref, signalOf()))
  check("agent/resume for a crewmate nothing recorded answers the typed refusal of kind agent with the owner's sentence, and a fault of the owner stays a fault", owner.CrewmateNotRecorded !== undefined && unrecorded?.code === RPC_REFUSED && unrecorded.data?.kind === 'agent' && unrecorded.message === 'No transcript found for crewmate a-none' && broken?.code === undefined && broken?.message === 'the resume owner broke', `${j({ code: unrecorded?.code, kind: unrecorded?.data?.kind, message: unrecorded?.message })} · ${j({ code: broken?.code, message: broken?.message })}`)
}

section('§4b project/query: a folder nobody trusted, a parameter that is missing or malformed, and what the project does not hold or will not serve')
{
  const { ports } = stubPorts({ getAppState: () => ({ toolPermissionContext: {} }) })
  const query = (params: Record<string, unknown>): Promise<Refusal | null> => refusalOf(runnerArmsOf(ports)['project/query'](params as never, ref, signalOf()))
  const shown = (answer: Refusal | null): string => j({ code: answer?.code, message: answer?.message, data: answer?.data })
  trusted = false
  const untrusted = await query({ op: 'sessions' })
  check('project/query in a folder nobody trusted answers the typed refusal of kind trust with the sentence it printed', untrusted?.code === RPC_REFUSED && untrusted.data?.kind === 'trust' && untrusted.message === 'Trust this folder in Mercury before serving its project', j({ code: untrusted?.code, kind: untrusted?.data?.kind, message: untrusted?.message }))

  trusted = true
  forget()
  const projects = mkdtempSync(join(tmpdir(), 'runner-arms-project-'))
  const SAVED = '11111111-2222-4333-8444-555555555555'
  const UNSAVED = '99999999-8888-4777-a666-555555555555'
  const NEEDS_ID = 'A session_id UUID is required'
  const NEEDS_BOTH = 'sender and message are required'
  const NEEDS_REF = 'A mercury:// reference is required'
  writeFileSync(join(projects, `${SAVED}.jsonl`), '')
  answers.set('getProjectDir', () => projects)
  const WIRE_FORM = 'invalid params for project/query'
  const badParameter = (answer: Refusal | null, sentence: string, ...paths: string[]): boolean => answer?.code === RPC_INVALID_PARAMS && answer.message === WIRE_FORM && j(answer.data) === j({ method: 'project/query', issues: paths.map(path => ({ path, message: sentence })) })
  const notServed = (answer: Refusal | null, sentence: string): boolean => answer?.code === RPC_REFUSED && j(answer.data) === j({ kind: 'project' }) && answer.message === sentence
  const held: Array<{ name: string; answer: Refusal | null; ok: boolean }> = []
  const hold = async (name: string, params: Record<string, unknown>, ok: (answer: Refusal | null) => boolean): Promise<void> => {
    const answer = await query(params)
    held.push({ name, answer, ok: ok(answer) })
  }
  await hold('rows with no session_id', { op: 'rows' }, answer => badParameter(answer, NEEDS_ID, 'session_id'))
  await hold('rows with a session_id that is no UUID', { op: 'rows', session_id: 'not-a-uuid' }, answer => badParameter(answer, NEEDS_ID, 'session_id'))
  await hold('send with no sender', { op: 'send', session_id: SAVED, message: 'words' }, answer => badParameter(answer, NEEDS_BOTH, 'sender'))
  await hold('send with no message', { op: 'send', session_id: SAVED, sender: 'a-client' }, answer => badParameter(answer, NEEDS_BOTH, 'message'))
  await hold('send with neither', { op: 'send', session_id: SAVED }, answer => badParameter(answer, NEEDS_BOTH, 'sender', 'message'))
  await hold('recall with no query', { op: 'recall' }, answer => badParameter(answer, 'query is required', 'query'))
  await hold('resource with no ref', { op: 'resource' }, answer => badParameter(answer, NEEDS_REF, 'ref'))
  await hold('resource with a ref that is no mercury:// reference', { op: 'resource', ref: 'https://example.test/x' }, answer => badParameter(answer, NEEDS_REF, 'ref'))
  await hold('resource with a transcript reference whose id is no UUID', { op: 'resource', ref: 'mercury://transcript/session/not-a-uuid' }, answer => badParameter(answer, NEEDS_ID, 'ref'))
  const parameters = held.splice(0)
  check(
    "project/query refuses a parameter that is missing or malformed in the wire's one form for bad parameters: the code -32602, invalid params for project/query as the message, and in data.issues the sentence it printed beside the parameter's name: session_id, sender, message, query and ref",
    parameters.length === 9 && parameters.every(one => one.ok),
    parameters.filter(one => !one.ok).map(one => `${one.name}: ${shown(one.answer)}`).join(' · '),
  )

  type WorkerRecord = ReturnType<typeof import('../../src/daemon/concourse-workers/concourseWorkers.ts').readSessionWorkers>[string]
  type DaemonAnswer = Awaited<ReturnType<typeof import('../../src/daemon/control/controlSocket.ts').daemonControlRpc>>
  type ReadDecision = ReturnType<typeof import('../../src/permissions/rules/filesystem.ts').checkReadPermissionForTool>
  const elsewhere = { sessionId: SAVED, workspaceId: join(tmpdir(), 'another-project') } satisfies Pick<WorkerRecord, 'sessionId' | 'workspaceId'>
  const here = { sessionId: SAVED, workspaceId: getOriginalCwd() } satisfies Pick<WorkerRecord, 'sessionId' | 'workspaceId'>
  const daemonSaysNo = { ok: false, code: 'EREFUSED', error: 'the session is held by another caller' } satisfies DaemonAnswer
  const daemonUnreached = { ok: false, code: 'ENOCONN', error: 'the daemon is not reachable (ENOCONN)' } satisfies DaemonAnswer
  const denied = { behavior: 'deny', message: 'Permission to read that file has not been granted.', decisionReason: { type: 'other', reason: 'a deny rule of this proof' } } satisfies ReadDecision
  const allowed = { behavior: 'allow' } satisfies ReadDecision
  const letter = { op: 'send', session_id: SAVED, sender: 'a-client', message: 'words' }
  await hold('rows of a session that is not saved', { op: 'rows', session_id: UNSAVED }, answer => notServed(answer, `No saved session ${UNSAVED} in this project`))
  await hold('a transcript reference to a session that is not saved', { op: 'resource', ref: `mercury://transcript/session/${UNSAVED}` }, answer => notServed(answer, `No saved session ${UNSAVED} in this project`))
  await hold('send to a session that is not live', letter, answer => notServed(answer, `Session ${SAVED} is not live`))
  answers.set('sessionOwnedByLiveWorker', () => 'runner-1')
  answers.set('readSessionWorkers', () => ({ 'runner-1': elsewhere }))
  await hold('send to a session of another project', letter, answer => notServed(answer, 'The session belongs to another project'))
  answers.set('readSessionWorkers', () => ({ 'runner-1': here }))
  answers.set('daemonControlRpc', async () => daemonSaysNo)
  await hold('send that the daemon does not take', letter, answer => notServed(answer, daemonSaysNo.error))
  answers.set('checkReadPermissionForTool', () => denied)
  await hold('a file the read rules do not allow', { op: 'resource', ref: 'mercury://file/README.md' }, answer => notServed(answer, denied.message))
  answers.set('checkReadPermissionForTool', () => allowed)
  await hold('a file outside the project', { op: 'resource', ref: 'mercury://file/../outside.txt' }, answer => notServed(answer, 'File resources must stay inside this project'))
  const refusals = held.splice(0)
  check(
    'project/query refuses what the project does not hold or will not serve with the typed refusal of kind project and the sentence it printed: a session that is not saved, by its id and by a transcript reference, a session that is not live, a session of another project, a message the daemon does not take, a file the read rules do not allow, a file outside the project',
    refusals.length === 7 && refusals.every(one => one.ok),
    refusals.filter(one => !one.ok).map(one => `${one.name}: ${shown(one.answer)}`).join(' · '),
  )
  answers.set('daemonControlRpc', async () => daemonUnreached)
  const unreached = await query(letter)
  check('a daemon that cannot be reached stays a fault of the run: the sentence with no code and no kind, which the wire sends as the internal error', unreached !== null && unreached.code === undefined && unreached.data === undefined && unreached.message === daemonUnreached.error, shown(unreached))
  {
    const net = await import('node:net')
    const socket = (await import(at('src/daemon/control/controlSocket.ts'))) as typeof import('../../src/daemon/control/controlSocket.ts')
    const { forwardFrame } = await import('../../src/daemon/control/handover.ts')
    const daemonHome = mkdtempSync(join(tmpdir(), 'arms-d-'))
    const daemonDirBefore = process.env.MERCURY_DAEMON_DIR
    process.env.MERCURY_DAEMON_DIR = daemonHome
    const answering = async (reply: string, path: string): Promise<import('node:net').Server> => {
      const server = net.createServer(sock => {
        sock.on('error', () => {})
        sock.on('data', () => sock.write(reply))
      })
      await new Promise<void>(done => server.listen(path, done))
      return server
    }
    const codeOf = (reply: unknown): string => String((reply as { ok?: unknown; code?: unknown }).ok === false ? (reply as { code?: unknown }).code : 'answered')
    const garbled = await answering('not a reply\n', socket.controlSockPath())
    answers.delete('daemonControlRpc')
    const pinged = await socket.daemonControlRpc({ op: 'ping' } as never, { timeoutMs: 2_000 })
    const malformed = await query(letter)
    const forwarded = await forwardFrame(socket.controlSockPath(), j({ op: 'ping' }), 2_000)
    await new Promise<void>(done => garbled.close(() => done()))
    const swollenPath = process.platform === 'win32' ? `\\\\.\\pipe\\runner-arms-swollen-${process.pid}` : join(daemonHome, 'b.sock')
    const swollen = await answering('x'.repeat((1 << 20) + 64), swollenPath)
    const overCap = await forwardFrame(swollenPath, j({ op: 'ping' }), 5_000)
    await new Promise<void>(done => swollen.close(() => done()))
    const { startControlServer } = await import('../../src/daemon/control/controlServer.ts')
    const daemon = await startControlServer({} as never)
    const tooLong = await query({ ...letter, message: 'x'.repeat(1 << 21) })
    await daemon.close()
    const key = await socket.mintControlKey()
    socket.clearControlKeyMemo()
    let dispatched: () => Promise<{ ok: false; error: string }> = async () => ({ ok: false, error: daemonSaysNo.error })
    const hosting = await startControlServer({ isReady: () => true, controlKey: key, concourseDispatch: () => dispatched() } as never)
    const refusedDispatch = await socket.daemonControlRpc({ op: 'sessionDispatch', clientMessageId: 'runner-arms-1', targetSessionId: SAVED, workspaceDir: getOriginalCwd(), prompt: 'words', origin: { kind: 'outside-report', sender: 'a-client', via: 'mcp-server' }, by: 'mcp:a-client' } as never, { timeoutMs: 5_000 })
    const notTaken = await query(letter)
    dispatched = async () => { throw new Error('boom') }
    const thrownInside = await query(letter)
    await hosting.close()
    rmSync(socket.controlSockPath(), { force: true })
    const older = await answering(`${j({ ok: false, code: 'EUNKNOWN', error: 'unknown op: sessionDispatch' })}\n`, socket.controlSockPath())
    const tooOld = await query(letter)
    await new Promise<void>(done => older.close(() => done()))
    if (daemonDirBefore === undefined) delete process.env.MERCURY_DAEMON_DIR
    else process.env.MERCURY_DAEMON_DIR = daemonDirBefore
    rmSync(daemonHome, { recursive: true, force: true })
    check(
      "a reply on the daemon's socket that cannot be read is a fault on the caller's side with a code of its own (EBADMSG), never a code the daemon's own refusals carry: the socket's client names it for a frame that is no JSON, and the forwarding daemon for one that is no JSON and one past the frame cap",
      codeOf(pinged) === 'EBADMSG' && codeOf(forwarded) === 'EBADMSG' && codeOf(overCap) === 'EBADMSG',
      j({ client: pinged, forwarder: forwarded, pastTheCap: overCap }),
    )
    check('project/query answers a reply of the daemon that cannot be read as a fault of the run: the sentence with no code and no kind, which the wire sends as the internal error', malformed !== null && malformed.code === undefined && malformed.data === undefined && malformed.message === 'malformed daemon reply', shown(malformed))
    check("a message that makes the frame to the daemon larger than its cap is the caller's to shorten: the daemon's own control server, asked over its socket, refuses the frame, and project/query answers -32602 on message with the daemon's sentence", badParameter(tooLong, 'request exceeds 1MB — shorten the prompt or send in parts', 'message'), shown(tooLong))
    check(
      "the daemon's own control server answers a dispatch it will not take with a code of its own (EREFUSED), and project/query reads that code alone as the refusal of kind project",
      codeOf(refusedDispatch) === 'EREFUSED' && notServed(notTaken, daemonSaysNo.error),
      j({ daemon: refusedDispatch, arm: notTaken === null ? null : { code: notTaken.code, message: notTaken.message, data: notTaken.data } }),
    )
    const fault = (answer: Refusal | null, words: RegExp): boolean => answer !== null && answer.code === undefined && answer.data === undefined && words.test(answer.message)
    check(
      'a throw inside the daemon and a daemon too old for the verb are faults of the run, never refusals: each the sentence with no code and no kind, which the wire sends as the internal error',
      fault(thrownInside, /^daemon error — boom$/) && fault(tooOld, /^the daemon is an older build/),
      `${shown(thrownInside)} · ${shown(tooOld)}`,
    )
  }
  rmSync(projects, { recursive: true, force: true })
  forget()
  trusted = null
}

section('§5 session/send_now: only while a turn is in flight, from the one send-now function')
{
  const store = storeOf({})
  const { ports, live } = stubPorts({ getAppState: store.get, setAppState: store.set })
  const arms = runnerArmsOf(ports)
  forget()
  const sent = { queued: 2, released: 2, crewmates: 1, shells: 0 }
  answers.set('sendQueuedWordsNow', () => sent)
  const idle = await arms['session/send_now']({}, ref, signalOf())
  const idleCalls = said('sendQueuedWordsNow').length
  live.inFlightAbort = new AbortController()
  const flying = await arms['session/send_now']({}, ref, signalOf())
  const call = said('sendQueuedWordsNow')[0]
  check(
    'the runner answers session/send_now only while a turn is in flight, from the one send-now function',
    idle === sendNowReal.SEND_NOW_NOTHING_QUEUED && idleCalls === 0 && flying === sent && said('sendQueuedWordsNow').length === 1 && call?.args[0] === store.get && call.args[1] === store.set,
    `${j(idle)} · ${idleCalls} · ${j(flying)}`,
  )
}

section('§6 session/set_kit: the serialized MCP lane, the command memos, and the completion of an unresolved kit')
{
  const kit = { schema: 1, mcp: [], skills: [], invocable: [] }
  const unresolved = { ...kit, resolved: false, deltas: { mcpOff: [], skillStates: {}, extensionsOff: [] } }
  const commands = [{ name: 'fresh-command' }]
  const scene = (run: boolean): { arms: ReturnType<typeof runnerArmsOf>; live: Ports['live']; lane: number[]; store: Store } => {
    const store = storeOf({})
    ;(store.state as Record<string, unknown>).mcp = { clients: [], tools: [], commands: [], resources: {} }
    const lane: number[] = []
    const { ports, live } = stubPorts({ getAppState: store.get, setAppState: store.set, serializeMcpChange: (operation: () => Promise<unknown>) => (lane.push(seen.length), run ? operation() : Promise.resolve({ applied: true, connected: [], disconnected: [], errors: {} })) })
    return { arms: runnerArmsOf(ports), live, lane, store }
  }
  forget()
  answers.set('getCommands', async () => commands)
  setProcessSessionKit({ schema: 1, mcp: [], skills: ['held-before'], invocable: [] } as never)
  const parked = scene(false)
  await parked.arms['session/set_kit']({ kit }, ref, signalOf())
  const untouched = j(sessionKitOf()?.skills)
  const ran = scene(true)
  const answer = await ran.arms['session/set_kit']({ kit }, ref, signalOf())
  check('H1b the kit_edit arm exists and rides the serialized MCP mutation lane', untouched === j(['held-before']) && parked.lane.length === 1 && seen.length > 0 && ran.lane.length === 1 && j(sessionKitOf()?.skills) === j([]) && j(answer) === j({ applied: true, connected: [], disconnected: [], errors: {} }), `before the lane ran ${untouched} · after ${j(sessionKitOf()?.skills)} · ${j(answer)}`)
  const cleared = seen.findIndex(call => call.name === 'clearCommandMemoizationCaches')
  const read = seen.findIndex(call => call.name === 'getCommands')
  check('H1d the reconcile clears the command memos (the per-cwd model-list memo included)', cleared !== -1 && read > cleared && ran.live.activeCommands === (commands as never) && said('pruneSkillSessionHooks').length === 1, `cleared at ${cleared}, read at ${read}`)
  const resolvedCalls = said('completeSessionKitFromRoster').length
  forget()
  answers.set('getCommands', async () => commands)
  answers.set('completeSessionKitFromRoster', () => ({ ...kit, skills: ['fresh-command'] }))
  const open = scene(true)
  await open.arms['session/set_kit']({ kit: unresolved }, ref, signalOf())
  const completion = said('completeSessionKitFromRoster')[0]?.args as [{ resolved?: boolean }, { commands?: unknown; mcpNames?: unknown }] | undefined
  check('H1e the completion replay is guarded to the unresolved arm only', resolvedCalls === 0 && said('completeSessionKitFromRoster').length === 1 && completion?.[0].resolved === false && completion[1].commands === commands && j(completion[1].mcpNames) === j([]) && sessionKitOf()?.resolved === undefined && j(sessionKitOf()?.skills) === j(['fresh-command']), `${resolvedCalls} · ${said('completeSessionKitFromRoster').length} · ${j(sessionKitOf())}`)
  const bad = await refusalOf(ran.arms['session/set_kit']({ kit: { schema: 2 } }, ref, signalOf()))
  check('a kit the grammar refuses is refused as a kit, inside the lane', bad?.code === RPC_REFUSED && bad.data?.kind === 'kit' && String(bad.message).startsWith('kit refused — ') && ran.lane.length === 2, j(bad))
}

section('§7 credentials/changed: every memo of the old account is dropped, in one arm')
{
  const arms = runnerArmsOf(stubPorts().ports)
  forget()
  const arm = arms['credentials/changed'] as (typeof arms)['credentials/changed'] | undefined
  const answer = typeof arm === 'function' ? await arm({}) : 'no arm'
  const order = seen.map(call => call.name)
  check("the runner's control loop takes a credentials/changed notification", typeof arm === 'function' && answer === undefined && RUNNER_NOTIFICATION_METHODS.includes('credentials/changed'), String(answer))
  check('…and resets the limit verdict and drops its credential memos there', order.includes('resetLimitsForCredentialSwitch') && order.includes('dropCredentialMemos') && order.indexOf('readGlobalConfigAgain') === 0, j(order))
  check("the runner's credential_change arm reads the OpenAI account again beside the Anthropic reset", order.includes('readOpenaiAccountAgain') && order.indexOf('readOpenaiAccountAgain') > order.indexOf('resetLimitsForCredentialSwitch') && order.includes('noteCrewAccountChange'), j(order))
}

section('§8 session/facts: each fact comes from its one owner, and a fact its owner does not hold is absent')
{
  const appState = { mcp: { clients: [], tools: [] }, toolPermissionContext: { mode: 'implement' }, effortValue: 'xhigh', tasks: {}, fileHistory: { snapshots: [], trackedFiles: new Set<string>(), rewindUndo: undefined } }
  const scene = (): { ports: Ports; live: Ports['live']; used: Call[] } => stubPorts({ getAppState: () => appState, liveMcp: { addedAt: new Map() }, mcpSignIns: new Map(), messages: [], missionGuard: { missionCardView: () => null } })
  const tasks = [{ id: '1', subject: 'S'.repeat(140), status: 'in_progress', blocks: ['2'], blockedBy: [], metadata: { ledger: ' the ledger ' } }, { id: '2', subject: 'second', activeForm: 'Seconding', status: 'pending', blocks: [], blockedBy: ['1'], metadata: {} }]
  type Owned<Owner extends (...args: never[]) => unknown> = NonNullable<Awaited<ReturnType<Owner>>>
  const held = {
    noticeRows: [{ key: 'n-1', state: 'unread', summary: 'a notice the owner holds' }],
    providerLimitWarning: { provider: 'anthropic', text: 'the warning the owner holds' } satisfies Owned<typeof import('../../src/models/roads/limitWarning.ts').providerLimitWarning>,
    anthropicObservedUsage: { owner: 'the owner of the observation', fiveHour: { utilization: 0.41, resetsAt: 1_800_000_000, observedAtMs: 1_700_000_000_000 } } satisfies Owned<typeof import('../../src/models/roads/anthropic/anthropicLimits.ts').anthropicObservedUsage>,
    anthropicWindowFact: { status: 'allowed_warning', observedAtMs: 1_700_000_000_000, owner: 'the owner of the window' } satisfies Owned<typeof import('../../src/models/roads/anthropic/anthropicLimits.ts').anthropicWindowFact>,
    openaiCatalogueFact: { sourceKind: 'api-key', models: [{ id: 'gpt-fixture', displayName: 'GPT Fixture', supportedReasoningEfforts: ['low', 'high'], reasoningEffortsStated: true }], fetchedAtMs: 1_700_000_000_000 } satisfies Owned<typeof import('../../src/models/roads/openai/openaiCatalogue.ts').openaiCatalogueFact>,
    openaiObservedUsage: { primary: { used: 41 } },
    sampleRowsOf: [{ id: 'sample-1', title: 'the sample the owner holds' }],
    anthropicSignInEmail: 'who@example.test',
    effortSentOf: 'high',
    skillsRosterOf: [{ name: 'the roster the owner holds' }],
    offSkillNamesOf: ['a-skill-that-is-off'],
  }
  const arm = (): void => {
    forget()
    for (const [name, value] of Object.entries(held)) answers.set(name, () => value)
    answers.set('listSessionMission', async () => tasks)
    answers.set('sampleRowsOf', async () => held.sampleRowsOf)
  }
  arm()
  const full = scene()
  full.live.activeModel = 'the-seat-model'
  full.live.activeCommands = [{ name: 'first-skill' }, { name: 'second-skill' }] as never
  const wire = await answerSessionFacts(full.ports)
  const facts = sessionFactsFromWire(wire)
  const got = facts as unknown as Record<string, unknown> & { usage: Record<string, unknown>; identity: Record<string, unknown> }
  check('the session_facts arm is found, and the answer is sent through the wire codec', facts !== null && 'permission_mode' in wire && !('permissionMode' in wire) && j(sessionFactsToWire(facts)) === j(wire), Object.keys(wire).join(' '))
  check('the runner reads its latch fact and its catalogue fact once per answer', said('anthropicWindowFact').length === 1 && said('openaiCatalogueFact').length === 1, `${said('anthropicWindowFact').length} · ${said('openaiCatalogueFact').length}`)
  check('N6 the facts answer carries the ledger', j(got.notices) === j(held.noticeRows), j(got.notices))
  check('the child answers limitWarning from the ONE owner (providerLimitWarning) on its own model', j(got.usage.limitWarning) === j(held.providerLimitWarning) && j(said('providerLimitWarning').map(call => call.args[0])) === j([{ model: 'the-seat-model' }]), `${j(got.usage.limitWarning)} · ${j(said('providerLimitWarning').map(call => call.args[0]))}`)
  check('the facts answer carries anthropicObserved beside the window verdict', j(got.usage.anthropicObserved) === j(held.anthropicObservedUsage) && j(got.usage.anthropicWindow) === j(held.anthropicWindowFact), `${j(got.usage.anthropicObserved)} · ${j(got.usage.anthropicWindow)}`)
  check('§1 the session_facts answer spreads openaiObservedUsage() under the openaiObserved key', j(got.usage.openaiObserved) === j(held.openaiObservedUsage), j(got.usage.openaiObserved))
  check('the runner relays listSessionMission: each task with its id, its subject and active form cut to 120, its status, its links and its ledger', j(got.mission) === j([{ id: '1', subject: 'S'.repeat(120), status: 'in_progress', blocks: ['2'], ledger: 'the ledger' }, { id: '2', subject: 'second', activeForm: 'Seconding', status: 'pending', blockedBy: ['1'] }]), j(got.mission))
  check('F6d the runner relays the rows with its facts', j(got.samples) === j(held.sampleRowsOf) && said('sampleRowsOf')[0]?.args[0] === getSessionId(), j(got.samples))
  check('the runner composes accountEmail through the one sign-in email reader of the presence owner', got.identity.accountEmail === 'who@example.test' && said('anthropicSignInEmail').length === 1, j(got.identity))
  check("the runner's facts answer spells the sent word through the one owner", got.effortSent === 'high' && said('effortSentOf').length === 1, j(got.effortSent))
  const roster = said('skillsRosterOf')[0]?.args
  const off = said('offSkillNamesOf')[0]?.args
  check('S5 the child projects off rows beside the table roster', j(got.skills) === j(held.skillsRosterOf) && roster?.[0] === full.live.activeCommands && roster[1] === held.offSkillNamesOf && j(off?.[1]) === j(['first-skill', 'second-skill']) && off?.[0] === sessionKitOf(), `${j(got.skills)} · ${j(off?.[1])}`)
  arm()
  for (const name of ['anthropicObservedUsage', 'anthropicWindowFact', 'openaiCatalogueFact', 'anthropicSignInEmail', 'effortSentOf']) answers.set(name, () => undefined)
  answers.set('openaiObservedUsage', () => ({}))
  answers.set('listSessionMission', async () => Promise.reject(new Error('the task list is unreadable')))
  const bare = scene()
  const none = sessionFactsFromWire(await answerSessionFacts(bare.ports)) as unknown as typeof got
  check('…and spreads them onto the usage row and the answer, absent when undefined', !('anthropicWindow' in none.usage) && !('openaiCatalogue' in none) && !('anthropicObserved' in none.usage) && 'anthropicWindow' in got.usage && j(got.openaiCatalogue) === j(held.openaiCatalogueFact), `${Object.keys(none.usage).join(' ')} · ${j(got.openaiCatalogue)}`)
  check('an OpenAI observation with neither window is not spread, an unsent effort leaves its key ABSENT, no sign-in email is null, and an unreadable task list is an empty mission', !('openaiObserved' in none.usage) && !('effortSent' in none) && none.identity.accountEmail === null && j(none.mission) === j([]), `${Object.keys(none.usage).join(' ')} · ${j(none.identity)} · ${j(none.mission)}`)
  check('with no model of its own the seat answers on the engine model, and asks the owner of the warning about that one', j(said('providerLimitWarning').map(call => call.args[0])) === j([{ model: getEngineModel() }]) && (none as unknown as { model: { effective: string } }).model.effective === getEngineModel(), j(said('providerLimitWarning').map(call => call.args[0])))
}

section('§8b the park: what refuses it, in its order')
{
  let running = false
  let pending = 0
  const store = storeOf({})
  const asks = { pendingControlRequestCount: () => pending }
  const { ports } = stubPorts({ getAppState: store.get, asks, driver: { isRunning: () => running }, isMainThreadCommand: (command: { agentId?: unknown }) => command.agentId === undefined })
  const free = runnerParkRefusal(ports)
  pending = 2
  const census = runnerParkRefusal(ports)
  const wanted = capabilityHoldWords(runnerCapabilityHolds(asks))
  store.state.tasks = { a1: agentTask('a1'), a2: agentTask('a2'), a3: agentTask('a3', 'completed') }
  const tasks = runnerParkRefusal(ports)
  enqueue({ value: 'for a crewmate', mode: 'task-notification', agentId: 'a1' } as never)
  const agentLine = runnerParkRefusal(ports)
  enqueue({ value: 'the operator waits', mode: 'prompt', uuid: 'park-line' } as never)
  const queuedLine = runnerParkRefusal(ports)
  running = true
  const turn = runnerParkRefusal(ports)
  dequeue(command => command.uuid === ('park-line' as never))
  dequeue(command => command.agentId === ('a1' as never))
  check('the quiesce refusal ends on the census (turn, queued prompt, background tasks first; the census closes it)', free === null && census !== null && census === wanted && tasks === '2 background task(s) still running' && agentLine === tasks && queuedLine === 'a prompt is queued' && turn === 'a turn is running', j({ free, census, tasks, agentLine, queuedLine, turn }))
}

section('§8c the landing of a spawn switch')
{
  switches._resetSpawnSwitchesForTesting()
  lawful.resetLawfulPrefixChanges()
  const messages: Array<Record<string, unknown>> = []
  const { ports } = stubPorts({ messages })
  const before = j(switches.spawnSwitchFacts().subagents)
  landSpawnSwitch('subagents', false, ports)
  const words = `you turned ${switches.SPAWN_SWITCH_LABEL.subagents} off`
  const landed = j(switches.spawnSwitchFacts().subagents)
  const declared = [lawful.consumeLawfulPrefixChange('main'), lawful.consumeLawfulPrefixChange('agent-1'), lawful.consumeLawfulPrefixChange('agent-1')]
  check('…the landing moves the switch and marks the transition row', before !== landed && landed === j({ on: false, source: 'in-session' }) && messages.length === 1 && j(messages[0]).includes(switches.spawnSwitchTransitionLine('subagents', false)), `${before} → ${landed} · ${j(messages).slice(0, 200)}`)
  check('the spawn-switch toggle declares for every owner', j(declared) === j([words, words, null]), j(declared))
  landSpawnSwitch('subagents', false, ports)
  check('a toggle to where the switch stands lands no row and declares nothing', messages.length === 1 && lawful.consumeLawfulPrefixChange('main') === null && lawful.consumeLawfulPrefixChange('agent-1') === null, `${messages.length}`)
  switches._resetSpawnSwitchesForTesting()
  lawful.resetLawfulPrefixChanges()
}

section('§9 session/claim: the claim binds and answers, the load runs behind the answer, and every step keeps its place')
{
  const SID = '6f1d2c3b-4a59-4e68-9f70-a1b2c3d4e5f6'
  const FRESH = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  const home = mkdtempSync(join(tmpdir(), 'runner-arms-claim-'))
  mkdirSync(join(home, 'recorded'), { recursive: true })
  writeFileSync(join(home, `${SID}.jsonl`), '')
  const resumed = {
    sessionId: SID,
    fullPath: join(home, 'recorded', `${SID}.jsonl`),
    messages: [
      { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'the first words' } },
      { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] } },
    ],
    contentReplacements: [],
  }
  const catalogue = { source_kind: 'chatgpt', models: [], fetched_at_ms: 5 }
  type Scene = { ports: Ports; live: Ports['live']; messages: unknown[]; state: () => Record<string, unknown> }
  const scene = (): Scene => {
    let state: Record<string, unknown> = { toolPermissionContext: getEmptyToolPermissionContext() }
    const messages: unknown[] = [{ type: 'user', uuid: 'stale', message: { role: 'user', content: 'a line from before the claim' } }]
    const { ports, live } = stubPorts({
      getAppState: () => state,
      setAppState: (updater: (previous: unknown) => Record<string, unknown>) => void (state = updater(state)),
      messages,
      options: {},
      liveMcp: { refresh: async () => {} },
      peer: { holdScope: (scope: string) => (seen.push({ name: `hold:${scope}`, args: [] }), () => void seen.push({ name: `release:${scope}`, args: [] })) },
    })
    live.awaitingSessionClaim = true
    return { ports, live, messages, state: () => state }
  }
  const names = (): string[] => seen.map(call => call.name)
  const order = (...wanted: string[]): boolean => {
    const at = wanted.map(name => names().indexOf(name))
    return at.every((index, i) => index !== -1 && (i === 0 || index > at[i - 1]!))
  }
  const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
  const armed = (): void => {
    forget()
    answers.set('resolveHeadlessModel', async model => model)
    answers.set('consumeSessionHomePin', () => home)
    answers.set('openaiObservedUsage', () => ({}))
    for (const name of ['listSessionMission', 'sampleRowsOf']) answers.set(name, async () => [])
    for (const name of ['noticeRows', 'skillsRosterOf', 'offSkillNamesOf']) answers.set(name, () => [])
  }

  armed()
  const refusals: Array<[string, Refusal | null, number]> = []
  for (const [why, params, prepare] of [
    ['a session id that is no uuid', { session_id: 'not-a-uuid' }, null],
    ['a mode that is none', { session_id: SID, mode: 'bogus' }, null],
    ['an effort off the ladder', { session_id: SID, effort: 'banana' }, null],
    ['a runner that carries its identity', { session_id: SID }, (live: Ports['live']) => void (live.awaitingSessionClaim = false)],
    ['a claim still settling', { session_id: SID }, (live: Ports['live']) => void (live.claimSettling = new Promise(() => {}))],
  ] as Array<[string, Parameters<typeof claimSession>[0], ((live: Ports['live']) => void) | null]>) {
    const refusedScene = scene()
    prepare?.(refusedScene.live)
    refusals.push([why, (await within(refusalOf(claimSession(params, refusedScene.ports)))) as Refusal | null, seen.length])
  }
  check('W13 the claim validates everything BEFORE mutating: a claim it refuses drops no memo, clears no section, holds no scope and binds no file', refusals.every(([, refusal, calls]) => refusal?.code === RPC_REFUSED && refusal.data?.kind === 'claim' && String(refusal.message).startsWith('claim refused — ') && calls === 0), j(refusals))

  armed()
  let open!: () => void
  const gate = new Promise<void>(done => (open = done))
  let restored!: () => void
  const restoring = new Promise<void>(done => (restored = done))
  answers.set('loadConversationForResume', async () => (await gate, resumed))
  answers.set('restoreSessionStateFromListing', async () => await restoring)
  clearModeTransitions()
  const warm = scene()
  const claiming = claimSession({ session_id: SID, resume: true, mode: 'implement', effort: 'high', model: 'the-claimed-model', restart_reason: 'crash', title: '  the claimed title  ', openai_catalogue: catalogue }, warm.ports)
  const answer = await within(claiming, 1_000)
  const settling = warm.live.claimSettling
  const atAnswer = { names: names(), awaiting: warm.live.awaitingSessionClaim, messages: warm.messages.length, settling: settling !== null }
  const facts = { done: false }
  const appState = { mcp: { clients: [], tools: [] }, toolPermissionContext: { mode: 'implement' }, tasks: {}, fileHistory: { snapshots: [], trackedFiles: new Set<string>(), rewindUndo: undefined } }
  const asked = answerSessionFacts(stubPorts({ live: warm.live, getAppState: () => appState, liveMcp: { addedAt: new Map() }, mcpSignIns: new Map(), messages: [], missionGuard: { missionCardView: () => null } }).ports).then(() => void (facts.done = true))
  await pause(40)
  const factsHeld = !facts.done
  check(
    "R6 `resume: true` loads the transcript through the cold boot's own loader behind the ack (the claim is the binding; the load never holds the answer)",
    j(answer) === j({ session_id: SID }) && atAnswer.settling && atAnswer.awaiting && atAnswer.messages === 1 && j(said('loadConversationForResume').map(call => call.args)) === j([[SID, join(home, `${SID}.jsonl`)]]) && !atAnswer.names.includes('switchSession'),
    j(atAnswer),
  )
  check('the claim answers after binding; the load runs behind the answer', atAnswer.names.indexOf('claimSessionWriter') !== -1 && atAnswer.names.indexOf('claimSessionWriter') < atAnswer.names.indexOf('hold:session') && atAnswer.names.indexOf('hold:session') < atAnswer.names.indexOf('loadConversationForResume') && said('claimSessionWriter')[0]?.args[0] === join(home, `${SID}.jsonl`), j(atAnswer.names))
  check('the warm claim drops the credential memos BEFORE it applies the session (presence is live at the claim)', atAnswer.names.indexOf('dropCredentialMemos') === 0 && atAnswer.names.indexOf('dropCredentialMemos') < atAnswer.names.indexOf('consumeSessionHomePin'), j(atAnswer.names))
  check('K10b the runner decodes the snapshot the claim carries and primes its catalogue with it at the claim', j(said('primeOpenaiCatalogue').map(call => call.args[0])) === j([openaiCatalogueFromWire(catalogue)]) && atAnswer.names.includes('primeOpenaiCatalogue') && atAnswer.names.indexOf('primeOpenaiCatalogue') < atAnswer.names.indexOf('claimSessionWriter'), j(said('primeOpenaiCatalogue')))
  check("the warm claim names 'claim': the mode it carries enters the ledger under the claim's own road, before anything is bound", j(modeTransitions().map(entry => [entry.from, entry.to, entry.road])) === j([['default', 'implement', 'claim']]), j(modeTransitions()))
  check('WR the claim frame carries the restart reason into the runner before the load, for the reconciliation to read', warm.live.runnerRestartReason === 'crash')
  open()
  await pause(40)
  const midRestore = { names: names(), messages: warm.messages.length }
  check('every road that restores a session awaits the restore, so the ledger is rebuilt before the first turn', midRestore.names.includes('restoreSessionStateFromListing') && !midRestore.names.includes('restoreSessionMetadata') && midRestore.messages === 1 && !facts.done, j(midRestore.names))
  restored()
  await within(claiming)
  await within(settling ?? warm.live.claimSettling)
  await within(asked)
  check('session/facts answers only once the claimed session is loaded', factsHeld && facts.done && warm.live.claimSettling === null)
  check('session verbs queue behind the load (the session scope is held until the claim settles)', atAnswer.names.includes('hold:session') && !atAnswer.names.includes('release:session') && !midRestore.names.includes('release:session') && names().filter(name => name === 'release:session').length === 1 && order('port:settleClearBirth', 'port:heldNoticeWaits', 'release:session'), j(names().slice(-8)))
  check('the runner holds queue/add until the claim settles', !midRestore.names.includes('port:releaseQueueUntilClaimed') && order('port:hydrateResumedRun', 'port:releaseQueueUntilClaimed', 'release:session') && !warm.live.awaitingSessionClaim, j(names().slice(-6)))
  check(
    'R6 the live conversation is the loaded one (spliced in place — the turn loop holds the same array)',
    warm.ports.messages === (warm.messages as never) && j(warm.messages) === j(resumed.messages) && warm.live.turnsRun === 1 && warm.live.resumeOf === SID,
    `${warm.messages.length} messages · turns ${warm.live.turnsRun} · resume of ${String(warm.live.resumeOf)}`,
  )
  check(
    'R6 the same restore steps as a cold --resume boot (identity switch, file pointer, state, metadata) and the run hydration',
    order('switchSession', 'resetSessionFilePointer', 'restoreSessionStateFromListing', 'restoreSessionMetadata', 'port:settleSessionBriefs', 'port:armSessionRunnerWiring', 'port:hydrateResumedRun', 'port:settleClearBirth') && j(said('switchSession')[0]?.args) === j([SID, dirname(resumed.fullPath)]) && said('restoreSessionStateFromListing')[0]?.args[0] === resumed && j(said('port:settleSessionBriefs')[0]?.args[1]) === 'true',
    j(names()),
  )
  check('every headless resume road hands the loaded facts to restoreSessionMetadata: the warm claim', said('restoreSessionMetadata').length === 1 && said('restoreSessionMetadata')[0]?.args[0] === resumed)
  check('RED WHERE THE CLAIM CLEARS NO SECTION: the claim clears the section cache before it loads the transcript, after the validations and before the loader seeds a record', said('clearSystemPromptSections').length === 1 && order('hold:session', 'clearSystemPromptSections', 'loadConversationForResume'), j(names().slice(0, 9)))
  check('W13 the id-keyed wiring arms at claim time (wards/crew/room under the claimed id)', j(said('port:armSessionRunnerWiring').map(call => call.args)) === j([[SID]]) && order('switchSession', 'port:armSessionRunnerWiring'))
  check('…the warm claim (resume: true) runs the one resume closure, once, after the wiring', said('port:hydrateResumedRun').length === 1)
  check('C3 the runner compares the inherited model with its effective model on the warm claim, once the claimed model is the seat\'s', said('port:settleClearBirth').length === 1 && warm.live.activeModel === 'the-claimed-model' && order('setEngineModelOverride', 'saveSessionModel', 'port:settleClearBirth') && j(said('saveCustomTitle').map(call => call.args)) === j([[SID, 'the claimed title']]), `${String(warm.live.activeModel)} · ${j(said('saveCustomTitle'))}`)
  check('the claimed mode and effort land on the seat at the settle', (warm.state().toolPermissionContext as { mode?: string }).mode === 'implement' && warm.state().effortValue === 'high' && j(said('markSessionPermissionModeAtClaim').map(call => call.args)) === j([['implement']]), j(warm.state().effortValue))

  armed()
  answers.set('consumeSessionHomePin', () => '/the/pinned/home')
  const fresh = scene()
  const freshAnswer = await within(claimSession({ session_id: FRESH }, fresh.ports))
  await within(fresh.live.claimSettling)
  check('W13 the claim consumes the transcript-home pin at the id switch (the setup.ts seam deferred)', said('consumeSessionHomePin').length === 1 && j(said('switchSession').map(call => call.args)) === j([[FRESH, '/the/pinned/home']]) && said('claimSessionWriter')[0]?.args[0] === join('/the/pinned/home', `${FRESH}.jsonl`), j(said('switchSession')))
  check('the claim is the conversation boundary on BOTH arms: a fresh claim clears the section cache too, before the id switch, loads nothing and hydrates nothing', j(freshAnswer) === j({ session_id: FRESH }) && order('clearSystemPromptSections', 'switchSession', 'port:settleSessionBriefs', 'port:armSessionRunnerWiring', 'port:settleClearBirth', 'port:releaseQueueUntilClaimed', 'release:session') && said('loadConversationForResume').length === 0 && said('port:hydrateResumedRun').length === 0 && fresh.messages.length === 1 && !fresh.live.awaitingSessionClaim, j(names()))

  armed()
  answers.set('loadConversationForResume', async () => null)
  const lost = scene()
  await within(claimSession({ session_id: SID, resume: true }, lost.ports))
  await within(lost.live.claimSettling)
  check('a claimed session whose transcript does not load ends as a cold runner would: the load error, exit 1, the session scope released, and nothing of the session applied', j(said('emitLoadError').map(call => call.args[0])) === j([`No conversation found for session id ${SID}`]) && j(said('gracefulShutdownSync').map(call => call.args[0])) === j([1]) && names().at(-1) === 'release:session' && !names().includes('switchSession') && lost.live.awaitingSessionClaim && said('port:releaseQueueUntilClaimed').length === 0, j(names()))

  const posixModes = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
  if (posixModes) {
    const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs')
    const lockedDir = join(home, 'locked-pin')
    mkdirSync(lockedDir, { recursive: true })
    const lockedFile = join(lockedDir, `${SID}.jsonl`)
    writeFileSync(lockedFile, '{"type":"user","uuid":"u1"}\n', 'utf8')
    chmodSync(lockedFile, 0o000)
    try {
      armed()
      answers.set('consumeSessionHomePin', () => lockedDir)
      answers.set('loadConversationForResume', async () => null)
      const unread = scene()
      await within(claimSession({ session_id: SID, resume: true }, unread.ports))
      await within(unread.live.claimSettling)
      const msg = String(said('emitLoadError')[0]?.args[0] ?? '')
      check('a claimed session whose transcript exists and cannot be read reports the read error instead of absent', msg.includes(`Session ${SID} transcript could not be read:`) && msg.includes('EACCES'), msg)
    } finally {
      chmodSync(lockedFile, 0o644)
    }
  }
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-runner-arms: green' : `\nprove-runner-arms: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
