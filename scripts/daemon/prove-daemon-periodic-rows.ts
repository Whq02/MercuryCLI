#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'daemon-periodic-rows-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SELF = 'scripts/daemon/prove-daemon-periodic-rows.ts'
const PART = 'src/daemon/run/periodic.ts'

let failures = 0
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const STOPS = ['stopPlaneHeal', 'stopArmedBeat', 'stopSessionlessBeat', 'stopLockBeat'] as const
type Stop = (typeof STOPS)[number]
type Row = { name: string; everyMs: number; holdsTheProcess: boolean; stoppedBy: Stop | null; does: string }
const ROWS: Row[] = [
  { name: 'the plane heal floor', everyMs: 30_000, holdsTheProcess: false, stoppedBy: 'stopPlaneHeal', does: 'the heal check, when no watch of the plane folders has called it: the key, the record and the socket are put back when one is missing, and who serves the plane is read' },
  { name: 'the armed-restart beat', everyMs: 4_000, holdsTheProcess: false, stoppedBy: 'stopArmedBeat', does: 'a restart that was armed behind live work is taken once nothing lives, is being born or is hosted by an older daemon' },
  { name: 'the sessionless beat', everyMs: 5_000, holdsTheProcess: false, stoppedBy: 'stopSessionlessBeat', does: 'an owned daemon that hosts nothing leaves after its grace, and says once what holds it' },
  { name: 'the idle-predecessor sweep', everyMs: 5_000, holdsTheProcess: false, stoppedBy: 'stopSessionlessBeat', does: 'after a handover: the sockets of helpers that left are removed, and an older daemon that reads idle is asked to leave' },
  { name: 'the handover lock beat', everyMs: 2_000, holdsTheProcess: false, stoppedBy: 'stopLockBeat', does: 'after a handover without the lock: the daemon lock is taken when its holder has left, and the beat stops itself' },
  { name: 'the reconcile tick', everyMs: 60_000, holdsTheProcess: false, stoppedBy: null, does: 'the worker records are reconciled when the roster or the records moved, idle empty sessions are retired, idle warm runners are swept; nothing stops it but the exit' },
  { name: 'the keep-alive', everyMs: 1 << 30, holdsTheProcess: true, stoppedBy: null, does: 'nothing: it holds the event loop open, and the way out clears the handle it is handed' },
]

type Armed = { ms: number; work: () => void; released: boolean; cleared: boolean }
const did: string[] = []
const armedNow: Armed[] = []
const realSet = globalThis.setInterval
const realClear = globalThis.clearInterval
globalThis.setInterval = ((work: () => void, ms?: number) => {
  const timer: Armed = { ms: ms ?? 0, work, released: false, cleared: false }
  armedNow.push(timer)
  did.push(`arm ${ms}`)
  return Object.assign(timer, {
    unref: () => {
      timer.released = true
      did.push(`unref ${ms}`)
      return timer
    },
  })
}) as never
globalThis.clearInterval = ((timer: unknown) => {
  const known = armedNow.find(armed => armed === timer)
  if (known === undefined) return realClear(timer as never)
  known.cleared = true
  did.push(`clear ${known.ms}`)
}) as never

