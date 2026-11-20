#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { EndPart } from '../../src/daemon/roster/end.js'
import type { WorkerHandle } from '../../src/daemon/roster/types.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

function makeFakeChild(): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess
  const stdin = { destroyed: false, writableEnded: false, end() { this.writableEnded = true } }
  Object.assign(emitter, { stdin, pid: 0 })
  return emitter
}

function makeIdleHandle(): WorkerHandle {
  return {
    longLived: { turnActive: false, waitingOnAgents: 0 },
  } as unknown as WorkerHandle
}

console.log('============================================================')
console.log(' Deadlines d06: poll-event conversions settle on the event')
console.log('============================================================')

section('EndPart.askedSettled settles on child exit without the 25 ms poll')
{
  const end = new EndPart({ platform: 'win32', runnerAskBoundMs: 5_000 })
  let immediateResolved = false
  await end.askedSettled().then(() => {
    immediateResolved = true
  })
  check('askedSettled resolves immediately when no child is pending', immediateResolved)

  const child = makeFakeChild()
  end.endChild('w1', makeIdleHandle(), child, 'SIGTERM')

  let settled = false
  let settledOnMicrotask = false
  let emittedAt = 0
  let settledAt = 0
  const startedAt = performance.now()
  const waiter = end.askedSettled().then(() => {
    settled = true
    settledAt = performance.now()
  })

  await new Promise<void>(resolve => {
    setTimeout(() => {
      emittedAt = performance.now()
      child.emit('exit', 0, null)
      queueMicrotask(() => {
        queueMicrotask(() => {
          settledOnMicrotask = settled
          resolve()
        })
      })
    }, 5)
  })
  await waiter
  const afterEmitMs = Math.round((settledAt - emittedAt) * 100) / 100
  const totalMs = Math.round(settledAt - startedAt)
  check(
    'askedSettled settles on the microtask after child exit (red under a 25 ms sleep poll)',
    settledOnMicrotask && afterEmitMs < 20,
    `settledOnMicrotask=${settledOnMicrotask} afterEmitMs=${afterEmitMs} totalMs=${totalMs}`,
  )

  const a = makeFakeChild()
  const b = makeFakeChild()
  end.endChild('w2', makeIdleHandle(), a, 'SIGTERM')
  end.endChild('w3', makeIdleHandle(), b, 'SIGTERM')
  let bothSettled = false
  const bothWaiter = end.askedSettled().then(() => {
    bothSettled = true
  })
  a.emit('exit', 0, null)
  await Promise.resolve()
  await Promise.resolve()
  const stillWaitingAfterOne = !bothSettled
  b.emit('exit', 0, null)
  await Promise.resolve()
  await Promise.resolve()
  const doneAfterSecond = bothSettled
  await bothWaiter
  check(
    'askedSettled stays pending until the last pending child exits, then settles immediately',
    stillWaitingAfterOne && doneAfterSecond,
    `stillWaitingAfterOne=${stillWaitingAfterOne} doneAfterSecond=${doneAfterSecond}`,
  )
}

console.log(failures === 0 ? '\nprove-deadlines-d06: green' : `\nprove-deadlines-d06: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
