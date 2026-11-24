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
const UNSETTLED = Symbol('unsettled')
const within = <T,>(work: Promise<T> | T, ms = 3_000): Promise<T | typeof UNSETTLED> => Promise.race([Promise.resolve(work), new Promise<typeof UNSETTLED>(done => setTimeout(() => done(UNSETTLED), ms))])
setTimeout(() => {
  console.log('  [FAIL] the proof ended within its two minutes')
  process.exit(1)
}, 120_000).unref()

type Call = { name: string; args: unknown[]; retiring?: boolean; started?: boolean }
const seen: Call[] = []
const answers = new Map<string, (...args: unknown[]) => unknown>()
const said = (name: string): Call[] => seen.filter(call => call.name === name)
let retiringNow: () => boolean = () => false
let startedNow: () => boolean = () => false

async function spied(rel: string, wanted: string[]): Promise<void> {
  const real = (await import(at(rel))) as Record<string, unknown>
  const wrapped = Object.fromEntries(
    wanted.map(name => [
      name,
      (...args: unknown[]): unknown => {
        seen.push({ name, args, retiring: retiringNow(), started: startedNow() })
        return answers.get(name)?.(...args)
      },
    ]),
  )
  mock.module(at(rel), () => ({ ...real, ...wrapped }))
}

await spied('src/daemon/runner/messageQueueManager.ts', ['enqueue', 'remove'])
await spied('src/screen/composer/input-core/command-queue.ts', ['subscribeQueueConsumption', 'queuedWordsWaitForTurnEnd'])
await spied('src/engine/tasks/local-agent/crewmateTask.tsx', ['handOverForegroundCrewmatesToQueuedMessage'])
await spied('src/daemon/saturn/sessionScheduleBridge.ts', ['registerLocalWakeSink'])
await spied('src/tools/monitor/laneWall.ts', ['sessionLaneWall'])
await spied('src/sessions/transcripts/sessionStorage.ts', ['doesMessageExistInSession'])
await spied('src/daemon/runner/commandLifecycle.ts', ['notifyCommandLifecycle'])
await spied('src/permissions/guards/mission.ts', ['syncMissionFromCard', 'resumeMissionOnOperatorInput', 'clearActiveMission', 'setActiveMission'])
await spied('src/platform/processes/gracefulShutdown.ts', ['gracefulShutdownSync'])

const door = await import('../../src/daemon/runner/inputDoor.ts')
const { createRunnerState } = await import('../../src/daemon/runner/runnerPorts.ts')
const { saturnQueueStamp, screenCommandQueueStamp } = await import('../../src/engine/message-shapes/noticeRows.ts')
const { operatorPauseGate } = await import('../../src/engine/loop/pauseGate.ts')
const { RPC_INVALID_PARAMS } = await import('../../src/daemon/runner-wire/errors.ts')
const { AGENT_MESSAGE_STATUS } = await import('../../src/engine/tasks/local-agent/agentMessage.ts')

type Ports = Parameters<typeof door.acceptInput>[1]
type Queued = Record<string, unknown>
type Scene = { ports: Ports; live: Ports['live']; kicks: () => number; running: { now: boolean }; local: { now: boolean }; received: Set<string>; inits: () => number }

function scene(given: Record<string, unknown> = {}): Scene {
  seen.length = 0
  answers.clear()
  answers.set('doesMessageExistInSession', async () => false)
  answers.set('queuedWordsWaitForTurnEnd', () => false)
  answers.set('setActiveMission', (words: unknown) => `the mission card of ${String(words)}`)
  answers.set('sessionLaneWall', () => ({ closed: false }))
  const live = createRunnerState()
  let kicks = 0
  let inits = 0
  const running = { now: false }
  const local = { now: false }
  const received = new Set<string>()
  const ports = {
    live,
    options: { initializeMcp: async () => void (inits++, seen.push({ name: 'port:initializeMcp', args: [], started: live.sessionInitialized })) },
    driver: { kick: () => void (kicks++, seen.push({ name: 'port:kick', args: [], started: live.sessionInitialized })), isRunning: () => running.now },
    getAppState: () => ({}),
    setAppState: () => {},
    localCommandInput: () => local.now,
    missionLineOf: () => null,
    receivedUuids: { add: (id: string) => void received.add(id), has: (id: string) => received.has(id) },
    ...given,
  } as unknown as Ports
  retiringNow = () => live.retiringQueuedCommands
  startedNow = () => live.sessionInitialized
  return { ports, live, kicks: () => kicks, running, local, received, inits: () => inits }
}
const queued = (): Queued[] => said('enqueue').map(call => call.args[0] as Queued)
const refusalOf = async (work: Promise<unknown>): Promise<{ code?: number; data?: { issues?: Array<{ path?: string[] }> } } | null> => work.then(() => null, error => error as never)
const SATURN = { kind: 'saturn', fire: 'cron', firedAt: '2026-11-17T09:00:00.000Z' }

