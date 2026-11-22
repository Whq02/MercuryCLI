import { appendFileSync, writeSync } from 'node:fs'
import type { Writable } from 'stream'
import { getClearTerminalSequence } from './capabilities.js'
import type { Diff } from '../frame.js'
import { cursorMove, cursorTo, eraseLines } from '../termio/csi.js'
import { BSU, ESU, HIDE_CURSOR, SHOW_CURSOR } from '../termio/dec.js'
import { link } from '../termio/osc.js'
import { noteTerminalWriteHeld } from '../terminalOut.js'
import { sleepSync } from '../../utils/timers.js'
import { passedOver } from '../../utils/passedOver.js'
import { hostEnv } from '../../utils/hostEnv.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


export type Terminal = Unbuilt

export type DeliverySyscalls = {
  writeSync: (fd: number, data: Buffer, offset: number) => number
  sleep: (ms: number) => void
}

const defaultSyscalls: DeliverySyscalls = {
  writeSync: (fd, data, offset) => writeSync(fd, data, offset),
  sleep: ms => {
    sleepSync(ms)
  },
}

let lastWriteSpins = 0

const SPIN_LIMIT = 400
const SPIN_QUANTUM_MS = 2.5

export type FrameDelivery = {
  readonly seq: number
  readonly bytes: number
  readonly writtenAt: number
  drainedAt: number | null
}

let deliverySeq = 0
let lastDelivery: FrameDelivery | null = null

export function lastFrameDelivery(): FrameDelivery | null {
  return lastDelivery
}

export function writeAllSync(
  fd: number,
  data: Buffer,
  syscalls: DeliverySyscalls = defaultSyscalls,
): boolean {
  const startedAt = performance.now()
  try {
    return writeWhole(fd, data, syscalls)
  } finally {
    noteTerminalWriteHeld(performance.now() - startedAt)
  }
}

function writeWhole(fd: number, data: Buffer, syscalls: DeliverySyscalls): boolean {
  let offset = 0
  lastWriteSpins = 0
  while (offset < data.length) {
    try {
      offset += syscalls.writeSync(fd, data, offset)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        if (++lastWriteSpins > SPIN_LIMIT) return false
        syscalls.sleep(SPIN_QUANTUM_MS)
        continue
      }
      if (code === 'EPIPE' || code === 'EIO') return true
      throw e
    }
  }
  return true
}

export function streamTakesWrites(
  stream: { destroyed?: boolean; writable?: boolean; writableEnded?: boolean },
): boolean {
  return stream.destroyed !== true && stream.writableEnded !== true && stream.writable !== false
}

export function writeDiffToTerminal(
  terminal: Terminal,
  diff: Diff,
  skipSyncMarkers?: boolean,
  syscalls?: DeliverySyscalls,
): boolean {
  return notBuilt('src/ink/session/delivery.ts:128')
}