try {
  const { periodicArmer } = await import('../../src/daemon/run/periodic.ts')
  const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
  const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')
  type State = ReturnType<typeof makeDaemonRunState>
  type Arm = (name: string, work: () => void, alsoStops?: () => void) => unknown
  const fresh = (): { state: State; arm: Arm } => {
    armedNow.length = 0
    did.length = 0
    const state = makeDaemonRunState({ dir: home, bootBuildTree: 'aaaaaaaaaaaa', foreground: false, breaker: new DaemonBreaker(), maxInflight: 1, controlEnabled: true })
    return { state, arm: periodicArmer(state) as Arm }
  }
  const thrown = (run: () => void): string | null => {
    try {
      run()
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  section(`§1 the ${ROWS.length} rows of the daemon's periodic work, armed through the one function the boot arms them by, in the order the boot arms them`)
  {
    const { state, arm } = fresh()
    const ran: string[] = []
    const handles: unknown[] = []
    const refused = ROWS.map(row => thrown(() => void handles.push(arm(row.name, () => void ran.push(row.name), () => void did.push(`also ${row.name}`)))))
    const wrong = refused.flatMap((why, i) => (why === null ? [] : [`"${ROWS[i]!.name}" is not armed: ${why}`]))
    check(`every row this proof holds is a row of the list and arms in this order: ${ROWS.map(row => row.name).join(', ')}`, wrong.length === 0, `${wrong.join(' | ')} — a row was dropped from ${PART}, renamed, or moved before one this proof holds ahead of it: put the list back, or change ${SELF} in the same commit and say what a daemon now arms first`)
    for (const [i, row] of ROWS.entries()) {
      const timer = armedNow[i]
      const period = timer?.ms
      check(`${row.name}: every ${row.everyMs} ms, ${row.holdsTheProcess ? 'holding the process open' : 'not holding the process open'} — ${row.does}`, timer !== undefined && period === row.everyMs && timer.released === !row.holdsTheProcess && handles[i] === timer, timer === undefined ? `nothing was armed for it` : period !== row.everyMs ? `it is armed every ${period} ms: the period is behaviour — put ${row.everyMs} back in its row of ${PART}, or change ${SELF} in the same commit and say what a daemon now does more or less often` : timer.released === row.holdsTheProcess ? `it ${timer.released ? 'does not hold' : 'holds'} the process open, and this proof holds the other: set holdsTheProcess in its row of ${PART}` : 'the function does not hand back the timer it armed: the keep-alive is cleared by the handle the way out is handed')
      timer?.work()
      check(`${row.name}: its tick runs the work it was armed with and no other`, ran.join() === row.name, `the tick ran ${JSON.stringify(ran)}: the arming function hands setInterval the work of its caller — put \`setInterval(work, row.everyMs)\` back in ${PART}`)
      ran.length = 0
    }
    const handed = STOPS.filter(stop => state[stop] !== null)
    const held = [...new Set(ROWS.flatMap(row => (row.stoppedBy === null ? [] : [row.stoppedBy])))]
    check(`arming gives the state the handles the way out calls, and no other: ${held.join(', ')}`, handed.join() === held.join(), `the state holds ${handed.join(', ') || 'none'}`)
    for (const stop of STOPS) {
      did.length = 0
      state[stop]?.()
      const rows = ROWS.filter(row => row.stoppedBy === stop)
      const kept = [...rows].reverse().flatMap(row => [`clear ${row.everyMs}`, `also ${row.name}`])
      check(`${stop} stops ${[...rows].reverse().map(row => row.name).join(', then ') || 'nothing'}: each interval is cleared, then what its caller added runs, the row armed last first`, did.join(' · ') === kept.join(' · ') && rows.every(row => armedNow[ROWS.indexOf(row)]?.cleared === true), `it did ${JSON.stringify(did)} where this proof holds ${JSON.stringify(kept)} — what stops a row is its stoppedBy in ${PART}; a handle that is not called, or called in another order, leaves an interval running on the way out`)
    }
    const never = ROWS.filter(row => row.stoppedBy === null)
    check(`no handle of the state stops ${never.map(row => row.name).join(' or ')}`, never.every(row => armedNow[ROWS.indexOf(row)]?.cleared === false), never.filter(row => armedNow[ROWS.indexOf(row)]?.cleared !== false).map(row => row.name))
  }

  section('§2 the order of the list is the order the boot arms in: each pair of neighbours, both ways round')
  {
    for (const [i, first] of ROWS.entries()) {
      const second = ROWS[i + 1]
      if (second === undefined) continue
      const inOrder = fresh()
      const kept = thrown(() => {
        inOrder.arm(first.name, () => {})
        inOrder.arm(second.name, () => {})
      })
      const turned = fresh()
      const refused = thrown(() => {
        turned.arm(second.name, () => {})
        turned.arm(first.name, () => {})
      })
      check(`"${first.name}" is armed before "${second.name}", and the other way round is refused`, kept === null && refused !== null && refused.includes(`"${first.name}" was asked after "${second.name}"`), kept !== null ? `the list of ${PART} holds "${second.name}" before "${first.name}", and this proof holds "${first.name}" first — two rows changed places: the order the daemon arms its periodic work in is behaviour; put the rows of ${PART} back in the order of ${SELF}, or change both in one commit and say what a daemon now arms first` : `arming "${second.name}" and then "${first.name}" was not refused (${refused ?? 'no error'}): the arming function holds the boot to the order of the list — put the check of the order back in ${PART}`)
    }
    const skipping = fresh()
    const skipped = thrown(() => {
      skipping.arm(ROWS[0]!.name, () => {})
      skipping.arm(ROWS[2]!.name, () => {})
      skipping.arm(ROWS[5]!.name, () => {})
      skipping.arm(ROWS[6]!.name, () => {})
    })
    check('a boot that arms fewer rows (no handover: no sweep, no lock beat) is in order all the same', skipped === null && armedNow.map(timer => timer.ms).join() === [ROWS[0]!, ROWS[2]!, ROWS[5]!, ROWS[6]!].map(row => row.everyMs).join(), skipped ?? armedNow.map(timer => timer.ms))
    const alone = fresh()
    check('with the control layer off the keep-alive is the one row armed', thrown(() => void alone.arm(ROWS[6]!.name, () => {})) === null && armedNow.length === 1 && armedNow[0]!.released === false && STOPS.every(stop => alone.state[stop] === null))
    const twice = fresh()
    const again = thrown(() => {
      twice.arm(ROWS[1]!.name, () => {})
      twice.arm(ROWS[1]!.name, () => {})
    })
    check('a row is armed once: a second arming of it is refused', again !== null && armedNow.length === 1, again ?? 'no error')
  }
} finally {
  globalThis.setInterval = realSet
  globalThis.clearInterval = realClear
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nprove-daemon-periodic-rows: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