section('§1 a queued command is stamped: its time from the frame or the arrival, its origin and workload from the one stamp')
{
  const framed = scene()
  const verdict = await within(door.acceptInput({ kind: 'prompt', content: 'the words', sentAt: '2026-01-02T03:04:05.000Z' }, framed.ports))
  const before = Date.now()
  await within(door.acceptInput({ kind: 'prompt', content: 'no stamp' }, framed.ports))
  await within(door.acceptInput({ kind: 'prompt', content: 'a stamp that is no time', sentAt: 'yesterday' }, framed.ports))
  const [first, second, third] = queued()
  const arrived = (command: Queued | undefined): boolean => typeof command?.sentAt === 'string' && Math.abs(Date.parse(command.sentAt as string) - before) < 5_000
  check("the runner stamps the queued command from the frame's timestamp, or the arrival", j(verdict) === j({ accepted: true }) && first?.sentAt === '2026-01-02T03:04:05.000Z' && arrived(second) && arrived(third) && first.value === 'the words' && first.mode === 'prompt', j(queued().map(command => command.sentAt)))
  check('the door starts the MCP servers, marks the session started and kicks the driver once for each line', framed.inits() === 3 && framed.live.sessionInitialized && framed.kicks() === 3 && said('syncMissionFromCard').length === 3, `inits ${framed.inits()} kicks ${framed.kicks()} started ${framed.live.sessionInitialized} syncs ${said('syncMissionFromCard').length}; acceptInput in src/daemon/runner/inputDoor.ts must start MCP, mark the session started and kick once per line`)
  const ordered = scene()
  await within(door.acceptInput({ kind: 'prompt', content: 'one line' }, ordered.ports))
  const placeOf = (name: string): number => seen.findIndex(call => call.name === name)
  const startAt = placeOf('port:initializeMcp')
  const queueAt = placeOf('enqueue')
  const kickAt = placeOf('port:kick')
  check(
    'the door starts the MCP servers and marks the session started before it queues, and kicks the driver after: for one line the start stands before the enqueue and the enqueue before the kick, the session is unmarked at the start and marked at the enqueue',
    startAt !== -1 && queueAt !== -1 && kickAt !== -1 && startAt < queueAt && queueAt < kickAt && seen[startAt]!.started === false && seen[queueAt]!.started === true && ordered.inits() === 1 && ordered.kicks() === 1,
    j(seen.map(call => `${call.name}${call.started ? ' (started)' : ''}`)),
  )

  const fire = scene()
  await within(door.acceptInput({ kind: 'prompt', content: 'the fire', origin: SATURN }, fire.ports))
  await within(door.acceptInput({ kind: 'prompt', content: 'a channel line', origin: { kind: 'channel', server: 'x' } }, fire.ports))
  await within(door.acceptInput({ kind: 'prompt', content: 'a screen command', origin: { kind: 'screen-command', command: 'model' } }, fire.ports))
  const [fired, foreign, screen] = queued()
  const stamp = saturnQueueStamp(SATURN) as { origin: unknown; workload: string }
  check("the stdin road's fire spreads the one stamp beside its words (red on the base: the origin rides alone, no workload — the fire bills as the session's default)", j(fired?.origin) === j(stamp.origin) && fired?.workload === stamp.workload && stamp.workload === 'cron' && fired.value === 'the fire' && !('origin' in (foreign ?? {})) && !('workload' in (foreign ?? {})), j([fired, foreign]))
  check('a screen command carries its own stamp: its origin and the meta mark, and no workload', j(screen?.origin) === j((screenCommandQueueStamp({ kind: 'screen-command', command: 'model' }) as { origin: unknown }).origin) && screen?.isMeta === true && !('workload' in (screen ?? {})), j(screen))
  operatorPauseGate.pause()
  const paused = scene()
  await within(door.acceptInput({ kind: 'prompt', content: 'a fire while paused', origin: SATURN }, paused.ports))
  const heldByAFire = operatorPauseGate.paused()
  await within(door.acceptInput({ kind: 'prompt', content: 'the operator speaks' }, paused.ports))
  check("the operator's own words lift the pause and wake the mission; a fire does neither", heldByAFire && !operatorPauseGate.paused() && said('resumeMissionOnOperatorInput').length === 1, `${heldByAFire} · ${operatorPauseGate.paused()} · ${said('resumeMissionOnOperatorInput').length}`)
}

