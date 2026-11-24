#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'agentwait-home-'))

import type { QueuedCommand } from '../../src/screen/composer/input-core/textInput.ts'

const { createTurnDriver } = await import('../../src/daemon/runner/turnDriver.ts')
type TurnDriverPorts = Parameters<typeof createTurnDriver>[0]
const { onSeatRow, onSeatSpawned } = await import('../../src/daemon/session-seat/sessionSeat.ts')
const { readSessionTail } = await import('../../src/engine/connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { statusLine } = await import('../../src/screen/chat/SwitchboardTagBar.tsx')
const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
const { stopRunningCrewmateTasks } = await import('../../src/engine/tasks/local-agent/crewmateTask.tsx')
const { drainRows } = await import('../../src/daemon/runner/sdkEventQueue.ts')
const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}fix by section above: A1 createTurnDriver in src/daemon/runner/turnDriver.ts, A2 onSeatRow in src/daemon/session-seat/sessionSeat.ts, A3 statusLine in src/screen/chat/SwitchboardTagBar.tsx, A4 stopRunningAgentTasks in src/engine/tasks/local-agent/crewmateTask.tsx, A5 DaemonSessionConnector in src/engine/connector/daemonConnector.ts` : ''}`)
  if (!ok) failures++
}
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function settleTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick()
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the agent-wait prover exceeded 60s; a turn-driver wait (createTurnDriver in src/daemon/runner/turnDriver.ts) or a settleTicks loop never finished')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

console.log('interrupt · agent wait — the wait is spoken, the interrupt reaches every agent')

console.log('\nA1 the driver announces the agent wait and its end')
{
  const queue: QueuedCommand[] = [{ value: 'spawn three agents', mode: 'prompt' } as QueuedCommand]
  const announced: number[] = []
  const phases = new Set<string>()
  let polls = 0
  let running = 3
  const ports: TurnDriverPorts = {
    dequeue: () => queue.shift(),
    dequeueCommand: command => {
      const at = queue.indexOf(command)
      return at < 0 ? undefined : queue.splice(at, 1)[0]
    },
    peek: () => queue[0],
    notifyLifecycle: () => {},
    enqueueOutput: () => {},
    writeDirect: async () => {},
    drainRows: () => [],
    executeTurn: async () => {
      await tick()
    },
    beforeCycle: async () => {},
    onTurnStart: () => {},
    turnIdOf: () => 't-aw',
    openTurnRow: () => ({ type: 'turn', state: 'started', turn_id: 't-aw' }) as never,
    onTurnSettled: () => {},
    hasWaitableBackgroundTasks: () => {
      polls++
      if (polls === 3) running = 2
      if (polls >= 5) running = 0
      return running > 0
    },
    hasHoldableBackgroundAgents: () => false,
    waitableBackgroundTaskCount: () => running,
    onAgentWait: count => announced.push(count),
    settleIdle: async () => 'stay',
    closeOutput: async () => {},
    isShuttingDown: () => false,
    idleTimerStop: () => {},
    idleTimerStart: () => {},
    onCycleError: () => ({ type: 'outcome', status: 'failed' }) as never,
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
const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }
const row = (o: Record<string, unknown>): Record<string, unknown> => ({ seq: 1, timestamp: 't', session_id: sid, turn: 1, ...o })
const waitingRow = (agents: number): Record<string, unknown> => row({ type: 'turn', state: 'waiting', turn_id: 't-aw', agents })
const USAGE = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 }
const outcome = (): Record<string, unknown> => row({ type: 'outcome', schema: 1, turn_id: 't-aw', status: 'completed', steps: 1, wall_ms: 1, usage: USAGE, models: [], denials: [] })
const tail = () => readSessionTail(sid, dir) as { stateWord?: string; waitingOnAgents?: number } | null
{
  onSeatRow(SHORT, waitingRow(3), roster as never, dir)
  check("a turn row waiting on 3 ⇒ stateWord 'waiting-on-agents' with the count", tail()?.stateWord === 'waiting-on-agents' && tail()?.waitingOnAgents === 3, JSON.stringify(tail()))
  onSeatRow(SHORT, waitingRow(1), roster as never, dir)
  check('the count moves with the runner (1)', tail()?.stateWord === 'waiting-on-agents' && tail()?.waitingOnAgents === 1, JSON.stringify(tail()))
  onSeatRow(SHORT, waitingRow(0), roster as never, dir)
  check('a wait of zero clears the wait', tail()?.stateWord === undefined && tail()?.waitingOnAgents === undefined, JSON.stringify(tail()))
  onSeatRow(SHORT, waitingRow(2), roster as never, dir)
  onSeatRow(SHORT, outcome(), roster as never, dir)
  check("the turn's outcome row clears it (the settle belt)", tail()?.stateWord === undefined, JSON.stringify(tail()))
  onSeatRow(SHORT, waitingRow(2), roster as never, dir)
  onSeatSpawned(SHORT, roster as never, dir)
  check('a respawn clears it (a child dead mid-wait never leaks the word)', tail()?.stateWord === undefined, JSON.stringify(tail()))
  onSeatRow(SHORT, row({ type: 'compaction', state: 'started', trigger: 'manual' }), roster as never, dir)
  check("the fold's own word rides its own row ('compacting', no count)", tail()?.stateWord === 'compacting' && tail()?.waitingOnAgents === undefined, JSON.stringify(tail()))
  onSeatRow(SHORT, row({ type: 'compaction', state: 'ended', trigger: 'manual' }), roster as never, dir)
  onSeatRow(SHORT, waitingRow(0), roster as never, dir)
  check('a zero count is no wait at all', tail()?.stateWord === undefined, JSON.stringify(tail()))
}

