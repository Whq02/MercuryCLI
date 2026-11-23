#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { SCENARIOS, fixtures, openRig, runScripted, type Scenario } from './turnScenarios.ts'

const { runEventCore } = await import('../../src/engine/loop/turn-machine.ts')
const governor = await import('../../src/crew/capacity/governor.ts')
const trace = await import('../../src/platform/observability/invocationTrace.ts')

const STREAM_FILE = 'src/engine/loop/turn/streamModel.ts'
const EARLY_FILE = 'src/engine/tool-dispatch/earlyStarts.ts'
const GATE_FILE = 'src/engine/tool-dispatch/toolExecution.ts'
const SETTLE_MS = 5
const STOP_BUDGET_MS = 8_000
const LISTENER_BUDGET_MS = 400
const SLOW_LISTENERS_WAITED_FOR = 30
const TRACE_BUDGET_MS = 5_000

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const guard = setTimeout(() => {
  console.log(`\nTIMEOUT — the stops of the turn machine exceeded 280s; rerun one scenario alone with --only <name> to find the one that does not end, and look at where it waits in ${STREAM_FILE}`)
  process.exit(1)
}, 280_000)
guard.unref?.()

type Stop = { how: 'whole run' | 'return()' | 'throw()'; at: number }
type Driven = { yields: string[]; stoppedAt: string | null; permits: string[]; listeners: number; listenersAdded: number; modelCalls: number; ended: boolean }

function watchAbortListeners(signal: AbortSignal): { left: () => number; added: () => number } {
  const live = new Map<unknown, boolean>()
  let added = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  add('abort', () => {
    for (const [listener, once] of live) if (once) live.delete(listener)
  })
  signal.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type === 'abort') {
      added++
      live.set(listener, typeof options === 'object' && options !== null && (options as { once?: boolean }).once === true)
    }
    return add(type as never, listener as never, options as never)
  }) as never
  signal.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type === 'abort') live.delete(listener)
    return remove(type as never, listener as never, options as never)
  }) as never
  return { left: () => live.size, added: () => added }
}

let slowListeners = 0

async function drive(scenario: Scenario, stop: Stop): Promise<Driven> {
  const open = openRig(scenario.plan())
  const listeners = watchAbortListeners(open.rig.abortController.signal)
  const yields: string[] = []
  let stoppedAt: string | null = null
  const gen = runEventCore(open.params as never, open.consumed)
  const work = (async (): Promise<boolean> => {
    try {
      let step = await gen.next()
      while (!step.done) {
        const kind = (step.value as { kind: string }).kind
        yields.push(kind)
        if (stop.how !== 'whole run' && yields.length === stop.at) {
          stoppedAt = kind
          let after = stop.how === 'return()' ? await gen.return({ reason: 'completed' }) : await gen.throw(new Error('the reader threw'))
          while (!after.done) after = await gen.next()
          return true
        }
        step = await gen.next()
      }
      return true
    } catch {
      return true
    }
  })()
  let late: ReturnType<typeof setTimeout> | undefined
  const ended = await Promise.race([work, new Promise<boolean>(resolve => (late = setTimeout(() => resolve(false), STOP_BUDGET_MS)))])
  clearTimeout(late)
  await sleep(SETTLE_MS)
  const listenerBudget = slowListeners < SLOW_LISTENERS_WAITED_FOR ? LISTENER_BUDGET_MS : 20
  for (let waited = 0; listeners.left() > 0 && waited < listenerBudget; waited += 10) await sleep(10)
  if (listeners.left() > 0) slowListeners++
  const held = governor.heldPermits()
  const permits = held.map(permit => `${permit.lane} ${permit.callId}`)
  for (const permit of held) governor.releaseModelPermit(permit.permitId)
  const driven = { yields, stoppedAt, permits, listeners: listeners.left(), listenersAdded: listeners.added(), modelCalls: open.counts.modelCalls, ended }
  open.close()
  return driven
}

console.log('============================================================')
console.log(' the turn machine, stopped: a reader that ends the run at any yield leaves no model permit held and no listener on the run\'s abort signal')
console.log('============================================================')

const only = process.argv.indexOf('--only') >= 0 ? process.argv[process.argv.indexOf('--only') + 1] : undefined
const scenarios = only === undefined ? SCENARIOS : SCENARIOS.filter(scenario => scenario.name === only)
const stopsAt = new Map<string, number>()
let stops = 0
let stopsThatHoldAPermit = 0
let drivesThatLeaveAListener = 0
let scenariosThatListenBesideTheModelCall = 0