section('§2 the foreground crewmates are handed over on a human prompt mid-turn, and on nothing else')
{
  const handed = async (input: Parameters<typeof door.acceptInput>[0], prepare: (s: Scene) => void = () => {}): Promise<number> => {
    const s = scene()
    s.running.now = true
    prepare(s)
    await within(door.acceptInput(input, s.ports))
    return said('handOverForegroundCrewmatesToQueuedMessage').length
  }
  const human = await handed({ kind: 'prompt', content: 'look here' })
  const args = said('handOverForegroundCrewmatesToQueuedMessage')[0]?.args.length
  const cases = {
    'a Tab-held line': await handed({ kind: 'prompt', content: 'later', priority: 'later' }),
    'a cron wake': await handed({ kind: 'prompt', content: 'fire', origin: SATURN }),
    'a held seat verb': await handed({ kind: 'prompt', content: 'held' }, () => answers.set('queuedWordsWaitForTurnEnd', () => true)),
    'a queued local command': await handed({ kind: 'prompt', content: '/model' }, s => void (s.local.now = true)),
    'a shell line': await handed({ kind: 'shell', command: 'ls' }),
    'a prompt between turns': await handed({ kind: 'prompt', content: 'idle' }, s => void (s.running.now = false)),
  }
  check('the runner door hands the foreground crewmates over on a human prompt mid-turn, never on a Tab-held line, a cron wake, a held seat verb or a queued local command', human === 1 && args === 2 && Object.values(cases).every(count => count === 0), `human ${human} · ${j(cases)}`)
  const marked = scene()
  marked.local.now = true
  await within(door.acceptInput({ kind: 'prompt', content: '/model' }, marked.ports))
  await within(door.acceptInput({ kind: 'shell', command: 'ls', priority: 'next' }, scene().ports))
  check('a local command is marked as one on the queue, and a shell line is queued in bash mode with its priority', queued().length === 1 && queued()[0]!.mode === 'bash' && queued()[0]!.priority === 'next' && queued()[0]!.value === 'ls', `${j(queued())}; acceptInput in src/daemon/runner/inputDoor.ts must queue a shell line in bash mode with its priority and queue the local command as one`)
}

section('§3 a line seen before, a note for a crewmate, a report from outside')
{
  const twice = scene()
  const first = await within(door.acceptInput({ kind: 'prompt', content: 'once', id: 'line-1' }, twice.ports))
  const again = await within(door.acceptInput({ kind: 'prompt', content: 'once', id: 'line-1' }, twice.ports))
  const recorded = scene()
  answers.set('doesMessageExistInSession', async () => true)
  const historical = await within(door.acceptInput({ kind: 'prompt', content: 'from the record', id: 'line-9' }, recorded.ports))
  check('a line whose id the runner took, or the record holds, is answered as a duplicate and queued once; one the record alone holds is told completed', j(first) === j({ accepted: true }) && j(again) === j({ accepted: false, reason: 'duplicate' }) && j(historical) === j({ accepted: false, reason: 'duplicate' }) && queued().length === 0 && j(said('notifyCommandLifecycle').map(call => call.args)) === j([['line-9', 'completed']]) && recorded.kicks() === 0, `${j(first)} ${j(again)} ${j(historical)}`)
  const notes = scene()
  await within(door.acceptInput({ kind: 'note', to: 'a-crewmate', content: 'a word for you', id: 'note-1' }, notes.ports))
  await within(door.acceptInput({ kind: 'outside-report', sender: 'the-reporter', content: 'a report' }, notes.ports))
  const [note, report] = queued()
  check('a note is queued for its crewmate as a notification from a human, and an outside report rides the next words with its sender; neither kicks the driver', note?.agentId === 'a-crewmate' && note.mode === 'task-notification' && j(note.origin) === j({ kind: 'human' }) && note.priority === 'next' && note.uuid === 'note-1' && j(report?.origin) === j({ kind: 'outside-report', sender: 'the-reporter', via: 'mcp-server' }) && report?.ridesNextWords === true && report.skipSlashCommands === true && notes.kicks() === 0, j([note, report]))
}

