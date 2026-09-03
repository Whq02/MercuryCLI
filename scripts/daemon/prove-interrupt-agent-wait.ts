#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-interrupt-agent-wait.ts — a turn held open only by
//  its background agents says so, and an interrupt reaches every one of them.
//
//  The operator's screen: three agents running, the footer on "interrupting
//  — the reply stops at its next step", the row on "thinking", and nothing
//  stopping. THE ROAD: the runner's drain parks on its background agents
//  after the model's own stream ends; the interrupt aborted a controller
//  that stream had already released, so no agent heard it and the seat
//  stayed busy. Now the driver announces the wait, the runner relays it on
//  the status frame, the seat folds it into the tail projection, the
//  connector lifts it into the live phase, the status row speaks it — and
//  the interrupt stops every running agent through the task owner's one road.
//
//  The laws under proof (fixture-fed, cpu-pure):
//    A1  the driver announces the agent wait with the running count and
//        announces 0 when the wait ends (never twice for one count)
//    A2  the seat folds the runner's { waitingOnAgents: n } status frame
//        into the tail projection (stateWord 'waiting-on-agents' + the
//        count); null, the result frame and a respawn clear it; the fold's
//        'compacting' word still rides the same frame
//    A3  the words: the status row speaks the wait and the way out, the
//        interrupt claims what the road does, the second esc names the hard
//        stop — and none of them says "thinking" or "next step"
//    A4  the task owner's stop road: every running agent's controller
//        aborts, the task settles killed and notified, and a `stopped`
//        termination rides the SDK event queue per agent; settled tasks are
//        left alone
//    A5  the wiring, structural: the runner's interrupt calls the stop road,
//        the driver's wait reaches the status frame, the connector's second
//        esc sends hard:true, the daemon cuts a runner that holds its turn
//        past a second, the control server forwards the flag, and the REPL
//        maps the waiting phase to its own words, never the thinking dress
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-interrupt-agent-wait.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'agentwait-home-'))

import type { QueuedCommand } from '../../src/types/textInputTypes.ts'

const { createTurnDriver } = await import('../../src/cli/headless/turnDriver.ts')
type TurnDriverPorts = Parameters<typeof createTurnDriver>[0]
const { onSeatLine, onSeatSpawned } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { statusLine } = await import('../../src/components/SwitchboardTagBar.tsx')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const { stopRunningAgentTasks } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { drainSdkEvents } = await import('../../src/utils/sdkEventQueue.ts')
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const read = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function settleTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick()
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the agent-wait prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

console.log('interrupt · agent wait — the wait is spoken, the interrupt reaches every agent')

// ── A1 the driver announces its wait ────────────────────────────────────────
console.log('\nA1 the driver announces the agent wait and its end')
{
  const queue: QueuedCommand[] = [{ value: 'spawn three agents', mode: 'prompt' } as QueuedCommand]
  const announced: number[] = []
  const phases = new Set<string>()
  let polls = 0
  let running = 3
  const ports: TurnDriverPorts = {
    dequeue: () => queue.shift(),
    peek: () => queue[0],
    notifyLifecycle: () => {},
    enqueueOutput: () => {},
    writeDirect: async () => {},
    drainSdkEvents: () => [],
    flushInternalEvents: async () => {},
    executeTurn: async () => {
      await tick()
    },
    beforeCycle: async () => {},
    onTurnStart: () => {},
    onTurnSettled: () => {},
    // Three agents run for the first polls after the stream, then two,
    // then none — the count the wait speaks moves with them.
    hasWaitableBackgroundTasks: () => {
      polls++
      if (polls === 3) running = 2
      if (polls >= 5) running = 0
      return running > 0
    },
    hasHoldableBackgroundAgents: () => false,
    waitableBackgroundTaskCount: () => running,
    onAgentWait: count => announced.push(count),
    takePendingSuggestion: () => null,
    settleIdle: async () => 'stay',
    closeOutput: async () => {},
    notifySessionState: () => {},
    isShuttingDown: () => false,
    idleTimerStop: () => {},
    idleTimerStart: () => {},
    onCycleError: () => ({ type: 'result' }) as never,
    shutdown: () => {},
    clock: { sleep: async () => tick() },
  }
  const driver = createTurnDriver(ports)
  const watch = setInterval(() => phases.add(driver.phase()), 0)
  driver.kick()
  await settleTicks(60)
  clearInterval(watch)
  check("the drain parked on the agents ('waiting_for_agents' was a phase)", phases.has('waiting_for_agents'), [...phases].join(','))
  check('the wait was announced with the running count, moved with it, and ended with 0', JSON.stringify(announced) === JSON.stringify([3, 2, 0]), JSON.stringify(announced))
  check('the driver settled idle after the wait', driver.phase() === 'idle', driver.phase())
}

