#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { checker, scratchRoot, guardWrite } from './harness.ts'

const ROOT = scratchRoot('drain')
const t = checker()

const barrier = await import('./barrier.ts')

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

async function runTurn(
  sessionId: string,
  close: 'return' | 'throw' | 'early-return',
): Promise<{ order: string[]; onDisk: string }> {
  const owner = makeOwnerKey({ workspace: ROOT, sessionId, lane: 'main' })
  const path = guardWrite(ROOT, sidecar.runSidecarPath(owner))
  machineExit = close === 'throw' ? 'throw' : 'return'

  const it = queryEvents(paramsFor(owner) as never)
  await it.next()
  coord.noteRunEvent(owner, { type: 'substantive', at: 2, reason: 'edits landed' })

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