section(`(1) each of the ${scenarios.length} scenarios, run whole and then stopped at every yield by return() and by throw()`)
for (const scenario of scenarios) {
  const whole = await drive(scenario, { how: 'whole run', at: 0 })
  if (whole.listenersAdded > whole.modelCalls) scenariosThatListenBesideTheModelCall++
  const permits: string[] = whole.permits.length > 0 ? [`the whole run: ${whole.permits.join(', ')}`] : []
  const listeners: string[] = whole.listeners > 0 ? [`the whole run: ${whole.listeners} of ${whole.listenersAdded} added`] : []
  const hung: string[] = whole.ended ? [] : ['the whole run']
  for (const how of ['return()', 'throw()'] as const) {
    for (let at = 1; at <= whole.yields.length; at++) {
      const stopped = await drive(scenario, { how, at })
      if (stopped.stoppedAt === null) continue
      stops++
      stopsAt.set(stopped.stoppedAt, (stopsAt.get(stopped.stoppedAt) ?? 0) + 1)
      if (!stopped.ended) hung.push(`${how} at yield ${at} (${stopped.stoppedAt})`)
      if (stopped.permits.length > 0) {
        stopsThatHoldAPermit++
        permits.push(`${how} at yield ${at} (${stopped.stoppedAt}): ${stopped.permits.join(', ')}`)
      }
      if (stopped.listeners > 0) listeners.push(`${how} at yield ${at} (${stopped.stoppedAt}): ${stopped.listeners} of ${stopped.listenersAdded} added`)
    }
  }
  drivesThatLeaveAListener += listeners.length
  const few = (rows: string[]): string => `${rows.slice(0, 3).join(' · ')}${rows.length > 3 ? ' · …' : ''}`
  check(
    `${scenario.name}: ${whole.yields.length} yields; the whole run and a stop at each of them leave no permit held and no listener on the run's abort signal`,
    permits.length === 0 && listeners.length === 0 && hung.length === 0,
    [
      permits.length > 0
        ? `${permits.length} left a permit held (${few(permits)}): a permit is released where it is taken — waitForModelPermit of ${STREAM_FILE} releases what it took when it is closed at its own yield, and streamModel opens the try whose finally releases the permit before announceModelCall`
        : '',
      listeners.length > 0
        ? `${listeners.length} left a listener on the signal ${LISTENER_BUDGET_MS} ms after the end (${few(listeners)}): who adds a listener to the run's signal removes it when its own work ends — a tool call started early (${EARLY_FILE}) when the call settles, a model call (${STREAM_FILE}) in the finally of its try`
        : '',
      hung.length > 0 ? `did not end within ${STOP_BUDGET_MS} ms: ${few(hung)}` : '',
    ]
      .filter(Boolean)
      .join(' — '),
  )
}

if (only === undefined) {
  section('(2) the stops reach what they are about')
  const atPermit = stopsAt.get('model_permit') ?? 0
  const atCallStarted = stopsAt.get('model_call_started') ?? 0
  const floor = 2 * scenarios.length - 4
  check(
    `${stops} stops over ${scenarios.length} scenarios, ${atPermit} at model_permit and ${atCallStarted} at model_call_started: none left a permit held`,
    stopsThatHoldAPermit === 0 && atPermit >= floor && atCallStarted >= floor,
    `${stopsThatHoldAPermit} of ${stops} stops left a permit held; a scenario that asks the model is stopped at its model_permit and at its model_call_started by return() and by throw() (${atPermit} and ${atCallStarted} stops; ${floor} of each at least) — if the machine no longer yields those two events before it streams, name the yields that now stand between acquireModelPermit and the try that releases it`,
  )
  check(
    `${scenariosThatListenBesideTheModelCall} scenarios add a listener to the run's abort signal beside their model calls' own (a tool call started early, a tool call raced against the abort, a parked seat): no whole run and no stop left one`,
    drivesThatLeaveAListener === 0 && scenariosThatListenBesideTheModelCall >= 10,
    `${drivesThatLeaveAListener} runs or stops left a listener; ${scenariosThatListenBesideTheModelCall} scenarios add one beside their model calls (10 at least: the scenarios whose reply calls a tool) — if no scenario starts a tool call early any more, this check holds nothing: plan one in scripts/core-runtime/turnScenarios.ts`,
  )

  section('(3) a tool call cut before it began leaves no trace record')
  let cutCallRan = 0
  let tracePath = ''
  const cut = await runScripted({
    env: { MERCURY_TRACE: '1' },
    tools: [{ name: 'CutBeforeItBegan', onCall: () => void cutCallRan++ }],
    script: [[...fixtures.yields(fixtures.calls('tu_cut', 'CutBeforeItBegan', { text: 'x' })), { kind: 'throw', error: new Error('the stream failed after it announced the call') }]],
  })
  const ran = await runScripted({
    env: { MERCURY_TRACE: '1' },
    tools: [{ name: 'RanToItsEnd' }],
    before: () => {
      tracePath = trace.getInvocationTracePath()
    },
    script: [fixtures.yields(fixtures.calls('tu_ran', 'RanToItsEnd', { text: 'x' })), fixtures.yields(fixtures.says('after tools.'))],
  })
  const recordsOf = (tool: string): Array<{ tool?: string; ok?: boolean }> =>
    (existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { tool?: string; ok?: boolean })
      .filter(row => row.tool === tool)
  for (let waited = 0; recordsOf('RanToItsEnd').length === 0 && waited < TRACE_BUDGET_MS; waited += 20) {
    await trace.flushTraceNow()
    await sleep(20)
  }
  const ofTheCallThatRan = recordsOf('RanToItsEnd')
  const ofTheCutCall = recordsOf('CutBeforeItBegan')
  check(
    'a model call that fails after it announced a tool call settles that call without running it, and the trace holds a record for the call that ran in the next run and none for the cut one',
    cut.terminal.reason === 'model_error' && cutCallRan === 0 && ran.terminal.reason === 'completed' && tracePath.startsWith(ran.home) && ofTheCallThatRan.length === 1 && ofTheCallThatRan[0]?.ok === true && ofTheCutCall.length === 0,
    `the run whose stream failed ended ${String(cut.terminal.reason)} with its tool called ${cutCallRan} time(s); the run after it ended ${String(ran.terminal.reason)}; ${tracePath} holds ${ofTheCallThatRan.length} record(s) for the call that ran (${JSON.stringify(ofTheCallThatRan)}; one, ok true, is right) and ${ofTheCutCall.length} for the call cut before it began (${JSON.stringify(ofTheCutCall)}; none is right) — runTransactionBody of ${GATE_FILE} writes no invocation trace where it finds the call's signal aborted before anything of the call ran`,
  )
}

console.log('')
console.log(failures === 0 ? `prove-turn-stops-release: ALL HOLD — ${checks} checks` : `prove-turn-stops-release: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
