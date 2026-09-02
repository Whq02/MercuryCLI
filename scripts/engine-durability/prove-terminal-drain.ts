#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-terminal-drain.ts — M0 reproducer for defect D.
//
//  ORACLE: close a turn generator
//  by normal return, by throw, and by .return() — every path settles durably or
//  reports degraded explicitly. A terminal result is never emitted while its
//  required durable write is still outstanding.
//
//  What the code does today — src/query.ts, the queryEvents finally:
//      // Run kernel: terminal outcome + forced atomic sidecar flush. Fire-and-
//      // forget by design — the flush is awaited inside; the turn's generator
//      // teardown must never block on disk.
//      void noteQueryTurnEnd({ ... })
//  Missed invariant: required settlement before the terminal receipt.
//  noteQueryTurnEnd → noteTurnEnd ends with `await flushRun(owner)`; detaching
//  it means a process exiting right after a turn can end that work mid-flight,
//  and its errors are absorbed by the observer's own try/catch
//  (src/services/run/runTurnObserver.ts).
//
//  Rig: the turn machine is replaced by a scripted generator (the module-mock
//  seam scripts/core-runtime/prove-runsurface-contract.ts uses for src/query.ts),
//  so the REAL run lifecycle runs around a machine whose exit path this proof
//  controls exactly. The sidecar write is held by scripts/engine-durability/barrier.ts and
//  released only after a bounded number of controlled scheduling turns — so
//  "did the generator settle before its write?" is a decision, not a race.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { checker, scratchRoot, guardWrite } from './harness.ts'

const ROOT = scratchRoot('drain')
const t = checker()

const barrier = await import('./barrier.ts')

// ── the scripted turn machine (installed before src/query.ts binds it) ──────
type Terminal = { reason: string }
type MachineExit = 'return' | 'throw'
let machineExit: MachineExit = 'return'

async function* scriptedMachine(): AsyncGenerator<unknown, Terminal> {
  yield { kind: 'notice', notice: { type: 'keel-probe' } }
  if (machineExit === 'throw') throw new Error('scripted turn failure')
  return { reason: 'completed' }
}

mock.module('../../src/run-core/turn-machine.ts', () => ({
  runEventCore: () => scriptedMachine(),
}))

const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const sidecar = await import('../../src/services/run/runSidecar.ts')
const coord = await import('../../src/services/run/runCoordinator.ts')
const { queryEvents } = await import('../../src/query.ts')

function paramsFor(owner: string): unknown {
  return {
    messages: [
      { type: 'user', uuid: 'u1', isMeta: false, message: { content: 'land the change' } },
    ],
    querySource: 'repl_main_thread',
    toolUseContext: {
      owner,
      agentId: 'main',
      abortController: new AbortController(),
      options: {},
    },
  }
}

/**
 * Drive one turn to its terminal boundary with the sidecar write HELD, and
 * report whether the generator settled before the write was released.
 * `close` selects which of the three closure paths ends the turn.
 */
async function runTurn(
  sessionId: string,
  close: 'return' | 'throw' | 'early-return',
): Promise<{ order: string[]; onDisk: string }> {
  const owner = makeOwnerKey({ workspace: ROOT, sessionId, lane: 'main' })
  const path = guardWrite(ROOT, sidecar.runSidecarPath(owner))
  machineExit = close === 'throw' ? 'throw' : 'return'

  const it = queryEvents(paramsFor(owner) as never)
  await it.next() // runs the real turn-start lifecycle, parks at the scripted yield
  // Only substantive main-lane runs persist — make this one real work.
  coord.noteRunEvent(owner, { type: 'substantive', at: 2, reason: 'edits landed' })

  // The observation is an ORDERING, recorded by the events themselves: the
  // terminal write announces when it starts and when it lands, and the
  // generator announces when it settles. The gate is released the instant the
  // write reaches it, so the durable path is never artificially slowed — the
  // only question this measures is which of the two finishes first.
  const order: string[] = []
  const hold = barrier.holdNextPublish(p => p === path)
  void hold.entered.then(() => {
    order.push('write-started')
    hold.release()
  })
  void hold.settled.then(() => order.push('write-settled'))

  try {
    if (close === 'early-return') await it.return(undefined as never)
    else await it.next()
  } catch {
    /* the throw path propagates; the finally is what this proof measures */
  }
  order.push('generator-settled')

  await hold.settled
  await barrier.microturns()
  const load = await sidecar.loadRunSidecar(owner)
  return { order, onDisk: load.state }
}

for (const [close, title] of [
  ['return', 'normal return'],
  ['throw', 'throw'],
  ['early-return', '.return()'],
] as const) {
  t.section(`§ closure by ${title}`)
  const r = await runTurn(`keel-drain-${close}`, close)
  const settledAt = r.order.indexOf('write-settled')
  const generatorAt = r.order.indexOf('generator-settled')
  t.check(
    `the required terminal write settles before the turn generator does (${title})`,
    settledAt !== -1 && settledAt < generatorAt,
    `order=[${r.order.join(' → ')}]`,
  )
  t.check(
    `the terminal generation is durable once the turn's work drains (${title})`,
    r.onDisk === 'loaded',
    `sidecar state=${r.onDisk}`,
  )
}

t.finish('prove-terminal-drain')