console.log('\nA3 the words the status row speaks')
{
  const base = { title: 't', projectLabel: 'p', interrupting: false, hardStopping: false, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false, wait: null }
  const waiting = { ...IDLE_LIVE, inFlight: true, phase: 'waiting' as const, agentsWaiting: 3 }
  const one = { ...waiting, agentsWaiting: 1 }
  const thinking = { ...IDLE_LIVE, inFlight: true, phase: 'thinking' as const }
  check("waiting on three: 'waiting on 3 crewmates'", statusLine(waiting, base) === 'waiting on 3 crewmates', statusLine(waiting, base))
  check("waiting on one: 'waiting on 1 crewmate'", statusLine(one, base) === 'waiting on 1 crewmate', statusLine(one, base))
  const interrupting = statusLine(thinking, { ...base, interrupting: true })
  check("the interrupt claims what the road does — the request torn down (the esc rung's hint rides the ladder owner)", interrupting === 'interrupting — the request is torn down', interrupting)
  const hard = statusLine(thinking, { ...base, interrupting: true, hardStopping: true })
  check('the second esc says the interrupt went again and names the stop door — never a cut', hard === 'interrupting again — the request is torn down once more; x on its row stops the runner', hard)
  check("none of the interrupt's words promise a 'next step' or dress the wait as thinking", ![interrupting, hard, statusLine(waiting, base)].some(w => /next step|thinking/.test(w)))
}

console.log('\nA4 the stop road reaches every running agent')
{
  setIsInteractive(false)
  drainRows()
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
  const stopped = stopRunningCrewmateTasks(state.tasks, setAppState as never)
  check('the two running agents are the ones stopped, in task order', stopped.map(t => t.id).join(',') === 'a1,a2', stopped.map(t => t.id).join(','))
  check("both controllers aborted (the agents' own queries tear down)", aborted.sort().join(',') === 'a1,a2', aborted.join(','))
  const after = state.tasks as Record<string, { status: string; notified: boolean }>
  check('both settled killed and notified; the completed agent is untouched', after.a1!.status === 'killed' && after.a2!.status === 'killed' && after.a1!.notified && after.a2!.notified && after.a3!.status === 'completed' && !after.a3!.notified, JSON.stringify(after))
  const events = drainRows() as Array<{ type?: string; state?: string; task_id?: string; status?: string; summary?: string }>
  const stops = events.filter(e => e.type === 'task' && e.state === 'ended' && e.status === 'stopped')
  check("a 'stopped' task row rides the stream per agent, naming it", stops.length === 2 && stops.map(e => e.task_id).join(',') === 'a1,a2' && stops[0]!.summary === 'Build the parser', JSON.stringify(events))
  check('a store with nothing running stops nothing and emits nothing', stopRunningCrewmateTasks(state.tasks, setAppState as never).length === 0 && drainRows().length === 0)
  setIsInteractive(true)
}

console.log('\nA5 the wiring — runner to glass (structural)')
{
  const plane = mkdtempSync(join(tmpdir(), 'agentwait-door-'))
  const planeBefore = process.env.MERCURY_DAEMON_DIR
  process.env.MERCURY_DAEMON_DIR = plane
  const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
  const { publishSessionFacts, publishSessionTail } = await import('../../src/engine/connector/seatProjections.ts')
  const doorId = 'agentwait-door'
  const presses: Array<Record<string, unknown>> = []
  let factsFeedReads: () => void = () => {}
  const door = new DaemonSessionConnector({ sessionId: doorId, runnerId: 'runner-agentwait', title: 'the chat', projectLabel: 'proof', workspaceId: plane, home: plane }, {
    rpc: async (req: Record<string, unknown>) => {
      presses.push(req)
      return { ok: true, outcome: 'applied' }
    },
    factsRead: (read: () => void) => {
      factsFeedReads = read
    },
  })
  const reaches = door as unknown as { readTail(): void }
  publishSessionFacts({
    schema: 1,
    sessionId: doorId,
    atMs: 1,
    pendingModel: null,
    busy: true,
    model: { effective: 'claude-sonnet-5-5', setting: null },
    usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    workspace: { cwd: plane, originalCwd: plane, projectRoot: plane },
    queue: [],
  })
  factsFeedReads()
  publishSessionTail({ schema: 1, sessionId: doorId, atMs: 1, text: null, stateWord: 'waiting-on-agents', waitingOnAgents: 2 })
  reaches.readTail()
  const lifted = door.live()
  door.interrupt()
  door.interrupt()
  await settleTicks(6)
  if (planeBefore === undefined) delete process.env.MERCURY_DAEMON_DIR
  else process.env.MERCURY_DAEMON_DIR = planeBefore
  check(
    'the connector lifts the wait into the live phase and the second esc sends hard:true (the press carries its own operation id)',
    lifted.phase === 'waiting' &&
      lifted.agentsWaiting === 2 &&
      presses.length === 2 &&
      presses.every(press => press.op === 'sessionControl' && press.action === 'interrupt' && press.sessionId === doorId && press.by === 'operator' && typeof press.clientOpId === 'string') &&
      presses[0]!.hard === undefined &&
      presses[1]!.hard === true &&
      presses[0]!.clientOpId !== presses[1]!.clientOpId,
    JSON.stringify({ lifted: { phase: lifted.phase, agentsWaiting: lifted.agentsWaiting }, presses }),
  )
}

console.log(failures === 0 ? '\n ✅ INTERRUPT · AGENT WAIT — the wait is spoken, the interrupt reaches every agent' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
