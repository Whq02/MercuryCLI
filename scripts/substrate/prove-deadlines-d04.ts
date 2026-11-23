#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { drainPipedStdoutForExit, observeStdoutPressure } from '../../src/platform/processes/gracefulShutdown.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const STAND_IN_POLL_MS = 5_000
const SETTLE_CEILING_MS = 500
const activeTimeouts = (): number => process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length

console.log('============================================================')
console.log(' d04 deadline proofs: poll-event waiters settle on the event')
console.log('============================================================')

section('gracefulShutdown: drainPipedStdoutForExit settles on stream drain/error without polling')
{
  const baseTimers = activeTimeouts()
  const emitter = Object.assign(new EventEmitter(), { isTTY: false, writableLength: 256, destroyed: false, writable: true })
  const t0 = performance.now()
  setTimeout(() => {
    emitter.writableLength = 0
    emitter.emit('drain')
  }, 5)
  const result = await drainPipedStdoutForExit(emitter, STAND_IN_POLL_MS)
  const elapsed = Math.round(performance.now() - t0)
  check('an emitting stream settles on drain well before the stood-in poll period', result.drained && result.remainingBytes === 0 && elapsed < SETTLE_CEILING_MS, `drained=${result.drained} remaining=${result.remainingBytes} elapsed=${elapsed}ms; make drainPipedStdoutForExit in src/platform/processes/gracefulShutdown.ts resolve on the stream drain event instead of waiting for its poll period`)
  check('no timer or drain listener is left behind after drain', activeTimeouts() === baseTimers && emitter.listenerCount('drain') === 0, `timers=${activeTimeouts() - baseTimers} listeners=${emitter.listenerCount('drain')}; drainPipedStdoutForExit in src/platform/processes/gracefulShutdown.ts must clear its timer and remove its drain listener when it settles`)
}

{
  const baseTimers = activeTimeouts()
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const blind = {
    isTTY: false,
    writableLength: 0,
    destroyed: false,
    writable: true,
    write: (): boolean => false,
    on(event: string, listener: (...args: unknown[]) => void): unknown {
      ;(listeners[event] ??= []).push(listener)
      return blind
    },
  }
  observeStdoutPressure(blind)
  blind.write()
  const t0 = performance.now()
  setTimeout(() => {
    for (const listener of listeners.drain ?? []) listener()
  }, 5)
  const result = await drainPipedStdoutForExit(blind, STAND_IN_POLL_MS)
  const elapsed = Math.round(performance.now() - t0)
  check('an observed blind stream settles on drain well before the stood-in poll period', result.drained && elapsed < SETTLE_CEILING_MS, `drained=${result.drained} elapsed=${elapsed}ms; observeStdoutPressure and drainPipedStdoutForExit in src/platform/processes/gracefulShutdown.ts must settle on a drain event from an observed stream`)
  check('no timer is left behind after observed drain', activeTimeouts() === baseTimers, `timers=${activeTimeouts() - baseTimers}; drainPipedStdoutForExit in src/platform/processes/gracefulShutdown.ts must clear its timer once the observed drain event settles it`)
}

{
  const baseTimers = activeTimeouts()
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const broken = {
    isTTY: false,
    writableLength: 0,
    destroyed: false,
    writable: true,
    write: (): boolean => false,
    on(event: string, listener: (...args: unknown[]) => void): unknown {
      ;(listeners[event] ??= []).push(listener)
      return broken
    },
  }
  observeStdoutPressure(broken)
  broken.write()
  const t0 = performance.now()
  setTimeout(() => {
    for (const listener of listeners.error ?? []) listener(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  }, 5)
  const result = await drainPipedStdoutForExit(broken, STAND_IN_POLL_MS)
  const elapsed = Math.round(performance.now() - t0)
  check('an observed stream settles on EPIPE well before the stood-in poll period', !result.drained && elapsed < SETTLE_CEILING_MS, `drained=${result.drained} elapsed=${elapsed}ms; observeStdoutPressure and drainPipedStdoutForExit in src/platform/processes/gracefulShutdown.ts must settle with drained false on an error event from an observed stream`)
  check('no timer is left behind after observed EPIPE', activeTimeouts() === baseTimers, `timers=${activeTimeouts() - baseTimers}; drainPipedStdoutForExit in src/platform/processes/gracefulShutdown.ts must clear its timer once the error event settles it`)
}

{
  const baseTimers = activeTimeouts()
  let releaseWrite: (() => void) | null = null
  const stream = new Writable({
    highWaterMark: 16,
    write(_chunk, _encoding, callback) {
      releaseWrite = callback
    },
  })
  const accepted = stream.write(Buffer.alloc(64, 0x61))
  const t0 = performance.now()
  setTimeout(() => {
    releaseWrite?.()
  }, 10)
  const result = await drainPipedStdoutForExit(stream, STAND_IN_POLL_MS)
  const elapsed = Math.round(performance.now() - t0)
  check('a real Writable under backpressure settles on Node drain well before the stood-in poll period', !accepted && result.drained && result.remainingBytes === 0 && elapsed < SETTLE_CEILING_MS, `accepted=${accepted} drained=${result.drained} remaining=${result.remainingBytes} elapsed=${elapsed}ms; drainPipedStdoutForExit in src/platform/processes/gracefulShutdown.ts must settle on the drain event of a real Writable under backpressure`)
  check('no timer or drain listener is left behind on the Writable', activeTimeouts() === baseTimers && stream.listenerCount('drain') === 0, `timers=${activeTimeouts() - baseTimers} listeners=${stream.listenerCount('drain')}; drainPipedStdoutForExit in src/platform/processes/gracefulShutdown.ts must clear its timer and remove its drain listener when it settles`)
}

console.log(failures === 0 ? '\nprove-deadlines-d04: green' : `\nprove-deadlines-d04: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
