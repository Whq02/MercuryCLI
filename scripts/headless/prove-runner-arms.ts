#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const at = (rel: string): string => join(ROOT, rel)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (value: unknown): string => JSON.stringify(value)

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

await spied('src/services/agents/operatorStop.ts', ['stopAgentByOperator'])
await spied('src/tools/AgentTool/resumeAgent.ts', ['resumeAgentBackground'])
const sendNowReal = await spied('src/cli/headless/sendNow.ts', ['sendQueuedWordsNow'])
await spied('src/commands.ts', ['clearCommandMemoizationCaches', 'getCommands'])
await spied('src/services/mcp/kitCompletion.ts', ['completeSessionKitFromRoster'])
await spied('src/utils/config.ts', ['readGlobalConfigAgain'])
await spied('src/services/anthropicLimits.ts', ['resetLimitsForCredentialSwitch'])
await spied('src/utils/auth.ts', ['dropCredentialMemos'])
await spied('src/services/providers/openai/openaiCatalogue.ts', ['readOpenaiAccountAgain', 'primeOpenaiCatalogue'])
await spied('src/utils/crew/crewAccountChange.ts', ['noteCrewAccountChange'])
await spied('src/utils/gracefulShutdown.ts', ['gracefulShutdownSync', 'gracefulShutdown'])
await spied('src/utils/hooks/sessionHooks.ts', ['pruneSkillSessionHooks'])

const { runnerArmsOf } = await import('../../src/cli/headless/runnerArms.ts')
const { createRunnerState } = await import('../../src/cli/headless/runnerPorts.ts')
const { RUNNER_NOTIFICATION_METHODS, RUNNER_REQUEST_METHODS } = await import('../../src/cli/headless/runnerMethods.ts')
const { RPC_REFUSED } = await import('../../src/runner/wire/errors.ts')
const { isLocalShellTask } = await import('../../src/tasks/LocalShellTask/guards.ts')
const { AGENT_INTERRUPT_BY_OPERATOR, AGENT_RESUME_NOTE, peekOperatorMessages } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { drainRows } = await import('../../src/utils/sdkEventQueue.ts')
const { dequeue } = await import('../../src/utils/messageQueueManager.ts')
const { sessionKitOf, setProcessSessionKit } = await import('../../src/services/mcp/sessionKitPin.ts')

type Ports = Parameters<typeof runnerArmsOf>[0]
type Refusal = { code?: number; message?: string; data?: { kind?: string } }

