#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_BARE = '1'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const T = join(ROOT, 'src') + '/'
const { watchMode } = await import(T + 'daemon/runner/boot/watchMode.ts')
const { bindInputDoor } = await import(T + 'daemon/runner/boot/bindInputDoor.ts')
const { notifyPermissionModeChanged } = await import(T + 'permissions/rules/permissionModeListener.ts')
const posture = await import(T + 'screen/cockpit/runtimePosture.ts')
const queue = await import(T + 'daemon/runner/messageQueueManager.ts')
const { wrapInSystemReminder } = await import(T + 'engine/message-shapes/text.ts')
const { setAskChannel } = await import(T + 'boot/process-state/processState.ts')
const { runnerArmsOf } = await import(T + 'daemon/runner/runnerArms.ts')
const { runTurn } = await import(T + 'daemon/runner/runnerTurn.ts')
const { afterTools } = await import(T + 'engine/loop/turn/afterTools.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`); if (!ok) failures++ }
type Row = { type: string; mode: string }
type Notice = { value: string; mode: string } | null
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const realSetTimeout = globalThis.setTimeout
const realSetInterval = globalThis.setInterval
let timersStarted = 0
const countTimers = (): void => {
  Object.assign(globalThis, {
    setTimeout: (...args: Parameters<typeof setTimeout>) => { timersStarted++; return realSetTimeout(...args) },
    setInterval: (...args: Parameters<typeof setInterval>) => { timersStarted++; return realSetInterval(...args) },
  })
}
const stopCounting = (): void => { Object.assign(globalThis, { setTimeout: realSetTimeout, setInterval: realSetInterval }) }
const scene = (start: string, opts: { turnHad: boolean } = { turnHad: true }) => {
  queue.resetCommandQueue()
  posture.resetRuntimePostureForTest()
  setAskChannel('sdk')
  posture.markSessionNonInteractive(start)
  if (opts.turnHad) posture.getRuntimePostureSection()
  const rows: Row[] = []
  const made = watchMode.run({
    enqueueRow: (row: Row) => void rows.push(row),
    liveScope: () => ({ sessionId: 's' }),
  } as never) as { takeModeNotice: () => Notice; noteOperatorMode: (mode: string) => void }
  return { rows, take: made.takeModeNotice, note: made.noteOperatorMode, modes: () => rows.map(row => row.mode).join(',') }
}
const moves = (mode: string): void => notifyPermissionModeChanged(mode as never)
const noticeOf = (mode: string, from: string) => ({ value: wrapInSystemReminder(posture.permissionModeChangedReminder(mode, from)), mode: 'task-notification' })
const queued = (): unknown[] => queue.getCommandQueue()

console.log('A. the step and the listener')
{
  const s = scene('default')
  check('the step is named watchMode and makes noteOperatorMode and takeModeNotice', watchMode.name === 'watchMode' && same(watchMode.makes, ['noteOperatorMode', 'takeModeNotice']), JSON.stringify(watchMode.makes))
  moves('implement'); moves('flow'); moves('apollo'); moves('dontAsk')
  check('the listener writes a mode row at once for each of the five modes and none for another', s.modes() === 'implement,flow,dontAsk' && s.rows[0]?.type === 'mode', s.modes())
  check('a mode that moved by a road other than the operator leaves no notice to take', s.take() === null && queued().length === 0)
}
console.log('B. an operator\'s change sends nothing by itself')
{
  const s = scene('default')
  countTimers()
  s.note('implement'); s.note('flow'); s.note('sovereign')
  stopCounting()
  check('three changes start no timer', timersStarted === 0, `${timersStarted} timers`)
  check('and put nothing on the command queue and write no row', queued().length === 0 && s.rows.length === 0, JSON.stringify(queued()))
  await new Promise(resolve => realSetTimeout(resolve, 300))
  check('nothing arrives later either', queued().length === 0, JSON.stringify(queued()))
}
console.log('C. the notice is taken at a turn\'s begin, once')
{
  const s = scene('default')
  check('no change: nothing to take', s.take() === null)
  s.note('implement')
  check('one change: ONE notice, for the mode that stands, from the mode last told', same(s.take(), noticeOf('implement', 'default')), JSON.stringify(s.take()))
  check('a second turn takes nothing', s.take() === null)
  s.note('flow'); s.note('default'); s.note('sovereign')
  check('several changes between two turns: one notice, of the last mode, from the mode last told', same(s.take(), noticeOf('sovereign', 'implement')))
  s.note('flow'); s.note('sovereign')
  check('a change and a change back: no notice', s.take() === null)
  s.note('apollo')
  check('every mode the arm can set counts: apollo is told', same(s.take(), noticeOf('apollo', 'sovereign')))
}
{
  const s = scene('default', { turnHad: false })
  s.note('implement')
  check('a session that has had no turn takes none', s.take() === null)
  check('and its first turn\'s posture section states the mode that stands', (posture.getRuntimePostureSection() ?? '').includes('Permission mode for this run: implement.'), posture.getRuntimePostureSection() ?? 'null')
  check('and the next turn is not told again', s.take() === null)
}
console.log('D. the set-mode arm hands the mode to the step and tells nothing itself')
{
  const s = scene('default')
  let state = { toolPermissionContext: { mode: 'default', isBypassPermissionsModeAvailable: true } } as Record<string, unknown>
  const noted: string[] = []
  const ports = new Proxy({
    getAppState: () => state,
    setAppState: (update: (previous: unknown) => Record<string, unknown>) => { state = update(state); moves((state.toolPermissionContext as { mode: string }).mode) },
    asks: { recheckPendingPermissionRequests: async () => {} },
    noteOperatorMode: (mode: string) => { noted.push(mode); s.note(mode) },
  } as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : () => undefined) })
  const arms = runnerArmsOf(ports as never) as Record<string, (params: unknown) => unknown>
  countTimers()
  const answer = arms['session/set_mode']!({ mode: 'implement' })
  arms['session/set_mode']!({ mode: 'flow' })
  stopCounting()
  check('the arm answers the mode, notes each change and writes each row at once', same(answer, { mode: 'implement' }) && same(noted, ['implement', 'flow']) && s.modes() === 'implement,flow', `${JSON.stringify(answer)} · ${noted} · ${s.modes()}`)
  check('it starts no timer and queues nothing', timersStarted === 0 && queued().length === 0, `${timersStarted} timers · ${JSON.stringify(queued())}`)
  check('the next turn takes one notice of the last mode', same(s.take(), noticeOf('flow', 'default')))
}
console.log('E. runTurn joins the notice to the turn that begins')
{
  const STOP = new Error('probe stop')
  const begin = async (s: ReturnType<typeof scene>, command: Record<string, unknown>, opts: { local?: boolean; given?: unknown[] } = {}): Promise<unknown[] | null> => {
    let heard: unknown[] | null = null
    const ports = new Proxy({
      takeModeNotice: s.take,
      localCommandInput: () => opts.local === true,
      party: { blockOpen() {}, landed() {} },
      live: { activeModel: 'probe-model' },
      messages: [],
      emitCommandNotifications: (list: unknown[]) => { heard = list; throw STOP },
    } as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : () => undefined) })
    const ended = await runTurn(command as never, [], () => {}, opts.given as never, ports as never).then(() => 'returned', (error: unknown) => (error === STOP ? 'stopped' : `threw ${String(error)}`))
    if (ended !== 'stopped') console.log(`    (the turn ${ended})`)
    return heard
  }
  const prompt = { value: 'go', mode: 'prompt', uuid: '11111111-1111-4111-8111-111111111111' }
  const wake = { value: '<task-notification><task-id>t1</task-id><status>completed</status><summary>done</summary></task-notification>', mode: 'task-notification' }
  {
    const s = scene('default')
    check('a prompt with no change begins with the prompt alone', same(await begin(s, prompt), [prompt]))
    s.note('implement')
    check('a prompt after a change begins with the notice before the prompt', same(await begin(s, prompt), [noticeOf('implement', 'default'), prompt]))
    check('the prompt after that carries none', same(await begin(s, prompt), [prompt]))
  }
  {
    const s = scene('default')
    s.note('flow')
    const heard = await begin(s, wake)
    check('a turn a notification starts (a wake, a crewmate\'s completion) is told the same way', heard !== null && heard.length === 2 && same(heard[0], noticeOf('flow', 'default')), JSON.stringify(heard))
  }
  {
    const s = scene('default')
    const riding = { value: 'a riding notice', mode: 'task-notification' }
    s.note('sovereign')
    check('the notice stands after the notices the driver handed the turn', same(await begin(s, prompt, { given: [riding] }), [riding, noticeOf('sovereign', 'default'), prompt]))
  }
  {
    const s = scene('default')
    s.note('implement')
    check('a local command, which no model hears, takes no notice', same(await begin(s, prompt, { local: true }), [prompt]))
    check('so the next turn that goes to the model still carries it', same(await begin(s, prompt), [noticeOf('implement', 'default'), prompt]))
  }
}
type StepRow = { type: string; attachment?: { type: string; prompt?: unknown; commandMode?: string } }
const reminderOf = (mode: string, from: string): string => wrapInSystemReminder(posture.permissionModeChangedReminder(mode, from))
const step = async (s: ReturnType<typeof scene>, opts: { querySource?: string; agentId?: string; aborted?: boolean; hand?: boolean } = {}) => {
  const abortController = new AbortController()
  if (opts.aborted) abortController.abort('interrupt')
  const context = {
    abortController,
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    ...(opts.hand === false ? {} : { takeModeNotice: s.take }),
    messages: [],
    options: { tools: [], engineModel: 'probe-model', mcpClients: [] },
    getAppState: () => ({ mcp: { clients: [] } }),
  }
  const iter = {
    toolUseBlocks: [], toolUseContext: context, updatedToolUseContext: context,
    messagesForRequest: [], assistantMessages: [], toolResults: [] as StepRow[],
    state: { turnCount: 1, stopHookActive: false }, tracking: undefined,
    shouldPreventContinuation: false, loopStoppedCycle: null, loopStoppedRecord: null, callChain: { key: 't', hop: 0 },
  }
  const run = {
    querySource: opts.querySource ?? 'sdk', emit: (event: unknown) => event, params: {},
    budgetGuard: { maxTurnsExceeded: () => false }, awaitingReply: [], consumedCommandUuids: [],
  }
  const events: Array<{ kind: string }> = []
  const machine = afterTools(run as never, iter as never)
  let decision: { kind: string; next?: { messages: StepRow[] } } | undefined
  for (;;) {
    const got = await machine.next()
    if (got.done) { decision = got.value as never; break }
    events.push(got.value as never)
  }
  const riding = iter.toolResults.filter(row => row.attachment?.type === 'queued_command')
  return { decision, events, riding, next: decision?.next?.messages.filter(row => row.attachment?.type === 'queued_command') ?? [] }
}
const promptOf = (row: StepRow | undefined): string => (typeof row?.attachment?.prompt === 'string' ? row.attachment.prompt : JSON.stringify(row?.attachment?.prompt))