section('§4 a row from the wire: refused when empty, carried whole when not')
{
  const taken: unknown[] = []
  const ports = { acceptInput: async (input: unknown) => (taken.push(input), { accepted: true }) } as unknown as Ports
  const empty = await refusalOf(door.acceptInputRow({ type: 'prompt', content: '' } as never, ports))
  const emptyShell = await refusalOf(door.acceptInputRow({ type: 'shell', command: '' } as never, ports))
  check('a prompt with no words and a shell line with no command are invalid params of queue/add, each naming its field, and reach no queue', empty?.code === RPC_INVALID_PARAMS && j(empty.data?.issues?.[0]?.path) === j(['content']) && emptyShell?.code === RPC_INVALID_PARAMS && j(emptyShell.data?.issues?.[0]?.path) === j(['command']) && taken.length === 0, `${j(empty)} · ${j(emptyShell)}`)
  await door.acceptInputRow({ type: 'prompt', content: 'words', id: 'p-1', priority: 'later', sent_at: '2026-01-02T03:04:05.000Z', origin: SATURN, schema: { type: 'object' } } as never, ports)
  await door.acceptInputRow({ type: 'prompt', content: [{ type: 'text', text: 'a block' }, { type: 'image', media_type: 'image/png', data: 'AAAA' }] } as never, ports)
  await door.acceptInputRow({ type: 'shell', command: 'ls', id: 's-1' } as never, ports)
  await door.acceptInputRow({ type: 'note', to: 'a-crewmate', content: 'a word' } as never, ports)
  await door.acceptInputRow({ type: 'outside-report', sender: 'the-reporter', content: 'a report', id: 'r-1' } as never, ports)
  check(
    'a row is handed on whole: its id, priority, time, origin and schema beside its words, an image block as a base64 source, and each kind under its own name',
    j(taken) ===
      j([
        { kind: 'prompt', content: 'words', schema: { type: 'object' }, id: 'p-1', priority: 'later', sentAt: '2026-01-02T03:04:05.000Z', origin: SATURN },
        { kind: 'prompt', content: [{ type: 'text', text: 'a block' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
        { kind: 'shell', command: 'ls', id: 's-1' },
        { kind: 'note', to: 'a-crewmate', content: 'a word' },
        { kind: 'outside-report', sender: 'the-reporter', content: 'a report', id: 'r-1' },
      ]),
    j(taken),
  )
}

section('§5 the rows door of a runner that waits for a claim, and the local wake')
{
  const { BOOT_STEPS } = await import('../../src/daemon/runner/boot/bootList.ts')
  const { BOOT_ENDS } = await import('../../src/daemon/runner/runnerPorts.ts')
  const refusal = BOOT_STEPS.find(step => step.name === 'refuseClaimlessRowsDoor')
  const booting = async (wire: boolean, awaiting: boolean): Promise<{ result: unknown; lines: string[]; exits: unknown[] }> => {
    const s = scene({ options: wire ? { door: 'wire' } : {} })
    s.live.awaitingSessionClaim = awaiting
    const lines: string[] = []
    const real = process.stderr.write
    process.stderr.write = ((chunk: unknown): boolean => (lines.push(String(chunk)), true)) as typeof process.stderr.write
    let result: unknown
    try {
      result = await refusal?.run(s.ports)
    } finally {
      process.stderr.write = real
    }
    return { result, lines, exits: said('gracefulShutdownSync').map(call => call.args[0]) }
  }
  const unclaimable = await booting(false, true)
  check(
    'a run on the rows door that waits for a claim is refused at the boot, where no claim can land: the boot ends with one sentence on stderr that says what it waits for and how to name a session, and exit 2',
    refusal !== undefined && unclaimable.result === BOOT_ENDS && j(unclaimable.exits) === j([2]) && unclaimable.lines.length === 1 && ['MERCURY_CONCOURSE_WORKER=1', 'session/claim', 'mercury runner', '--session-id', '--continue', '--resume'].every(word => unclaimable.lines[0]!.includes(word)) && unclaimable.lines[0]!.endsWith('\n'),
    `${j(unclaimable.exits)} · ${j(unclaimable.lines)}`,
  )
  const onTheWire = await booting(true, true)
  const named = await booting(false, false)
  check('…the wire door, where a claim does land, and a run that carries its session boot on and write nothing', onTheWire.result !== BOOT_ENDS && onTheWire.exits.length === 0 && onTheWire.lines.length === 0 && named.result !== BOOT_ENDS && named.exits.length === 0 && named.lines.length === 0, `${j(onTheWire)} · ${j(named)}`)

  const oneShot = scene({ streamingInput: false })
  door.armLocalWake(oneShot.ports)
  const armedForOneShot = said('registerLocalWakeSink').length
  const streaming = scene({ streamingInput: true })
  door.armLocalWake(streaming.ports)
  const sink = said('registerLocalWakeSink')[0]?.args[0] as ((prompt: string, facts?: Record<string, unknown>) => void) | undefined
  check('run.ts arms the local-wake sink only for streaming input (the OFF-surface evidence)', armedForOneShot === 0 && said('registerLocalWakeSink').length === 1 && typeof sink === 'function', `one-shot arms ${armedForOneShot}, total ${said('registerLocalWakeSink').length}; armLocalWake in src/daemon/runner/inputDoor.ts must register the sink only when streamingInput is set`)
  sink?.('the wake words', { spelling: 'in ten minutes', reason: 'look again' })
  const woke = queued()[0]
  const origin = woke?.origin as { kind?: string; fire?: string; firedAt?: string; spelling?: string; reason?: string } | undefined
  check('the seatless wake road spreads the one stamp (red on the base: a literal of its own)', origin?.kind === 'saturn' && origin.fire === 'wake' && origin.spelling === 'in ten minutes' && origin.reason === 'look again' && j({ origin: woke?.origin, workload: woke?.workload }) === j(saturnQueueStamp(woke?.origin)) && woke?.workload === 'cron' && woke.value === 'the wake words' && woke.mode === 'prompt' && woke.priority === 'later' && woke.skipSlashCommands === true && typeof woke.uuid === 'string' && streaming.kicks() === 1, j(woke))
  check('the sink queues the wake as words for the model, never as a meta row: no isMeta, skipSlashCommands (red on the base: isMeta: true)', woke !== undefined && j(Object.keys(woke).sort()) === j(['mode', 'origin', 'priority', 'skipSlashCommands', 'uuid', 'value', 'workload']), j(Object.keys(woke ?? {}).sort()))
  const closed = scene({ streamingInput: true })
  door.armLocalWake(closed.ports)
  closed.live.inputClosed = true
  ;(said('registerLocalWakeSink')[0]?.args[0] as (prompt: string) => void)('after the input closed')
  const walled = scene({ streamingInput: true })
  answers.set('sessionLaneWall', () => ({ closed: true, reopensAtMs: Date.now() + 60_000 }))
  door.armLocalWake(walled.ports)
  ;(said('registerLocalWakeSink')[0]?.args[0] as (prompt: string) => void)('behind the wall')
  check('a wake after the input closed queues nothing, and a wake behind a closed wall waits and does not queue', queued().length === 0 && closed.kicks() === 0 && walled.kicks() === 0, `${j(queued())} kicks ${closed.kicks()} ${walled.kicks()}; the sink armed by armLocalWake in src/daemon/runner/inputDoor.ts must queue nothing after inputClosed or behind a closed lane wall`)
}

section('§6 the notification frames: one announcer, each notice once, and never one the runner retired itself')
{
  const rows: Array<Record<string, unknown>> = []
  const frames: string[][] = []
  const s = scene({ announcedNotifications: new WeakSet(), emitTaskNotificationFrames: (payloads: string[]) => void frames.push(payloads) })
  const notice = (id: string): Record<string, unknown> => ({ mode: 'task-notification', value: `<task-notification><task-id>${id}</task-id><status>completed</status><summary>done ${id}</summary></task-notification>` })
  const a = notice('a')
  const b = notice('b')
  const words = { mode: 'prompt', value: 'plain words' }
  door.emitCommandNotifications([a, a, b, words] as never, s.ports)
  door.emitCommandNotifications([a, b] as never, s.ports)
  check("lock: every road that speaks a notice's frame — the drain, the idle kick and the next operator turn's held deliveries — goes through one announcer that speaks each notice exactly once", frames.length === 3 && frames[0]!.length === 1 && frames[0]![0]!.includes('<task-id>a</task-id>') && frames[1]![0]!.includes('<task-id>b</task-id>') && frames[2]!.length === 0, j(frames))
  check('an outside report speaks no frame, and two notices in one value speak two', door.taskNotificationPayloads({ mode: 'task-notification', value: 'x', origin: { kind: 'outside-report' } } as never).length === 0 && door.taskNotificationPayloads({ mode: 'prompt', value: `${String(a.value)} and ${String(b.value)}` } as never).length === 2, 'taskNotificationPayloads in src/daemon/runner/inputDoor.ts must return no payload for an outside-report and two for a value holding two notices')

  const told = scene({ enqueueRow: (row: Record<string, unknown>) => void rows.push(row), liveScope: () => ({ session_id: 'the-session', turn: 2 }) })
  door.emitTaskNotificationFrames(
    [
      '<task-notification><task-id>t-1</task-id><tool-use-id>call-1</tool-use-id><output-file>/out/t-1</output-file><status>completed</status><summary>all done</summary><total-tokens>120</total-tokens><tool-uses>3</tool-uses><duration-ms>900</duration-ms></task-notification>',
      '<task-notification><task-id>t-2</task-id><status>killed</status><summary>stopped</summary></task-notification>',
      `<task-notification><task-id>t-3</task-id><status>${AGENT_MESSAGE_STATUS}</status><summary>a message</summary></task-notification>`,
      '<task-notification><task-id>t-4</task-id><summary>no status</summary></task-notification>',
    ],
    told.ports,
  )
  check(
    'a completion is one task row under the live scope: ended with its status, call, file, summary and usage; killed reads stopped; a message or a pause is progress; a payload with no status is no row',
    rows.length === 3 && rows[0]!.type === 'task' && rows[0]!.state === 'ended' && rows[0]!.status === 'completed' && rows[0]!.task_id === 't-1' && rows[0]!.turn === 2 && j(rows[0]!.usage) === j({ tokens: 120, tool_uses: 3, duration_ms: 900 }) && rows[1]!.status === 'stopped' && !('usage' in rows[1]!) && rows[2]!.state === 'progress' && !('status' in rows[2]!),
    `${j(rows)}; emitTaskNotificationFrames in src/daemon/runner/inputDoor.ts builds these task rows`,
  )

  const drained: unknown[][] = []
  const watch = scene({ emitCommandNotifications: (commands: unknown[]) => void drained.push(commands) })
  const stop = () => {}
  answers.set('subscribeQueueConsumption', () => stop)
  const stopped = door.watchDrainedNotifications(watch.ports)
  const listener = said('subscribeQueueConsumption')[0]?.args[0] as ((event: Record<string, unknown>) => void) | undefined
  const agentNotice = { ...notice('c'), agentId: 'a-crewmate' }
  listener?.({ kind: 'removed', commands: [a, agentNotice, words] })
  listener?.({ kind: 'added', commands: [b] })
  const spoken = drained.length
  watch.live.retiringQueuedCommands = true
  listener?.({ kind: 'removed', commands: [b] })
  check('lock: the runner speaks one task_notification frame per completion on the drain road too — a main-thread notice the mid-turn drain consumed, never one the runner retired itself', stopped === stop && spoken === 1 && j(drained) === j([[a]]) && drained[0]![0] === a, j(drained))
  const retire = scene()
  door.retireQueuedCommands([a, b] as never, retire.ports)
  const during = said('remove')[0]
  answers.set('remove', () => {
    throw new Error('the queue refused')
  })
  let threw = false
  try {
    door.retireQueuedCommands([a] as never, retire.ports)
  } catch {
    threw = true
  }
  check("the runner's own retire door marks itself while it removes, and unmarks when the removal ends or throws", during?.retiring === true && j(during.args[0]) === j([a, b]) && threw && !retire.live.retiringQueuedCommands, `${String(during?.retiring)} · ${threw} · ${retire.live.retiringQueuedCommands}`)
}

console.log(failures === 0 ? '\nprove-input-door: green' : `\nprove-input-door: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