function stubPorts(given: Record<string, unknown> = {}): { ports: Ports; live: Ports['live']; used: Call[] } {
  const used: Call[] = []
  const recorder = (name: string): unknown =>
    new Proxy(function () {}, {
      apply: (_target, _self, args: unknown[]) => {
        used.push({ name, args })
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
  check("the runner's interrupt releases the driver's hold and stops no task", soft.used.filter(call => call.name === 'driver.releaseHold').length === 1 && soft.kills.length === 0 && soft.store.sets === 0 && said('stopAgentByOperator').length === 0, `${usedNames(soft.used)} · kills ${soft.kills.length}`)
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
  answers.set('stopAgentByOperator', async () => ({ outcome: 'applied', kind: 'agent', status: 'killed' }))
  const applied = await arms['agent/stop']({ agent_id: 'a1' }, ref, signalOf())
  const plain = said('stopAgentByOperator')[0]
  const context = plain?.args[1] as { getAppState?: unknown; setAppState?: unknown } | undefined
  await arms['agent/stop']({ agent_id: 'a1', note: AGENT_INTERRUPT_BY_OPERATOR }, ref, signalOf())
  await arms['agent/stop']({ agent_id: 'a1', note: 'some other words' }, ref, signalOf())
  const reasons = said('stopAgentByOperator').map(call => j(call.args[2]))
  answers.set('stopAgentByOperator', async () => ({ outcome: 'refused', reason: 'Lane a1 is not running (status: completed) — nothing to stop' }))
  const refusedStop = await refusalOf(arms['agent/stop']({ agent_id: 'a1' }, ref, signalOf()))
  check(
    "the runner's stop_task rides the one operator-stop owner and answers applied or refused with its reason",
    j(applied) === j({ receipt: 'applied', kind: 'agent', status: 'killed' }) && plain?.args[0] === 'a1' && context?.getAppState === store.get && context.setAppState === store.set && refusedStop?.code === RPC_REFUSED && refusedStop.data?.kind === 'agent' && refusedStop.message === 'Lane a1 is not running (status: completed) — nothing to stop',
    `${j(applied)} · ${j(refusedStop)}`,
  )
  check('the typed note rides the stop verb into the runner as the operator-interrupt reason, and no other note does', j(reasons) === j([j({}), j({ reason: AGENT_INTERRUPT_BY_OPERATOR }), j({})]), j(reasons))
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
  check("the runner's resume_task queues a note for a RUNNING agent into the operator lane and answers queued", j(queued) === j({ queued: true, agent_id: 'a1' }) && j(peekOperatorMessages(store.state.tasks.a1)) === j(['look at the parser']) && said('resumeAgentBackground').length === 0, `${j(queued)} · ${j(peekOperatorMessages(store.state.tasks.a1))}`)
  const noNote = await refusalOf(arms['agent/resume']({ agent_id: 'a1' }, ref, signalOf()))
  const notAgent = await refusalOf(arms['agent/resume']({ agent_id: 's1', note: 'words' }, ref, signalOf()))
  check('a running agent with no note still answers the old refusal', noNote?.code === RPC_REFUSED && noNote.data?.kind === 'agent' && noNote.message === 'the crewmate is running — nothing to resume' && notAgent?.message === noNote.message, `${j(noNote)} · ${j(notAgent)}`)
  live.awaitingSessionClaim = true
  const early = await refusalOf(arms['agent/resume']({ agent_id: 'gone' }, ref, signalOf()))
  live.awaitingSessionClaim = false
  check('before the claim there is nothing to resume from, and the owner is not reached', early?.code === RPC_REFUSED && early.data?.kind === 'nothing-to-resume' && said('resumeAgentBackground').length === 0 && order.length === 0, j(early))
  answers.set('resumeAgentBackground', async () => ({ agentId: 'gone', outputFile: '/out/gone.md', description: 'Lane gone', note: ' (in the session folder)', cwdFallback: '/session', recordedCwd: '/recorded' }))
  const resumed = await arms['agent/resume']({ agent_id: 'gone' }, ref, signalOf())
  const asked = said('resumeAgentBackground')[0]?.args[0] as { agentId?: string; prompt?: string; replyTarget?: string; canUseTool?: unknown; toolUseContext?: Record<string, unknown> } | undefined
  check(
    "the runner's resume_task rides the one resume owner with the resume note and the runner's own permission road",
    asked?.agentId === 'gone' && asked.prompt === AGENT_RESUME_NOTE && asked.replyTarget === 'parent' && asked.canUseTool === canUseTool && asked.toolUseContext?.marker === 'the relaunch context' && !('toolUseId' in (asked.toolUseContext ?? {})) && asked.toolUseContext?.abortController instanceof AbortController && j(order) === j(['initializeMcp', 'relaunchContext']),
    `${j({ ...asked, canUseTool: asked?.canUseTool === canUseTool })} · ${j(order)}`,
  )
  check('the crew resume answer carries the note and recorded directory', j(resumed) === j({ agent_id: 'gone', output_file: '/out/gone.md', cwd_fallback: '/session', recorded_cwd: '/recorded', note: ' (in the session folder)' }), j(resumed))
  const receipt = dequeue(command => typeof command.value === 'string' && command.value.includes('<task-id>gone</task-id>'))
  await arms['agent/resume']({ agent_id: 'gone', note: 'carry on with the tests' }, ref, signalOf())
  const withNote = said('resumeAgentBackground')[1]?.args[0] as { prompt?: string; replyTarget?: string } | undefined
  const second = dequeue(command => typeof command.value === 'string' && command.value.includes('<task-id>gone</task-id>'))
  check("a resume with the operator's own words sends those words, answers to the operator, and leaves no receipt row of its own", withNote?.prompt === 'carry on with the tests' && withNote.replyTarget === 'operator' && receipt !== undefined && String(receipt.value).includes('(in the session folder)') && second === undefined, `${j(withNote)} · receipt ${receipt !== undefined} · second ${second !== undefined}`)
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

console.log(failures === 0 ? '\nprove-runner-arms: green' : `\nprove-runner-arms: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
