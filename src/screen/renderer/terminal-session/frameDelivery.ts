import { appendFileSync, writeSync } from 'node:fs'
import type { Writable } from 'stream'
import { getClearTerminalSequence } from './capabilities.js'
import type { Diff } from '../frame.js'
import { cursorMove, cursorTo, eraseLines } from '../termio/csi.js'
import { BSU, ESU, HIDE_CURSOR, SHOW_CURSOR } from '../termio/dec.js'
import { link } from '../termio/osc.js'
import { noteTerminalWriteHeld } from '../terminalOut.js'
import { sleepSync } from '../../../platform/async/timers.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'


type TerminalStream = Writable & { isTTY?: boolean; fd?: number }

export type Terminal = { stdout: TerminalStream; stderr: TerminalStream }

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

function patchBytes(patch: Diff[number]): string {
  switch (patch.type) {
    case 'stdout':
      return patch.content
    case 'styleStr':
      return patch.str
    case 'hyperlink':
      return link(patch.uri)
    case 'cursorMove':
      return cursorMove(patch.x, patch.y)
    case 'cursorTo':
      return cursorTo(patch.col)
    case 'clear':
      return eraseLines(patch.count)
    case 'clearTerminal':
      return getClearTerminalSequence()
    case 'cursorHide':
      return HIDE_CURSOR
    case 'cursorShow':
      return SHOW_CURSOR
    case 'carriageReturn':
      return '\r'
  }
}

function teeWrite(text: string, path: string, delivered: boolean, spins?: number): void {
  const file = hostEnv().INK_WRITE_TEE
  if (!file) return
  try {
    const record = {
      ts: Date.now(),
      len: text.length,
      path,
      delivered,
      ...(spins === undefined ? {} : { spins, waitMs: Math.round(spins * SPIN_QUANTUM_MS) }),
      ...(hostEnv().INK_WRITE_TEE_FULL ? { content: text } : { sample: text.slice(0, 40) }),
    }
    appendFileSync(file, `${JSON.stringify(record)}\n`)
    appendFileSync(`${file}.raw`, text)
  } catch (error) {
    passedOver(error)
  }
}

export function writeDiffToTerminal(
  terminal: Terminal,
  diff: Diff,
  skipSyncMarkers = false,
  syscalls?: DeliverySyscalls,
): boolean {
  const body = diff.map(patchBytes).join('')
  if (body === '') return true
  const text = skipSyncMarkers ? body : BSU + body + ESU
  const bytes = Buffer.from(text, 'utf8')
  const delivery: FrameDelivery = { seq: ++deliverySeq, bytes: bytes.length, writtenAt: performance.now(), drainedAt: null }
  lastDelivery = delivery
  const { stdout } = terminal
  if (stdout.isTTY === true && stdout.fd !== undefined) {
    const delivered = writeAllSync(stdout.fd, bytes, syscalls)
    delivery.drainedAt = performance.now()
    teeWrite(text, `fd${stdout.fd}`, delivered, lastWriteSpins)
    return delivered
  }
  stdout.write(text, () => {
    delivery.drainedAt = performance.now()
  })
  teeWrite(text, 'stream', true)
  return true
}
