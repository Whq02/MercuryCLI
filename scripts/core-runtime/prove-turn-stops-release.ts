#!/usr/bin/env bun
import { SCENARIOS, openRig, type Scenario } from './turnScenarios.ts'

const { runEventCore } = await import('../../src/run-core/turn-machine.ts')
const governor = await import('../../src/services/capacity/governor.ts')

const STREAM_FILE = 'src/run-core/turn/streamModel.ts'
const SETTLE_MS = 5
const STOP_BUDGET_MS = 8_000

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the stops of the turn machine exceeded 280s')
  process.exit(1)
}, 280_000)
guard.unref?.()

type Stop = { how: 'whole run' | 'return()' | 'throw()'; at: number }
type Driven = { yields: string[]; stoppedAt: string | null; permits: string[]; ended: boolean }

async function drive(scenario: Scenario, stop: Stop): Promise<Driven> {
  const open = openRig(scenario.plan())
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
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
  const held = governor.heldPermits()
  const permits = held.map(permit => `${permit.lane} ${permit.callId}`)
  for (const permit of held) governor.releaseModelPermit(permit.permitId)
  open.close()
  return { yields, stoppedAt, permits, ended }
}

console.log('============================================================')
console.log(' the turn machine, stopped: a reader that ends the run at any yield leaves no model permit held')
console.log('============================================================')

const only = process.argv.indexOf('--only') >= 0 ? process.argv[process.argv.indexOf('--only') + 1] : undefined
const scenarios = only === undefined ? SCENARIOS : SCENARIOS.filter(scenario => scenario.name === only)
const stopsAt = new Map<string, number>()
let stops = 0
let stopsThatLeak = 0

section(`(1) each of the ${scenarios.length} scenarios, run whole and then stopped at every yield by return() and by throw()`)
for (const scenario of scenarios) {
  const whole = await drive(scenario, { how: 'whole run', at: 0 })
  const leaks: string[] = whole.permits.length > 0 ? [`after the whole run: ${whole.permits.join(', ')}`] : []
  const hung: string[] = whole.ended ? [] : ['the whole run']
  for (const how of ['return()', 'throw()'] as const) {
    for (let at = 1; at <= whole.yields.length; at++) {
      const stopped = await drive(scenario, { how, at })
      if (stopped.stoppedAt === null) continue
      stops++
      stopsAt.set(stopped.stoppedAt, (stopsAt.get(stopped.stoppedAt) ?? 0) + 1)
      if (!stopped.ended) hung.push(`${how} at yield ${at} (${stopped.stoppedAt})`)
      if (stopped.permits.length === 0) continue
      stopsThatLeak++
      leaks.push(`${how} at yield ${at} (${stopped.stoppedAt}): ${stopped.permits.join(', ')}`)
    }
  }
  check(
    `${scenario.name}: ${whole.yields.length} yields, no permit held after the whole run or after a stop at any of them`,
    leaks.length === 0 && hung.length === 0,
    `${leaks.length} left a permit held — ${leaks.slice(0, 4).join(' · ')}${leaks.length > 4 ? ' · …' : ''}${hung.length > 0 ? ` — did not end within ${STOP_BUDGET_MS} ms: ${hung.slice(0, 4).join(' · ')}` : ''} — a permit is released where it is taken: waitForModelPermit of ${STREAM_FILE} releases what it took when it is closed at its own yield, and streamModel opens the try whose finally releases the permit before announceModelCall`,
  )
}

if (only === undefined) {
  section('(2) the stops reach the yields that stand between a permit and its release')
  const atPermit = stopsAt.get('model_permit') ?? 0
  const atCallStarted = stopsAt.get('model_call_started') ?? 0
  check(
    `${stops} stops over ${scenarios.length} scenarios, ${atPermit} at model_permit and ${atCallStarted} at model_call_started: none left a permit held`,
    stopsThatLeak === 0 && atPermit >= 2 * scenarios.length - 4 && atCallStarted >= 2 * scenarios.length - 4,
    `${stopsThatLeak} of ${stops} stops left a permit held; a scenario that asks the model is stopped at its model_permit and at its model_call_started by return() and by throw() (${atPermit} and ${atCallStarted} stops; ${2 * scenarios.length - 4} of each at least) — if the machine no longer yields those two events before it streams, name the yields that now stand between acquireModelPermit and the try that releases it`,
  )
}

console.log('')
console.log(failures === 0 ? `prove-turn-stops-release: ALL HOLD — ${checks} checks` : `prove-turn-stops-release: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