console.log('F. a running turn takes the notice at its next step')
{
  const s = scene('default')
  const quiet = await step(s)
  check('no change: the step hands over with no riding notice', quiet.decision?.kind === 'hand_over' && quiet.riding.length === 0, JSON.stringify(quiet.decision?.kind))
  s.note('implement'); s.note('flow')
  const told = await step(s)
  check('a change made while the turn runs rides the next model call: ONE notice, of the last mode, from the mode last told', told.decision?.kind === 'hand_over' && told.riding.length === 1 && promptOf(told.riding[0]) === reminderOf('flow', 'default') && told.riding[0]?.attachment?.commandMode === 'task-notification', `${told.riding.length} · ${promptOf(told.riding[0])}`)
  check('it is in the messages the next call is handed, and it was emitted as an attachment', told.next.length === 1 && told.events.some(event => event.kind === 'attachment'), `${told.next.length} · ${told.events.map(event => event.kind)}`)
  const after = await step(s)
  check('the step after carries none, and the next turn\'s begin has nothing left to take', after.riding.length === 0 && s.take() === null)
  check('nothing went through the command queue', queue.getCommandQueue().length === 0, JSON.stringify(queue.getCommandQueue()))
}
{
  const s = scene('default')
  s.note('implement'); s.note('default')
  const back = await step(s)
  check('a change and a change back while the turn runs: no notice', back.riding.length === 0)
}
{
  const s = scene('default')
  s.note('sovereign')
  const ended = await step(s, { aborted: true })
  check('a turn that ends before another step takes nothing', ended.decision?.kind === 'end' && ended.riding.length === 0, JSON.stringify(ended.decision))
  check('so the notice stands for the next turn\'s begin', JSON.stringify(s.take()) === JSON.stringify({ value: reminderOf('sovereign', 'default'), mode: 'task-notification' }))
}
{
  const s = scene('default')
  s.note('implement')
  const crewmate = await step(s, { querySource: 'agent:probe', agentId: 'a1' })
  check('a crewmate\'s own loop takes nothing, though the port is in its context', crewmate.decision?.kind === 'hand_over' && crewmate.riding.length === 0)
  const fork = await step(s, { querySource: 'compact' })
  check('nor does a side run that is not the main thread', fork.riding.length === 0)
  const main = await step(s, { querySource: 'main_thread' })
  check('the main thread\'s next step then carries it', main.riding.length === 1 && promptOf(main.riding[0]) === reminderOf('implement', 'default'))
}
{
  const s = scene('default')
  s.note('implement')
  const bare = await step(s, { hand: false })
  check('a turn whose host hands no port carries nothing and takes nothing', bare.riding.length === 0 && s.take() !== null)
}
console.log('\n' + (failures === 0 ? 'MODE NOTICE WAITS GREEN' : `MODE NOTICE WAITS RED: ${failures} failed`))
process.exit(failures === 0 ? 0 : 1)