// ── A2 the seat folds the frame into the tail projection ────────────────────
console.log('\nA2 the seat folds the agent wait into the tail projection')
const dir = mkdtempSync(join(tmpdir(), 'agentwait-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-agentwait001'
const SHORT = 'concourse-aw1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-aw',
    isolation: 'exclusive',
    modelKey: 'claude-opus-5',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)
const roster = { control: () => true, list: () => [], patchSeatModel: () => true }
const statusFrame = (status: unknown): string =>
  JSON.stringify({ type: 'system', subtype: 'status', status, uuid: '00000000-0000-4000-a000-000000000002', session_id: sid })
const tail = () => readSessionTail(sid, dir) as { stateWord?: string; waitingOnAgents?: number } | null
{
  onSeatLine(SHORT, statusFrame({ waitingOnAgents: 3 }), roster as never, dir)
  check("{ waitingOnAgents: 3 } ⇒ stateWord 'waiting-on-agents' with the count", tail()?.stateWord === 'waiting-on-agents' && tail()?.waitingOnAgents === 3, JSON.stringify(tail()))
  onSeatLine(SHORT, statusFrame({ waitingOnAgents: 1 }), roster as never, dir)
  check('the count moves with the runner (1)', tail()?.stateWord === 'waiting-on-agents' && tail()?.waitingOnAgents === 1, JSON.stringify(tail()))
  onSeatLine(SHORT, statusFrame(null), roster as never, dir)
  check('status null clears the wait', tail()?.stateWord === undefined && tail()?.waitingOnAgents === undefined, JSON.stringify(tail()))
  onSeatLine(SHORT, statusFrame({ waitingOnAgents: 2 }), roster as never, dir)
  onSeatLine(SHORT, JSON.stringify({ type: 'result', subtype: 'success' }), roster as never, dir)
  check("the turn's result frame clears it (the settle belt)", tail()?.stateWord === undefined, JSON.stringify(tail()))
  onSeatLine(SHORT, statusFrame({ waitingOnAgents: 2 }), roster as never, dir)
  onSeatSpawned(SHORT, roster as never, dir)
  check('a respawn clears it (a child dead mid-wait never leaks the word)', tail()?.stateWord === undefined, JSON.stringify(tail()))
  onSeatLine(SHORT, statusFrame('compacting'), roster as never, dir)
  check("the fold's own word still rides the same frame ('compacting', no count)", tail()?.stateWord === 'compacting' && tail()?.waitingOnAgents === undefined, JSON.stringify(tail()))
  onSeatLine(SHORT, statusFrame({ waitingOnAgents: 0 }), roster as never, dir)
  check('a zero count is no wait at all', tail()?.stateWord === undefined, JSON.stringify(tail()))
}

// ── A3 the words ────────────────────────────────────────────────────────────
console.log('\nA3 the words the status row speaks')
{
  const base = { title: 't', projectLabel: 'p', interrupting: false, hardStopping: false, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false }
  const waiting = { ...IDLE_LIVE, inFlight: true, phase: 'waiting' as const, agentsWaiting: 3 }
  const one = { ...waiting, agentsWaiting: 1 }
  const thinking = { ...IDLE_LIVE, inFlight: true, phase: 'thinking' as const }
  check("waiting on three: 'waiting on 3 agents · esc stops them'", statusLine(waiting, base) === 'waiting on 3 agents · esc stops them', statusLine(waiting, base))
  check("waiting on one: 'waiting on 1 agent · esc stops them'", statusLine(one, base) === 'waiting on 1 agent · esc stops them', statusLine(one, base))
  const interrupting = statusLine(thinking, { ...base, interrupting: true })
  check('the interrupt claims what the road does — the request torn down, esc again forces a stop', interrupting === 'interrupting — the request is torn down · esc again forces a stop', interrupting)
  const hard = statusLine(thinking, { ...base, interrupting: true, hardStopping: true })
  check('the second esc names the hard stop and its one-second bound', hard === 'stopping — the runner is cut if the turn is still open in a second', hard)
  check("none of the interrupt's words promise a 'next step' or dress the wait as thinking", ![interrupting, hard, statusLine(waiting, base)].some(w => /next step|thinking/.test(w)))
}

// ── A4 the task owner's stop road ───────────────────────────────────────────
console.log('\nA4 the stop road reaches every running agent')
{
  setIsInteractive(false)
  drainSdkEvents()
  const aborted: string[] = []
  const controller = (id: string): AbortController => {
    const c = new AbortController()
    c.signal.addEventListener('abort', () => aborted.push(id))
    return c
  }
  const agent = (id: string, status: string, description: string): Record<string, unknown> => ({
    id,
    type: 'local_agent',
    status,
    description,
    toolUseId: `tu-${id}`,
    startTime: Date.now(),
    outputFile: join(dir, `${id}.out`),
    outputOffset: 0,
    notified: false,
    abortController: controller(id),
  })
  let state: { tasks: Record<string, unknown> } = {
    tasks: {
      a1: agent('a1', 'running', 'Build the parser'),
      a2: agent('a2', 'running', 'Build the lexer'),
      a3: agent('a3', 'completed', 'Build the docs'),
    },
  }
  const setAppState = (updater: (prev: typeof state) => typeof state): void => {
    state = updater(state)
  }
  const stopped = stopRunningAgentTasks(state.tasks, setAppState as never)
  check('the two running agents are the ones stopped, in task order', stopped.map(t => t.id).join(',') === 'a1,a2', stopped.map(t => t.id).join(','))
  check("both controllers aborted (the agents' own queries tear down)", aborted.sort().join(',') === 'a1,a2', aborted.join(','))
  const after = state.tasks as Record<string, { status: string; notified: boolean }>
  check('both settled killed and notified; the completed agent is untouched', after.a1!.status === 'killed' && after.a2!.status === 'killed' && after.a1!.notified && after.a2!.notified && after.a3!.status === 'completed' && !after.a3!.notified, JSON.stringify(after))
  const events = drainSdkEvents() as Array<{ subtype?: string; task_id?: string; status?: string; summary?: string }>
  const stops = events.filter(e => e.subtype === 'task_notification' && e.status === 'stopped')
  check("a 'stopped' termination rides the SDK stream per agent, naming it", stops.length === 2 && stops.map(e => e.task_id).join(',') === 'a1,a2' && stops[0]!.summary === 'Build the parser', JSON.stringify(events))
  check('a store with nothing running stops nothing and emits nothing', stopRunningAgentTasks(state.tasks, setAppState as never).length === 0 && drainSdkEvents().length === 0)
  setIsInteractive(true)
}

// ── A5 the wiring ───────────────────────────────────────────────────────────
console.log('\nA5 the wiring — runner to glass (structural)')
{
  const print = read('src/cli/print.ts')
  check("the runner's interrupt aborts the in-flight request AND stops the running agents", /case 'interrupt': \{[\s\S]{0,1600}inFlightAbort\?\.abort\(\)\s*\n\s*stopRunningAgentTasks\(getAppState\(\)\.tasks, setAppState\)/.test(print))
  check('the runner relays the agent wait on the status frame ({ waitingOnAgents: n } / null)', /onAgentWait: count => \{[\s\S]{0,400}subtype: 'status',\s*\n\s*status: count > 0 \? \{ waitingOnAgents: count \} : null/.test(print))
  const driver = read('src/cli/headless/turnDriver.ts')
  check("the driver announces the wait where it parks ('waiting_for_agents') and 0 on every exit of the cycle", /phase = 'waiting_for_agents'[\s\S]{0,500}announceWait\(Math\.max\(1, ports\.waitableBackgroundTaskCount\?\.\(\) \?\? 1\)\)/.test(driver) && /finally \{\s*\n[\s\S]{0,300}announceWait\(0\)/.test(driver))
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check('the connector lifts the wait into the live phase and the second esc sends hard:true', /this\.liveStateWord === 'waiting-on-agents'[\s\S]{0,80}\? 'waiting'/.test(connector) && /action: 'interrupt', sessionId: this\.record\.sessionId, by: 'operator', \.\.\.\(hard \? \{ hard: true \} : \{\}\)/.test(connector))
  const main = read('src/daemon/main.ts')
  check('the daemon cuts a runner that still holds its turn a second after a hard interrupt, then publishes the seat facts', /hard === true && roster !== null/.test(main) && /if \(!seatTurnOpen\(row\)\) return[\s\S]{0,400}live\.kill\(runnerId\)[\s\S]{0,600}publishSeatFacts\(runnerId, undefined, live\)/.test(main) && /\}, 1_000\)\.unref\(\)/.test(main))
  const server = read('src/daemon/controlServer.ts')
  check('the control server forwards the hard flag', /\.\.\.\(raw\.hard === true \? \{ hard: true \} : \{\}\)/.test(server))
  const repl = read('src/screens/REPL.tsx')
  check("the REPL speaks the wait in its own words and never maps the waiting phase onto the thinking mode", /seatLive\.phase === 'waiting' \? `waiting on \$\{seatLive\.agentsWaiting\} agent/.test(repl) && !/'waiting'\s*\?\s*'thinking'/.test(repl))
  const seatLive = read('src/services/engine-connector/seatLive.ts')
  check("the live-phase vocabulary carries 'waiting' with its count", /'waiting' \| 'idle'/.test(seatLive) && /agentsWaiting: number/.test(seatLive))
}

console.log(failures === 0 ? '\n ✅ INTERRUPT · AGENT WAIT — the wait is spoken, the interrupt reaches every agent' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
